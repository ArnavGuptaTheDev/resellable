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

## Cart, deals and negotiation (milestone 5)

- **"Submitted" means the opening offer is waiting for the seller's first move.** Any counter-offer or cart edit after that moves the deal to "negotiating".
- **New lines can only be added while it's a cart.** During negotiation, either side can change quantities or remove lines, and only the buyer proposes per-line prices. This keeps "both sides can propose line changes" without letting a seller push extra items into a buyer's deal.
- **A line's list price snapshot is taken again when its quantity changes.** Tier pricing depends on quantity, so the original snapshot would be wrong.
- **Stock is checked when adding to the cart and when submitting, and enforced only at agreement.** The early checks give quick feedback. The agreement batch is the real guarantee (atomic, with the `CHECK (quantity >= 0)` constraint).
- **`deals.agree_token` doubles as a per-operation token.** Every guarded transition stamps a fresh one, and dependent writes in the same batch (stock moves, events) only apply if their request won. That rules out double decrements and stray timeline events.
- **Accept sends the offer ID it's accepting.** If a newer offer arrived in the meantime, accepting is refused instead of agreeing to an amount the user didn't see.
- **"Mark shipped / picked up" requires a hand-over method.** The spec has both sides pick the method before hand-over.
- **The seller marks paid, then shipped or picked up; the buyer confirms receipt.** This follows the spec's ordering exactly.
- **Cancelling a cart empties it.** Lines are soft-removed and the cart deal is marked cancelled, freeing the one-open-cart slot.
- **Chat opens once the cart is submitted** and stays open after completion or cancellation, for follow-ups. Sellers never see carts.
- **Only the buyer and seller can open a deal; superusers can't.** Deals are private negotiations. Superusers' "everything" covers access and moderation, not reading other people's chats.
- **The deal page polls every 4 seconds while visible**, with `?since=<updated_at>`, so an unchanged deal costs one small read. Header badges refresh every 60 seconds, and also on focus and after cart actions.
- **A deal "needs you" when** the other side did something you haven't seen, or it's your move (a live offer from them; for the buyer, paying after agreement; for the seller, marking hand-over once paid).
- **The seller's "how to pay" note is edited under Deals → Selling.** It's shown to the buyer from agreement on.
- **Photos of items in your deals stay visible to both parties** even after the item is hidden or sold out.
- **Timeline ties within the same millisecond sort as offer, then message, then event**, so an offer appears before the status change it caused.
