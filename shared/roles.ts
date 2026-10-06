export const ROLES = ['superuser', 'seller', 'buyer'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that can be granted through the allowlist. Superuser comes only from SUPERUSER_EMAILS. */
export const INVITE_ROLES = ['seller', 'buyer'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export function isInviteRole(v: unknown): v is InviteRole {
  return v === 'seller' || v === 'buyer';
}

/** Sellers can also buy; superusers can do everything. */
export function canSell(role: Role): boolean {
  return role === 'seller' || role === 'superuser';
}

export function hasRole(role: Role, allowed: readonly Role[]): boolean {
  return role === 'superuser' || allowed.includes(role);
}

export interface Me {
  id: number;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: Role;
  paymentNote: string | null;
}
