/**
 * Deal state machine, shared by the UI (which buttons to show) and the Worker
 * (which enforces it). Pure: covered by test/deals.test.ts.
 *
 *   cart → submitted → negotiating → agreed → paid → fulfilled → completed
 *   cancelled is reachable from any state before fulfilled.
 */

export const DEAL_STATUSES = ['cart', 'submitted', 'negotiating', 'agreed', 'paid', 'fulfilled', 'completed', 'cancelled'] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export const DEAL_STATUS_LABELS: Record<DealStatus, string> = {
  cart: 'Cart',
  submitted: 'Submitted',
  negotiating: 'Negotiating',
  agreed: 'Agreed',
  paid: 'Paid',
  fulfilled: 'Shipped / picked up',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export type Side = 'buyer' | 'seller';

export type DealAction =
  | 'add_line' // put something in the cart
  | 'edit_lines' // change quantity / proposed price, remove a line
  | 'submit' // buyer sends the cart with an opening offer
  | 'offer' // counter-offer (either side)
  | 'accept' // accept the live offer
  | 'set_fulfilment' // shipping / pickup + notes
  | 'mark_paid' // seller confirms payment received (off-platform)
  | 'mark_fulfilled' // seller: shipped or handed over
  | 'complete' // buyer confirms receipt
  | 'cancel'
  | 'message';

export interface DealState {
  status: DealStatus;
  /** Who made the live offer; null when there is none (never made, or voided by a cart edit). */
  liveOfferBy: Side | null;
  fulfilmentMethod: 'shipping' | 'pickup' | null;
  /** Active (not removed) lines. */
  lineCount: number;
}

const OPEN: DealStatus[] = ['submitted', 'negotiating'];
const CANCELLABLE: DealStatus[] = ['cart', 'submitted', 'negotiating', 'agreed', 'paid'];

/** null when `side` may do `action` in `state`; otherwise a human-readable reason. */
export function denyReason(action: DealAction, state: DealState, side: Side): string | null {
  const { status } = state;
  switch (action) {
    case 'add_line':
      return side === 'buyer' && status === 'cart' ? null : 'Items can only be added to an open cart.';
    case 'edit_lines':
      if (status === 'cart') return side === 'buyer' ? null : 'Only the buyer edits their cart.';
      return OPEN.includes(status) ? null : 'Lines can only change before the deal is agreed.';
    case 'submit':
      if (side !== 'buyer' || status !== 'cart') return 'Only the buyer can submit their cart.';
      return state.lineCount > 0 ? null : 'The cart is empty.';
    case 'offer':
      if (!OPEN.includes(status)) return 'Offers can only be made while negotiating.';
      return state.lineCount > 0 ? null : 'There is nothing left in this deal to make an offer on.';
    case 'accept':
      if (!OPEN.includes(status)) return 'There is no offer to accept.';
      if (!state.liveOfferBy) return 'There is no live offer. Make a new one after the cart change.';
      return state.liveOfferBy === side ? 'You made this offer; the other side has to accept it.' : null;
    case 'set_fulfilment':
      return status === 'agreed' || status === 'paid' ? null : 'Fulfilment is chosen after the price is agreed.';
    case 'mark_paid':
      if (side !== 'seller') return 'Only the seller marks the deal paid.';
      return status === 'agreed' ? null : 'Only an agreed deal can be marked paid.';
    case 'mark_fulfilled':
      if (side !== 'seller') return 'Only the seller marks the order shipped or picked up.';
      if (status !== 'paid') return 'Mark the deal paid first.';
      return state.fulfilmentMethod ? null : 'Choose shipping or pickup first.';
    case 'complete':
      if (side !== 'buyer') return 'Only the buyer confirms receipt.';
      return status === 'fulfilled' ? null : 'The order has not been shipped or picked up yet.';
    case 'cancel':
      if (status === 'cart' && side !== 'buyer') return 'Only the buyer can empty their cart.';
      return CANCELLABLE.includes(status) ? null : 'This deal can no longer be cancelled.';
    case 'message':
      return status === 'cart' ? 'Submit the cart to start chatting with the seller.' : null;
  }
}

/** Status after a permitted action. */
export function nextStatus(action: DealAction, state: DealState): DealStatus {
  switch (action) {
    case 'submit':
      return 'submitted';
    // Any move beyond the opening offer means negotiation has started.
    case 'offer':
    case 'edit_lines':
      return state.status === 'submitted' ? 'negotiating' : state.status;
    case 'accept':
      return 'agreed';
    case 'mark_paid':
      return 'paid';
    case 'mark_fulfilled':
      return 'fulfilled';
    case 'complete':
      return 'completed';
    case 'cancel':
      return 'cancelled';
    default:
      return state.status;
  }
}

/** Statuses at which stock has been taken and a cancel must put it back. */
export const STOCK_RESERVED: DealStatus[] = ['agreed', 'paid'];

/** Whether this side should act next (drives the unread / "needs you" indicator). */
export function isMyTurn(state: DealState, side: Side): boolean {
  switch (state.status) {
    case 'submitted':
    case 'negotiating':
      return state.liveOfferBy != null && state.liveOfferBy !== side;
    case 'agreed':
      // Buyer pays next; until fulfilment is chosen both sides have something to settle.
      return side === 'buyer' || !state.fulfilmentMethod;
    case 'paid':
      return side === 'seller';
    case 'fulfilled':
      return side === 'buyer';
    default:
      return false;
  }
}
