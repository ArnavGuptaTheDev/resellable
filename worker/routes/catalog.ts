import { Hono } from 'hono';
import type { CatalogCard, CatalogItemDetail } from '../../shared/catalog';
import { CONDITIONS } from '../../shared/items';
import { ACTIVE_SELLER_SQL, activeSellerArg, loadBundles, loadTiers } from '../lib/catalog';
import { ftsQuery, getPhotos, imgUrl, toPhoto, type ItemRow } from '../lib/items';
import { apiError, requireUser } from '../middleware';
import type { AppEnv } from '../types';

/** Browse, search and detail pages. Open to every signed-in role. */
const catalog = new Hono<AppEnv>();
catalog.use('*', requireUser);

const PAGE = 48;

catalog.get('/', async (c) => {
  const q = c.req.query('q');
  const category = c.req.query('category');
  const condition = c.req.query('condition');
  const price = c.req.query('price'); // 'priced' | 'offer'
  const kind = c.req.query('kind'); // 'bundles' = bundles only
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const fts = ftsQuery(q);
  const active = activeSellerArg(c.env);

  let items: CatalogCard[] = [];
  let total = 0;
  if (kind !== 'bundles') {
    const where = [`i.status = 'listed'`, ACTIVE_SELLER_SQL];
    const args: (string | number)[] = [active];
    if (category) {
      where.push('i.category = ? COLLATE NOCASE');
      args.push(category);
    }
    if (condition && (CONDITIONS as readonly string[]).includes(condition)) {
      where.push('i.condition = ?');
      args.push(condition);
    }
    if (price === 'priced') where.push('i.price IS NOT NULL');
    if (price === 'offer') where.push('i.price IS NULL');
    if (fts) {
      where.push('i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)');
      args.push(fts);
    }
    const whereSql = where.join(' AND ');
    // Search results by relevance; otherwise newest first.
    const order = fts
      ? `(SELECT rank FROM items_fts WHERE items_fts MATCH ? AND rowid = i.id), i.updated_at DESC`
      : 'i.updated_at DESC, i.id DESC';
    const orderArgs = fts ? [fts] : [];
    const [rows, count] = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT i.*, u.name AS seller_name,
                (SELECT thumb_key FROM item_photos p WHERE p.item_id = i.id ORDER BY p.sort_order, p.id LIMIT 1) AS cover_thumb
           FROM items i JOIN users u ON u.id = i.seller_id
          WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ).bind(...args, ...orderArgs, PAGE, offset),
      c.env.DB.prepare(`SELECT count(*) AS n FROM items i JOIN users u ON u.id = i.seller_id WHERE ${whereSql}`).bind(...args),
    ]);
    const list = rows!.results as (ItemRow & { seller_name: string | null; cover_thumb: string | null })[];
    const tiers = await loadTiers(c.env.DB, list.map((r) => r.id));
    items = list.map((r) => ({
      id: r.id,
      title: r.title,
      category: r.category,
      condition: r.condition,
      quantity: r.quantity,
      price: r.price,
      tiers: tiers.get(r.id) ?? [],
      status: r.status,
      coverThumbUrl: r.cover_thumb ? imgUrl(r.cover_thumb) : null,
      seller: { id: r.seller_id, name: r.seller_name },
    }));
    total = (count!.results[0] as { n: number }).n;
  }

  // Bundles: on the first page, unless item-only filters are active.
  const itemFilters = category || condition || price;
  let bundles: Awaited<ReturnType<typeof loadBundles>> = [];
  if (offset === 0 && (kind === 'bundles' || !itemFilters)) {
    const like = q?.trim() ? `%${q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
    const { results } = await c.env.DB.prepare(
      `SELECT b.id FROM bundles b JOIN users u ON u.id = b.seller_id
        WHERE b.status = 'listed' AND ${ACTIVE_SELLER_SQL}
          ${like ? `AND (b.title LIKE ?2 ESCAPE '\\' OR b.description LIKE ?2 ESCAPE '\\')` : ''}
        ORDER BY b.updated_at DESC LIMIT 50`,
    )
      .bind(...(like ? [active, like] : [active]))
      .all<{ id: number }>();
    bundles = await loadBundles(c.env.DB, results.map((r) => r.id));
  }

  return c.json({ items, total, bundles, pageSize: PAGE });
});

catalog.get('/categories', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT i.category, count(*) AS n FROM items i JOIN users u ON u.id = i.seller_id
      WHERE i.status = 'listed' AND i.category IS NOT NULL AND i.category <> '' AND ${ACTIVE_SELLER_SQL}
      GROUP BY i.category COLLATE NOCASE ORDER BY n DESC, i.category LIMIT 100`,
  )
    .bind(activeSellerArg(c.env))
    .all<{ category: string; n: number }>();
  return c.json({ categories: results.map((r) => ({ name: r.category, count: r.n })) });
});

catalog.get('/items/:id{[0-9]+}', async (c) => {
  const user = c.get('user');
  const row = await c.env.DB.prepare(
    `SELECT i.*, u.name AS seller_name, ${ACTIVE_SELLER_SQL} AS seller_active
       FROM items i JOIN users u ON u.id = i.seller_id WHERE i.id = ?`,
  )
    .bind(activeSellerArg(c.env), Number(c.req.param('id')))
    .first<ItemRow & { seller_name: string | null; seller_active: number }>();
  const own = row && (row.seller_id === user.id || user.role === 'superuser');
  const public_ = row && (row.status === 'listed' || row.status === 'sold_out') && row.seller_active === 1;
  if (!row || (!own && !public_)) return apiError(c, 404, 'not_found');

  const [photos, tiers, inBundles] = await Promise.all([
    getPhotos(c.env.DB, row.id),
    loadTiers(c.env.DB, [row.id]),
    c.env.DB.prepare(`SELECT b.id FROM bundle_items bi JOIN bundles b ON b.id = bi.bundle_id WHERE bi.item_id = ? AND b.status = 'listed'`)
      .bind(row.id)
      .all<{ id: number }>(),
  ]);
  const bundles = await loadBundles(c.env.DB, inBundles.results.map((r) => r.id));

  const detail: CatalogItemDetail = {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    tags: row.tags ? row.tags.split(',') : [],
    condition: row.condition,
    quantity: row.quantity,
    price: row.price,
    tiers: tiers.get(row.id) ?? [],
    status: row.status,
    photos: photos.map(toPhoto),
    seller: { id: row.seller_id, name: row.seller_name },
    bundles: bundles.map((b) => ({ id: b.id, title: b.title, price: b.price, available: b.available })),
    updatedAt: row.updated_at,
  };
  return c.json({ item: detail, own: !!own });
});

catalog.get('/bundles/:id{[0-9]+}', async (c) => {
  const user = c.get('user');
  const [bundle] = await loadBundles(c.env.DB, [Number(c.req.param('id'))]);
  if (!bundle) return apiError(c, 404, 'not_found');
  const own = bundle.seller.id === user.id || user.role === 'superuser';
  if (!own) {
    const active = await c.env.DB.prepare(`SELECT ${ACTIVE_SELLER_SQL} AS ok FROM users u WHERE u.id = ?`)
      .bind(activeSellerArg(c.env), bundle.seller.id)
      .first<{ ok: number }>();
    if (bundle.status !== 'listed' || active?.ok !== 1) return apiError(c, 404, 'not_found');
  }
  return c.json({ bundle, own });
});

export default catalog;
