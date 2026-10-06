# Resellable

An invite-only web app (installable PWA) for selling your stuff to people you know:

1. A seller lists items quickly from their phone.
2. Buyers fill a cart.
3. Both sides negotiate **one price for the whole cart**.

There is **no payment processing**. The app ends at "we agreed on a price, here is how to pay and hand over", and both happen off-platform.

It runs entirely on Cloudflare's free tier:

- **Astro** builds the UI as static pages.
- One **Hono** Worker serves `/api/*`, `/auth/*` and `/img/*`.
- **D1** stores the data, and a private **R2** bucket stores photos.

Why things are built the way they are: [DECISIONS.md](DECISIONS.md).

## Contents

- [Features](#features)
- [Quick start (local)](#quick-start-local)
- [First-time Cloudflare setup](#first-time-cloudflare-setup)
- [Deploy](#deploy)
- [Secrets](#secrets)
- [Google OAuth](#google-oauth)
- [Access control](#access-control)
- [How it works](#how-it-works)
- [Where to change things](#where-to-change-things)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)

## Features

**Selling**

| Screen | What it does |
| --- | --- |
| `/sell/add` | **Quick add**: take or pick photos, then title, quantity, price (optional) and condition. **Save & add another** keeps category, tags and condition. |
| `/sell/batch` | **Batch from photos**: every photo becomes a draft. Then fill in title → Enter → quantity → Enter → price → Enter, row by row. It also receives photos shared from your phone's gallery once the app is installed. |
| `/sell` | **Inventory**: search, status and category filters, inline quantity and price, CSV export. Bulk actions: list, hide, to draft, set category, **Create bundle**, **Add to bundle**. |
| `/sell/item?id=…` | Full editor: photos (add, remove, make cover), every field, quantity price tiers, duplicate |
| `/sell/bundles`, `/sell/bundle?id=…` | Bundles priced as a fixed amount or a percent off the items' total |

**Buying**

| Screen | What it does |
| --- | --- |
| `/` | Browse and search (title, description, tags), with filters for category, condition, has price / make an offer, and bundles only |
| `/item?id=…`, `/bundle?id=…` | Photo gallery, tier pricing, stock, bundle contents with the saving, and add to cart |
| `/cart` | One cart per seller: change quantities, propose prices (required for make-an-offer items), see the list total and your proposed total, then send it with an opening offer |
| `/deals`, `/deal?id=…` | Negotiation and hand-over: counter-offers, accept, chat, then paid → shipped / picked up → received. The page refreshes itself every few seconds. |

**Admin** (`/admin`, superusers only): invite emails as buyer or seller, change roles, remove invites, disable accounts.

**Everywhere**

- A cyberpunk theme in light and dark: it follows the system setting, with a toggle that's remembered.
- Mobile-first, installable as an app.
- Unread badges for deals that need you.

## Quick start (local)

Requirements: Node 22.12+ (developed on 24).

```sh
npm install
cp .dev.vars.example .dev.vars   # local secrets; placeholders are fine to start
npm run db:migrate               # create local D1 tables
npm run db:seed                  # optional: sample items, tiers, a bundle (example.com users)
npm run dev                      # → http://localhost:4321
```

`npm run dev` runs two processes:

- `astro dev` on :4321, which serves the UI with hot reload and proxies `/api`, `/auth` and `/img` to the Worker;
- `wrangler dev` on :8787, which runs the Worker. D1 and R2 are simulated in `.wrangler/`.

### Signing in locally

You have two options:

- **Without Google:** with `DEV_LOGIN=true` in `.dev.vars` (the example file sets it), open
  http://localhost:4321/auth/dev-login?email=seller@example.com (or `buyer@example.com` after seeding, or any email in your `SUPERUSER_EMAILS`).
  - It applies the same allowlist, superuser and disabled checks as real sign-in.
  - It only answers on `localhost` with `DEV_LOGIN=true`, and a test checks it returns 404 otherwise.
  - Never set it in production.
- **With Google:** put the real client ID and secret in `.dev.vars`, and add `http://localhost:4321/auth/callback` to the OAuth client.

### Production-like run

```sh
npm run preview                  # full build (+ service worker) served by wrangler dev → http://localhost:8787
```

For Google sign-in under `preview`, comment out `APP_ORIGIN` in `.dev.vars`, and add `http://localhost:8787/auth/callback` to the OAuth client.

### Checks

```sh
npm run check          # astro check + Worker typecheck
npm test               # all unit tests (vitest)
npm run scan:secrets   # run before every commit; the repo is public
```

| Test file | Covers |
| --- | --- |
| `test/pricing.test.ts` | Quantity tiers, bundle sums and saving, percent-off rounding, availability, cart totals, tier and bundle-pricing rules |
| `test/deals.test.ts` | The deal state machine: who may do what, in which status |
| `test/deal-db.test.ts` | Deals against real SQLite (the same SQL D1 runs): stock reserved at agreement, **the stock race** (two deals for the last units, double accept, short bundle component), **restore on cancel from `deal_stock_moves`** (even after the bundle changed), and the auto vs manual sold-out rule |
| `test/auth.test.ts`, `test/dev-login.test.ts` | Superuser and allowlist rules, signed cookies, open-redirect guard, dev-login guard |
| `test/items.test.ts` | Money parsing and formatting, tags, item validation, search query sanitising, image sniffing |

## First-time Cloudflare setup

Do this once, logged in with `npx wrangler login`.

1. **Create the D1 database:**

   ```sh
   npx wrangler d1 create resellable
   ```

   Put the printed `database_id` in `wrangler.jsonc`. It's not a secret.
2. **Create the R2 bucket for photos:**

   ```sh
   npx wrangler r2 bucket create resellable-images
   ```

   Keep it **private**: no r2.dev URL and no custom domain. Photos are served only through the Worker's `/img/*` route, which requires a session. If wrangler says R2 isn't enabled, enable R2 once in the dashboard (it's free-tier eligible).
3. **Create the Google OAuth client** ([below](#google-oauth)) and put its client ID in `wrangler.jsonc` → `vars.GOOGLE_CLIENT_ID`.
4. **Set the three secrets** ([below](#secrets)).
5. **Deploy**, either:
   - `npm run deploy` from your machine; or
   - connect [Workers Builds](#auto-deploy-from-github-workers-builds) and push to `main`.
6. **Optional custom domain:** add it under the Worker's **Settings → Domains & Routes**. Then add `https://<domain>/auth/callback` to the OAuth client. No code change is needed: the Worker uses the request's own origin.

## Deploy

```sh
npm run deploy     # build (astro + service worker) → apply D1 migrations (--remote) → wrangler deploy
```

### Auto-deploy from GitHub (Workers Builds)

Every push to `main` builds and deploys on Cloudflare. GitHub Actions isn't used.

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository** and pick this repo. If the Worker already exists, use its **Settings → Builds → Connect** instead.
2. Use these settings:

   | Setting | Value |
   | --- | --- |
   | Worker name | `resellable`. **It must match `"name"` in `wrangler.jsonc`**, or the build fails. |
   | Production branch | `main` |
   | Build command | `npm run build` |
   | Deploy command | `npm run deploy:ci` |
   | Root directory | *(empty)* |

3. **API token:** `deploy:ci` runs `wrangler d1 migrations apply DB --remote` before `wrangler deploy`. The token Workers Builds generates automatically has no D1 permission. Under **Settings → Builds → API token**, use a custom token with the default build permissions plus **Account → D1 → Edit**.
4. Optional: turn off builds for non-production branches under **Branch control**.

On each push:

1. Cloudflare runs `npm ci`, then `npm run build` (Astro, then `dist/sw.js`).
2. Then it runs `npm run deploy:ci`, which applies new migrations and deploys. If a migration fails, nothing is deployed.

Logs are under the Worker's **Deployments** tab. Runtime secrets aren't part of the build: set them once on the Worker and they persist across deploys. Don't put secrets in the dashboard's *build* variables.

### Migrations

- Schema changes go in a new `migrations/NNNN_name.sql`. Never edit an applied one.
- `npm run db:migrate` applies migrations locally; `npm run db:migrate:remote` applies them to production (`deploy:ci` does this too).
- `items_fts` is an FTS5 virtual table kept in sync by triggers. If `wrangler d1 export` complains about virtual tables, drop `items_fts` and its triggers before exporting. Recreate them afterwards from `migrations/0001_init.sql` and rebuild with `INSERT INTO items_fts(items_fts) VALUES ('rebuild');`.

## Secrets

This repository is public. **Never commit credentials.** Real values live in only two places:

- **Production:** Worker secrets, set with `npx wrangler secret put NAME`.
- **Local dev:** `.dev.vars` (git-ignored). `.dev.vars.example` holds placeholders only.

| Name | Kind | What it is |
| --- | --- | --- |
| `GOOGLE_CLIENT_SECRET` | secret | Google OAuth client secret |
| `SESSION_SECRET` | secret | Random string of at least 32 characters; signs the short-lived OAuth state cookie. Generate it with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Use a different value in production and locally. |
| `SUPERUSER_EMAILS` | secret | Comma-separated emails that always have access and the superuser role. It's kept secret so the repo doesn't publish them. |
| `GOOGLE_CLIENT_ID` | plain var | Public by design; it's in `wrangler.jsonc` → `vars`. Don't also set it as a secret. |
| `APP_ORIGIN`, `DEV_LOGIN` | local only | Dev-proxy origin and the dev-login switch. Never set in production. |

```sh
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put SUPERUSER_EMAILS
npx wrangler secret list          # names only, never values
```

Before every commit, run `npm run scan:secrets`. It uses `gitleaks` if installed. Otherwise it scans every file git would commit for:

- key and token patterns;
- Google OAuth secrets;
- private keys;
- email addresses not on `example.com`;
- local user paths.

## Google OAuth

1. In [Google Cloud Console](https://console.cloud.google.com/), go to **APIs & Services → OAuth consent screen**:
   - Choose **External**.
   - Add the scopes `openid`, `email` and `profile`.
   - While the app is in *Testing*, only listed test users can sign in. Add your invitees there, or publish the app. These scopes don't need Google's verification review.
2. Go to **Credentials → Create credentials → OAuth client ID → Web application**, and add one **Authorized redirect URI** per place the app runs:
   - `https://<your domain or resellable.<subdomain>.workers.dev>/auth/callback`
   - `http://localhost:4321/auth/callback` for `npm run dev`
3. Put the client ID in `wrangler.jsonc` → `vars.GOOGLE_CLIENT_ID` (and `.dev.vars`). Store the secret with `wrangler secret put GOOGLE_CLIENT_SECRET` (and in `.dev.vars`).

How sign-in works:

- **Code flow:** the authorization code flow with PKCE. The verifier and state live in a signed, HttpOnly cookie for 10 minutes.
- **Token checks:** the Worker exchanges the code over TLS and validates the ID token's `iss`, `aud`, `exp` and **`email_verified`**.
- **Invites:** only emails in `SUPERUSER_EMAILS` or on the allowlist get a session. Anyone else sees "not invited", and nothing is stored about them.
- **Session:** the session cookie is `__Host-session` (HttpOnly, Secure, SameSite=Lax, 30 days, extended while in use). D1 stores only a SHA-256 hash of its token.

## Access control

- **Roles:** `superuser` (only from `SUPERUSER_EMAILS`), `seller` (who can also buy) and `buyer`. Sellers and buyers are invited on `/admin`.
- **Checked on every request:** session expiry, the disabled flag, and current allowlist or env membership. Disabling a user, or removing their invite, ends their access on their next request.
- **Enforced on the server:** every route checks the role, and ownership too. Another seller's items and bundles return 404. Only the buyer and seller can open a deal.
- **CSRF:** every mutating request needs the app's own `Origin` plus the per-session `X-CSRF-Token` header. The session cookie is SameSite=Lax.

## How it works

### Deals

```
cart → submitted → negotiating → agreed → paid → fulfilled → completed
        (cancelled from any state before fulfilled; the server enforces every step)
```

- **Offers:** an offer is one total for the whole cart. Only the side that did **not** make the live offer can accept it. Changing the cart while negotiating withdraws the live offer.
- **Agreement:** one D1 batch marks the deal agreed, takes the stock (bundles expanded into components) and records exactly what it took in `deal_stock_moves`. `items.quantity` has `CHECK (quantity >= 0)`, so if another deal took the stock first, the whole batch rolls back and the user sees which item ran short.
- **Cancel after agreement:** puts back exactly what `deal_stock_moves` recorded, even if the bundle has changed since. Items the system marked sold out go back to listed; items the seller marked sold out stay that way.
- **After agreement:** the seller's "how to pay" note is shown (set it under **Deals → Selling**). Both sides pick pickup or shipping. The seller marks it paid, then shipped or picked up, and the buyer confirms receipt.
- **Updates:** deal pages poll every 4 seconds while visible; there are no sockets.

Code: `shared/deals.ts` (state machine) and `worker/lib/deals.ts` (database operations).

### Pricing

All in `shared/pricing.ts`. Money is integer paise.

- **Tiers:** "1 for ₹350, 5+ for ₹300 each" applies the highest tier the quantity reaches. Tiers are only allowed on items that have a price.
- **Bundles:** priced at a fixed amount, or a percent off the sum of the components (tier-priced at their quantities, rounded to the paisa). Percent off needs every component priced. A bundle is unavailable when any component is short.
- **Line prices:** a cart line snapshots its list price when added, and again when its quantity changes.

### Photos

- **In the browser:** resized to at most 1600 px (main) and 400 px (thumbnail), WebP (JPEG where the browser can't encode WebP), with EXIF rotation applied.
- **In the Worker:** checks the real format from the file's first bytes, the size, and the per-item limit.
- **Storage:** files go to `photos/<uuid>` keys in the private R2 bucket. `/img/*` serves them only to signed-in users allowed to see them, with `Cache-Control: private, max-age=31536000, immutable`.

### PWA

- **Manifest:** `public/manifest.webmanifest` has icons (including maskable), shortcuts, and a **Web Share Target**: share photos from the gallery to Resellable to batch-add them.
- **Service worker:** `scripts/sw.template.js` is built into `dist/sw.js` with this build's file list and version:
  - **Precache:** the app shell (static pages) and hashed assets.
  - **Pages:** network first, falling back to the cached shell, then an offline page.
  - **Never cached:** `/api/*`, `/auth/*` and `/img/*`.
  - **Updates:** old caches are dropped on each deploy.

## Where to change things

| To change… | Edit |
| --- | --- |
| Colors (light and dark), spacing, glow | `src/styles/tokens.css`: the tokens on `:root`, plus both dark blocks (system-dark and the manual toggle) |
| Fonts | The `@fontsource/*` imports in `src/layouts/Shell.astro`, and the `--font-display`, `--font-text` and `--font-mono` tokens |
| Currency and locale | `shared/config.ts` → `CURRENCY`, `LOCALE`, `MINOR_PER_MAJOR` |
| Upload limits (photos per item, sizes, dimensions, quality) | `shared/config.ts` → `UPLOAD`. The browser and the Worker both read it. |
| Field limits (title length, max quantity or price) | `shared/config.ts` → `LIMITS` |
| Deal polling interval | `POLL_MS` in `src/components/deals/DealPage.tsx` |
| Session length | `SESSION_TTL_MS` in `worker/lib/session.ts` |
| Security headers, CSP, static caching | `public/_headers` |
| App name, icons, share target | `public/manifest.webmanifest`, `public/icons/` |
| Sample data | `seed/seed.sql` |
| Nav links | `links` in `src/layouts/Shell.astro` |

## Project layout

| Path | What it is |
| --- | --- |
| `src/pages/` | Static page shells; data loads client-side from `/api/*` |
| `src/components/` | Preact islands: `sell/`, `shop/`, `deals/`, `admin/` |
| `src/layouts/Shell.astro` | Header, nav, badges, theme pre-paint, session guard, SW registration |
| `src/lib/` | Browser helpers: `api.ts` (fetch + CSRF), `session.ts`, `images.ts` (resize/compress), `badges.ts` |
| `src/styles/` | `tokens.css` (theme), `global.css`, plus per-area `sell.css`, `shop.css`, `deals.css` |
| `shared/` | Shared by UI and Worker: `config.ts`, `pricing.ts`, `deals.ts`, `items.ts`, `money.ts`, `roles.ts`, types |
| `worker/` | Hono Worker: `routes/` (auth, me, admin, items, bundles, catalog, deals, images), `lib/`, `middleware.ts` |
| `migrations/` | D1 schema, applied in order |
| `seed/seed.sql` | Local sample data |
| `scripts/` | `build-sw.mjs` + `sw.template.js` (service worker), `secret-scan.mjs` |
| `test/` | Vitest tests; `helpers/d1.ts` runs D1 code against real SQLite |
| `public/` | `_headers`, manifest, icons, favicon |
| `wrangler.jsonc` | Worker config: static assets, D1 + R2 bindings, plain vars |

## Troubleshooting

| Problem | Likely cause and fix |
| --- | --- |
| `redirect_uri_mismatch` from Google | The exact `https://<host>/auth/callback` isn't on the OAuth client. Add it; it can take a few minutes to apply. |
| "Access blocked" or "not a test user" | The consent screen is in *Testing*. Add the account as a test user, or publish the app. |
| "Not invited" for someone you invited | They signed in with a different Google account. The allowlist matches the exact email. |
| Build fails at `d1 migrations apply` | The Workers Builds token lacks **D1 Edit** ([see above](#auto-deploy-from-github-workers-builds)). |
| Build fails with a name mismatch | The Worker name in the dashboard must be `resellable` (the `"name"` in `wrangler.jsonc`). |
| Old UI after a deploy | The service worker serves pages network-first, so a normal reload is enough. If you're stuck: browser settings → site data → clear for the domain. |
| Photos don't appear for a buyer | The item is a draft or hidden, or the buyer isn't part of a deal containing it. |
