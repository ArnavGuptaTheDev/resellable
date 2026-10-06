import { Hono, type Context } from 'hono';
import { LIMITS, MINOR_PER_MAJOR, UPLOAD } from '../../shared/config';
import {
  CONDITION_LABELS,
  ITEM_STATUSES,
  cleanText,
  normalizeTags,
  validateItem,
  type ItemInput,
  type ItemStatus,
} from '../../shared/items';
import { validateTiers, type Tier } from '../../shared/pricing';
import { loadTiers } from '../lib/catalog';
import { checkImage, putPhoto } from '../lib/images';
import {
  deleteOrphanedKeys,
  ftsQuery,
  getItem,
  getPhotos,
  toInventoryItem,
  toItem,
  toPhoto,
  type ItemRow,
  type PhotoRow,
} from '../lib/items';
import { apiError, requireRole, requireUser } from '../middleware';
import type { AppEnv } from '../types';

const items = new Hono<AppEnv>();
items.use('*', requireUser, requireRole('seller'));

type Ctx = Context<AppEnv>;

/** The item if the current user owns it (or is a superuser); otherwise null (→ 404, no existence leak). */
async function loadOwned(c: Ctx, id: number): Promise<ItemRow | null> {
  if (!Number.isInteger(id)) return null;
  const item = await getItem(c.env.DB, id);
  const user = c.get('user');
  if (!item || (item.seller_id !== user.id && user.role !== 'superuser')) return null;
  return item;
}

async function readJson<T>(c: Ctx): Promise<T | null> {
  return c.req.json<T>().catch(() => null);
}

function cleanDescription(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = v.replace(/\r\n/g, '\n').trim().slice(0, LIMITS.description);
  return s || null;
}

/** Normalized column values for the fields present in `input`. */
function columns(input: ItemInput): Record<string, string | number | null> {
  const cols: Record<string, string | number | null> = {};
  if (input.title !== undefined) cols.title = cleanText(input.title, LIMITS.title) ?? '';
  if (input.description !== undefined) cols.description = cleanDescription(input.description);
  if (input.category !== undefined) cols.category = cleanText(input.category, LIMITS.category);
  if (input.tags !== undefined) cols.tags = normalizeTags(input.tags).join(',');
  if (input.condition !== undefined) cols.condition = input.condition;
  if (input.quantity !== undefined) cols.quantity = input.quantity;
  if (input.price !== undefined) cols.price = input.price;
  if (input.status !== undefined) {
    cols.status = input.status;
    cols.sold_out_auto = 0; // any manual status change clears the automatic flag
  }
  return cols;
}

function invalid(c: Ctx, fields: Record<string, string>) {
  return c.json({ error: 'invalid', message: Object.values(fields)[0], fields }, 422);
}

// ------------------------------------------------------------------ lists

items.get('/mine', async (c) => {
  const user = c.get('user');
  const status = c.req.query('status');
  const category = c.req.query('category');
  const fts = ftsQuery(c.req.query('q'));
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 500);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);

  const where = ['i.seller_id = ?'];
  const args: (string | number)[] = [user.id];
  if (status && (ITEM_STATUSES as readonly string[]).includes(status)) {
    where.push('i.status = ?');
    args.push(status);
  }
  if (category) {
    where.push('i.category = ? COLLATE NOCASE');
    args.push(category);
  }
  if (fts) {
    where.push('i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)');
    args.push(fts);
  }
  const whereSql = where.join(' AND ');

  const [list, total, counts] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT i.*,
              (SELECT thumb_key FROM item_photos p WHERE p.item_id = i.id ORDER BY p.sort_order, p.id LIMIT 1) AS cover_thumb,
              (SELECT count(*) FROM item_photos p WHERE p.item_id = i.id) AS photo_count
         FROM items i WHERE ${whereSql}
        ORDER BY i.updated_at DESC, i.id DESC
        LIMIT ? OFFSET ?`,
    ).bind(...args, limit, offset),
    c.env.DB.prepare(`SELECT count(*) AS n FROM items i WHERE ${whereSql}`).bind(...args),
    c.env.DB.prepare('SELECT status, count(*) AS n FROM items WHERE seller_id = ? GROUP BY status').bind(user.id),
  ]);

  return c.json({
    items: (list!.results as (ItemRow & { cover_thumb: string | null; photo_count: number })[]).map(toInventoryItem),
    total: (total!.results[0] as { n: number }).n,
    counts: Object.fromEntries((counts!.results as { status: ItemStatus; n: number }[]).map((r) => [r.status, r.n])),
  });
});

/** Category autocomplete: existing values across the catalog, most used first. */
items.get('/categories', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT category, count(*) AS n FROM items
      WHERE category IS NOT NULL AND category <> ''
      GROUP BY category COLLATE NOCASE ORDER BY n DESC, category LIMIT 200`,
  ).all<{ category: string }>();
  return c.json({ categories: results.map((r) => r.category) });
});

/** Spreadsheet-safe CSV cell: quoted when needed, formula-looking text neutralized. */
function csvCell(v: string | number | null): string {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

items.get('/export.csv', async (c) => {
  const user = c.get('user');
  const { results } = await c.env.DB.prepare(
    `SELECT i.*, (SELECT count(*) FROM item_photos p WHERE p.item_id = i.id) AS photo_count
       FROM items i WHERE i.seller_id = ? ORDER BY i.id`,
  )
    .bind(user.id)
    .all<ItemRow & { photo_count: number }>();

  const header = ['id', 'title', 'category', 'tags', 'condition', 'quantity', 'price', 'status', 'photos', 'description', 'created', 'updated'];
  const iso = (ms: number) => new Date(ms).toISOString();
  const lines = [header.join(',')];
  for (const r of results) {
    lines.push(
      [
        r.id,
        r.title,
        r.category,
        r.tags.split(',').filter(Boolean).join('; '),
        CONDITION_LABELS[r.condition],
        r.quantity,
        r.price == null ? 'make an offer' : (r.price / MINOR_PER_MAJOR).toFixed(2),
        r.status,
        r.photo_count,
        r.description,
        iso(r.created_at),
        iso(r.updated_at),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  const date = new Date().toISOString().slice(0, 10);
  // BOM so Excel opens UTF-8 (₹, accents) correctly.
  return c.body(`﻿${lines.join('\r\n')}\r\n`, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="inventory-${date}.csv"`,
  });
});

// ------------------------------------------------------------------ create

items.post('/', async (c) => {
  const input = await readJson<ItemInput>(c);
  if (!input) return apiError(c, 400, 'bad_json');
  const status = input.status ?? 'draft';
  const errors = validateItem(input, { title: input.title ?? '', status });
  if (Object.keys(errors).length) return invalid(c, errors as Record<string, string>);

  const now = Date.now();
  const cols = { quantity: 1, condition: 'new', ...columns({ ...input, status }), seller_id: c.get('user').id, created_at: now, updated_at: now };
  const names = Object.keys(cols);
  const row = await c.env.DB.prepare(
    `INSERT INTO items (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')}) RETURNING *`,
  )
    .bind(...Object.values(cols))
    .first<ItemRow>();
  return c.json({ item: toItem(row!, []) }, 201);
});

/** Batch from photos: one multipart upload (main + thumb) becomes one draft item. */
items.post('/drafts', async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return apiError(c, 400, 'bad_form');
  const main = await checkImage(form.get('main'), UPLOAD.mainMaxBytes, 'Main');
  if (typeof main === 'string') return apiError(c, 422, 'invalid_image', main);
  const thumb = await checkImage(form.get('thumb'), UPLOAD.thumbMaxBytes, 'Thumbnail');
  if (typeof thumb === 'string') return apiError(c, 422, 'invalid_image', thumb);

  const keys = await putPhoto(c.env.IMAGES, main, thumb);
  const now = Date.now();
  const item = await c.env.DB.prepare(
    `INSERT INTO items (seller_id, status, quantity, created_at, updated_at)
     VALUES (?, 'draft', 1, ?, ?) RETURNING *`,
  )
    .bind(c.get('user').id, now, now)
    .first<ItemRow>();
  const photo = await c.env.DB.prepare(
    `INSERT INTO item_photos (item_id, r2_key, thumb_key, sort_order, created_at)
     VALUES (?, ?, ?, 0, ?) RETURNING *`,
  )
    .bind(item!.id, keys.main, keys.thumb, now)
    .first<PhotoRow>();
  return c.json({ item: toItem(item!, [photo!]) }, 201);
});

// ------------------------------------------------------------------ bulk

const BULK_ACTIONS = ['list', 'hide', 'draft', 'set_category'] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];

items.post('/bulk', async (c) => {
  const body = await readJson<{ ids?: unknown; action?: unknown; category?: unknown }>(c);
  const ids = Array.isArray(body?.ids) ? body.ids.filter((n): n is number => Number.isInteger(n)) : [];
  const action = body?.action as BulkAction;
  if (!ids.length || ids.length > 500 || !BULK_ACTIONS.includes(action)) {
    return apiError(c, 400, 'bad_request', 'Expected { ids: number[] (1-500), action }.');
  }
  const now = Date.now();
  const user = c.get('user');
  // json_each keeps the statement at a fixed number of bound parameters.
  const scope = 'id IN (SELECT value FROM json_each(?)) AND seller_id = ?';
  const scopeArgs = [JSON.stringify(ids), user.id];

  let stmt: D1PreparedStatement;
  if (action === 'set_category') {
    if (body!.category !== null && typeof body!.category !== 'string') {
      return apiError(c, 422, 'invalid_category', 'Category must be text.');
    }
    const category = cleanText(body!.category as string | null, LIMITS.category);
    stmt = c.env.DB.prepare(`UPDATE items SET category = ?, updated_at = ? WHERE ${scope}`).bind(category, now, ...scopeArgs);
  } else {
    const status = { list: 'listed', hide: 'hidden', draft: 'draft' }[action];
    // Listing needs a title; untitled drafts are skipped and reported.
    const extra = action === 'list' ? " AND title <> ''" : '';
    stmt = c.env.DB.prepare(`UPDATE items SET status = ?, sold_out_auto = 0, updated_at = ? WHERE ${scope}${extra}`).bind(
      status,
      now,
      ...scopeArgs,
    );
  }
  const res = await stmt.run();
  return c.json({ updated: res.meta.changes, skipped: ids.length - res.meta.changes });
});

// ------------------------------------------------------------------ single item

async function fullItem(c: Ctx, row: ItemRow) {
  const [photos, tiers] = await Promise.all([getPhotos(c.env.DB, row.id), loadTiers(c.env.DB, [row.id])]);
  return toItem(row, photos, tiers.get(row.id) ?? []);
}

items.get('/:id{[0-9]+}', async (c) => {
  const item = await loadOwned(c, Number(c.req.param('id')));
  if (!item) return apiError(c, 404, 'not_found');
  return c.json({ item: await fullItem(c, item) });
});

/** Replaces the item's quantity tiers. Body: { tiers: [{ minQty, unitPrice }] }. Only for priced items. */
items.put('/:id{[0-9]+}/tiers', async (c) => {
  const item = await loadOwned(c, Number(c.req.param('id')));
  if (!item) return apiError(c, 404, 'not_found');
  const body = await readJson<{ tiers?: unknown }>(c);
  if (!body || !Array.isArray(body.tiers)) return apiError(c, 400, 'bad_request', 'Expected { tiers: [...] }.');
  const tiers: Tier[] = (body.tiers as { minQty?: unknown; unitPrice?: unknown }[]).map((t) => ({
    minQty: Number(t?.minQty),
    unitPrice: Number(t?.unitPrice),
  }));
  const error = validateTiers(item.price, tiers);
  if (error) return c.json({ error: 'invalid', message: error, fields: { tiers: error } }, 422);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM item_price_tiers WHERE item_id = ?').bind(item.id),
    ...tiers.map((t) => c.env.DB.prepare('INSERT INTO item_price_tiers (item_id, min_qty, unit_price) VALUES (?, ?, ?)').bind(item.id, t.minQty, t.unitPrice)),
    c.env.DB.prepare('UPDATE items SET updated_at = ? WHERE id = ?').bind(Date.now(), item.id),
  ]);
  return c.json({ item: await fullItem(c, (await getItem(c.env.DB, item.id))!) });
});

/**
 * Removing an item's price would break two rules: tiers need a base price,
 * and percent-off bundles need every component priced. Returns the reason.
 */
async function priceRemovalBlocker(c: Ctx, itemId: number): Promise<string | null> {
  const [tiers, bundle] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT count(*) AS n FROM item_price_tiers WHERE item_id = ?').bind(itemId),
    c.env.DB.prepare(
      `SELECT b.title FROM bundles b JOIN bundle_items bi ON bi.bundle_id = b.id
        WHERE bi.item_id = ? AND b.pricing_mode = 'percent_off' LIMIT 1`,
    ).bind(itemId),
  ]);
  if ((tiers!.results[0] as { n: number }).n > 0) return 'Remove the quantity tiers before removing the price.';
  const b = bundle!.results[0] as { title: string } | undefined;
  if (b) return `This item is in the percent-off bundle "${b.title}". Give that bundle a fixed price first.`;
  return null;
}

items.patch('/:id{[0-9]+}', async (c) => {
  const item = await loadOwned(c, Number(c.req.param('id')));
  if (!item) return apiError(c, 404, 'not_found');
  const input = await readJson<ItemInput>(c);
  if (!input) return apiError(c, 400, 'bad_json');

  const final = { title: input.title ?? item.title, status: input.status ?? item.status };
  const errors = validateItem(input, final);
  if (Object.keys(errors).length) return invalid(c, errors as Record<string, string>);

  if (input.price === null && item.price !== null) {
    const blocker = await priceRemovalBlocker(c, item.id);
    if (blocker) return invalid(c, { price: blocker });
  }

  const cols = columns(input);
  if (!Object.keys(cols).length) return apiError(c, 400, 'nothing_to_update');
  cols.updated_at = Date.now();
  const row = await c.env.DB.prepare(
    `UPDATE items SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')} WHERE id = ? RETURNING *`,
  )
    .bind(...Object.values(cols), item.id)
    .first<ItemRow>();
  return c.json({ item: await fullItem(c, row!) });
});

/** Copies fields, photos (sharing the same immutable R2 objects) and price tiers into a new draft. */
items.post('/:id{[0-9]+}/duplicate', async (c) => {
  const src = await loadOwned(c, Number(c.req.param('id')));
  if (!src) return apiError(c, 404, 'not_found');
  const now = Date.now();
  const copy = await c.env.DB.prepare(
    `INSERT INTO items (seller_id, title, description, category, tags, condition, quantity, price, status, created_at, updated_at)
     SELECT ?, title, description, category, tags, condition, quantity, price, 'draft', ?, ?
       FROM items WHERE id = ? RETURNING *`,
  )
    .bind(c.get('user').id, now, now, src.id)
    .first<ItemRow>();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO item_photos (item_id, r2_key, thumb_key, sort_order, created_at)
       SELECT ?, r2_key, thumb_key, sort_order, ? FROM item_photos WHERE item_id = ?`,
    ).bind(copy!.id, now, src.id),
    c.env.DB.prepare(
      `INSERT INTO item_price_tiers (item_id, min_qty, unit_price)
       SELECT ?, min_qty, unit_price FROM item_price_tiers WHERE item_id = ?`,
    ).bind(copy!.id, src.id),
  ]);
  return c.json({ item: await fullItem(c, copy!) }, 201);
});

// ------------------------------------------------------------------ photos

items.post('/:id{[0-9]+}/photos', async (c) => {
  const item = await loadOwned(c, Number(c.req.param('id')));
  if (!item) return apiError(c, 404, 'not_found');
  const count = await c.env.DB.prepare('SELECT count(*) AS n FROM item_photos WHERE item_id = ?')
    .bind(item.id)
    .first<{ n: number }>();
  if (count!.n >= UPLOAD.maxPhotosPerItem) {
    return apiError(c, 409, 'too_many_photos', `An item can have at most ${UPLOAD.maxPhotosPerItem} photos.`);
  }

  const form = await c.req.formData().catch(() => null);
  if (!form) return apiError(c, 400, 'bad_form');
  const main = await checkImage(form.get('main'), UPLOAD.mainMaxBytes, 'Main');
  if (typeof main === 'string') return apiError(c, 422, 'invalid_image', main);
  const thumb = await checkImage(form.get('thumb'), UPLOAD.thumbMaxBytes, 'Thumbnail');
  if (typeof thumb === 'string') return apiError(c, 422, 'invalid_image', thumb);

  const keys = await putPhoto(c.env.IMAGES, main, thumb);
  const now = Date.now();
  const [, photo] = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE items SET updated_at = ? WHERE id = ?').bind(now, item.id),
    c.env.DB.prepare(
      `INSERT INTO item_photos (item_id, r2_key, thumb_key, sort_order, created_at)
       VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM item_photos WHERE item_id = ?1), ?4)
       RETURNING *`,
    ).bind(item.id, keys.main, keys.thumb, now),
  ]);
  return c.json({ photo: toPhoto((photo!.results as PhotoRow[])[0]!) }, 201);
});

items.delete('/:id{[0-9]+}/photos/:photoId{[0-9]+}', async (c) => {
  const item = await loadOwned(c, Number(c.req.param('id')));
  if (!item) return apiError(c, 404, 'not_found');
  const photo = await c.env.DB.prepare('DELETE FROM item_photos WHERE id = ? AND item_id = ? RETURNING *')
    .bind(Number(c.req.param('photoId')), item.id)
    .first<PhotoRow>();
  if (!photo) return apiError(c, 404, 'not_found');
  // Bundles may use this photo as their cover; clear it rather than dangle.
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE bundles SET cover_photo_id = NULL WHERE cover_photo_id = ?').bind(photo.id),
    c.env.DB.prepare('UPDATE items SET updated_at = ? WHERE id = ?').bind(Date.now(), item.id),
  ]);
  c.executionCtx.waitUntil(deleteOrphanedKeys(c.env.DB, c.env.IMAGES, [photo.r2_key, photo.thumb_key]));
  return c.json({ ok: true });
});

/** Body: { ids: photoId[] } in the new order (first = cover). Must list every photo of the item. */
items.put('/:id{[0-9]+}/photos/order', async (c) => {
  const item = await loadOwned(c, Number(c.req.param('id')));
  if (!item) return apiError(c, 404, 'not_found');
  const body = await readJson<{ ids?: unknown }>(c);
  const ids = Array.isArray(body?.ids) ? body.ids : [];
  const current = await getPhotos(c.env.DB, item.id);
  const same = ids.length === current.length && current.every((p) => ids.includes(p.id));
  if (!same) return apiError(c, 422, 'bad_order', 'Order must list every photo of the item exactly once.');
  await c.env.DB.batch(
    ids.map((id, i) => c.env.DB.prepare('UPDATE item_photos SET sort_order = ? WHERE id = ? AND item_id = ?').bind(i, id, item.id)),
  );
  return c.json({ item: await fullItem(c, item) });
});

export default items;
