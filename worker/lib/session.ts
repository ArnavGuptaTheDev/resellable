import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { InviteRole, Me } from '../../shared/roles';
import { effectiveRole } from './access';
import { randomToken, sha256Hex } from './crypto';
import type { AppEnv } from '../types';

export const SESSION_COOKIE = 'session';
const DAY = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * DAY;
/** Extend the session when less than this much time is left. */
const REFRESH_BELOW_MS = 15 * DAY;

export interface SessionUser extends Me {
  csrfToken: string;
  sessionHash: string;
}

function setSessionCookie(c: Context<AppEnv>, token: string, maxAgeMs: number) {
  setCookie(c, SESSION_COOKIE, token, {
    prefix: 'host', // __Host-session: Secure, Path=/, no Domain
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

export function clearSessionCookie(c: Context<AppEnv>) {
  deleteCookie(c, SESSION_COOKIE, { prefix: 'host', path: '/', secure: true });
}

export async function createSession(c: Context<AppEnv>, userId: number): Promise<void> {
  const token = randomToken(32);
  const now = Date.now();
  await c.env.DB.batch([
    // Opportunistic cleanup of this user's expired sessions.
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(userId, now),
    c.env.DB.prepare(
      'INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(await sha256Hex(token), userId, randomToken(24), now, now + SESSION_TTL_MS),
  ]);
  setSessionCookie(c, token, SESSION_TTL_MS);
}

interface SessionRow {
  id_hash: string;
  user_id: number;
  csrf_token: string;
  expires_at: number;
  email: string;
  name: string | null;
  avatar_url: string | null;
  disabled: number;
  payment_note: string | null;
  allow_role: InviteRole | null;
}

/**
 * Loads the session and re-checks access on every request: expiry, disabled
 * flag, and current allowlist / SUPERUSER_EMAILS membership. Any failure
 * deletes the session and clears the cookie.
 */
export async function loadSession(c: Context<AppEnv>): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE, 'host');
  if (!token) return null;
  const hash = await sha256Hex(token);

  const row = await c.env.DB.prepare(
    `SELECT s.id_hash, s.user_id, s.csrf_token, s.expires_at,
            u.email, u.name, u.avatar_url, u.disabled, u.payment_note,
            a.role AS allow_role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN allowlist a ON a.email = u.email
      WHERE s.id_hash = ?`,
  )
    .bind(hash)
    .first<SessionRow>();

  const now = Date.now();
  const role = row ? effectiveRole(c.env, row.email, row.allow_role, row.disabled === 1) : null;

  if (!row || row.expires_at <= now || !role) {
    if (row) await c.env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(hash).run();
    clearSessionCookie(c);
    return null;
  }

  if (row.expires_at - now < REFRESH_BELOW_MS) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id_hash = ?')
        .bind(now + SESSION_TTL_MS, hash)
        .run(),
    );
    setSessionCookie(c, token, SESSION_TTL_MS);
  }

  return {
    id: row.user_id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    role,
    paymentNote: row.payment_note,
    csrfToken: row.csrf_token,
    sessionHash: hash,
  };
}

export async function destroySession(c: Context<AppEnv>, hash: string) {
  await c.env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(hash).run();
  clearSessionCookie(c);
}

export async function destroyUserSessions(db: D1Database, userId: number) {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}
