import type { Me } from '../../shared/roles';

export interface Session {
  user: Me;
  csrfToken: string;
}

let current: Promise<Session | null> | null = null;

/** Fetches /api/me once per page load. Resolves null when not signed in. */
export function getSession(): Promise<Session | null> {
  current ??= fetch('/api/me', { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(
    async (res) => {
      if (res.status === 401) return null;
      if (!res.ok) throw new Error(`/api/me failed: HTTP ${res.status}`);
      return (await res.json()) as Session;
    },
  );
  return current;
}

export function loginUrl(next = location.pathname + location.search): string {
  return `/login?next=${encodeURIComponent(next)}`;
}

export function redirectToLogin(): never {
  location.replace(loginUrl());
  throw new Error('redirecting to login');
}
