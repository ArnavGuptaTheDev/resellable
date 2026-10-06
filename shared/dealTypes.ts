import type { DealStatus, Side } from './deals';
import type { CartTotals } from './pricing';

export interface DealLineView {
  id: number;
  kind: 'item' | 'bundle';
  refId: number;
  title: string;
  thumbUrl: string | null;
  quantity: number;
  /** Snapshot list price per unit; null = make an offer. */
  listUnitPrice: number | null;
  proposedUnitPrice: number | null;
  /** Current stock (items) or whole bundles available now. */
  available: number;
  /** Current list unit price at this quantity, to flag changes since the snapshot. */
  currentUnitPrice: number | null;
  removedAt: number | null;
}

/** Stock taken at agreement (deal_stock_moves); bundle contents as they were then. */
export interface ReservedView {
  lineId: number;
  bundleId: number | null;
  itemId: number;
  title: string;
  perUnit: number;
  quantity: number;
  restoredAt: number | null;
}

export interface OfferView {
  id: number;
  by: Side;
  amount: number;
  message: string | null;
  createdAt: number;
}

export type TimelineEntry =
  | { type: 'offer'; at: number; id: string; by: Side; offer: OfferView; state: 'live' | 'superseded' | 'voided' | 'accepted' }
  | { type: 'message'; at: number; id: string; by: Side; body: string }
  | { type: 'event'; at: number; id: string; by: Side | null; kind: string; data: Record<string, unknown> };

export interface DealView {
  id: number;
  status: DealStatus;
  me: Side;
  buyer: { id: number; name: string | null };
  seller: { id: number; name: string | null };
  lines: DealLineView[];
  totals: CartTotals;
  liveOffer: OfferView | null;
  agreedTotal: number | null;
  fulfilmentMethod: 'shipping' | 'pickup' | null;
  fulfilmentNotes: string | null;
  /** Seller's "how to pay" note; shown once agreed. */
  paymentNote: string | null;
  reserved: ReservedView[];
  timeline: TimelineEntry[];
  updatedAt: number;
}

export interface DealSummary {
  id: number;
  status: DealStatus;
  me: Side;
  other: { id: number; name: string | null };
  lineCount: number;
  thumbs: string[];
  /** Agreed total, else live offer, else proposed total. */
  amount: number | null;
  amountLabel: 'agreed' | 'offer' | 'proposed';
  needsAttention: boolean;
  lastActivityAt: number;
}

export interface CartView {
  dealId: number;
  seller: { id: number; name: string | null };
  lines: DealLineView[];
  totals: CartTotals;
  updatedAt: number;
}
