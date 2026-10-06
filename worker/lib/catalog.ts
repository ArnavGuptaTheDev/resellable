import type { BundleView } from '../../shared/catalog';
import type { ItemStatus } from '../../shared/items';
import {
  bundleAvailability,
  bundlePrice,
  bundleSaving,
  componentsSum,
  unitPriceFor,
  type BundleComponent,
  type BundlePricing,
  type Tier,
} from '../../shared/pricing';
import { superuserEmails } from './access';
import { imgUrl } from './items';

/**
 * SQL condition: the seller (alias `u`) still has access — not disabled and
 * either invited or an env superuser. Bind with activeSellerArgs(env).
 */
export const ACTIVE_SELLER_SQL = `(u.disabled = 0 AND (u.email IN (SELECT email FROM allowlist) OR lower(u.email) IN (SELECT value FROM json_each(?))))`;
export const activeSellerArg = (env: Env) => JSON.stringify([...superuserEmails(env)]);

export async function loadTiers(db: D1Database, itemIds: number[]): Promise<Map<number, Tier[]>> {
  const map = new Map<number, Tier[]>();
  if (!itemIds.length) return map;
  const { results } = await db
    .prepare('SELECT item_id, min_qty, unit_price FROM item_price_tiers WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY min_qty')
    .bind(JSON.stringify(itemIds))
    .all<{ item_id: number; min_qty: number; unit_price: number }>();
  for (const r of results) {
    const list = map.get(r.item_id) ?? [];
    list.push({ minQty: r.min_qty, unitPrice: r.unit_price });
    map.set(r.item_id, list);
  }
  return map;
}

interface BundleRow {
  id: number;
  seller_id: number;
  seller_name: string | null;
  title: string;
  description: string | null;
  cover_photo_id: number | null;
  pricing_mode: 'fixed' | 'percent_off';
  fixed_price: number | null;
  percent_off: number | null;
  status: 'listed' | 'hidden';
  cover_r2: string | null;
  cover_thumb: string | null;
}

interface ComponentRow {
  bundle_id: number;
  per: number;
  item_id: number;
  title: string;
  price: number | null;
  stock: number;
  status: ItemStatus;
  r2_key: string | null;
  thumb_key: string | null;
}

export function pricingOf(b: { pricing_mode: 'fixed' | 'percent_off'; fixed_price: number | null; percent_off: number | null }): BundlePricing {
  return b.pricing_mode === 'fixed'
    ? { mode: 'fixed', fixedPrice: b.fixed_price ?? 0 }
    : { mode: 'percent_off', percentOff: b.percent_off ?? 0 };
}

/** Loads bundles with components, computing price, saving and availability. Keeps the order of `ids`. */
export async function loadBundles(db: D1Database, ids: number[]): Promise<BundleView[]> {
  if (!ids.length) return [];
  const idsJson = JSON.stringify(ids);
  const [bundles, comps] = await db.batch([
    db
      .prepare(
        `SELECT b.*, u.name AS seller_name, p.r2_key AS cover_r2, p.thumb_key AS cover_thumb
           FROM bundles b JOIN users u ON u.id = b.seller_id
           LEFT JOIN item_photos p ON p.id = b.cover_photo_id
          WHERE b.id IN (SELECT value FROM json_each(?))`,
      )
      .bind(idsJson),
    db
      .prepare(
        `SELECT bi.bundle_id, bi.quantity AS per, i.id AS item_id, i.title, i.price, i.quantity AS stock, i.status,
                (SELECT r2_key FROM item_photos p WHERE p.item_id = i.id ORDER BY p.sort_order, p.id LIMIT 1) AS r2_key,
                (SELECT thumb_key FROM item_photos p WHERE p.item_id = i.id ORDER BY p.sort_order, p.id LIMIT 1) AS thumb_key
           FROM bundle_items bi JOIN items i ON i.id = bi.item_id
          WHERE bi.bundle_id IN (SELECT value FROM json_each(?))
          ORDER BY bi.rowid`,
      )
      .bind(idsJson),
  ]);
  const compRows = comps!.results as ComponentRow[];
  const tiers = await loadTiers(db, [...new Set(compRows.map((c) => c.item_id))]);

  const byId = new Map<number, BundleView>();
  for (const b of bundles!.results as BundleRow[]) {
    const rows = compRows.filter((c) => c.bundle_id === b.id);
    const comps: BundleComponent[] = rows.map((c) => ({
      price: c.price,
      tiers: tiers.get(c.item_id) ?? [],
      quantity: c.per,
      stock: c.stock,
      available: c.status === 'listed' || c.status === 'sold_out',
    }));
    const pricing = pricingOf(b);
    // Cover: chosen photo, else the first component's cover photo.
    const fallback = rows.find((r) => r.thumb_key);
    byId.set(b.id, {
      id: b.id,
      seller: { id: b.seller_id, name: b.seller_name },
      title: b.title,
      description: b.description,
      pricingMode: b.pricing_mode,
      fixedPrice: b.fixed_price,
      percentOff: b.percent_off,
      status: b.status,
      coverPhotoId: b.cover_photo_id,
      coverUrl: b.cover_r2 ? imgUrl(b.cover_r2) : fallback?.r2_key ? imgUrl(fallback.r2_key) : null,
      coverThumbUrl: b.cover_thumb ? imgUrl(b.cover_thumb) : fallback?.thumb_key ? imgUrl(fallback.thumb_key) : null,
      price: bundlePrice(pricing, comps),
      componentsSum: componentsSum(comps),
      saving: bundleSaving(pricing, comps),
      available: bundleAvailability(comps),
      components: rows.map((c, i) => ({
        itemId: c.item_id,
        title: c.title,
        quantity: c.per,
        unitPrice: unitPriceFor(comps[i]!, c.per),
        stock: c.stock,
        status: c.status,
        thumbUrl: c.thumb_key ? imgUrl(c.thumb_key) : null,
      })),
    });
  }
  return ids.map((id) => byId.get(id)).filter((b): b is BundleView => !!b);
}
