const enc = new TextEncoder();

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Random URL-safe token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Base64url(input: string): Promise<string> {
  return base64url(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
}

/** `payload.signature`, where payload is base64url JSON. */
export async function signValue(data: unknown, secret: string): Promise<string> {
  const payload = base64url(enc.encode(JSON.stringify(data)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return `${payload}.${base64url(sig)}`;
}

export async function verifyValue<T>(signed: string | undefined, secret: string): Promise<T | null> {
  if (!signed) return null;
  const dot = signed.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const expected = base64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)));
  if (!safeEqual(sig, expected)) return null;
  try {
    return JSON.parse(new TextDecoder().decode(base64urlDecode(payload))) as T;
  } catch {
    return null;
  }
}
