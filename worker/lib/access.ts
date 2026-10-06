import type { InviteRole, Role } from '../../shared/roles';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmail(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v.trim());
}

export function superuserEmails(env: Env): Set<string> {
  return new Set(
    (env.SUPERUSER_EMAILS ?? '')
      .split(',')
      .map(normalizeEmail)
      .filter(Boolean),
  );
}

export function isSuperuser(env: Env, email: string): boolean {
  return superuserEmails(env).has(normalizeEmail(email));
}

/**
 * Effective role for an email right now, or null if it has no access.
 * Superuser only from env; otherwise the allowlist role. Disabled users have no
 * access unless they are env superusers (those always have access).
 */
export function effectiveRole(
  env: Env,
  email: string,
  allowRole: InviteRole | null,
  disabled: boolean,
): Role | null {
  if (isSuperuser(env, email)) return 'superuser';
  if (disabled || !allowRole) return null;
  return allowRole;
}
