/**
 * App-wide config shared by the UI and the Worker. Edit values here.
 */

/** Single app-wide currency. Money is stored as integer minor units. */
export const CURRENCY = 'INR';
export const LOCALE = 'en-IN';
export const MINOR_PER_MAJOR = 100; // paise per rupee

/** Uploads. The browser resizes before upload; the Worker enforces these. */
export const UPLOAD = {
  maxPhotosPerItem: 10,
  mainMaxPx: 1600,
  thumbMaxPx: 400,
  mainMaxBytes: 2 * 1024 * 1024,
  thumbMaxBytes: 200 * 1024,
  /** WebP preferred; JPEG accepted for browsers that can't encode WebP. */
  types: ['image/webp', 'image/jpeg'] as const,
  mainQuality: 0.82,
  thumbQuality: 0.75,
};

/** Field limits for items. */
export const LIMITS = {
  title: 120,
  description: 4000,
  category: 60,
  tag: 32,
  tags: 20,
  maxQuantity: 1_000_000,
  maxPrice: 100_000_000_00, // ₹10 crore in paise
};
