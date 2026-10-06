import { describe, expect, it } from 'vitest';
import { effectiveRole, isEmail, superuserEmails } from '../worker/lib/access';
import { safeEqual, signValue, verifyValue } from '../worker/lib/crypto';
import { safeNext } from '../worker/routes/auth';

const env = { SUPERUSER_EMAILS: ' Admin@Example.com, ops@example.com ,' } as Env;

describe('superusers come only from SUPERUSER_EMAILS', () => {
  it('parses, trims and lowercases the env list', () => {
    expect([...superuserEmails(env)]).toEqual(['admin@example.com', 'ops@example.com']);
  });

  it('env superuser wins regardless of allowlist and disabled flag', () => {
    expect(effectiveRole(env, 'ADMIN@example.com', null, false)).toBe('superuser');
    expect(effectiveRole(env, 'admin@example.com', 'buyer', true)).toBe('superuser');
  });

  it('allowlist role applies otherwise; never superuser', () => {
    expect(effectiveRole(env, 'a@example.com', 'seller', false)).toBe('seller');
    expect(effectiveRole(env, 'a@example.com', 'buyer', false)).toBe('buyer');
  });

  it('no access when not invited or disabled', () => {
    expect(effectiveRole(env, 'a@example.com', null, false)).toBeNull();
    expect(effectiveRole(env, 'a@example.com', 'seller', true)).toBeNull();
  });
});

describe('signed values', () => {
  it('round-trips', async () => {
    const signed = await signValue({ s: 'state', n: '/x' }, 'secret-1');
    expect(await verifyValue(signed, 'secret-1')).toEqual({ s: 'state', n: '/x' });
  });

  it('rejects a wrong secret or a tampered payload', async () => {
    const signed = await signValue({ s: 'state' }, 'secret-1');
    expect(await verifyValue(signed, 'secret-2')).toBeNull();
    const [payload, sig] = signed.split('.');
    const forged = btoa(JSON.stringify({ s: 'evil' })).replace(/=+$/, '');
    expect(await verifyValue(`${forged}.${sig}`, 'secret-1')).toBeNull();
    expect(await verifyValue(`${payload}.`, 'secret-1')).toBeNull();
    expect(await verifyValue(undefined, 'secret-1')).toBeNull();
  });
});

describe('helpers', () => {
  it('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('safeNext only allows same-site relative paths', () => {
    expect(safeNext('/admin?x=1')).toBe('/admin?x=1');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(undefined)).toBe('/');
  });

  it('isEmail', () => {
    expect(isEmail('a@example.com')).toBe(true);
    expect(isEmail('not an email')).toBe(false);
    expect(isEmail(42)).toBe(false);
  });
});
