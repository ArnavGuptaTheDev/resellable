# Build "Resellable"

You are building **Resellable**, an invite-only web app (installable PWA) where a seller lists things they want to sell, buyers build a cart, and both sides negotiate one final price for the whole cart. There is **no payment processing**. The app ends at "we agreed on a price, here is how we pay and hand over", and both happen off-platform.

It must work for any kind of item, not just electronics. The first real use is a large inventory of small electronic components (ESP32, ESP8266, sensors, etc.), so **adding items fast from a phone is the most important UX in the app**.

Before writing code: read this whole spec, check the current Cloudflare docs for anything marked "verify", then give me a short plan and the D1 schema for approval. Build in the milestones at the bottom, and stop after each one so I can test.

## Hard constraints

- Everything must run on Cloudflare's free tier. No paid services, no payment system.
- Frontend: **Astro + TypeScript, static output**. Interactivity through a small number of islands, in vanilla TS or **Preact** where state gets complex (cart, deal thread, item intake). No framework runtime for the whole page.
- Backend: Cloudflare Workers runtime (not a Node server), TypeScript, **Hono** for routing, **D1** for data, **R2** for images. Deploy as Cloudflare Pages + Pages Functions; verify in current docs whether Workers with static assets is now the recommended path for new projects and use that instead if so. Either way, one deployable project.
- Since output is static and the app is behind login, pages are static shells and data is fetched client-side from `/api/*`. No SEO requirements.
- Fonts: one distinctive display face and one clean text face, self-hosted through Fontsource, subset to Latin, `font-display: swap`. Suggested: Chakra Petch (display), IBM Plex Sans (text), IBM Plex Mono for prices and quantities. Change them if you have a better pairing, but keep it to these three roles.
- Theme: **cyberpunk, with both light and dark modes**. Follows system preference, with a manual toggle that persists. Built on CSS custom properties. Neon accents on dark; the light mode should be a proper design (think printed tech manual with neon ink), not an inverted dark mode. Keep text contrast at WCAG AA. Glow and scanline effects are decoration only, and off under `prefers-reduced-motion`.
- Mobile-first. Most use will be on a phone.

## Auth and access

- **Google OAuth only** (authorization code flow with PKCE, handled in the Worker). Require `email_verified`.
- **Invite-only by email allowlist.**
  - `SUPERUSER_EMAILS` env var: comma-separated emails. These users always have access and the superuser role.
  - Superusers can add or remove allowed emails in an admin screen, and set each invited user's role.
  - A Google account whose email is neither in the env var nor the allowlist gets a "not invited" page and no session.
- Roles: `superuser`, `seller`, `buyer`. Sellers can also buy. Superusers can do everything, including disabling a user.
- Sessions: random session id in an HttpOnly, Secure, SameSite=Lax cookie; session rows in D1 with expiry. CSRF protection on all mutating routes.
- Every API route checks session and role on the server. Never trust the client for ownership or role checks.

## Data model (propose the exact schema, this is the intent)

- **users**: email, name, avatar, role, disabled flag.
- **allowlist**: email, role, invited_by, created_at.
- **items**: seller, title, description (optional), category (free text with autocomplete from existing values), tags, condition (new / used / for parts), **quantity in stock**, **price (nullable)**, status (draft / listed / hidden / sold out), timestamps.
  - Price null means **"make an offer"**: the buyer proposes first.
- **item_photos**: item, R2 key, thumbnail key, sort order.
- **quantity tiers** (optional per item): min quantity → unit price. Example: 1 for ₹350, 5+ for ₹300 each.
- **bundles**: seller, title, description, cover photo, pricing as either a fixed bundle price or a percent off the sum of component prices. Example: "Build a Robot".
- **bundle_items**: bundle, item, quantity. Bundle availability is derived from component stock; a bundle is unavailable when any component is short.
- **deals**: buyer, seller, status, fulfilment method (shipping / pickup), fulfilment notes, agreed total, timestamps. One open cart per buyer-seller pair.
- **deal_lines**: deal, item or bundle, quantity, list unit price snapshot at the time it was added, optional buyer-proposed price for that line.
- **offers**: deal, made_by, total amount, optional message, created_at. Immutable rows; the latest one is the live offer.
- **messages**: deal, author, text, created_at. Plain text chat on the deal.

Money is stored as integer minor units (paise). Currency defaults to INR and is a single app-wide config value.

Nothing is hard-deleted from deals, offers, or messages. Items and bundles are soft-hidden.

## Seller features

### Fast item intake (the priority)

- **Quick add**: one screen. Take or pick photos (`<input capture>` plus multi-select), title, quantity, price (optional), condition. Everything else optional and collapsed. Save and immediately start the next one ("Save & add another" keeps category, tags, and condition from the previous item).
- **Batch from photos**: select many photos at once; each becomes a draft item. Then a drafts list where I fill in title, quantity, and price inline, row by row, without opening each item.
- **Duplicate item** action.
- Resize and compress images **in the browser** before upload: main image max 1600px WebP, plus a ~400px thumbnail. Upload both. Do not depend on Cloudflare Images or any paid transform.
- Inventory view: searchable, filterable table/list with inline edit of quantity and price, and bulk actions (list, hide, set category, add to bundle).
- **CSV export** of inventory.

### Bundles and discounts

- Create a bundle by selecting items in the inventory view and choosing "Create bundle", then set quantities and the bundle price or percent off.
- Bundle page shows what is inside, the sum of individual prices, and the saving.
- Quantity tier pricing per item.
- Any further special discount happens through a counter-offer on the deal, so no coupon system.

## Buyer features

- Browse and search: text search over title, description, tags; filters for category, condition, has price / make an offer, bundles only. D1 FTS5 if available on D1 (verify), otherwise `LIKE`.
- Item page and bundle page with photo gallery.
- **Cart**: add items (with quantity) and bundles from a seller. For items with no price, the buyer must enter the price they are offering. For priced items they may optionally propose a different one.
- Cart shows list total (with tiers and bundle pricing applied) and the buyer's proposed total. The buyer submits the cart as a deal with an opening offer, which can simply be the list total.

## Deals and negotiation

State machine, enforced on the server:

`cart → submitted → negotiating → agreed → paid → fulfilled → completed`, with `cancelled` reachable from any state before `fulfilled`.

Rules:

- An offer is a total for the whole cart, with an optional message. Either side can counter.
- Only the party who did **not** make the latest offer can accept it.
- Editing the cart (lines or quantities) while negotiating voids the live offer and requires a new one. Both sides can propose line changes; the seller can also remove lines they can no longer supply.
- On **agreed**: record the agreed total, reserve stock by decrementing item quantities in a single D1 batch, and fail cleanly if stock ran out in the meantime. On cancel after agreement, restore stock.
- After agreement both sides pick the fulfilment method (shipping or pickup) and exchange details in the deal chat. The seller marks **paid**, then **shipped / picked up**; the buyer confirms receipt to complete. Payment itself is off-platform; show a free-text "how to pay" note from the seller's profile (e.g. UPI ID).
- The deal page is one timeline: offers, cart changes, status changes, and chat messages in order.
- Updates by polling every few seconds while a deal page is open. No WebSockets or Durable Objects.
- In-app unread indicators for deals needing my attention. No email.

## PWA

- Web app manifest, icons, installable on Android and desktop.
- Service worker caches the app shell and static assets only. Never cache `/api/*` or authenticated images in a shared cache.
- Web Share Target so I can share photos from the phone gallery straight into "Batch from photos" (do this if it fits cleanly; skip if it complicates the service worker).

## Images and R2

- R2 bucket is **private**. Images are served through an authenticated Worker route with long-lived private cache headers and immutable keys.
- Validate content type and size on upload. Cap at a sensible per-image size and per-item photo count.

## Non-goals

No payments, no public listings, no email, no ratings or reviews, no multi-currency, no real-time sockets, no native app.

## Project deliverables

- D1 migrations in the repo, plus a seed script with sample items and a bundle for local dev.
- `wrangler` config with D1 and R2 bindings; secrets documented in `.dev.vars.example` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SUPERUSER_EMAILS`, session secret).
- Unit tests for pricing (tiers, bundles, totals) and the deal state machine, including the stock race on agreement.
- **README** covering: local dev, build, deploy to Cloudflare, creating the D1 database and R2 bucket, setting up the Google OAuth client and redirect URIs, setting secrets, and where to edit content and config (theme tokens, fonts, currency, upload limits).

## Milestones

1. Scaffold, theme with light/dark, fonts, layout shell, deploy pipeline working with a hello page.
2. Google OAuth, sessions, allowlist, admin screen, role checks.
3. Items: quick add, client-side image processing, R2 upload, inventory view, batch from photos, CSV export.
4. Browse, search, item pages, bundles, quantity tiers.
5. Cart, deals, offers, chat, state machine, stock reservation, tests.
6. PWA, polish, README.