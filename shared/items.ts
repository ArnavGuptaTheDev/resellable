import { LIMITS } from './config';
import type { Tier } from './pricing';

export const CONDITIONS = ['new', 'used', 'for_parts'] as const;
export type Condition = (typeof CONDITIONS)[number];
export const CONDITION_LABELS: Record<Condition, string> = { new: 'New', used: 'Used', for_parts: 'For parts' };

export const ITEM_STATUSES = ['draft', 'listed', 'hidden', 'sold_out'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const STATUS_LABELS: Record<ItemStatus, string> = {
  draft: 'Draft',
  listed: 'Listed',
  hidden: 'Hidden',
  sold_out: 'Sold out',
};

export interface Photo {
  id: number;
  url: string;
  thumbUrl: string;
}

export interface Item {
  id: number;
  sellerId: number;
  title: string;
  description: string | null;
  category: string | null;
  tags: string[];
  condition: Condition;
  quantity: number;
  /** Minor units; null = make an offer. */
  price: number | null;
  status: ItemStatus;
  createdAt: number;
  updatedAt: number;
  photos: Photo[];
  /** Quantity price tiers (min quantity → unit price). Only on priced items. */
  tiers: Tier[];
}

/** Row in the inventory list (no full photo list). */
export interface InventoryItem extends Omit<Item, 'photos' | 'description' | 'tiers'> {
  coverThumbUrl: string | null;
  photoCount: number;
}

/** Fields a seller can set. All optional for PATCH. */
export interface ItemInput {
  title?: string;
  description?: string | null;
  category?: string | null;
  tags?: string[] | string;
  condition?: Condition;
  quantity?: number;
  price?: number | null;
  status?: ItemStatus;
}

/** "ESP32, Wi-Fi ,esp32" → ["esp32", "wi-fi"] */
export function normalizeTags(input: string[] | string | null | undefined): string[] {
  const parts = Array.isArray(input) ? input : (input ?? '').split(',');
  const seen = new Set<string>();
  for (const p of parts) {
    const t = p.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, LIMITS.tag);
    if (t) seen.add(t);
    if (seen.size >= LIMITS.tags) break;
  }
  return [...seen];
}

/** Collapses whitespace; '' → null. */
export function cleanText(v: string | null | undefined, max: number): string | null {
  if (v == null) return null;
  const s = v.replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
}

export type FieldErrors = Partial<Record<keyof ItemInput, string>>;

/**
 * Validates a (partial) item input. Returns field errors, empty when valid.
 * `final` is the merged state after applying the input, used for cross-field
 * rules (a listed item needs a title).
 */
export function validateItem(input: ItemInput, final: { title: string; status: ItemStatus }): FieldErrors {
  const e: FieldErrors = {};
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > LIMITS.title)) {
    e.title = `Title must be at most ${LIMITS.title} characters.`;
  }
  if (
    input.description !== undefined &&
    input.description !== null &&
    (typeof input.description !== 'string' || input.description.length > LIMITS.description)
  ) {
    e.description = `Description must be at most ${LIMITS.description} characters.`;
  }
  if (
    input.category !== undefined &&
    input.category !== null &&
    (typeof input.category !== 'string' || input.category.length > LIMITS.category)
  ) {
    e.category = `Category must be at most ${LIMITS.category} characters.`;
  }
  if (input.tags !== undefined && !Array.isArray(input.tags) && typeof input.tags !== 'string') {
    e.tags = 'Tags must be a list.';
  }
  if (input.condition !== undefined && !CONDITIONS.includes(input.condition)) e.condition = 'Pick a condition.';
  if (
    input.quantity !== undefined &&
    (!Number.isInteger(input.quantity) || input.quantity < 0 || input.quantity > LIMITS.maxQuantity)
  ) {
    e.quantity = 'Quantity must be a whole number, 0 or more.';
  }
  if (
    input.price !== undefined &&
    input.price !== null &&
    (!Number.isInteger(input.price) || input.price < 0 || input.price > LIMITS.maxPrice)
  ) {
    e.price = 'Price must be a positive amount, or empty for "make an offer".';
  }
  if (input.status !== undefined && !ITEM_STATUSES.includes(input.status)) e.status = 'Unknown status.';
  if (!e.title && final.status !== 'draft' && !final.title.trim()) {
    e.title = 'Add a title before listing.';
  }
  return e;
}
