# Decisions

Choices made where the spec left room. Each one has a line of reasoning, so it's easy to revisit.

## Platform and setup

- **Workers with static assets, not Pages.** Cloudflare's Pages docs now say "Start new projects with Workers."
- **Detail pages use query strings** (`/item?id=…`), because static output can't generate a page per item.
- **Superusers can't be disabled in the app.** The spec says `SUPERUSER_EMAILS` users "always have access", so to remove one, change the secret.
- **`/auth/dev-login` exists for local dev.** It only works with `DEV_LOGIN=true` and a localhost origin, and still applies every access check. It makes local testing possible without Google.
- **Currency and upload limits live in `shared/config.ts`, not in env vars.** The static UI needs them at build time, and keeping them in one file means one source of truth.

## Items and photos

- **JPEG is accepted as well as WebP.** Some browsers (older Safari) can't encode WebP and silently return PNG. The Worker still checks the real format from the file's bytes.
- **Photo keys aren't tied to an item** (`photos/<uuid>`). Duplicating an item shares the same immutable files, and a file is deleted only when no photo row uses it.
- **Draft and hidden items' photos are visible only to their seller and superusers.** Listed and sold-out items' photos are visible to anyone signed in.
- **Quick add lists the item immediately by default.** A "List now" checkbox saves a draft instead, which keeps intake to one tap.
- **Bulk "List" skips items without a title** and reports how many it skipped, so an untitled draft is never listed.
- **Any manual status change clears `sold_out_auto`.** A cancel should only flip items back to listed if the system marked them sold out, not the seller.

## Browse, bundles and tiers (milestone 4)

- **Browse shows `listed` items only.** Listed items with zero stock still appear, dimmed and marked "Out of stock". A seller sees their own items marked "Yours".
- **Items and bundles of sellers who have lost access are hidden from browse.** That covers sellers who are disabled or no longer invited. A removed seller shouldn't keep selling.
- **A bundle's "bought separately" sum applies tier pricing at each component's quantity.** This matches what buying those items individually would cost.
- **Percent-off bundle prices round to the nearest paisa.** Money is stored in paise and the spec has no rounding rule.
- **A bundle is unavailable when any component is short, or isn't listed or sold out** (draft or hidden). You can't buy a bundle whose parts aren't for sale.
- **A fixed-price bundle may include make-an-offer items.** Only percent off needs every component priced (approved change 2).
- **Removing an item's price is refused while it has tiers or sits in a percent-off bundle.** This enforces approved change 2 from both directions instead of silently changing the bundle.
- **Tiers replace as a set** (`PUT /api/items/:id/tiers`). The UI edits them as a list, and a single write keeps them consistent.
- **Bundle search uses `LIKE` on title and description.** FTS5 covers items, the dominant search. Bundles are few, so they appear on the first results page when no item-only filter is set.
- **A bundle cover must be a photo of one of its items.** It's served to buyers while the bundle is listed, even if that item is hidden.
- **"Add to bundle" adds quantity 1 per selected item**, increasing an existing line. Quantities can be adjusted in the bundle editor afterwards.
