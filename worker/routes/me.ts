import { Hono } from 'hono';
import type { Me } from '../../shared/roles';
import { apiError, requireUser } from '../middleware';
import type { AppEnv } from '../types';

const me = new Hono<AppEnv>();
me.use('*', requireUser);

me.get('/', (c) => {
  const { csrfToken, sessionHash: _hash, ...user } = c.get('user');
  return c.json({ user: user satisfies Me, csrfToken }, 200, { 'Cache-Control': 'no-store' });
});

const MAX_NAME = 80;
const MAX_NOTE = 500;

me.patch('/', async (c) => {
  const body = await c.req.json<{ name?: unknown; paymentNote?: unknown }>().catch(() => null);
  if (!body) return apiError(c, 400, 'bad_json');
  const user = c.get('user');
  const sets: string[] = [];
  const args: (string | null)[] = [];

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length > MAX_NAME) {
      return apiError(c, 422, 'invalid_name', `Name must be at most ${MAX_NAME} characters.`);
    }
    sets.push('name = ?');
    args.push(body.name.trim() || null);
  }
  if (body.paymentNote !== undefined) {
    if (body.paymentNote !== null && (typeof body.paymentNote !== 'string' || body.paymentNote.length > MAX_NOTE)) {
      return apiError(c, 422, 'invalid_payment_note', `Payment note must be at most ${MAX_NOTE} characters.`);
    }
    sets.push('payment_note = ?');
    args.push(typeof body.paymentNote === 'string' ? body.paymentNote.trim() || null : null);
  }
  if (!sets.length) return apiError(c, 400, 'nothing_to_update');

  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...args, user.id)
    .run();
  return c.json({ ok: true });
});

export default me;
