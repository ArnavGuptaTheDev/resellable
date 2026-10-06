import { Hono } from 'hono';
import { apiError, requireUser } from '../middleware';
import { pushToUser, vapidConfig } from '../lib/notify';
import type { AppEnv } from '../types';

/** Per-device notification subscriptions. */
const push = new Hono<AppEnv>();
push.use('*', requireUser);

const B64URL = /^[A-Za-z0-9_-]+$/;

push.get('/key', (c) => {
  const v = vapidConfig(c.env);
  return c.json({ publicKey: v?.publicKey ?? null });
});

/** Body: the browser's PushSubscription JSON ({ endpoint, keys: { p256dh, auth } }). */
push.post('/subscribe', async (c) => {
  if (!vapidConfig(c.env)) return apiError(c, 409, 'push_disabled', 'Notifications are not configured on this server.');
  const body = await c.req.json<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }>().catch(() => null);
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  let url: URL | null = null;
  try {
    url = new URL(endpoint);
  } catch {
    /* invalid */
  }
  if (
    !url ||
    url.protocol !== 'https:' ||
    endpoint.length > 1000 ||
    typeof p256dh !== 'string' ||
    typeof auth !== 'string' ||
    !B64URL.test(p256dh) ||
    !B64URL.test(auth) ||
    p256dh.length < 80 ||
    p256dh.length > 100 ||
    auth.length < 16 ||
    auth.length > 32
  ) {
    return apiError(c, 422, 'invalid_subscription', 'That push subscription is not valid.');
  }
  // One row per endpoint; a device that changes account moves to the new user.
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
       user_agent = excluded.user_agent, failures = 0`,
  )
    .bind(c.get('user').id, endpoint, p256dh, auth, c.req.header('User-Agent')?.slice(0, 200) ?? null, Date.now())
    .run();
  return c.json({ ok: true });
});

push.post('/unsubscribe', async (c) => {
  const body = await c.req.json<{ endpoint?: unknown }>().catch(() => null);
  if (typeof body?.endpoint === 'string') {
    await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(body.endpoint, c.get('user').id).run();
  }
  return c.json({ ok: true });
});

/** Sends a test notification to all of the user's devices. */
push.post('/test', async (c) => {
  const results = await pushToUser(
    c.env,
    c.get('user').id,
    { title: 'Notifications are on', body: "You'll hear about offers, messages and deal updates here.", url: '/deals', tag: 'test' },
    'high',
  );
  return c.json({ devices: results.length, sent: results.filter((r) => r === 'sent').length });
});

export default push;
