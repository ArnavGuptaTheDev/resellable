import { Hono } from 'hono';
import { isInviteRole, type InviteRole } from '../../shared/roles';
import { isEmail, isSuperuser, normalizeEmail, superuserEmails } from '../lib/access';
import { destroyUserSessions } from '../lib/session';
import { apiError, requireRole, requireUser } from '../middleware';
import type { AppEnv } from '../types';

const admin = new Hono<AppEnv>();
admin.use('*', requireUser, requireRole('superuser'));

interface UserRow {
  id: number;
  email: string;
  name: string | null;
  avatar_url: string | null;
  disabled: number;
  created_at: number;
  last_login_at: number | null;
  allow_role: InviteRole | null;
}

admin.get('/users', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.avatar_url, u.disabled, u.created_at, u.last_login_at,
            a.role AS allow_role
       FROM users u LEFT JOIN allowlist a ON a.email = u.email
      ORDER BY u.last_login_at DESC NULLS LAST, u.id DESC`,
  ).all<UserRow>();

  return c.json({
    users: results.map((u) => {
      const superuser = isSuperuser(c.env, u.email);
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        avatarUrl: u.avatar_url,
        disabled: u.disabled === 1,
        createdAt: u.created_at,
        lastLoginAt: u.last_login_at,
        superuser,
        // Role they would have right now, ignoring the disabled flag. null = no longer invited.
        role: superuser ? 'superuser' : u.allow_role,
      };
    }),
  });
});

admin.patch('/users/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ disabled?: unknown }>().catch(() => null);
  if (!Number.isInteger(id) || !body || typeof body.disabled !== 'boolean') {
    return apiError(c, 400, 'bad_request', 'Expected { disabled: boolean }.');
  }
  const user = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: number; email: string }>();
  if (!user) return apiError(c, 404, 'not_found');
  if (isSuperuser(c.env, user.email)) {
    return apiError(c, 409, 'superuser_locked', 'Superusers come from SUPERUSER_EMAILS and cannot be disabled here.');
  }

  await c.env.DB.prepare('UPDATE users SET disabled = ? WHERE id = ?')
    .bind(body.disabled ? 1 : 0, id)
    .run();
  if (body.disabled) await destroyUserSessions(c.env.DB, id);
  return c.json({ ok: true });
});

admin.get('/allowlist', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT a.email, a.role, a.created_at, inv.email AS invited_by_email,
            u.id AS user_id, u.name, u.last_login_at, u.disabled
       FROM allowlist a
       LEFT JOIN users inv ON inv.id = a.invited_by
       LEFT JOIN users u ON u.email = a.email
      ORDER BY a.created_at DESC`,
  ).all<{
    email: string;
    role: InviteRole;
    created_at: number;
    invited_by_email: string | null;
    user_id: number | null;
    name: string | null;
    last_login_at: number | null;
    disabled: number | null;
  }>();

  return c.json({
    superusers: [...superuserEmails(c.env)].sort(),
    entries: results.map((r) => ({
      email: r.email,
      role: r.role,
      createdAt: r.created_at,
      invitedBy: r.invited_by_email,
      userId: r.user_id,
      name: r.name,
      lastLoginAt: r.last_login_at,
      disabled: r.disabled === 1,
    })),
  });
});

admin.post('/allowlist', async (c) => {
  const body = await c.req.json<{ email?: unknown; role?: unknown }>().catch(() => null);
  if (!body || !isEmail(body.email)) return apiError(c, 422, 'invalid_email', 'Enter a valid email address.');
  if (!isInviteRole(body.role)) return apiError(c, 422, 'invalid_role', 'Role must be seller or buyer.');
  const email = normalizeEmail(body.email);
  if (isSuperuser(c.env, email)) {
    return apiError(c, 409, 'already_superuser', 'That email is already a superuser via SUPERUSER_EMAILS.');
  }

  const res = await c.env.DB.prepare(
    `INSERT INTO allowlist (email, role, invited_by, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (email) DO NOTHING`,
  )
    .bind(email, body.role, c.get('user').id, Date.now())
    .run();
  if (!res.meta.changes) return apiError(c, 409, 'exists', 'That email is already invited.');
  return c.json({ ok: true }, 201);
});

admin.patch('/allowlist/:email', async (c) => {
  const email = normalizeEmail(decodeURIComponent(c.req.param('email')));
  const body = await c.req.json<{ role?: unknown }>().catch(() => null);
  if (!body || !isInviteRole(body.role)) return apiError(c, 422, 'invalid_role', 'Role must be seller or buyer.');
  const res = await c.env.DB.prepare('UPDATE allowlist SET role = ? WHERE email = ?').bind(body.role, email).run();
  if (!res.meta.changes) return apiError(c, 404, 'not_found');
  return c.json({ ok: true });
});

admin.delete('/allowlist/:email', async (c) => {
  const email = normalizeEmail(decodeURIComponent(c.req.param('email')));
  const res = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM allowlist WHERE email = ?').bind(email),
    // Access is re-checked per request anyway; this just tidies up.
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)').bind(email),
  ]);
  if (!res[0]!.meta.changes) return apiError(c, 404, 'not_found');
  return c.json({ ok: true });
});

export default admin;
