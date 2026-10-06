import { CURRENCY, LOCALE, MINOR_PER_MAJOR } from './config';

const whole = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY, maximumFractionDigits: 0 });
const fractional = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY, minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 35000 → "₹350"; 35050 → "₹350.50" (never "₹350.5"). */
export function formatMoney(minor: number): string {
  return (minor % MINOR_PER_MAJOR === 0 ? whole : fractional).format(minor / MINOR_PER_MAJOR);
}

/** Major units for an input field: 35050 → "350.50", 35000 → "350". */
export function toMajorString(minor: number | null | undefined): string {
  if (minor == null) return '';
  const major = minor / MINOR_PER_MAJOR;
  return Number.isInteger(major) ? String(major) : major.toFixed(2);
}

/**
 * Parses user input in major units ("350", "350.5", "1,200", "₹ 99") to minor
 * units. '' → null. Returns NaN for anything invalid.
 */
export function parseMoney(input: string): number | null {
  const s = input.replace(/[₹,\s]/g, '');
  if (s === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * MINOR_PER_MAJOR + Number(frac.padEnd(2, '0'));
}
