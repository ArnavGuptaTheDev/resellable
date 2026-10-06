/**
 * Web Push for Workers using only WebCrypto (Node's `web-push` package does not
 * run on Workers):
 *   - payload encryption: RFC 8291 (aes128gcm content coding, RFC 8188)
 *   - VAPID authentication: RFC 8292 (ES256 JWT)
 * Covered by test/webpush.test.ts against the RFC 8291 Appendix A vector.
 */
import { base64url, base64urlDecode } from './crypto';

const enc = new TextEncoder();
const RECORD_SIZE = 4096;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** JWK for a P-256 key from raw base64url parts (uncompressed public 0x04||x||y, private d). */
function jwk(publicRaw: Uint8Array, d?: Uint8Array): JsonWebKey {
  if (publicRaw.length !== 65 || publicRaw[0] !== 4) throw new Error('Expected an uncompressed P-256 public key');
  return {
    kty: 'EC',
    crv: 'P-256',
    x: base64url(publicRaw.slice(1, 33)),
    y: base64url(publicRaw.slice(33, 65)),
    ...(d ? { d: base64url(d) } : {}),
    ext: true,
  };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

export interface PushKeys {
  /** Browser's public key, base64url (subscription.keys.p256dh). */
  p256dh: string;
  /** Browser's auth secret, base64url (subscription.keys.auth). */
  auth: string;
}

/** For tests: fixed sender key pair and salt instead of fresh random ones. */
export interface EncryptOverrides {
  salt?: Uint8Array;
  senderPublic?: Uint8Array;
  senderPrivate?: Uint8Array;
}

/** Encrypts a payload for one subscription. Returns the request body (header + single record). */
export async function encryptPayload(keys: PushKeys, plaintext: Uint8Array, o: EncryptOverrides = {}): Promise<Uint8Array> {
  const uaPublic = base64urlDecode(keys.p256dh);
  const authSecret = base64urlDecode(keys.auth);
  const salt = o.salt ?? crypto.getRandomValues(new Uint8Array(16));

  // Sender (application server) ephemeral ECDH key pair.
  let senderPrivate: CryptoKey;
  let senderPublic: Uint8Array;
  if (o.senderPrivate && o.senderPublic) {
    senderPublic = o.senderPublic;
    senderPrivate = await crypto.subtle.importKey('jwk', jwk(senderPublic, o.senderPrivate), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    senderPrivate = pair.privateKey;
    senderPublic = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  }

  const uaKey = await crypto.subtle.importKey('jwk', jwk(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // Standard field name is `public` (workers-types spells it `$public`; the runtime takes `public`).
  const ecdhParams = { name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, senderPrivate, 256));

  // RFC 8291 §3.4: combine ECDH secret with the auth secret, then RFC 8188 key + nonce.
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, senderPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Single record: plaintext || 0x02 (last-record delimiter), no padding.
  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new Error('Push payload too large');
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));

  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPublic.length;
  return concat(header, senderPublic, cipher);
}

/** VAPID Authorization header value for a push endpoint (RFC 8292). */
export async function vapidAuthorization(endpoint: string, publicKey: string, privateKey: string, subject: string, nowSec = Math.floor(Date.now() / 1000)) {
  const pub = base64urlDecode(publicKey);
  const key = await crypto.subtle.importKey('jwk', jwk(pub, base64urlDecode(privateKey)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = base64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = base64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: subject })));
  // WebCrypto ECDSA signatures are already raw r||s (what JWS ES256 wants).
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${base64url(sig)}, k=${publicKey}`;
}

export interface Subscription extends PushKeys {
  endpoint: string;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export type SendResult = 'sent' | 'gone' | 'failed';

/** Sends one encrypted push. 'gone' means the subscription should be deleted. */
export async function sendPush(sub: Subscription, payload: unknown, vapid: VapidConfig, opts: { ttl?: number; urgency?: 'normal' | 'high' } = {}): Promise<SendResult> {
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(payload)));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(sub.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttl ?? 24 * 3600),
      Urgency: opts.urgency ?? 'normal',
    },
    body,
  });
  if (res.status === 404 || res.status === 410) return 'gone';
  if (!res.ok) {
    console.warn('push failed', res.status, new URL(sub.endpoint).host, (await res.text()).slice(0, 200));
    return 'failed';
  }
  return 'sent';
}
