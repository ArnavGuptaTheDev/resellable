import { describe, expect, it } from 'vitest';
import { base64url, base64urlDecode } from '../worker/lib/crypto';
import { encryptPayload, vapidAuthorization } from '../worker/lib/webpush';

// RFC 8291 Appendix A
const V = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  expected:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** Browser-side decryption (what the push service's client does), to check random-key output. */
async function decrypt(body: Uint8Array, uaPrivate: string, uaPublic: string, auth: string): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const senderPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const jwk = (pub: Uint8Array, d?: string): JsonWebKey => ({ kty: 'EC', crv: 'P-256', x: base64url(pub.slice(1, 33)), y: base64url(pub.slice(33)), ...(d ? { d } : {}) });
  const uaPub = base64urlDecode(uaPublic);
  const priv = await crypto.subtle.importKey('jwk', jwk(uaPub, uaPrivate), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const sender = await crypto.subtle.importKey('jwk', jwk(senderPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: sender }, priv, 256));
  const te = new TextEncoder();
  const hk = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const ikm = await hk(base64urlDecode(auth), ecdh, new Uint8Array([...te.encode('WebPush: info\0'), ...uaPub, ...senderPublic]), 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), cipher),
  );
  expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
  return new TextDecoder().decode(plain.slice(0, -1));
}

describe('web push encryption (RFC 8291)', () => {
  it('matches the RFC 8291 Appendix A example byte for byte', async () => {
    const body = await encryptPayload({ p256dh: V.uaPublic, auth: V.auth }, base64urlDecode(V.plaintext), {
      salt: base64urlDecode(V.salt),
      senderPublic: base64urlDecode(V.asPublic),
      senderPrivate: base64urlDecode(V.asPrivate),
    });
    expect(base64url(body)).toBe(V.expected);
  });

  it('round-trips with a fresh sender key and salt', async () => {
    const msg = JSON.stringify({ title: 'New offer · Alice', body: '₹5,600 for 3 items', url: '/deal?id=1' });
    const body = await encryptPayload({ p256dh: V.uaPublic, auth: V.auth }, new TextEncoder().encode(msg));
    expect(base64url(body.slice(0, 16))).not.toBe(V.salt);
    expect(await decrypt(body, V.uaPrivate, V.uaPublic, V.auth)).toBe(msg);
  });

  it('refuses payloads that exceed one record', async () => {
    await expect(encryptPayload({ p256dh: V.uaPublic, auth: V.auth }, new Uint8Array(5000))).rejects.toThrow(/too large/);
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs an ES256 JWT for the endpoint origin that verifies with the public key', async () => {
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', V.asPublic, V.asPrivate, 'https://app.example.com', 1_000_000);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(m).toBeTruthy();
    expect(m[4]).toBe(V.asPublic);
    const claims = JSON.parse(new TextDecoder().decode(base64urlDecode(m[2]!)));
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_000_000 + 12 * 3600, sub: 'https://app.example.com' });
    expect(JSON.parse(new TextDecoder().decode(base64urlDecode(m[1]!)))).toEqual({ typ: 'JWT', alg: 'ES256' });

    const pub = base64urlDecode(V.asPublic);
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: base64url(pub.slice(1, 33)), y: base64url(pub.slice(33)) },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, base64urlDecode(m[3]!), new TextEncoder().encode(`${m[1]}.${m[2]}`));
    expect(ok).toBe(true);
  });
});
