import { getSession, redirectToLogin } from './session';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    /** Per-field messages for 422 validation errors. */
    public fields: Record<string, string> = {},
  ) {
    super(message ?? code);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * JSON fetch against /api. Adds the CSRF token to mutating requests and sends
 * the user to /login if the session is gone (expired, disabled, uninvited).
 */
export async function api<T = unknown>(path: string, opts: { method?: Method; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    const session = await getSession();
    if (!session) redirectToLogin();
    headers['X-CSRF-Token'] = session.csrfToken;
  }
  const isForm = opts.body instanceof FormData;
  // FormData sets its own multipart Content-Type with the boundary.
  if (opts.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
  });

  if (res.status === 401) redirectToLogin();
  const data = res.headers.get('Content-Type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; message?: string; fields?: Record<string, string> };
    throw new ApiError(res.status, err.error ?? `http_${res.status}`, err.message, err.fields);
  }
  return data as T;
}

/** Friendly message for an error thrown by api(). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.message && err.message !== err.code) return err.message;
    if (err.status === 403) return 'You do not have permission to do that.';
    return `Something went wrong (${err.code}).`;
  }
  return 'Network error. Check your connection and try again.';
}
