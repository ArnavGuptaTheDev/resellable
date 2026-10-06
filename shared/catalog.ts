import type { Condition, ItemStatus, Photo } from './items';
import type { Tier } from './pricing';

export interface SellerRef {
  id: number;
  name: string | null;
}

/** A card in browse results. */
export interface CatalogCard {
  id: number;
  title: string;
  category: string | null;
  condition: Condition;
  quantity: number;
  price: number | null;
  tiers: Tier[];
  status: ItemStatus;
  coverThumbUrl: string | null;
  seller: SellerRef;
}

export interface BundleComponentView {
  itemId: number;
  title: string;
  /** Units per bundle. */
  quantity: number;
  /** Tier-applied unit price at that quantity; null = no price. */
  unitPrice: number | null;
  stock: number;
  status: ItemStatus;
  thumbUrl: string | null;
}

export interface BundleView {
  id: number;
  seller: SellerRef;
  title: string;
  description: string | null;
  pricingMode: 'fixed' | 'percent_off';
  fixedPrice: number | null;
  percentOff: number | null;
  status: 'listed' | 'hidden';
  coverPhotoId: number | null;
  coverUrl: string | null;
  coverThumbUrl: string | null;
  /** Price of one bundle; null only for a percent_off bundle whose component lost its price. */
  price: number | null;
  componentsSum: number | null;
  saving: number | null;
  /** Whole bundles current stock can make. */
  available: number;
  components: BundleComponentView[];
}

export interface CatalogItemDetail {
  id: number;
  title: string;
  description: string | null;
  category: string | null;
  tags: string[];
  condition: Condition;
  quantity: number;
  price: number | null;
  tiers: Tier[];
  status: ItemStatus;
  photos: Photo[];
  seller: SellerRef;
  bundles: { id: number; title: string; price: number | null; available: number }[];
  updatedAt: number;
}
