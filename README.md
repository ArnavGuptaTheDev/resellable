# Resellable

Invite-only PWA for listing things to sell, building carts and negotiating one price per cart. Runs entirely on Cloudflare's free tier: Astro (static) for the UI, one Hono Worker for `/api/*`, `/auth/*` and `/img/*`, D1 for data and R2 for images.

> This README grows with each milestone. The full version (OAuth setup, D1/R2 creation, secrets, config reference) lands in milestone 6.

## Requirements

- Node 22.12+ (developed on Node 24)
- A Cloudflare account (free plan), logged in with `npx wrangler login`

## Local development

```sh
npm install
npm run dev
```

This runs two processes:

- `astro dev` on http://localhost:4321, which serves the UI with hot reload and proxies `/api`, `/auth` and `/img` to the Worker
- `wrangler dev` on http://localhost:8787, which runs the Worker locally (D1 and R2 are simulated in `.wrangler/`)

Open http://localhost:4321.

To run the production build exactly as it will be deployed (static assets plus the Worker together):

```sh
npm run preview      # astro build && wrangler dev → http://localhost:8787
```

## Checks

```sh
npm run check        # astro check + Worker typecheck
npm test             # unit tests (from milestone 5)
```

## Deploy

```sh
npm run deploy       # astro build && wrangler deploy
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
3. It runs `npm run deploy:ci`, which runs `wrangler deploy`. That uploads the Worker and `dist/` as static assets.

Build logs appear under the Worker's **Deployments** tab.

**Runtime secrets are not part of the build.** You set them once on the Worker (see [Secrets](#secrets)), and they persist across deploys. Do not put secrets in the dashboard's *build* variables either: those are only for the build step and are not readable at runtime.

> **Milestone 2 note:** `deploy:ci` will also apply D1 migrations (`wrangler d1 migrations apply --remote`). The API token that Workers Builds creates automatically does **not** have D1 permissions. In the build settings, switch to a custom API token that has the default permissions plus **D1: Edit**.

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
| `worker/` | The Hono Worker (API, auth, images) |
| `wrangler.jsonc` | Worker config: static assets, bindings |

## Theme and fonts

- Light and dark themes follow the system setting. The header button cycles **system → light → dark**, and the choice is saved in `localStorage`.
- Glow and scanline effects are switched off under `prefers-reduced-motion`.
- Fonts are self-hosted from Fontsource, using Latin subsets only, with `font-display: swap`:
  - Chakra Petch for display text
  - IBM Plex Sans for body text
  - IBM Plex Mono for prices and quantities
- To change a font, swap the `@fontsource/*` imports in `src/layouts/Shell.astro` and the `--font-*` tokens in `tokens.css`.
