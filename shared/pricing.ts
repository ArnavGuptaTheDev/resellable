/**
 * Pricing rules shared by the UI and the Worker. All amounts are integer
 * minor units (paise). Pure functions: covered by test/pricing.test.ts.
 */

export interface Tier {
  minQty: number;
  unitPrice: number;
}

export interface PricedItem {
  /** Base price for quantity 1; null = make an offer. */
  price: number | null;
  tiers: Tier[];
}

/**
 * Unit price for buying `qty` of an item: the tier with the highest minQty
 * that qty reaches, else the base price. null when the item has no price.
 */
export function unitPriceFor(item: PricedItem, qty: number): number | null {
  if (item.price == null) return null;
  let best: Tier | null = null;
  for (const t of item.tiers) {
    if (qty >= t.minQty && (!best || t.minQty > best.minQty)) best = t;
  }
  return best ? best.unitPrice : item.price;
}

export interface BundleComponent extends PricedItem {
  /** Units of this item per bundle. */
  quantity: number;
  /** Units in stock. */
  stock: number;
  /** Only listed / sold-out components count as available. */
  available: boolean;
}

export type BundlePricing = { mode: 'fixed'; fixedPrice: number } | { mode: 'percent_off'; percentOff: number };

/**
 * Sum of buying every component individually (tier pricing applied at the
 * component quantity). null if any component has no price.
 */
export function componentsSum(components: BundleComponent[]): number | null {
  let sum = 0;
  for (const c of components) {
    const unit = unitPriceFor(c, c.quantity);
    if (unit == null) return null;
    sum += unit * c.quantity;
  }
  return sum;
}

/** Price of one bundle. percent_off needs every component priced (else null). */
export function bundlePrice(pricing: BundlePricing, components: BundleComponent[]): number | null {
  if (pricing.mode === 'fixed') return pricing.fixedPrice;
  const sum = componentsSum(components);
  if (sum == null) return null;
  return Math.round((sum * (100 - pricing.percentOff)) / 100);
}

/** Saving vs buying individually; null when the sum is unknown. Never negative. */
export function bundleSaving(pricing: BundlePricing, components: BundleComponent[]): number | null {
  const sum = componentsSum(components);
  const price = bundlePrice(pricing, components);
  if (sum == null || price == null) return null;
  return Math.max(0, sum - price);
}

/** How many whole bundles current stock can make. 0 if any component is short or unavailable. */
export function bundleAvailability(components: BundleComponent[]): number {
  if (!components.length) return 0;
  let n = Infinity;
  for (const c of components) {
    if (!c.available) return 0;
    n = Math.min(n, Math.floor(c.stock / c.quantity));
  }
  return n;
}

// ------------------------------------------------------------------ cart totals

export interface LineForTotals {
  quantity: number;
  /** Snapshot list price per unit (item: tier-applied; bundle: bundle price). null = make an offer. */
  listUnitPrice: number | null;
  /** Buyer's proposed price per unit, if any. */
  proposedUnitPrice: number | null;
}

export interface CartTotals {
  /** Sum of list prices for lines that have one. */
  listTotal: number;
  /** Lines with no list price (make an offer). */
  offerLines: number;
  /** What the buyer proposes: proposed price where given, else list price. null if an offer line lacks a proposal. */
  proposedTotal: number | null;
}

export function cartTotals(lines: LineForTotals[]): CartTotals {
  let listTotal = 0;
  let offerLines = 0;
  let proposed: number | null = 0;
  for (const l of lines) {
    if (l.listUnitPrice == null) offerLines++;
    else listTotal += l.listUnitPrice * l.quantity;
    const unit = l.proposedUnitPrice ?? l.listUnitPrice;
    if (unit == null) proposed = null;
    else if (proposed != null) proposed += unit * l.quantity;
  }
  return { listTotal, offerLines, proposedTotal: proposed };
}

// ------------------------------------------------------------------ validation (server-enforced)

/** Tiers: whole min quantities ≥ 2, unique, non-negative prices, and only when the item has a price. */
export function validateTiers(price: number | null, tiers: Tier[]): string | null {
  if (!tiers.length) return null;
  if (price == null) return 'Price tiers need a base price. Set a price first, or remove the tiers.';
  const seen = new Set<number>();
  for (const t of tiers) {
    if (!Number.isInteger(t.minQty) || t.minQty < 2 || t.minQty > 1_000_000) return 'Tier quantities must be whole numbers, 2 or more.';
    if (!Number.isInteger(t.unitPrice) || t.unitPrice < 0) return 'Tier prices must be positive amounts.';
    if (seen.has(t.minQty)) return `Two tiers start at ${t.minQty}.`;
    seen.add(t.minQty);
  }
  if (tiers.length > 10) return 'At most 10 tiers.';
  return null;
}

/** percent_off bundles need every component priced; otherwise the bundle must be fixed-price. */
export function validateBundlePricing(pricing: BundlePricing, componentPrices: (number | null)[]): string | null {
  if (pricing.mode === 'fixed') {
    if (!Number.isInteger(pricing.fixedPrice) || pricing.fixedPrice < 0) return 'Enter a bundle price.';
    return null;
  }
  if (!Number.isInteger(pricing.percentOff) || pricing.percentOff < 0 || pricing.percentOff > 100) {
    return 'Percent off must be a whole number from 0 to 100.';
  }
  if (componentPrices.some((p) => p == null)) {
    return 'Percent off needs every item in the bundle to have a price. Use a fixed bundle price instead.';
  }
  return null;
}
