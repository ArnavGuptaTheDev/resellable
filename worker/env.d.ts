// Secrets and optional local-only vars. These are not in wrangler.jsonc, so
// `wrangler types` does not know about them. Set secrets with
// `wrangler secret put NAME` (production) or in .dev.vars (local).
interface Env {
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  /** Comma-separated. The only source of the superuser role. */
  SUPERUSER_EMAILS: string;
  /** Optional. Public origin when it differs from the request URL (e.g. the astro dev proxy). */
  APP_ORIGIN?: string;
  /** Local dev only: "true" enables /auth/dev-login on localhost. Never set in production. */
  DEV_LOGIN?: string;
}
