/**
 * Deals: cart, offers, agreement with stock reservation, fulfilment, cancel
 * with stock restore. Every rule goes through shared/deals.ts.
 *
 * Functions take the D1 database explicitly so the same code runs under the
 * Worker and in tests (test/deal-db.test.ts runs them against real SQLite).
 */
import { LIMITS } from '../../shared/config';
import { denyReason, isMyTurn, nextStatus, STOCK_RESERVED, type DealAction, type DealState, type DealStatus, type Side } from '../../shared/deals';
import type { CartView, DealLineView, DealSummary, DealView, OfferView, ReservedView, TimelineEntry } from '../../shared/dealTypes';
import { cartTotals, unitPriceFor } from '../../shared/pricing';
import { loadBundles, loadTiers } from './catalog';
import { imgUrl } from './items';

export class DealError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 422,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Actor {
  id: number;
}

/** JSON array of env superuser emails, for the active-seller check (see catalog.ts). */
export type ActiveSellers = string;

interface DealRow {
  id: number;
  buyer_id: number;
  seller_id: number;
  status: DealStatus;
  live_offer_id: number | null;
  agreed_total: number | null;
  agree_token: string | null;
  fulfilment_method: 'shipping' | 'pickup' | null;
  fulfilment_notes: string | null;
  last_activity_at: number;
  last_activity_by: number | null;
  buyer_seen_at: number;
  seller_seen_at: number;
  created_at: number;
  updated_at: number;
}

interface LineRow {
  id: number;
  deal_id: number;
  item_id: number | null;
  bundle_id: number | null;
  quantity: number;
  list_unit_price: number | null;
  proposed_unit_price: number | null;
  removed_at: number | null;
  created_at: number;
}

const MAX_LINE_QTY = 10_000;
const MAX_MESSAGE = 2000;
const MAX_NOTES = 1000;

const token = () => crypto.randomUUID();

// ------------------------------------------------------------------ loading + rules

async function loadDeal(db: D1Database, id: number) {
  return db.prepare('SELECT * FROM deals WHERE id = ?').bind(id).first<DealRow>();
}

async function activeLines(db: D1Database, dealId: number) {
  const { results } = await db.prepare('SELECT * FROM deal_lines WHERE deal_id = ? AND removed_at IS NULL ORDER BY id').bind(dealId).all<LineRow>();
  return results;
}

const sideOf = (d: DealRow, userId: number): Side | null => (d.buyer_id === userId ? 'buyer' : d.seller_id === userId ? 'seller' : null);

/** The deal and the actor's side. Sellers never see a buyer's cart. */
async function participant(db: D1Database, dealId: number, actor: Actor) {
  const deal = Number.isInteger(dealId) ? await loadDeal(db, dealId) : null;
  const side = deal && sideOf(deal, actor.id);
  if (!deal || !side || (deal.status === 'cart' && side === 'seller')) throw new DealError(404, 'not_found', 'Deal not found.');
  return { deal, side };
}

async function stateOf(db: D1Database, deal: DealRow): Promise<DealState> {
  const [offer, count] = await db.batch([
    db.prepare('SELECT made_by FROM offers WHERE id = ?').bind(deal.live_offer_id ?? -1),
    db.prepare('SELECT count(*) AS n FROM deal_lines WHERE deal_id = ? AND removed_at IS NULL').bind(deal.id),
  ]);
  const by = (offer!.results[0] as { made_by: number } | undefined)?.made_by;
  return {
    status: deal.status,
    liveOfferBy: by == null ? null : by === deal.buyer_id ? 'buyer' : 'seller',
    fulfilmentMethod: deal.fulfilment_method,
    lineCount: (count!.results[0] as { n: number }).n,
  };
}

function assertCan(action: DealAction, state: DealState, side: Side) {
  const reason = denyReason(action, state, side);
  if (reason) throw new DealError(409, 'not_allowed', reason);
}

/** SET fragment recording activity; bind with bumpArgs. updated_at strictly increases (pollers compare it). */
const BUMP = 'updated_at = MAX(?, updated_at + 1), last_activity_at = ?, last_activity_by = ?';
const bumpArgs = (now: number, actor: Actor) => [now, now, actor.id];

function eventStmt(db: D1Database, dealId: number, actor: Actor | null, kind: string, data: Record<string, unknown>, now: number) {
  return db
    .prepare('INSERT INTO deal_events (deal_id, actor_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(dealId, actor?.id ?? null, kind, JSON.stringify(data), now);
}

/**
 * Event written only if this request's guarded UPDATE won: the UPDATE stamps a
 * fresh token into deals.agree_token (used as a per-operation token) and the
 * event checks for it. Prevents events from requests that lost a race.
 */
function guardedEvent(db: D1Database, dealId: number, actor: Actor, kind: string, data: Record<string, unknown>, now: number, tok: string) {
  return db
    .prepare(
      `INSERT INTO deal_events (deal_id, actor_id, kind, data, created_at)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM deals WHERE id = ? AND agree_token = ?)`,
    )
    .bind(dealId, actor.id, kind, JSON.stringify(data), now, dealId, tok);
}

function checkQty(q: unknown): number {
  const n = Number(q);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LINE_QTY) throw new DealError(422, 'invalid_quantity', 'Quantity must be a whole number, 1 or more.');
  return n;
}

function checkMoney(v: unknown, what: string): number {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isInteger(n) || n < 0 || n > LIMITS.maxPrice) {
    throw new DealError(422, 'invalid_amount', `Enter a valid ${what}.`);
  }
  return n;
}

// ------------------------------------------------------------------ pricing a line

interface Priced {
  sellerId: number;
  title: string;
  available: number;
  listUnitPrice: number | null;
}

async function priceItem(db: D1Database, itemId: number, qty: number, activeSellers: ActiveSellers, requireListed: boolean): Promise<Priced> {
  const row = await db
    .prepare(
      `SELECT i.id, i.seller_id, i.title, i.quantity, i.price, i.status,
              (u.disabled = 0 AND (u.email IN (SELECT email FROM allowlist) OR lower(u.email) IN (SELECT value FROM json_each(?)))) AS active
         FROM items i JOIN users u ON u.id = i.seller_id WHERE i.id = ?`,
    )
    .bind(activeSellers, itemId)
    .first<{ seller_id: number; title: string; quantity: number; price: number | null; status: string; active: number }>();
  if (!row || (requireListed && (row.status !== 'listed' || row.active !== 1))) throw new DealError(404, 'not_found', 'That item is not available.');
  const tiers = await loadTiers(db, [itemId]);
  return {
    sellerId: row.seller_id,
    title: row.title,
    available: row.quantity,
    listUnitPrice: unitPriceFor({ price: row.price, tiers: tiers.get(itemId) ?? [] }, qty),
  };
}

async function priceBundle(db: D1Database, bundleId: number, activeSellers: ActiveSellers, requireListed: boolean): Promise<Priced> {
  const [b] = await loadBundles(db, [bundleId]);
  if (!b) throw new DealError(404, 'not_found', 'That bundle is not available.');
  if (requireListed) {
    const ok = await db
      .prepare(
        `SELECT (u.disabled = 0 AND (u.email IN (SELECT email FROM allowlist) OR lower(u.email) IN (SELECT value FROM json_each(?)))) AS active
           FROM users u WHERE u.id = ?`,
      )
      .bind(activeSellers, b.seller.id)
      .first<{ active: number }>();
    if (b.status !== 'listed' || ok?.active !== 1) throw new DealError(404, 'not_found', 'That bundle is not available.');
  }
  if (b.price == null) throw new DealError(409, 'no_price', 'This bundle has no price right now.');
  return { sellerId: b.seller.id, title: b.title, available: b.available, listUnitPrice: b.price };
}

function checkStock(p: Priced, qty: number) {
  if (qty > p.available) {
    throw new DealError(409, 'not_enough_stock', p.available > 0 ? `Only ${p.available} of "${p.title}" available.` : `"${p.title}" is out of stock.`);
  }
}

// ------------------------------------------------------------------ cart

export interface AddInput {
  itemId?: unknown;
  bundleId?: unknown;
  quantity?: unknown;
  proposedUnitPrice?: unknown;
}

/** Adds to (or creates) the buyer's open cart with that seller. Returns the deal id. */
export async function addToCart(db: D1Database, actor: Actor, input: AddInput, activeSellers: ActiveSellers, now = Date.now()): Promise<number> {
  const qtyToAdd = checkQty(input.quantity ?? 1);
  const isItem = input.itemId != null;
  const refId = Number(isItem ? input.itemId : input.bundleId);
  if (!Number.isInteger(refId)) throw new DealError(400, 'bad_request', 'Expected itemId or bundleId.');
  const proposed = input.proposedUnitPrice == null || input.proposedUnitPrice === '' ? null : checkMoney(input.proposedUnitPrice, 'price');

  const first = isItem ? await priceItem(db, refId, qtyToAdd, activeSellers, true) : await priceBundle(db, refId, activeSellers, true);
  if (first.sellerId === actor.id) throw new DealError(422, 'own_listing', "That's your own listing.");

  await db
    .prepare(
      `INSERT OR IGNORE INTO deals (buyer_id, seller_id, status, last_activity_at, last_activity_by, created_at, updated_at)
       VALUES (?, ?, 'cart', ?, ?, ?, ?)`,
    )
    .bind(actor.id, first.sellerId, now, actor.id, now, now)
    .run();
  const deal = await db
    .prepare(`SELECT id FROM deals WHERE buyer_id = ? AND seller_id = ? AND status = 'cart'`)
    .bind(actor.id, first.sellerId)
    .first<{ id: number }>();
  const dealId = deal!.id;

  const existing = await db
    .prepare(`SELECT * FROM deal_lines WHERE deal_id = ? AND ${isItem ? 'item_id' : 'bundle_id'} = ? AND removed_at IS NULL`)
    .bind(dealId, refId)
    .first<LineRow>();
  const qty = (existing?.quantity ?? 0) + qtyToAdd;
  // Re-price at the combined quantity (tiers) and re-check stock.
  const priced = isItem ? await priceItem(db, refId, qty, activeSellers, true) : first;
  checkStock(priced, qty);
  const finalProposed = proposed ?? existing?.proposed_unit_price ?? null;
  if (priced.listUnitPrice == null && finalProposed == null) {
    throw new DealError(422, 'price_required', 'This item has no asking price. Enter the price you would pay.');
  }

  const write = existing
    ? db
        .prepare('UPDATE deal_lines SET quantity = ?, list_unit_price = ?, proposed_unit_price = ?, updated_at = ? WHERE id = ?')
        .bind(qty, priced.listUnitPrice, finalProposed, now, existing.id)
    : db
        .prepare(
          `INSERT INTO deal_lines (deal_id, item_id, bundle_id, quantity, list_unit_price, proposed_unit_price, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(dealId, isItem ? refId : null, isItem ? null : refId, qty, priced.listUnitPrice, finalProposed, now, now);
  await db.batch([write, db.prepare(`UPDATE deals SET ${BUMP} WHERE id = ?`).bind(...bumpArgs(now, actor), dealId)]);
  return dealId;
}

/**
 * Changes a line's quantity and/or the buyer's proposed unit price. Outside
 * the cart this voids the live offer (the cart it priced no longer exists).
 */
export async function updateLine(
  db: D1Database,
  actor: Actor,
  dealId: number,
  lineId: number,
  input: { quantity?: unknown; proposedUnitPrice?: unknown },
  activeSellers: ActiveSellers,
  now = Date.now(),
) {
  const { deal, side } = await participant(db, dealId, actor);
  const state = await stateOf(db, deal);
  assertCan('edit_lines', state, side);
  const line = await db.prepare('SELECT * FROM deal_lines WHERE id = ? AND deal_id = ? AND removed_at IS NULL').bind(lineId, dealId).first<LineRow>();
  if (!line) throw new DealError(404, 'not_found', 'Line not found.');

  let qty = line.quantity;
  let list = line.list_unit_price;
  let proposed = line.proposed_unit_price;
  if (input.proposedUnitPrice !== undefined) {
    if (side !== 'buyer') throw new DealError(409, 'not_allowed', 'Only the buyer proposes line prices. Counter with an offer instead.');
    proposed = input.proposedUnitPrice === null || input.proposedUnitPrice === '' ? null : checkMoney(input.proposedUnitPrice, 'price');
  }
  if (input.quantity !== undefined) {
    qty = checkQty(input.quantity);
    // Snapshot again at the new quantity: tier pricing depends on it.
    const priced = line.item_id != null ? await priceItem(db, line.item_id, qty, activeSellers, false) : await priceBundle(db, line.bundle_id!, activeSellers, false);
    if (qty > line.quantity) checkStock(priced, qty);
    list = priced.listUnitPrice;
  }
  if (list == null && proposed == null) throw new DealError(422, 'price_required', 'This line has no asking price. Enter the price you would pay.');
  if (qty === line.quantity && list === line.list_unit_price && proposed === line.proposed_unit_price) return;

  const stmts = [
    db.prepare('UPDATE deal_lines SET quantity = ?, list_unit_price = ?, proposed_unit_price = ?, updated_at = ? WHERE id = ?').bind(qty, list, proposed, now, line.id),
    ...voidAndBump(db, deal, state, actor, now),
  ];
  if (deal.status !== 'cart') stmts.push(eventStmt(db, dealId, actor, 'line_changed', { lineId, from: line.quantity, to: qty, proposed }, now));
  await db.batch(stmts);
}

/** Soft-removes a line. The seller can drop lines they can no longer supply. */
export async function removeLine(db: D1Database, actor: Actor, dealId: number, lineId: number, now = Date.now()) {
  const { deal, side } = await participant(db, dealId, actor);
  const state = await stateOf(db, deal);
  assertCan('edit_lines', state, side);
  const res = await db
    .prepare('UPDATE deal_lines SET removed_at = ?, removed_by = ?, updated_at = ? WHERE id = ? AND deal_id = ? AND removed_at IS NULL')
    .bind(now, actor.id, now, lineId, dealId)
    .run();
  if (!res.meta.changes) throw new DealError(404, 'not_found', 'Line not found.');
  const stmts = voidAndBump(db, deal, state, actor, now);
  if (deal.status !== 'cart') stmts.push(eventStmt(db, dealId, actor, 'line_removed', { lineId }, now));
  await db.batch(stmts);
}

/** After a cart edit: drop the live offer (recorded as an event) and move submitted → negotiating. */
function voidAndBump(db: D1Database, deal: DealRow, state: DealState, actor: Actor, now: number) {
  if (deal.status === 'cart') return [db.prepare(`UPDATE deals SET ${BUMP} WHERE id = ?`).bind(...bumpArgs(now, actor), deal.id)];
  const stmts = [
    db
      .prepare(`UPDATE deals SET live_offer_id = NULL, status = ?, ${BUMP} WHERE id = ?`)
      .bind(nextStatus('edit_lines', state), ...bumpArgs(now, actor), deal.id),
  ];
  if (deal.live_offer_id) stmts.push(eventStmt(db, deal.id, actor, 'offer_voided', { offerId: deal.live_offer_id }, now));
  return stmts;
}

// ------------------------------------------------------------------ offers

/** Buyer sends the cart with an opening offer (defaults to the proposed total). */
export async function submitCart(
  db: D1Database,
  actor: Actor,
  dealId: number,
  input: { amount?: unknown; message?: unknown },
  activeSellers: ActiveSellers,
  now = Date.now(),
) {
  const { deal, side } = await participant(db, dealId, actor);
  assertCan('submit', await stateOf(db, deal), side);
  const lines = await activeLines(db, dealId);
  for (const l of lines) {
    const p = l.item_id != null ? await priceItem(db, l.item_id, l.quantity, activeSellers, true) : await priceBundle(db, l.bundle_id!, activeSellers, true);
    checkStock(p, l.quantity);
  }
  const totals = cartTotals(lines.map((l) => ({ quantity: l.quantity, listUnitPrice: l.list_unit_price, proposedUnitPrice: l.proposed_unit_price })));
  const amount = input.amount == null || input.amount === '' ? totals.proposedTotal : checkMoney(input.amount, 'offer');
  if (amount == null) throw new DealError(422, 'price_required', 'Enter a price for every make-an-offer item.');
  const message = cleanMessage(input.message, true);

  const tok = token();
  const [insert, update] = await db.batch([
    db
      .prepare(`INSERT INTO offers (deal_id, made_by, amount, message, created_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM deals WHERE id = ? AND status = 'cart')`)
      .bind(dealId, actor.id, amount, message, now, dealId),
    db
      .prepare(`UPDATE deals SET status = 'submitted', agree_token = ?, live_offer_id = (SELECT MAX(id) FROM offers WHERE deal_id = ?), ${BUMP} WHERE id = ? AND status = 'cart'`)
      .bind(tok, dealId, ...bumpArgs(now, actor), dealId),
    guardedEvent(db, dealId, actor, 'status', { to: 'submitted' }, now, tok),
  ]);
  if (!insert!.meta.changes || !update!.meta.changes) throw new DealError(409, 'conflict', 'The cart changed. Reload and try again.');
}

/** Counter-offer by either side while negotiating. */
export async function makeOffer(db: D1Database, actor: Actor, dealId: number, input: { amount?: unknown; message?: unknown }, now = Date.now()) {
  const { deal, side } = await participant(db, dealId, actor);
  const state = await stateOf(db, deal);
  assertCan('offer', state, side);
  const amount = checkMoney(input.amount, 'offer');
  const message = cleanMessage(input.message, true);
  const to = nextStatus('offer', state);
  const tok = token();

  const stmts = [
    db
      .prepare(
        `INSERT INTO offers (deal_id, made_by, amount, message, created_at)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM deals WHERE id = ? AND status = ?)`,
      )
      .bind(dealId, actor.id, amount, message, now, dealId, deal.status),
    db
      .prepare(`UPDATE deals SET status = ?, agree_token = ?, live_offer_id = (SELECT MAX(id) FROM offers WHERE deal_id = ?), ${BUMP} WHERE id = ? AND status = ?`)
      .bind(to, tok, dealId, ...bumpArgs(now, actor), dealId, deal.status),
  ];
  if (to !== deal.status) stmts.push(guardedEvent(db, dealId, actor, 'status', { to }, now, tok));
  const [insert] = await db.batch(stmts);
  if (!insert!.meta.changes) throw new DealError(409, 'conflict', 'The deal changed. Reload and try again.');
}

// ------------------------------------------------------------------ agreement + stock

interface Move {
  lineId: number;
  bundleId: number | null;
  itemId: number;
  perUnit: number;
  quantity: number;
}

/** Expands lines into per-item stock moves; bundles use their components as they are right now. */
async function computeMoves(db: D1Database, lines: LineRow[]): Promise<Move[]> {
  const moves: Move[] = [];
  const bundleIds = lines.filter((l) => l.bundle_id != null).map((l) => l.bundle_id!);
  const comps = bundleIds.length
    ? (
        await db
          .prepare('SELECT bundle_id, item_id, quantity FROM bundle_items WHERE bundle_id IN (SELECT value FROM json_each(?)) ORDER BY rowid')
          .bind(JSON.stringify(bundleIds))
          .all<{ bundle_id: number; item_id: number; quantity: number }>()
      ).results
    : [];
  for (const l of lines) {
    if (l.item_id != null) {
      moves.push({ lineId: l.id, bundleId: null, itemId: l.item_id, perUnit: 1, quantity: l.quantity });
    } else {
      for (const c of comps.filter((c) => c.bundle_id === l.bundle_id)) {
        moves.push({ lineId: l.id, bundleId: l.bundle_id, itemId: c.item_id, perUnit: c.quantity, quantity: c.quantity * l.quantity });
      }
    }
  }
  return moves;
}

/**
 * Accepts the live offer: in ONE D1 batch (a transaction) it marks the deal
 * agreed, decrements stock for every item (bundles expanded) and records the
 * exact moves. `items.quantity` has CHECK (quantity >= 0), so if another deal
 * took the stock first the whole batch fails and nothing changes. A random
 * agree_token makes the stock writes apply only if this request is the one
 * that moved the deal to agreed (no double decrement on a double accept).
 */
export async function acceptOffer(db: D1Database, actor: Actor, dealId: number, offerId: unknown, now = Date.now()) {
  const { deal, side } = await participant(db, dealId, actor);
  assertCan('accept', await stateOf(db, deal), side);
  if (offerId != null && Number(offerId) !== deal.live_offer_id) {
    throw new DealError(409, 'conflict', 'That offer is no longer the live one. Reload to see the latest.');
  }
  const lines = await activeLines(db, dealId);
  const moves = await computeMoves(db, lines);
  const perItem = new Map<number, number>();
  for (const m of moves) perItem.set(m.itemId, (perItem.get(m.itemId) ?? 0) + m.quantity);

  const t = token();
  const mine = `EXISTS (SELECT 1 FROM deals WHERE id = ${Number(dealId)} AND agree_token = ?)`;
  const stmts = [
    db
      .prepare(
        `UPDATE deals SET status = 'agreed', agreed_total = (SELECT amount FROM offers WHERE id = ?), agree_token = ?, ${BUMP}
          WHERE id = ? AND status IN ('submitted', 'negotiating') AND live_offer_id = ?`,
      )
      .bind(deal.live_offer_id, t, ...bumpArgs(now, actor), dealId, deal.live_offer_id),
    ...[...perItem].map(([itemId, qty]) =>
      db
        .prepare(
          `UPDATE items SET
             quantity = quantity - ?1,
             status = CASE WHEN quantity - ?1 = 0 AND status = 'listed' THEN 'sold_out' ELSE status END,
             sold_out_auto = CASE WHEN quantity - ?1 = 0 AND status = 'listed' THEN 1 ELSE sold_out_auto END,
             updated_at = ?2
           WHERE id = ?3 AND ${mine.replace('?', '?4')}`,
        )
        .bind(qty, now, itemId, t),
    ),
    ...moves.map((m) =>
      db
        .prepare(
          `INSERT INTO deal_stock_moves (deal_id, deal_line_id, bundle_id, item_id, per_unit_qty, quantity, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${mine}`,
        )
        .bind(dealId, m.lineId, m.bundleId, m.itemId, m.perUnit, m.quantity, now, t),
    ),
    db
      .prepare(`INSERT INTO deal_events (deal_id, actor_id, kind, data, created_at) SELECT ?, ?, 'status', ?, ? WHERE ${mine}`)
      .bind(dealId, actor.id, JSON.stringify({ to: 'agreed', offerId: deal.live_offer_id }), now, t),
  ];

  let results: D1Result[];
  try {
    results = await db.batch(stmts);
  } catch (err) {
    if (/CHECK constraint failed/i.test(String((err as Error)?.message ?? err))) {
      throw new DealError(409, 'out_of_stock', await shortageMessage(db, perItem));
    }
    throw err;
  }
  if (!results[0]!.meta.changes) throw new DealError(409, 'conflict', 'The deal changed before you accepted. Reload and try again.');
}

async function shortageMessage(db: D1Database, need: Map<number, number>): Promise<string> {
  const { results } = await db
    .prepare('SELECT id, title, quantity FROM items WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify([...need.keys()]))
    .all<{ id: number; title: string; quantity: number }>();
  const short = results.filter((r) => r.quantity < (need.get(r.id) ?? 0)).map((r) => `${r.title} (need ${need.get(r.id)}, ${r.quantity} left)`);
  return `Not enough stock to agree: ${short.join(', ') || 'stock changed'}. Edit the cart and make a new offer.`;
}

/**
 * Cancels. If stock was taken (agreed / paid), puts back exactly what
 * deal_stock_moves recorded, never the current bundle contents, and flips
 * items that were automatically marked sold out back to listed.
 */
export async function cancelDeal(db: D1Database, actor: Actor, dealId: number, input: { reason?: unknown }, now = Date.now()) {
  const { deal, side } = await participant(db, dealId, actor);
  assertCan('cancel', await stateOf(db, deal), side);
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, MAX_NOTES) || null : null;
  const t = token();
  const mine = `EXISTS (SELECT 1 FROM deals WHERE id = ?1 AND agree_token = ?2)`;
  const stmts = [
    db
      .prepare(`UPDATE deals SET status = 'cancelled', agree_token = ?, ${BUMP} WHERE id = ? AND status = ?`)
      .bind(t, ...bumpArgs(now, actor), dealId, deal.status),
  ];
  if (STOCK_RESERVED.includes(deal.status)) {
    stmts.push(
      db
        .prepare(
          `UPDATE items SET
             quantity = quantity + (SELECT SUM(m.quantity) FROM deal_stock_moves m WHERE m.deal_id = ?1 AND m.item_id = items.id AND m.restored_at IS NULL),
             status = CASE WHEN status = 'sold_out' AND sold_out_auto = 1 THEN 'listed' ELSE status END,
             sold_out_auto = CASE WHEN status = 'sold_out' AND sold_out_auto = 1 THEN 0 ELSE sold_out_auto END,
             updated_at = ?3
           WHERE id IN (SELECT item_id FROM deal_stock_moves WHERE deal_id = ?1 AND restored_at IS NULL) AND ${mine}`,
        )
        .bind(dealId, t, now),
      db.prepare(`UPDATE deal_stock_moves SET restored_at = ?3 WHERE deal_id = ?1 AND restored_at IS NULL AND ${mine}`).bind(dealId, t, now),
    );
  }
  if (deal.status !== 'cart') stmts.push(guardedEvent(db, dealId, actor, 'status', { to: 'cancelled', from: deal.status, reason }, now, t));
  const [res] = await db.batch(stmts);
  if (!res!.meta.changes) throw new DealError(409, 'conflict', 'The deal changed. Reload and try again.');
}

// ------------------------------------------------------------------ after agreement

export async function setFulfilment(db: D1Database, actor: Actor, dealId: number, input: { method?: unknown; notes?: unknown }, now = Date.now()) {
  const { deal, side } = await participant(db, dealId, actor);
  assertCan('set_fulfilment', await stateOf(db, deal), side);
  if (input.method !== 'shipping' && input.method !== 'pickup') throw new DealError(422, 'invalid_method', 'Choose shipping or pickup.');
  const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, MAX_NOTES) || null : null;
  await db.batch([
    db
      .prepare(`UPDATE deals SET fulfilment_method = ?, fulfilment_notes = ?, ${BUMP} WHERE id = ? AND status IN ('agreed', 'paid')`)
      .bind(input.method, notes, ...bumpArgs(now, actor), dealId),
    eventStmt(db, dealId, actor, 'fulfilment', { method: input.method, notes }, now),
  ]);
}

/** mark_paid / mark_fulfilled / complete: one guarded status step plus an event. */
export async function stepStatus(db: D1Database, actor: Actor, dealId: number, action: 'mark_paid' | 'mark_fulfilled' | 'complete', now = Date.now()) {
  const { deal, side } = await participant(db, dealId, actor);
  const state = await stateOf(db, deal);
  assertCan(action, state, side);
  const to = nextStatus(action, state);
  const tok = token();
  const [res] = await db.batch([
    db.prepare(`UPDATE deals SET status = ?, agree_token = ?, ${BUMP} WHERE id = ? AND status = ?`).bind(to, tok, ...bumpArgs(now, actor), dealId, deal.status),
    guardedEvent(db, dealId, actor, 'status', { to }, now, tok),
  ]);
  if (!res!.meta.changes) throw new DealError(409, 'conflict', 'The deal changed. Reload and try again.');
}

function cleanMessage(v: unknown, optional: boolean): string | null {
  if (v == null || v === '') {
    if (optional) return null;
    throw new DealError(422, 'empty_message', 'Write a message.');
  }
  if (typeof v !== 'string') throw new DealError(422, 'invalid_message', 'Message must be text.');
  const s = v.trim();
  if (!s && !optional) throw new DealError(422, 'empty_message', 'Write a message.');
  if (s.length > MAX_MESSAGE) throw new DealError(422, 'message_too_long', `Keep messages under ${MAX_MESSAGE} characters.`);
  return s || null;
}

export async function addMessage(db: D1Database, actor: Actor, dealId: number, body: unknown, now = Date.now()) {
  const { deal, side } = await participant(db, dealId, actor);
  assertCan('message', await stateOf(db, deal), side);
  const text = cleanMessage(body, false)!;
  await db.batch([
    db.prepare('INSERT INTO messages (deal_id, author_id, body, created_at) VALUES (?, ?, ?, ?)').bind(dealId, actor.id, text, now),
    db.prepare(`UPDATE deals SET ${BUMP} WHERE id = ?`).bind(...bumpArgs(now, actor), dealId),
  ]);
}

// ------------------------------------------------------------------ views

async function lineViews(db: D1Database, lines: LineRow[], includeRemoved = false): Promise<DealLineView[]> {
  const itemIds = lines.filter((l) => l.item_id != null).map((l) => l.item_id!);
  const bundleIds = lines.filter((l) => l.bundle_id != null).map((l) => l.bundle_id!);
  const [items, tiers, bundles] = await Promise.all([
    itemIds.length
      ? db
          .prepare(
            `SELECT i.id, i.title, i.quantity, i.price,
                    (SELECT thumb_key FROM item_photos p WHERE p.item_id = i.id ORDER BY p.sort_order, p.id LIMIT 1) AS thumb
               FROM items i WHERE i.id IN (SELECT value FROM json_each(?))`,
          )
          .bind(JSON.stringify(itemIds))
          .all<{ id: number; title: string; quantity: number; price: number | null; thumb: string | null }>()
          .then((r) => new Map(r.results.map((x) => [x.id, x])))
      : new Map(),
    loadTiers(db, itemIds),
    loadBundles(db, bundleIds).then((bs) => new Map(bs.map((b) => [b.id, b]))),
  ]);
  return lines
    .filter((l) => includeRemoved || l.removed_at == null)
    .map((l) => {
      if (l.item_id != null) {
        const it = items.get(l.item_id);
        return {
          id: l.id,
          kind: 'item' as const,
          refId: l.item_id,
          title: it?.title ?? 'Item',
          thumbUrl: it?.thumb ? imgUrl(it.thumb) : null,
          quantity: l.quantity,
          listUnitPrice: l.list_unit_price,
          proposedUnitPrice: l.proposed_unit_price,
          available: it?.quantity ?? 0,
          currentUnitPrice: it ? unitPriceFor({ price: it.price, tiers: tiers.get(l.item_id) ?? [] }, l.quantity) : null,
          removedAt: l.removed_at,
        };
      }
      const b = bundles.get(l.bundle_id!);
      return {
        id: l.id,
        kind: 'bundle' as const,
        refId: l.bundle_id!,
        title: b?.title ?? 'Bundle',
        thumbUrl: b?.coverThumbUrl ?? null,
        quantity: l.quantity,
        listUnitPrice: l.list_unit_price,
        proposedUnitPrice: l.proposed_unit_price,
        available: b?.available ?? 0,
        currentUnitPrice: b?.price ?? null,
        removedAt: l.removed_at,
      };
    });
}

const totalsOf = (lines: DealLineView[]) =>
  cartTotals(lines.filter((l) => l.removedAt == null).map((l) => ({ quantity: l.quantity, listUnitPrice: l.listUnitPrice, proposedUnitPrice: l.proposedUnitPrice })));

export async function getCarts(db: D1Database, actor: Actor): Promise<CartView[]> {
  const { results } = await db
    .prepare(`SELECT d.*, u.name AS seller_name FROM deals d JOIN users u ON u.id = d.seller_id WHERE d.buyer_id = ? AND d.status = 'cart' ORDER BY d.updated_at DESC`)
    .bind(actor.id)
    .all<DealRow & { seller_name: string | null }>();
  const carts: CartView[] = [];
  for (const d of results) {
    const lines = await lineViews(db, await activeLines(db, d.id));
    if (!lines.length) continue;
    carts.push({ dealId: d.id, seller: { id: d.seller_id, name: d.seller_name }, lines, totals: totalsOf(lines), updatedAt: d.updated_at });
  }
  return carts;
}

/** Within the same millisecond an offer comes before the status change it caused. */
const ORDER: Record<TimelineEntry['type'], number> = { offer: 0, message: 1, event: 2 };

/** Full deal for the deal page. Marks it seen for the viewer. Returns null if `since` matches (nothing new). */
export async function getDealView(db: D1Database, actor: Actor, dealId: number, since: number | null, now = Date.now()): Promise<DealView | null> {
  const { deal, side } = await participant(db, dealId, actor);
  if (since != null && since === deal.updated_at) return null;
  await db.prepare(`UPDATE deals SET ${side === 'buyer' ? 'buyer_seen_at' : 'seller_seen_at'} = ? WHERE id = ?`).bind(now, dealId).run();

  const [users, lineRows, offers, messages, events, moves] = await db.batch([
    db.prepare('SELECT id, name, payment_note FROM users WHERE id IN (?, ?)').bind(deal.buyer_id, deal.seller_id),
    db.prepare('SELECT * FROM deal_lines WHERE deal_id = ? ORDER BY id').bind(dealId),
    db.prepare('SELECT * FROM offers WHERE deal_id = ? ORDER BY id').bind(dealId),
    db.prepare('SELECT * FROM messages WHERE deal_id = ? ORDER BY id').bind(dealId),
    db.prepare('SELECT * FROM deal_events WHERE deal_id = ? ORDER BY id').bind(dealId),
    db
      .prepare(
        `SELECT m.*, i.title FROM deal_stock_moves m JOIN items i ON i.id = m.item_id WHERE m.deal_id = ? ORDER BY m.id`,
      )
      .bind(dealId),
  ]);
  const u = new Map((users!.results as { id: number; name: string | null; payment_note: string | null }[]).map((r) => [r.id, r]));
  const who = (id: number | null): Side | null => (id == null ? null : id === deal.buyer_id ? 'buyer' : 'seller');
  const lines = await lineViews(db, lineRows!.results as LineRow[], true);
  const evs = events!.results as { id: number; actor_id: number | null; kind: string; data: string; created_at: number }[];
  const voided = new Set(evs.filter((e) => e.kind === 'offer_voided').map((e) => (JSON.parse(e.data) as { offerId: number }).offerId));
  const accepted = deal.agreed_total != null ? deal.live_offer_id : null;

  const offerViews = (offers!.results as { id: number; made_by: number; amount: number; message: string | null; created_at: number }[]).map(
    (o): OfferView => ({ id: o.id, by: who(o.made_by)!, amount: o.amount, message: o.message, createdAt: o.created_at }),
  );
  const timeline: TimelineEntry[] = [
    ...offerViews.map(
      (o): TimelineEntry => ({
        type: 'offer',
        at: o.createdAt,
        id: `o${o.id}`,
        by: o.by,
        offer: o,
        state: o.id === accepted ? 'accepted' : voided.has(o.id) ? 'voided' : o.id === deal.live_offer_id ? 'live' : 'superseded',
      }),
    ),
    ...(messages!.results as { id: number; author_id: number; body: string; created_at: number }[]).map(
      (m): TimelineEntry => ({ type: 'message', at: m.created_at, id: `m${m.id}`, by: who(m.author_id)!, body: m.body }),
    ),
    ...evs.map((e): TimelineEntry => ({ type: 'event', at: e.created_at, id: `e${e.id}`, by: who(e.actor_id), kind: e.kind, data: JSON.parse(e.data) })),
  ].sort((a, b) => a.at - b.at || ORDER[a.type] - ORDER[b.type] || Number(a.id.slice(1)) - Number(b.id.slice(1)));

  const reserved: ReservedView[] = (moves!.results as { deal_line_id: number; bundle_id: number | null; item_id: number; title: string; per_unit_qty: number; quantity: number; restored_at: number | null }[]).map((m) => ({
    lineId: m.deal_line_id,
    bundleId: m.bundle_id,
    itemId: m.item_id,
    title: m.title,
    perUnit: m.per_unit_qty,
    quantity: m.quantity,
    restoredAt: m.restored_at,
  }));

  const agreedOrLater = ['agreed', 'paid', 'fulfilled', 'completed'].includes(deal.status);
  return {
    id: deal.id,
    status: deal.status,
    me: side,
    buyer: { id: deal.buyer_id, name: u.get(deal.buyer_id)?.name ?? null },
    seller: { id: deal.seller_id, name: u.get(deal.seller_id)?.name ?? null },
    lines,
    totals: totalsOf(lines),
    liveOffer: offerViews.find((o) => o.id === deal.live_offer_id) ?? null,
    agreedTotal: deal.agreed_total,
    fulfilmentMethod: deal.fulfilment_method,
    fulfilmentNotes: deal.fulfilment_notes,
    paymentNote: agreedOrLater || side === 'seller' ? (u.get(deal.seller_id)?.payment_note ?? null) : null,
    reserved,
    timeline,
    updatedAt: deal.updated_at,
  };
}

/** Deals list (carts excluded) with the "needs you" flag. */
export async function listDeals(db: D1Database, actor: Actor, as: Side): Promise<DealSummary[]> {
  const mineCol = as === 'buyer' ? 'buyer_id' : 'seller_id';
  const otherCol = as === 'buyer' ? 'seller_id' : 'buyer_id';
  const seenCol = as === 'buyer' ? 'buyer_seen_at' : 'seller_seen_at';
  const { results } = await db
    .prepare(
      `SELECT d.*, u.name AS other_name, o.made_by AS offer_by, o.amount AS offer_amount,
              (SELECT count(*) FROM deal_lines l WHERE l.deal_id = d.id AND l.removed_at IS NULL) AS line_count
         FROM deals d JOIN users u ON u.id = d.${otherCol}
         LEFT JOIN offers o ON o.id = d.live_offer_id
        WHERE d.${mineCol} = ? AND d.status <> 'cart'
        ORDER BY d.last_activity_at DESC LIMIT 200`,
    )
    .bind(actor.id)
    .all<DealRow & { other_name: string | null; offer_by: number | null; offer_amount: number | null; line_count: number }>();

  const out: DealSummary[] = [];
  for (const d of results) {
    const lines = await lineViews(db, await activeLines(db, d.id));
    const state: DealState = {
      status: d.status,
      liveOfferBy: d.offer_by == null ? null : d.offer_by === d.buyer_id ? 'buyer' : 'seller',
      fulfilmentMethod: d.fulfilment_method,
      lineCount: d.line_count,
    };
    const unseen = d.last_activity_by !== actor.id && d.last_activity_at > (d[seenCol] as number);
    const amount = d.agreed_total ?? d.offer_amount ?? totalsOf(lines).proposedTotal;
    out.push({
      id: d.id,
      status: d.status,
      me: as,
      other: { id: d[otherCol] as number, name: d.other_name },
      lineCount: d.line_count,
      thumbs: lines.map((l) => l.thumbUrl).filter((x): x is string => !!x).slice(0, 3),
      amount,
      amountLabel: d.agreed_total != null ? 'agreed' : d.offer_amount != null ? 'offer' : 'proposed',
      needsAttention: unseen || isMyTurn(state, as),
      lastActivityAt: d.last_activity_at,
    });
  }
  return out;
}

/** Header badges: deals needing the user, and units in their carts. */
export async function attention(db: D1Database, actor: Actor) {
  const [deals, cart] = await db.batch([
    db
      .prepare(
        `SELECT d.*, o.made_by AS offer_by FROM deals d LEFT JOIN offers o ON o.id = d.live_offer_id
          WHERE (d.buyer_id = ?1 OR d.seller_id = ?1) AND d.status NOT IN ('cart', 'completed', 'cancelled')
             OR ((d.buyer_id = ?1 OR d.seller_id = ?1) AND d.status IN ('completed', 'cancelled') AND d.last_activity_by <> ?1
                 AND d.last_activity_at > CASE WHEN d.buyer_id = ?1 THEN d.buyer_seen_at ELSE d.seller_seen_at END)`,
      )
      .bind(actor.id),
    db
      .prepare(
        `SELECT COALESCE(SUM(l.quantity), 0) AS n FROM deal_lines l JOIN deals d ON d.id = l.deal_id
          WHERE d.buyer_id = ? AND d.status = 'cart' AND l.removed_at IS NULL`,
      )
      .bind(actor.id),
  ]);
  let count = 0;
  for (const d of deals!.results as (DealRow & { offer_by: number | null })[]) {
    const side: Side = d.buyer_id === actor.id ? 'buyer' : 'seller';
    const seen = side === 'buyer' ? d.buyer_seen_at : d.seller_seen_at;
    const unseen = d.last_activity_by !== actor.id && d.last_activity_at > seen;
    const state: DealState = {
      status: d.status,
      liveOfferBy: d.offer_by == null ? null : d.offer_by === d.buyer_id ? 'buyer' : 'seller',
      fulfilmentMethod: d.fulfilment_method,
      lineCount: 1,
    };
    if (unseen || isMyTurn(state, side)) count++;
  }
  return { deals: count, cartUnits: (cart!.results[0] as { n: number }).n };
}
