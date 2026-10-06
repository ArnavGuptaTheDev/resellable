/**
 * Deal flow against real SQLite (same SQL the Worker runs on D1): agreement
 * reserves stock atomically, concurrent agreements can't oversell, and cancel
 * restores exactly what deal_stock_moves recorded.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DealError,
  acceptOffer,
  addMessage,
  addToCart,
  cancelDeal,
  getDealView,
  makeOffer,
  removeLine,
  setFulfilment,
  stepStatus,
  submitCart,
  updateLine,
} from '../worker/lib/deals';
import { createTestDb } from './helpers/d1';

const SELLER = { id: 1 };
const ALICE = { id: 2 };
const BOB = { id: 3 };
const ACTIVE = '[]'; // no env superusers in tests; everyone is on the allowlist
const ESP = 10;
const SENSOR = 11;
const OFFER_ITEM = 12;
const KIT = 20; // bundle: 1× ESP + 2× SENSOR, 10% off

let db: D1Database;
let raw: ReturnType<typeof createTestDb>['raw'];

const q = <T = Record<string, unknown>>(sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).get(...args) as T;
const stock = (id: number) => q<{ quantity: number; status: string; sold_out_auto: number }>('SELECT quantity, status, sold_out_auto FROM items WHERE id = ?', id);
const dealStatus = (id: number) => q<{ status: string; live_offer_id: number | null; agreed_total: number | null }>('SELECT status, live_offer_id, agreed_total FROM deals WHERE id = ?', id);
const moves = (id: number) => raw.prepare('SELECT item_id, bundle_id, per_unit_qty, quantity, restored_at FROM deal_stock_moves WHERE deal_id = ? ORDER BY id').all(id) as { item_id: number; bundle_id: number | null; per_unit_qty: number; quantity: number; restored_at: number | null }[];

async function errorOf(p: Promise<unknown>): Promise<DealError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DealError) return e;
    throw e;
  }
  throw new Error('expected a DealError');
}

/** Buyer adds lines and submits with the default opening offer. */
async function submitted(buyer: { id: number }, lines: { itemId?: number; bundleId?: number; quantity: number; proposedUnitPrice?: number }[]) {
  let dealId = 0;
  for (const l of lines) dealId = await addToCart(db, buyer, l, ACTIVE);
  await submitCart(db, buyer, dealId, {}, ACTIVE);
  return dealId;
}

beforeEach(() => {
  ({ d1: db, raw } = createTestDb());
  raw.exec(`
    INSERT INTO users (id, email, name, created_at) VALUES
      (1, 'seller@example.com', 'Seller', 0), (2, 'alice@example.com', 'Alice', 0), (3, 'bob@example.com', 'Bob', 0);
    INSERT INTO allowlist (email, role, created_at) VALUES
      ('seller@example.com', 'seller', 0), ('alice@example.com', 'buyer', 0), ('bob@example.com', 'buyer', 0);
    INSERT INTO items (id, seller_id, title, quantity, price, status, created_at, updated_at) VALUES
      (10, 1, 'ESP32', 4, 35000, 'listed', 0, 0),
      (11, 1, 'Sensor', 10, 6000, 'listed', 0, 0),
      (12, 1, 'Mystery box', 3, NULL, 'listed', 0, 0),
      (13, 1, 'Spare', 5, 1000, 'listed', 0, 0);
    INSERT INTO item_price_tiers (item_id, min_qty, unit_price) VALUES (10, 3, 30000);
    INSERT INTO bundles (id, seller_id, title, pricing_mode, percent_off, status, created_at, updated_at)
      VALUES (20, 1, 'Kit', 'percent_off', 10, 'listed', 0, 0);
    INSERT INTO bundle_items (bundle_id, item_id, quantity) VALUES (20, 10, 1), (20, 11, 2);
  `);
});

describe('cart', () => {
  it('snapshots tier pricing and re-snapshots on quantity change', async () => {
    const id = await addToCart(db, ALICE, { itemId: ESP, quantity: 2 }, ACTIVE);
    const lineId = q<{ id: number }>('SELECT id FROM deal_lines WHERE deal_id = ?', id).id;
    expect(q('SELECT list_unit_price AS p FROM deal_lines WHERE id = ?', lineId)).toEqual({ p: 35000 });
    await updateLine(db, ALICE, id, lineId, { quantity: 3 }, ACTIVE);
    expect(q('SELECT list_unit_price AS p FROM deal_lines WHERE id = ?', lineId)).toEqual({ p: 30000 });
  });

  it('adding the same item again merges into one line', async () => {
    const id = await addToCart(db, ALICE, { itemId: SENSOR, quantity: 1 }, ACTIVE);
    await addToCart(db, ALICE, { itemId: SENSOR, quantity: 2 }, ACTIVE);
    expect(q('SELECT count(*) AS n, SUM(quantity) AS qty FROM deal_lines WHERE deal_id = ?', id)).toEqual({ n: 1, qty: 3 });
  });

  it('one open cart per buyer and seller', async () => {
    const a = await addToCart(db, ALICE, { itemId: SENSOR, quantity: 1 }, ACTIVE);
    const b = await addToCart(db, ALICE, { itemId: ESP, quantity: 1 }, ACTIVE);
    expect(a).toBe(b);
  });

  it('make-an-offer items need a proposed price; own items and overselling are refused', async () => {
    expect((await errorOf(addToCart(db, ALICE, { itemId: OFFER_ITEM, quantity: 1 }, ACTIVE))).code).toBe('price_required');
    await addToCart(db, ALICE, { itemId: OFFER_ITEM, quantity: 1, proposedUnitPrice: 50000 }, ACTIVE);
    expect((await errorOf(addToCart(db, SELLER, { itemId: ESP, quantity: 1 }, ACTIVE))).code).toBe('own_listing');
    expect((await errorOf(addToCart(db, ALICE, { itemId: ESP, quantity: 5 }, ACTIVE))).code).toBe('not_enough_stock');
  });

  it('bundles are priced from components (tiers + percent off)', async () => {
    const id = await addToCart(db, ALICE, { bundleId: KIT, quantity: 1 }, ACTIVE);
    // (35000 + 2 × 6000) × 0.9
    expect(q('SELECT list_unit_price AS p FROM deal_lines WHERE deal_id = ?', id)).toEqual({ p: 42300 });
  });

  it('the seller cannot see a buyer’s cart', async () => {
    const id = await addToCart(db, ALICE, { itemId: ESP, quantity: 1 }, ACTIVE);
    expect((await errorOf(getDealView(db, SELLER, id, null))).status).toBe(404);
  });
});

describe('negotiation', () => {
  it('submit → counter → accept, only by the other party', async () => {
    const id = await submitted(ALICE, [{ itemId: ESP, quantity: 2 }]);
    expect(dealStatus(id)).toMatchObject({ status: 'submitted' });
    expect(q('SELECT amount FROM offers WHERE deal_id = ?', id)).toEqual({ amount: 70000 });

    // Buyer can't accept their own opening offer.
    expect((await errorOf(acceptOffer(db, ALICE, id, undefined))).code).toBe('not_allowed');

    await makeOffer(db, SELLER, id, { amount: 68000, message: 'Best I can do' });
    expect(dealStatus(id)).toMatchObject({ status: 'negotiating' });
    expect((await errorOf(acceptOffer(db, SELLER, id, undefined))).code).toBe('not_allowed');

    await acceptOffer(db, ALICE, id, undefined);
    expect(dealStatus(id)).toMatchObject({ status: 'agreed', agreed_total: 68000 });
    expect(stock(ESP).quantity).toBe(2);
    expect(moves(id)).toEqual([{ item_id: ESP, bundle_id: null, per_unit_qty: 1, quantity: 2, restored_at: null }]);
  });

  it('accepting a stale offer id is refused', async () => {
    const id = await submitted(ALICE, [{ itemId: SENSOR, quantity: 1 }]);
    const opening = dealStatus(id).live_offer_id!;
    await makeOffer(db, ALICE, id, { amount: 5000 });
    expect((await errorOf(acceptOffer(db, SELLER, id, opening))).code).toBe('conflict');
  });

  it('editing the cart while negotiating voids the live offer', async () => {
    const id = await submitted(ALICE, [{ itemId: ESP, quantity: 1 }, { itemId: SENSOR, quantity: 2 }]);
    const sensorLine = q<{ id: number }>('SELECT id FROM deal_lines WHERE deal_id = ? AND item_id = ?', id, SENSOR).id;
    await removeLine(db, SELLER, id, sensorLine); // seller can no longer supply it
    expect(dealStatus(id)).toMatchObject({ status: 'negotiating', live_offer_id: null });
    expect((await errorOf(acceptOffer(db, SELLER, id, undefined))).message).toMatch(/no live offer/i);
    const view = (await getDealView(db, ALICE, id, null))!;
    expect(view.timeline.some((e) => e.type === 'event' && e.kind === 'offer_voided')).toBe(true);
    expect(view.timeline.find((e) => e.type === 'offer')).toMatchObject({ state: 'voided' });
    // A new offer makes it acceptable again.
    await makeOffer(db, ALICE, id, { amount: 34000 });
    await acceptOffer(db, SELLER, id, undefined);
    expect(stock(SENSOR).quantity).toBe(10); // removed line took nothing
    expect(stock(ESP).quantity).toBe(3);
  });

  it('only the buyer proposes line prices', async () => {
    const id = await submitted(ALICE, [{ itemId: SENSOR, quantity: 1 }]);
    const line = q<{ id: number }>('SELECT id FROM deal_lines WHERE deal_id = ?', id).id;
    expect((await errorOf(updateLine(db, SELLER, id, line, { proposedUnitPrice: 1 }, ACTIVE))).code).toBe('not_allowed');
  });
});

describe('stock race on agreement', () => {
  it('two deals for the last units: exactly one agrees, nothing is oversold', async () => {
    const a = await submitted(ALICE, [{ itemId: ESP, quantity: 3 }]);
    const b = await submitted(BOB, [{ itemId: ESP, quantity: 3 }]);
    // Both pass every pre-check (4 in stock ≥ 3) before either batch runs.
    const results = await Promise.allSettled([acceptOffer(db, SELLER, a, undefined), acceptOffer(db, SELLER, b, undefined)]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBeInstanceOf(DealError);
    expect(failed[0]!.reason.code).toBe('out_of_stock');
    expect(failed[0]!.reason.message).toMatch(/ESP32 \(need 3, 1 left\)/);

    expect(stock(ESP)).toMatchObject({ quantity: 1, status: 'listed' });
    const loser = results[0]!.status === 'rejected' ? a : b;
    expect(dealStatus(loser).status).toBe('submitted'); // untouched
    expect(moves(loser)).toEqual([]);
    expect(q('SELECT count(*) AS n FROM deal_events WHERE deal_id = ? AND kind = ?', loser, 'status')).toEqual({ n: 1 }); // only "submitted"
  });

  it('a double accept of the same deal decrements stock once', async () => {
    const id = await submitted(ALICE, [{ itemId: SENSOR, quantity: 4 }]);
    const results = await Promise.allSettled([acceptOffer(db, SELLER, id, undefined), acceptOffer(db, SELLER, id, undefined)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(stock(SENSOR).quantity).toBe(6);
    expect(moves(id)).toHaveLength(1);
  });

  it('a short bundle component fails the whole agreement atomically', async () => {
    raw.exec('UPDATE items SET quantity = 3 WHERE id = 11'); // kit ×2 needs 4 sensors
    const id = await addToCart(db, ALICE, { bundleId: KIT, quantity: 1 }, ACTIVE);
    await submitCart(db, ALICE, id, {}, ACTIVE);
    const line = q<{ id: number }>('SELECT id FROM deal_lines WHERE deal_id = ?', id).id;
    raw.exec('UPDATE items SET quantity = 4 WHERE id = 11');
    await updateLine(db, ALICE, id, line, { quantity: 2 }, ACTIVE);
    await makeOffer(db, ALICE, id, { amount: 80000 });
    raw.exec('UPDATE items SET quantity = 3 WHERE id = 11'); // someone else bought one meanwhile
    expect((await errorOf(acceptOffer(db, SELLER, id, undefined))).code).toBe('out_of_stock');
    expect(stock(ESP).quantity).toBe(4); // ESP decrement rolled back too
    expect(stock(SENSOR).quantity).toBe(3);
    expect(moves(id)).toEqual([]);
  });

  it('reaching zero marks the item sold out automatically', async () => {
    const id = await submitted(ALICE, [{ itemId: ESP, quantity: 4 }]);
    await acceptOffer(db, SELLER, id, undefined);
    expect(stock(ESP)).toEqual({ quantity: 0, status: 'sold_out', sold_out_auto: 1 });
  });
});

describe('cancel restores stock from deal_stock_moves', () => {
  it('restores and flips auto sold-out items back to listed', async () => {
    const id = await submitted(ALICE, [{ itemId: ESP, quantity: 4 }]);
    await acceptOffer(db, SELLER, id, undefined);
    await cancelDeal(db, ALICE, id, { reason: 'changed my mind' });
    expect(dealStatus(id).status).toBe('cancelled');
    expect(stock(ESP)).toEqual({ quantity: 4, status: 'listed', sold_out_auto: 0 });
    expect(moves(id)[0]!.restored_at).not.toBeNull();
    // A second cancel is refused and restores nothing.
    expect((await errorOf(cancelDeal(db, SELLER, id, {}))).code).toBe('not_allowed');
    expect(stock(ESP).quantity).toBe(4);
  });

  it('keeps a manual sold-out status', async () => {
    const id = await submitted(ALICE, [{ itemId: ESP, quantity: 1 }]);
    await acceptOffer(db, SELLER, id, undefined);
    raw.exec(`UPDATE items SET status = 'sold_out', sold_out_auto = 0 WHERE id = 10`); // seller's choice
    await cancelDeal(db, SELLER, id, {});
    expect(stock(ESP)).toEqual({ quantity: 4, status: 'sold_out', sold_out_auto: 0 });
  });

  it('uses the recorded bundle contents, not the current bundle_items', async () => {
    const id = await addToCart(db, ALICE, { bundleId: KIT, quantity: 2 }, ACTIVE);
    await submitCart(db, ALICE, id, {}, ACTIVE);
    await acceptOffer(db, SELLER, id, undefined);
    expect(moves(id).map(({ restored_at, ...m }) => m)).toEqual([
      { item_id: ESP, bundle_id: KIT, per_unit_qty: 1, quantity: 2 },
      { item_id: SENSOR, bundle_id: KIT, per_unit_qty: 2, quantity: 4 },
    ]);
    expect([stock(ESP).quantity, stock(SENSOR).quantity]).toEqual([2, 6]);

    // Seller reworks the bundle after the deal was agreed.
    raw.exec('DELETE FROM bundle_items WHERE bundle_id = 20; INSERT INTO bundle_items (bundle_id, item_id, quantity) VALUES (20, 13, 3);');

    // Agreed deals show contents from the record.
    const view = (await getDealView(db, ALICE, id, null))!;
    expect(view.reserved.map((r) => [r.title, r.quantity])).toEqual([
      ['ESP32', 2],
      ['Sensor', 4],
    ]);

    await stepStatus(db, SELLER, id, 'mark_paid');
    await cancelDeal(db, SELLER, id, {});
    expect([stock(ESP).quantity, stock(SENSOR).quantity, stock(13).quantity]).toEqual([4, 10, 5]);
  });

  it('cancelling before agreement touches no stock', async () => {
    const id = await submitted(ALICE, [{ itemId: ESP, quantity: 2 }]);
    await cancelDeal(db, SELLER, id, {});
    expect(stock(ESP).quantity).toBe(4);
    expect(moves(id)).toEqual([]);
  });
});

describe('after agreement', () => {
  it('paid → fulfilled needs a fulfilment method; buyer completes; no cancel after fulfilled', async () => {
    const id = await submitted(ALICE, [{ itemId: SENSOR, quantity: 1 }]);
    await acceptOffer(db, SELLER, id, undefined);
    expect((await errorOf(stepStatus(db, ALICE, id, 'mark_paid'))).code).toBe('not_allowed');
    await stepStatus(db, SELLER, id, 'mark_paid');
    expect((await errorOf(stepStatus(db, SELLER, id, 'mark_fulfilled'))).message).toMatch(/shipping or pickup/);
    await setFulfilment(db, ALICE, id, { method: 'pickup', notes: 'Saturday 11am' });
    await stepStatus(db, SELLER, id, 'mark_fulfilled');
    expect((await errorOf(cancelDeal(db, ALICE, id, {}))).code).toBe('not_allowed');
    expect((await errorOf(stepStatus(db, SELLER, id, 'complete'))).code).toBe('not_allowed');
    await stepStatus(db, ALICE, id, 'complete');
    expect(dealStatus(id).status).toBe('completed');
    expect(stock(SENSOR).quantity).toBe(9); // completed deals keep the stock taken
  });

  it('timeline interleaves offers, events and messages in order', async () => {
    const id = await addToCart(db, ALICE, { itemId: SENSOR, quantity: 1 }, ACTIVE, 1000);
    await submitCart(db, ALICE, id, {}, ACTIVE, 2000);
    await addMessage(db, SELLER, id, 'Hi! Still available.', 3000);
    await makeOffer(db, SELLER, id, { amount: 5800 }, 4000);
    await acceptOffer(db, ALICE, id, undefined, 5000);
    const kinds = (await getDealView(db, SELLER, id, null))!.timeline.map((e) =>
      e.type === 'offer' ? `offer:${e.by}:${e.state}` : e.type === 'message' ? `msg:${e.by}` : `${e.kind}:${(e.data as { to?: string }).to}`,
    );
    expect(kinds).toEqual(['offer:buyer:superseded', 'status:submitted', 'msg:seller', 'offer:seller:accepted', 'status:negotiating', 'status:agreed']);
  });
});
