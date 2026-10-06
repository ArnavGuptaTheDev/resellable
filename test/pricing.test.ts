import { describe, expect, it } from 'vitest';
import {
  bundleAvailability,
  bundlePrice,
  bundleSaving,
  cartTotals,
  componentsSum,
  unitPriceFor,
  validateBundlePricing,
  validateTiers,
  type BundleComponent,
} from '../shared/pricing';

const esp32 = { price: 35000, tiers: [{ minQty: 5, unitPrice: 30000 }, { minQty: 10, unitPrice: 28000 }] };

describe('quantity tiers', () => {
  it('uses the base price below the first tier', () => {
    expect(unitPriceFor(esp32, 1)).toBe(35000);
    expect(unitPriceFor(esp32, 4)).toBe(35000);
  });

  it('uses the highest tier reached', () => {
    expect(unitPriceFor(esp32, 5)).toBe(30000);
    expect(unitPriceFor(esp32, 9)).toBe(30000);
    expect(unitPriceFor(esp32, 10)).toBe(28000);
    expect(unitPriceFor(esp32, 500)).toBe(28000);
  });

  it('does not depend on tier order', () => {
    const shuffled = { price: 35000, tiers: [esp32.tiers[1]!, esp32.tiers[0]!] };
    expect(unitPriceFor(shuffled, 7)).toBe(30000);
    expect(unitPriceFor(shuffled, 12)).toBe(28000);
  });

  it('is null for make-an-offer items', () => {
    expect(unitPriceFor({ price: null, tiers: [] }, 3)).toBeNull();
  });

  it('validates tiers: priced items only, min qty ≥ 2, unique', () => {
    expect(validateTiers(35000, esp32.tiers)).toBeNull();
    expect(validateTiers(35000, [])).toBeNull();
    expect(validateTiers(null, esp32.tiers)).toMatch(/base price/);
    expect(validateTiers(35000, [{ minQty: 1, unitPrice: 100 }])).toMatch(/2 or more/);
    expect(validateTiers(35000, [{ minQty: 2.5, unitPrice: 100 }])).toMatch(/whole/);
    expect(validateTiers(35000, [{ minQty: 5, unitPrice: -1 }])).toMatch(/positive/);
    expect(validateTiers(35000, [{ minQty: 5, unitPrice: 1 }, { minQty: 5, unitPrice: 2 }])).toMatch(/Two tiers/);
  });
});

const comp = (price: number | null, quantity: number, stock = 100, extra: Partial<BundleComponent> = {}): BundleComponent => ({
  price,
  tiers: [],
  quantity,
  stock,
  available: true,
  ...extra,
});

describe('bundles', () => {
  // Build a Robot: nano ₹220, sensor ₹60, driver ₹120, motors ₹160 ×2, chassis ₹300
  const robot = [comp(22000, 1), comp(6000, 1), comp(12000, 1), comp(16000, 2), comp(30000, 1)];

  it('sums components at their quantities', () => {
    expect(componentsSum(robot)).toBe(22000 + 6000 + 12000 + 32000 + 30000);
  });

  it('applies tier pricing to a component bought in quantity', () => {
    expect(componentsSum([{ ...esp32, quantity: 5, stock: 10, available: true }])).toBe(5 * 30000);
  });

  it('percent off the sum, rounded to the nearest paisa', () => {
    expect(bundlePrice({ mode: 'percent_off', percentOff: 15 }, robot)).toBe(86700);
    expect(bundlePrice({ mode: 'percent_off', percentOff: 33 }, [comp(1001, 1)])).toBe(671); // 670.67 → 671
    expect(bundleSaving({ mode: 'percent_off', percentOff: 15 }, robot)).toBe(102000 - 86700);
  });

  it('fixed price ignores the sum; saving never negative', () => {
    expect(bundlePrice({ mode: 'fixed', fixedPrice: 99900 }, robot)).toBe(99900);
    expect(bundleSaving({ mode: 'fixed', fixedPrice: 99900 }, robot)).toBe(102000 - 99900);
    expect(bundleSaving({ mode: 'fixed', fixedPrice: 200000 }, robot)).toBe(0);
  });

  it('a fixed bundle may contain make-an-offer items; percent off may not', () => {
    const withOffer = [...robot, comp(null, 1)];
    expect(bundlePrice({ mode: 'fixed', fixedPrice: 50000 }, withOffer)).toBe(50000);
    expect(componentsSum(withOffer)).toBeNull();
    expect(bundleSaving({ mode: 'fixed', fixedPrice: 50000 }, withOffer)).toBeNull();
    expect(validateBundlePricing({ mode: 'percent_off', percentOff: 10 }, [100, null])).toMatch(/every item/);
    expect(validateBundlePricing({ mode: 'percent_off', percentOff: 10 }, [100, 200])).toBeNull();
    expect(validateBundlePricing({ mode: 'fixed', fixedPrice: 500 }, [100, null])).toBeNull();
    expect(validateBundlePricing({ mode: 'percent_off', percentOff: 101 }, [100])).toMatch(/0 to 100/);
    expect(validateBundlePricing({ mode: 'fixed', fixedPrice: Number.NaN }, [100])).toMatch(/price/);
  });

  it('availability is limited by the scarcest component', () => {
    expect(bundleAvailability([comp(1, 1, 5), comp(1, 2, 5)])).toBe(2);
    expect(bundleAvailability([comp(1, 1, 5), comp(1, 2, 1)])).toBe(0); // short → unavailable
    expect(bundleAvailability([comp(1, 1, 5, { available: false })])).toBe(0);
    expect(bundleAvailability([])).toBe(0);
  });
});

describe('cart totals', () => {
  it('list total, proposed total and offer lines', () => {
    const t = cartTotals([
      { quantity: 5, listUnitPrice: 30000, proposedUnitPrice: null }, // tiered ESP32 ×5
      { quantity: 1, listUnitPrice: 86700, proposedUnitPrice: 80000 }, // bundle, buyer proposes less
      { quantity: 2, listUnitPrice: null, proposedUnitPrice: 5000 }, // make an offer
    ]);
    expect(t.listTotal).toBe(150000 + 86700);
    expect(t.offerLines).toBe(1);
    expect(t.proposedTotal).toBe(150000 + 80000 + 10000);
  });

  it('proposed total is unknown while an offer line has no proposal', () => {
    expect(cartTotals([{ quantity: 1, listUnitPrice: null, proposedUnitPrice: null }]).proposedTotal).toBeNull();
  });

  it('empty cart', () => {
    expect(cartTotals([])).toEqual({ listTotal: 0, offerLines: 0, proposedTotal: 0 });
  });
});
