import { describe, expect, it } from 'vitest';
import { normalizeTags, validateItem } from '../shared/items';
import { formatMoney, parseMoney, toMajorString } from '../shared/money';
import { sniffImageType } from '../worker/lib/images';
import { ftsQuery } from '../worker/lib/items';

describe('money', () => {
  it('parses major units into paise', () => {
    expect(parseMoney('350')).toBe(35000);
    expect(parseMoney('349.5')).toBe(34950);
    expect(parseMoney('₹ 1,200.05')).toBe(120005);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('  ')).toBeNull();
  });

  it('rejects junk', () => {
    for (const bad of ['abc', '-5', '1.234', '1e3', '.5']) expect(parseMoney(bad)).toBeNaN();
  });

  it('formats', () => {
    expect(toMajorString(35000)).toBe('350');
    expect(toMajorString(34950)).toBe('349.50');
    expect(toMajorString(null)).toBe('');
    expect(formatMoney(35000)).toBe('₹350');
    expect(formatMoney(34950)).toBe('₹349.50');
    expect(formatMoney(12345678)).toBe('₹1,23,456.78');
  });
});

describe('items', () => {
  it('normalizes tags', () => {
    expect(normalizeTags(' ESP32, Wi-Fi ,esp32,, ')).toEqual(['esp32', 'wi-fi']);
    expect(normalizeTags(['A  b', 'a b'])).toEqual(['a b']);
    expect(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(20);
  });

  it('drafts may be untitled; listed items need a title', () => {
    expect(validateItem({ title: '' }, { title: '', status: 'draft' })).toEqual({});
    expect(validateItem({ status: 'listed' }, { title: '  ', status: 'listed' }).title).toBeTruthy();
    expect(validateItem({ status: 'listed' }, { title: 'ESP32', status: 'listed' })).toEqual({});
  });

  it('validates numbers and enums', () => {
    const f = { title: 'x', status: 'draft' as const };
    expect(validateItem({ quantity: -1 }, f).quantity).toBeTruthy();
    expect(validateItem({ quantity: 1.5 }, f).quantity).toBeTruthy();
    expect(validateItem({ price: -1 }, f).price).toBeTruthy();
    expect(validateItem({ price: null }, f)).toEqual({});
    expect(validateItem({ condition: 'mint' as never }, f).condition).toBeTruthy();
    expect(validateItem({ status: 'deleted' as never }, f).status).toBeTruthy();
  });
});

describe('search', () => {
  it('builds a safe prefix query', () => {
    expect(ftsQuery('ESP32 wifi')).toBe('"esp32"* "wifi"*');
    expect(ftsQuery('" OR * NEAR(')).toBe('"or"* "near"*');
    expect(ftsQuery('   ')).toBeNull();
    expect(ftsQuery(undefined)).toBeNull();
  });
});

describe('image sniffing', () => {
  const webp = Uint8Array.from(atob('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='), (c) => c.charCodeAt(0));
  it('detects by magic bytes', () => {
    expect(sniffImageType(webp)).toBe('image/webp');
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // PNG not accepted
  });
});
