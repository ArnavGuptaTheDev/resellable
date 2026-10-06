import { describe, expect, it } from 'vitest';
import app from '../worker/index';

// Minimal env: the dev-login guard must reject before touching D1.
function env(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
    DB: new Proxy({}, { get: () => { throw new Error('DB must not be used'); } }),
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    SESSION_SECRET: 'example-session-secret-for-tests-only',
    SUPERUSER_EMAILS: 'admin@example.com',
    CURRENCY: 'INR',
    ...overrides,
  } as unknown as Env;
}

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

const hosts = ['localhost', '127.0.0.1', 'localhost:8787', 'resellable.example.workers.dev', 'evil.example'];

async function devLogin(host: string, e: Env) {
  // Same host in the URL (how Workers derives it) and the Host header.
  const req = new Request(`http://${host}/auth/dev-login?email=admin@example.com`, { headers: { Host: host } });
  return app.fetch(req, e, ctx);
}

describe('/auth/dev-login', () => {
  for (const host of hosts) {
    it(`404s when DEV_LOGIN is unset (Host: ${host})`, async () => {
      const res = await devLogin(host, env());
      expect(res.status).toBe(404);
      expect(res.headers.get('Set-Cookie')).toBeNull();
    });
  }

  it.each(['false', 'TRUE', '1', ''])('404s when DEV_LOGIN is %j', async (value) => {
    const res = await devLogin('localhost', env({ DEV_LOGIN: value }));
    expect(res.status).toBe(404);
  });

  it('control: DEV_LOGIN=true on localhost gets past the guard (reaches D1)', async () => {
    // The stub DB throws, which onError turns into a 500. Proves the 404s above come from the guard.
    const res = await devLogin('localhost', env({ DEV_LOGIN: 'true' }));
    expect(res.status).toBe(500);
  });

  it('404s with DEV_LOGIN=true on a non-local host', async () => {
    for (const host of ['resellable.example.workers.dev', 'evil.example']) {
      expect((await devLogin(host, env({ DEV_LOGIN: 'true' }))).status).toBe(404);
    }
  });

  it('404s with DEV_LOGIN=true when a spoofed localhost Host header hits a public URL', async () => {
    const req = new Request('https://resellable.example.workers.dev/auth/dev-login?email=admin@example.com', {
      headers: { Host: 'localhost' },
    });
    expect((await app.fetch(req, env({ DEV_LOGIN: 'true' }), ctx)).status).toBe(404);
  });

  it('404s with DEV_LOGIN=true on localhost when APP_ORIGIN is public', async () => {
    const res = await devLogin('localhost', env({ DEV_LOGIN: 'true', APP_ORIGIN: 'https://resellable.example.workers.dev' }));
    expect(res.status).toBe(404);
  });
});
