import { Hono, type Context } from 'hono';
import { LIMITS } from '../../shared/config';
import { cleanText } from '../../shared/items';
import { validateBundlePricing, type BundlePricing } from '../../shared/pricing';
import { loadBundles } from '../lib/catalog';
import { apiError, requireRole, requireUser } from '../middleware';
import type { AppEnv } from '../types';

/** Seller-side bundle management. */
const bundles = new Hono<AppEnv>();
bundles.use('*', requireUser, requireRole('seller'));

type Ctx = Context<AppEnv>;

interface BundleInput {
  title?: unknown;
  description?: unknown;
  pricingMode?: unknown;
  fixedPrice?: unknown;
  percentOff?: unknown;
  coverPhotoId?: unknown;
  status?: unknown;
  items?: unknown;
}

interface Line {
  itemId: number;
  quantity: number;
}

function parseLines(v: unknown): Line[] | string {
  if (!Array.isArray(v) || !v.length) return 'Add at least one item.';
  if (v.length > 50) return 'A bundle can have at most 50 different items.';
  const seen = new Set<number>();
  const out: Line[] = [];
  for (const raw of v as { itemId?: unknown; quantity?: unknown }[]) {
    const itemId = Number(raw?.itemId);
    const quantity = Number(raw?.quantity ?? 1);
    if (!Number.isInteger(itemId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
      return 'Each item needs a whole quantity from 1 to 1000.';
    }
    if (seen.has(itemId)) return 'An item appears twice; combine the quantities instead.';
    seen.add(itemId);
    out.push({ itemId, quantity });
  }
  return out;
}

/** Owned, existing items → their prices. Returns an error string if any id isn't the seller's. */
async function ownedPrices(c: Ctx, sellerId: number, ids: number[]): Promise<Map<number, number | null> | string> {
  const { results } = await c.env.DB.prepare('SELECT id, price FROM items WHERE seller_id = ? AND id IN (SELECT value FROM json_each(?))')
    .bind(sellerId, JSON.stringify(ids))
    .all<{ id: number; price: number | null }>();
  if (results.length !== ids.length) return 'A bundle can only contain your own items.';
  return new Map(results.map((r) => [r.id, r.price]));
}

function parsePricing(body: BundleInput, current?: BundlePricing): BundlePricing | string {
  const mode = body.pricingMode ?? current?.mode;
  if (mode === 'fixed') {
    const fixedPrice = body.fixedPrice ?? (current?.mode === 'fixed' ? current.fixedPrice : undefined);
    return { mode, fixedPrice: Number(fixedPrice) };
  }
  if (mode === 'percent_off') {
    const percentOff = body.percentOff ?? (current?.mode === 'percent_off' ? current.percentOff : undefined);
    return { mode, percentOff: Number(percentOff) };
  }
  return 'Choose fixed price or percent off.';
}

async function loadOwnBundle(c: Ctx, id: number) {
  const row = await c.env.DB.prepare('SELECT * FROM bundles WHERE id = ?').bind(id).first<{
    id: number;
    seller_id: number;
    pricing_mode: 'fixed' | 'percent_off';
    fixed_price: number | null;
    percent_off: number | null;
  }>();
  const user = c.get('user');
  if (!row || (row.seller_id !== user.id && user.role !== 'superuser')) return null;
  return row;
}

/** Cover must be a photo of one of the bundle's items. */
async function validCover(c: Ctx, coverPhotoId: unknown, itemIds: number[]): Promise<number | null | string> {
  if (coverPhotoId == null) return null;
  const id = Number(coverPhotoId);
  const ok = await c.env.DB.prepare('SELECT 1 FROM item_photos WHERE id = ? AND item_id IN (SELECT value FROM json_each(?))')
    .bind(id, JSON.stringify(itemIds))
    .first();
  return ok ? id : 'The cover must be a photo of an item in the bundle.';
}

bundles.get('/mine', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id FROM bundles WHERE seller_id = ? ORDER BY updated_at DESC')
    .bind(c.get('user').id)
    .all<{ id: number }>();
  return c.json({ bundles: await loadBundles(c.env.DB, results.map((r) => r.id)) });
});

bundles.get('/:id{[0-9]+}', async (c) => {
  const row = await loadOwnBundle(c, Number(c.req.param('id')));
  if (!row) return apiError(c, 404, 'not_found');
  const [bundle] = await loadBundles(c.env.DB, [row.id]);
  return c.json({ bundle });
});

bundles.post('/', async (c) => {
  const body = await c.req.json<BundleInput>().catch(() => null);
  if (!body) return apiError(c, 400, 'bad_json');
  const user = c.get('user');
  const title = cleanText(typeof body.title === 'string' ? body.title : '', LIMITS.title);
  if (!title) return apiError(c, 422, 'invalid_title', 'Give the bundle a title.');
  const lines = parseLines(body.items);
  if (typeof lines === 'string') return apiError(c, 422, 'invalid_items', lines);
  const prices = await ownedPrices(c, user.id, lines.map((l) => l.itemId));
  if (typeof prices === 'string') return apiError(c, 422, 'invalid_items', prices);
  const pricing = parsePricing(body);
  if (typeof pricing === 'string') return apiError(c, 422, 'invalid_pricing', pricing);
  const pricingError = validateBundlePricing(pricing, [...prices.values()]);
  if (pricingError) return apiError(c, 422, 'invalid_pricing', pricingError);
  const cover = await validCover(c, body.coverPhotoId, lines.map((l) => l.itemId));
  if (typeof cover === 'string') return apiError(c, 422, 'invalid_cover', cover);
  const status = body.status === 'hidden' ? 'hidden' : 'listed';
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, LIMITS.description) || null : null;

  const now = Date.now();
  const row = await c.env.DB.prepare(
    `INSERT INTO bundles (seller_id, title, description, cover_photo_id, pricing_mode, fixed_price, percent_off, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      user.id,
      title,
      description,
      cover,
      pricing.mode,
      pricing.mode === 'fixed' ? pricing.fixedPrice : null,
      pricing.mode === 'percent_off' ? pricing.percentOff : null,
      status,
      now,
      now,
    )
    .first<{ id: number }>();
  await c.env.DB.batch(
    lines.map((l) => c.env.DB.prepare('INSERT INTO bundle_items (bundle_id, item_id, quantity) VALUES (?, ?, ?)').bind(row!.id, l.itemId, l.quantity)),
  );
  const [bundle] = await loadBundles(c.env.DB, [row!.id]);
  return c.json({ bundle }, 201);
});

bundles.patch('/:id{[0-9]+}', async (c) => {
  const row = await loadOwnBundle(c, Number(c.req.param('id')));
  if (!row) return apiError(c, 404, 'not_found');
  const body = await c.req.json<BundleInput>().catch(() => null);
  if (!body) return apiError(c, 400, 'bad_json');

  // Final state of items and pricing, to validate the combination.
  let lines: Line[];
  if (body.items !== undefined) {
    const parsed = parseLines(body.items);
    if (typeof parsed === 'string') return apiError(c, 422, 'invalid_items', parsed);
    lines = parsed;
  } else {
    const { results } = await c.env.DB.prepare('SELECT item_id AS itemId, quantity FROM bundle_items WHERE bundle_id = ?').bind(row.id).all<Line>();
    lines = results;
  }
  const prices = await ownedPrices(c, row.seller_id, lines.map((l) => l.itemId));
  if (typeof prices === 'string') return apiError(c, 422, 'invalid_items', prices);
  const pricing = parsePricing(body, row.pricing_mode === 'fixed' ? { mode: 'fixed', fixedPrice: row.fixed_price ?? 0 } : { mode: 'percent_off', percentOff: row.percent_off ?? 0 });
  if (typeof pricing === 'string') return apiError(c, 422, 'invalid_pricing', pricing);
  const pricingError = validateBundlePricing(pricing, [...prices.values()]);
  if (pricingError) return apiError(c, 422, 'invalid_pricing', pricingError);

  const sets: string[] = ['pricing_mode = ?', 'fixed_price = ?', 'percent_off = ?', 'updated_at = ?'];
  const args: (string | number | null)[] = [
    pricing.mode,
    pricing.mode === 'fixed' ? pricing.fixedPrice : null,
    pricing.mode === 'percent_off' ? pricing.percentOff : null,
    Date.now(),
  ];
  if (body.title !== undefined) {
    const title = cleanText(typeof body.title === 'string' ? body.title : '', LIMITS.title);
    if (!title) return apiError(c, 422, 'invalid_title', 'Give the bundle a title.');
    sets.push('title = ?');
    args.push(title);
  }
  if (body.description !== undefined) {
    sets.push('description = ?');
    args.push(typeof body.description === 'string' ? body.description.trim().slice(0, LIMITS.description) || null : null);
  }
  if (body.status !== undefined) {
    if (body.status !== 'listed' && body.status !== 'hidden') return apiError(c, 422, 'invalid_status', 'Status must be listed or hidden.');
    sets.push('status = ?');
    args.push(body.status);
  }
  if (body.coverPhotoId !== undefined) {
    const cover = await validCover(c, body.coverPhotoId, lines.map((l) => l.itemId));
    if (typeof cover === 'string') return apiError(c, 422, 'invalid_cover', cover);
    sets.push('cover_photo_id = ?');
    args.push(cover);
  }

  const stmts = [c.env.DB.prepare(`UPDATE bundles SET ${sets.join(', ')} WHERE id = ?`).bind(...args, row.id)];
  if (body.items !== undefined) {
    stmts.push(c.env.DB.prepare('DELETE FROM bundle_items WHERE bundle_id = ?').bind(row.id));
    for (const l of lines) {
      stmts.push(c.env.DB.prepare('INSERT INTO bundle_items (bundle_id, item_id, quantity) VALUES (?, ?, ?)').bind(row.id, l.itemId, l.quantity));
    }
    // Drop a cover that no longer belongs to any component.
    stmts.push(
      c.env.DB.prepare(
        `UPDATE bundles SET cover_photo_id = NULL WHERE id = ?1 AND cover_photo_id IS NOT NULL
           AND cover_photo_id NOT IN (SELECT p.id FROM item_photos p JOIN bundle_items bi ON bi.item_id = p.item_id WHERE bi.bundle_id = ?1)`,
      ).bind(row.id),
    );
  }
  await c.env.DB.batch(stmts);
  const [bundle] = await loadBundles(c.env.DB, [row.id]);
  return c.json({ bundle });
});

/** "Add to bundle" from the inventory: adds items (or adds to their quantity). */
bundles.post('/:id{[0-9]+}/items', async (c) => {
  const row = await loadOwnBundle(c, Number(c.req.param('id')));
  if (!row) return apiError(c, 404, 'not_found');
  const body = await c.req.json<{ items?: unknown }>().catch(() => null);
  const add = parseLines(body?.items);
  if (typeof add === 'string') return apiError(c, 422, 'invalid_items', add);

  const { results: existing } = await c.env.DB.prepare('SELECT item_id AS itemId, quantity FROM bundle_items WHERE bundle_id = ?').bind(row.id).all<Line>();
  const merged = new Map(existing.map((l) => [l.itemId, l.quantity]));
  for (const l of add) merged.set(l.itemId, (merged.get(l.itemId) ?? 0) + l.quantity);
  if (merged.size > 50) return apiError(c, 422, 'invalid_items', 'A bundle can have at most 50 different items.');

  const prices = await ownedPrices(c, row.seller_id, [...merged.keys()]);
  if (typeof prices === 'string') return apiError(c, 422, 'invalid_items', prices);
  const pricing: BundlePricing = row.pricing_mode === 'fixed' ? { mode: 'fixed', fixedPrice: row.fixed_price ?? 0 } : { mode: 'percent_off', percentOff: row.percent_off ?? 0 };
  const pricingError = validateBundlePricing(pricing, [...prices.values()]);
  if (pricingError) return apiError(c, 422, 'invalid_pricing', pricingError);

  await c.env.DB.batch([
    ...add.map((l) =>
      c.env.DB.prepare(
        `INSERT INTO bundle_items (bundle_id, item_id, quantity) VALUES (?, ?, ?)
         ON CONFLICT (bundle_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity`,
      ).bind(row.id, l.itemId, l.quantity),
    ),
    c.env.DB.prepare('UPDATE bundles SET updated_at = ? WHERE id = ?').bind(Date.now(), row.id),
  ]);
  const [bundle] = await loadBundles(c.env.DB, [row.id]);
  return c.json({ bundle });
});

export default bundles;
