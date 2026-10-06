import type { Condition, InventoryItem, Item, ItemStatus, Photo } from '../../shared/items';
import type { Tier } from '../../shared/pricing';

export interface ItemRow {
  id: number;
  seller_id: number;
  title: string;
  description: string | null;
  category: string | null;
  tags: string;
  condition: Condition;
  quantity: number;
  price: number | null;
  status: ItemStatus;
  sold_out_auto: number;
  created_at: number;
  updated_at: number;
}

export interface PhotoRow {
  id: number;
  item_id: number;
  r2_key: string;
  thumb_key: string;
  sort_order: number;
}

export const imgUrl = (key: string) => `/img/${key}`;

export function toPhoto(p: PhotoRow): Photo {
  return { id: p.id, url: imgUrl(p.r2_key), thumbUrl: imgUrl(p.thumb_key) };
}

function base(r: ItemRow) {
  return {
    id: r.id,
    sellerId: r.seller_id,
    title: r.title,
    category: r.category,
    tags: r.tags ? r.tags.split(',') : [],
    condition: r.condition,
    quantity: r.quantity,
    price: r.price,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toItem(r: ItemRow, photos: PhotoRow[], tiers: Tier[] = []): Item {
  return { ...base(r), description: r.description, photos: photos.map(toPhoto), tiers };
}

export function toInventoryItem(r: ItemRow & { cover_thumb: string | null; photo_count: number }): InventoryItem {
  return { ...base(r), coverThumbUrl: r.cover_thumb ? imgUrl(r.cover_thumb) : null, photoCount: r.photo_count };
}

export async function getItem(db: D1Database, id: number) {
  return db.prepare('SELECT * FROM items WHERE id = ?').bind(id).first<ItemRow>();
}

export async function getPhotos(db: D1Database, itemId: number) {
  const { results } = await db
    .prepare('SELECT * FROM item_photos WHERE item_id = ? ORDER BY sort_order, id')
    .bind(itemId)
    .all<PhotoRow>();
  return results;
}

/**
 * Turns free text into a safe FTS5 query: each word becomes a quoted prefix
 * term, all ANDed. Returns null when nothing searchable remains.
 */
export function ftsQuery(q: string | undefined): string | null {
  const terms = (q ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  return terms.length ? terms.map((t) => `"${t}"*`).join(' ') : null;
}

/**
 * Deletes R2 objects for photo rows that no longer exist anywhere
 * (duplicated items share keys, so only orphaned keys are removed).
 */
export async function deleteOrphanedKeys(db: D1Database, bucket: R2Bucket, keys: string[]) {
  const orphaned: string[] = [];
  for (const key of keys) {
    const used = await db
      .prepare('SELECT 1 FROM item_photos WHERE r2_key = ?1 OR thumb_key = ?1 LIMIT 1')
      .bind(key)
      .first();
    if (!used) orphaned.push(key);
  }
  if (orphaned.length) await bucket.delete(orphaned);
}
