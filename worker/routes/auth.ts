import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { effectiveRole, isEmail, normalizeEmail } from '../lib/access';
import { base64urlDecode, randomToken, sha256Base64url, signValue, verifyValue } from '../lib/crypto';
import { createSession, destroySession } from '../lib/session';
import { appOrigin, requireUser } from '../middleware';
import type { AppEnv } from '../types';
import type { InviteRole } from '../../shared/roles';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const OAUTH_COOKIE = 'oauth';
const OAUTH_TTL_S = 600;

interface OAuthState {
  s: string; // state
  v: string; // PKCE code_verifier
  n: string; // where to go after sign-in
  e: number; // expiry (ms)
}

/** Only same-site relative paths, never `//host` or `/\host`. */
export function safeNext(next: string | undefined | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}

function fail(c: Context<AppEnv>, reason: 'not_invited' | 'disabled' | 'unverified' | 'error') {
  return c.redirect(`/not-invited?reason=${reason}`, 302);
}

const auth = new Hono<AppEnv>();

auth.get('/login', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || c.env.GOOGLE_CLIENT_ID.startsWith('REPLACE_') || !c.env.SESSION_SECRET) {
    return c.text('Google sign-in is not configured. See README → Google OAuth.', 500);
  }
  const state = randomToken(16);
  const verifier = randomToken(48);
  const payload: OAuthState = {
    s: state,
    v: verifier,
    n: safeNext(c.req.query('next')),
    e: Date.now() + OAUTH_TTL_S * 1000,
  };
  setCookie(c, OAUTH_COOKIE, await signValue(payload, c.env.SESSION_SECRET), {
    prefix: 'host',
    httpOnly: true,
    sameSite: 'Lax', // must survive the top-level redirect back from Google
    maxAge: OAUTH_TTL_S,
  });

  const url = new URL(GOOGLE_AUTH);
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${appOrigin(c)}/auth/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: await sha256Base64url(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return c.redirect(url.toString(), 302);
});

interface GoogleClaims {
  iss: string;
  aud: string;
  exp: number;
  email?: string;
  email_verified?: boolean | 'true' | 'false';
  name?: string;
  picture?: string;
}

auth.get('/callback', async (c) => {
  const signed = getCookie(c, OAUTH_COOKIE, 'host');
  deleteCookie(c, OAUTH_COOKIE, { prefix: 'host', path: '/', secure: true });

  if (c.req.query('error')) return c.redirect('/login?error=cancelled', 302);

  const saved = await verifyValue<OAuthState>(signed, c.env.SESSION_SECRET);
  const code = c.req.query('code');
  if (!saved || saved.e < Date.now() || !code || saved.s !== c.req.query('state')) {
    return c.redirect('/login?error=expired', 302);
  }

  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${appOrigin(c)}/auth/callback`,
      grant_type: 'authorization_code',
      code_verifier: saved.v,
    }),
  });
  if (!tokenRes.ok) {
    console.error('google token exchange failed', tokenRes.status, await tokenRes.text());
    return fail(c, 'error');
  }
  const { id_token } = (await tokenRes.json()) as { id_token?: string };

  // The ID token came straight from Google's token endpoint over TLS, so per
  // OpenID Connect Core §3.1.3.7 we validate claims rather than the signature.
  let claims: GoogleClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(id_token!.split('.')[1]!)));
  } catch {
    return fail(c, 'error');
  }
  if (
    !GOOGLE_ISSUERS.has(claims.iss) ||
    claims.aud !== c.env.GOOGLE_CLIENT_ID ||
    claims.exp * 1000 < Date.now() ||
    !claims.email
  ) {
    return fail(c, 'error');
  }
  if (claims.email_verified !== true && claims.email_verified !== 'true') return fail(c, 'unverified');

  return signIn(c, claims.email, claims.name ?? null, claims.picture ?? null, saved.n);
});

/**
 * Grants a session only if the email is an env superuser or on the allowlist,
 * and not disabled. Nothing is written for uninvited emails.
 */
async function signIn(c: Context<AppEnv>, rawEmail: string, name: string | null, avatar: string | null, next: string) {
  const email = normalizeEmail(rawEmail);
  const db = c.env.DB;
  const allow = await db
    .prepare('SELECT role FROM allowlist WHERE email = ?')
    .bind(email)
    .first<{ role: InviteRole }>();
  const existing = await db
    .prepare('SELECT id, disabled FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number; disabled: number }>();

  if (!effectiveRole(c.env, email, allow?.role ?? null, false)) return fail(c, 'not_invited');
  if (!effectiveRole(c.env, email, allow?.role ?? null, existing?.disabled === 1)) return fail(c, 'disabled');

  const now = Date.now();
  const user = await db
    .prepare(
      `INSERT INTO users (email, name, avatar_url, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (email) DO UPDATE SET
         name = COALESCE(excluded.name, users.name),
         avatar_url = COALESCE(excluded.avatar_url, users.avatar_url),
         last_login_at = excluded.last_login_at
       RETURNING id`,
    )
    .bind(email, name, avatar, now, now)
    .first<{ id: number }>();

  await createSession(c, user!.id);
  return c.redirect(safeNext(next), 302);
}

auth.post('/logout', requireUser, async (c) => {
  await destroySession(c, c.get('user').sessionHash);
  return c.json({ ok: true });
});

/**
 * Local development only: sign in as any allowed email without Google.
 * Requires DEV_LOGIN=true in .dev.vars AND a localhost origin. Still applies
 * the allowlist / superuser / disabled checks.
 */
auth.get('/dev-login', async (c) => {
  const host = new URL(appOrigin(c)).hostname;
  const reqHost = new URL(c.req.url).hostname;
  const local = (h: string) => h === 'localhost' || h === '127.0.0.1';
  if (c.env.DEV_LOGIN !== 'true' || !local(host) || !local(reqHost)) return c.notFound();
  const email = c.req.query('email');
  if (!isEmail(email)) return c.text('Pass ?email=someone@example.com', 400);
  return signIn(c, email, email.split('@')[0] ?? null, null, safeNext(c.req.query('next')));
});

export default auth;
