import type { Context, MiddlewareHandler } from 'hono';
import { hasRole, type Role } from '../shared/roles';
import { safeEqual } from './lib/crypto';
import { loadSession } from './lib/session';
import type { AppEnv } from './types';

/** Public origin of the app. APP_ORIGIN overrides it when behind the dev proxy. */
export function appOrigin(c: Context<AppEnv>): string {
  return c.env.APP_ORIGIN?.replace(/\/$/, '') || new URL(c.req.url).origin;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function apiError(c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 409 | 422, error: string, message?: string) {
  return c.json({ error, ...(message ? { message } : {}) }, status);
}

/**
 * Requires a valid session (re-checked against the allowlist, env superusers and
 * the disabled flag on every request) and, for mutating methods, a same-origin
 * request carrying the session's CSRF token.
 */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await loadSession(c);
  if (!user) return apiError(c, 401, 'unauthenticated');

  if (!SAFE_METHODS.has(c.req.method)) {
    const origin = c.req.header('Origin');
    // The request's own origin, plus APP_ORIGIN when set (the dev proxy).
    const allowed = new Set([new URL(c.req.url).origin, appOrigin(c)]);
    if (!origin || !allowed.has(origin)) return apiError(c, 403, 'bad_origin');
    const token = c.req.header('X-CSRF-Token');
    if (!token || !safeEqual(token, user.csrfToken)) return apiError(c, 403, 'bad_csrf');
  }

  c.set('user', user);
  await next();
};

/** Must run after requireUser. Superusers always pass. */
export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!hasRole(c.get('user').role, roles)) return apiError(c, 403, 'forbidden');
    await next();
  };
}
