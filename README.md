# Resellable

Invite-only PWA for listing things to sell, building carts and negotiating one price per cart. Runs entirely on Cloudflare's free tier: Astro (static) for the UI, one Hono Worker for `/api/*`, `/auth/*` and `/img/*`, D1 for data and R2 for images.

> This README grows with each milestone. R2 setup and the full config reference land in later milestones.

## Requirements

- Node 22.12+ (developed on Node 24)
- A Cloudflare account (free plan), logged in with `npx wrangler login`

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # then edit: set SUPERUSER_EMAILS to your email
npm run db:migrate               # create the local D1 tables
npm run dev
```

`npm run dev` runs two processes:

- `astro dev` on http://localhost:4321, which serves the UI with hot reload and proxies `/api`, `/auth` and `/img` to the Worker
- `wrangler dev` on http://localhost:8787, which runs the Worker locally (D1 and R2 are simulated in `.wrangler/`)

Open http://localhost:4321.

### Signing in locally

You have two options:

- **Without Google (quickest):** `.dev.vars.example` sets `DEV_LOGIN=true`, which turns on a local-only shortcut. Open http://localhost:4321/auth/dev-login?email=you@example.com, using an email from `SUPERUSER_EMAILS` or one you've invited. The normal allowlist, superuser and disabled checks still apply. The route only answers on `localhost`, and only when `DEV_LOGIN=true`, so never set that in production.
- **With Google:** put your real client ID and secret in `.dev.vars`, and add `http://localhost:4321/auth/callback` as a redirect URI on the OAuth client (see [Google OAuth](#google-oauth)).

To run the production build exactly as it will be deployed (static assets plus the Worker together):

```sh
npm run preview      # astro build && wrangler dev → http://localhost:8787
```

For Google sign-in under `preview`, comment out `APP_ORIGIN` in `.dev.vars` so the redirect goes to :8787, and add `http://localhost:8787/auth/callback` to the OAuth client.

## Checks

```sh
npm run check        # astro check + Worker typecheck
npm test             # unit tests
npm run scan:secrets # run before every commit
```

## First-time Cloudflare setup

Do this once, before the first deploy.

1. **Create the D1 database:**

   ```sh
   npx wrangler d1 create resellable
   ```

   Copy the `database_id` it prints into `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`. The ID is not a secret, and committing it is fine.

2. **Create the Google OAuth client** (see [Google OAuth](#google-oauth)). Put its client ID in `wrangler.jsonc` under `vars.GOOGLE_CLIENT_ID`.
3. **Set the secrets** (see [Secrets](#secrets)).
4. **Deploy:** run `npm run deploy` from your machine, or push to `main` once Workers Builds is connected.

## Google OAuth

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (or pick an existing one).
2. Go to **APIs & Services → OAuth consent screen**:
   - Choose **External** user type.
   - Fill in the app name and support email.
   - Add the scopes `openid`, `email` and `profile`.

   While the app is in *Testing*, only the test users you list can sign in. Either add each invitee there, or publish the app. These three scopes don't need Google's verification review.
3. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized redirect URIs**: add one for each place you run the app:
     - `https://resellable.<your-subdomain>.workers.dev/auth/callback`
     - `https://<your custom domain>/auth/callback` (if you use one)
     - `http://localhost:4321/auth/callback` (for `npm run dev`)
4. Copy the **Client ID** into `wrangler.jsonc` → `vars.GOOGLE_CLIENT_ID`, and into `.dev.vars` for local dev.
5. Store the **Client secret** only as a secret: run `npx wrangler secret put GOOGLE_CLIENT_SECRET` for production, and put it in `.dev.vars` for local dev.

How sign-in works:

- **Code flow:** it's the authorization code flow with PKCE. The PKCE verifier and `state` are kept in a signed, HttpOnly cookie that lasts 10 minutes.
- **Token checks:** the Worker exchanges the code for an ID token and checks `iss`, `aud`, `exp` and `email_verified`.
- **Session:** it creates a session only for emails in `SUPERUSER_EMAILS` or on the allowlist. The session cookie is `__Host-session` (HttpOnly, Secure, SameSite=Lax, 30 days, extended while in use), and D1 stores only a SHA-256 hash of its token.

## Access control

- **Superusers** are exactly the emails in the `SUPERUSER_EMAILS` secret. They can't be disabled from the app. To remove one, change the secret.
- **Sellers and buyers** are invited on the **Admin** screen (`/admin`), and their role can be changed there. Sellers can also buy.
- **Every request re-checks access.** That covers session expiry, the disabled flag, and current allowlist or `SUPERUSER_EMAILS` membership. So disabling a user, or removing them from the allowlist, ends their access on their next request.
- **CSRF:** every mutating API call must come from the app's own origin and carry the per-session `X-CSRF-Token` header.

## Deploy

```sh
npm run deploy       # astro build, apply D1 migrations (--remote), wrangler deploy
```

The first deploy creates the `resellable` Worker and prints its `*.workers.dev` URL. Later deploys update it in place.

### Auto-deploy from GitHub (Workers Builds)

Every push to `main` triggers a build and deploy on Cloudflare through **Workers Builds** (Cloudflare's Git integration). GitHub Actions is not involved.

**One-time setup:**

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository** (or, if the Worker already exists, open it and go to **Settings → Builds → Connect**). Then pick this GitHub repo.
2. Fill in these settings:

   | Setting | Value |
   | --- | --- |
   | Worker name | `resellable`. **This must match `"name"` in `wrangler.jsonc`**, or the build fails. |
   | Production branch | `main` |
   | Build command | `npm run build` |
   | Deploy command | `npm run deploy:ci` |
   | Root directory | *(leave empty)* |

3. Optional: under **Branch control**, turn off builds for non-production branches if you don't want preview versions created for other branches.

**What happens on push:**

1. Cloudflare clones the repo and runs `npm ci`.
2. It runs `npm run build`, which runs `astro build` and writes `dist/`.
3. It runs `npm run deploy:ci`. That applies any new D1 migrations to the production database (`wrangler d1 migrations apply DB --remote`), then runs `wrangler deploy`, which uploads the Worker and `dist/` as static assets. If a migration fails, nothing is deployed.

Build logs appear under the Worker's **Deployments** tab.

**Runtime secrets are not part of the build.** You set them once on the Worker (see [Secrets](#secrets)), and they persist across deploys. Do not put secrets in the dashboard's *build* variables either: those are only for the build step and are not readable at runtime.

> **D1 permission needed:** `deploy:ci` runs `wrangler d1 migrations apply DB --remote` before `wrangler deploy`. The API token that Workers Builds creates automatically does **not** have D1 permissions. Under the Worker's **Settings → Builds → API token**, use a custom token with the default build permissions plus **Account → D1 → Edit**.

## Secrets

This repository is public. **Never commit credentials.** Real values live in only two places:

- **Production:** Worker secrets, set with `npx wrangler secret put NAME`. They're stored encrypted on Cloudflare and never appear in `wrangler.jsonc` or in git.
- **Local dev:** a `.dev.vars` file, which is git-ignored. Copy it from `.dev.vars.example`, which holds placeholders only.

| Name | Kind | What it is |
| --- | --- | --- |
| `GOOGLE_CLIENT_SECRET` | secret | Google OAuth client secret from Google Cloud Console → Credentials. |
| `SESSION_SECRET` | secret | Random string of at least 32 characters. Signs the short-lived OAuth state cookie. Generate it with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `SUPERUSER_EMAILS` | secret | Comma-separated emails that always get access and the superuser role. It's kept secret so the repo doesn't publish your address. |
| `GOOGLE_CLIENT_ID` | plain var | The OAuth client ID. It isn't confidential (it appears in the Google sign-in URL), so it goes under `vars` in `wrangler.jsonc` from milestone 2. |

Set each secret once (you'll be prompted for the value):

```sh
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put SUPERUSER_EMAILS
```

To rotate a secret, run the same command again. `npx wrangler secret list` shows which secrets are set, without their values.

### Secret scan

Before every commit, run:

```sh
npm run scan:secrets
```

This uses `gitleaks` if it's installed. Otherwise it greps every file git would commit for:

- key and token patterns
- Google OAuth secrets
- private keys
- non-`example.com` email addresses
- local user paths

It exits non-zero if it finds anything.

## Project layout

| Path | What it is |
| --- | --- |
| `src/pages/` | Static page shells (one `.astro` file per screen) |
| `src/components/` | Astro components and Preact islands (`.tsx`) |
| `src/layouts/Shell.astro` | Header, nav, tab bar, font imports, pre-paint theme script |
| `src/styles/tokens.css` | **Theme tokens**: colors for light and dark, fonts, spacing. Edit colors here. |
| `src/styles/global.css` | Base styles and shared components (`.panel`, `.btn`, `.tag`, …) |
| `public/_headers` | Security headers and cache rules for static assets |
| `src/lib/` | Client helpers: `api.ts` (fetch with CSRF), `session.ts` (`/api/me`) |
| `worker/` | The Hono Worker: `routes/` (auth, me, admin), `lib/` (session, crypto, access), `middleware.ts` (auth, CSRF, roles) |
| `shared/` | TypeScript shared by the UI and the Worker (roles; pricing and deal rules later) |
| `migrations/` | D1 schema migrations, applied in order |
| `test/` | Vitest unit tests |
| `scripts/secret-scan.mjs` | Pre-commit secret scan |
| `wrangler.jsonc` | Worker config: static assets, D1 binding, plain vars |

## Theme and fonts

- Light and dark themes follow the system setting. The header button cycles **system → light → dark**, and the choice is saved in `localStorage`.
- Glow and scanline effects are switched off under `prefers-reduced-motion`.
- Fonts are self-hosted from Fontsource, using Latin subsets only, with `font-display: swap`:
  - Chakra Petch for display text
  - IBM Plex Sans for body text
  - IBM Plex Mono for prices and quantities
- To change a font, swap the `@fontsource/*` imports in `src/layouts/Shell.astro` and the `--font-*` tokens in `tokens.css`.
