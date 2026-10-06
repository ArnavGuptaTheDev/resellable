import { describe, expect, it } from 'vitest';
import { DEAL_STATUSES, denyReason, isMyTurn, nextStatus, type DealAction, type DealState, type DealStatus, type Side } from '../shared/deals';

const st = (status: DealStatus, extra: Partial<DealState> = {}): DealState => ({
  status,
  liveOfferBy: null,
  fulfilmentMethod: null,
  lineCount: 1,
  ...extra,
});
const can = (a: DealAction, s: DealState, side: Side) => denyReason(a, s, side) === null;

describe('deal state machine', () => {
  it('happy path transitions', () => {
    expect(nextStatus('submit', st('cart'))).toBe('submitted');
    expect(nextStatus('offer', st('submitted'))).toBe('negotiating');
    expect(nextStatus('offer', st('negotiating'))).toBe('negotiating');
    expect(nextStatus('edit_lines', st('submitted'))).toBe('negotiating');
    expect(nextStatus('accept', st('negotiating'))).toBe('agreed');
    expect(nextStatus('mark_paid', st('agreed'))).toBe('paid');
    expect(nextStatus('mark_fulfilled', st('paid'))).toBe('fulfilled');
    expect(nextStatus('complete', st('fulfilled'))).toBe('completed');
  });

  it('only the buyer submits a non-empty cart', () => {
    expect(can('submit', st('cart'), 'buyer')).toBe(true);
    expect(can('submit', st('cart'), 'seller')).toBe(false);
    expect(can('submit', st('cart', { lineCount: 0 }), 'buyer')).toBe(false);
    expect(can('submit', st('submitted'), 'buyer')).toBe(false);
  });

  it('only the party who did NOT make the live offer can accept it', () => {
    const byBuyer = st('submitted', { liveOfferBy: 'buyer' });
    expect(can('accept', byBuyer, 'seller')).toBe(true);
    expect(can('accept', byBuyer, 'buyer')).toBe(false);
    const bySeller = st('negotiating', { liveOfferBy: 'seller' });
    expect(can('accept', bySeller, 'buyer')).toBe(true);
    expect(can('accept', bySeller, 'seller')).toBe(false);
    // Voided by a cart edit: nobody can accept until a new offer.
    expect(can('accept', st('negotiating'), 'buyer')).toBe(false);
    expect(can('accept', st('negotiating'), 'seller')).toBe(false);
  });

  it('either side counters while open; not before submit or after agreement', () => {
    for (const side of ['buyer', 'seller'] as const) {
      expect(can('offer', st('submitted'), side)).toBe(true);
      expect(can('offer', st('negotiating'), side)).toBe(true);
      expect(can('offer', st('cart'), side)).toBe(false);
      expect(can('offer', st('agreed'), side)).toBe(false);
    }
    expect(can('offer', st('negotiating', { lineCount: 0 }), 'buyer')).toBe(false);
  });

  it('line edits: buyer in cart, both while open, nobody after agreement', () => {
    expect(can('edit_lines', st('cart'), 'buyer')).toBe(true);
    expect(can('edit_lines', st('cart'), 'seller')).toBe(false);
    expect(can('edit_lines', st('negotiating'), 'seller')).toBe(true);
    expect(can('edit_lines', st('agreed'), 'buyer')).toBe(false);
  });

  it('seller marks paid then fulfilled (needs a method); buyer completes', () => {
    expect(can('mark_paid', st('agreed'), 'seller')).toBe(true);
    expect(can('mark_paid', st('agreed'), 'buyer')).toBe(false);
    expect(can('mark_paid', st('negotiating'), 'seller')).toBe(false);
    expect(can('mark_fulfilled', st('paid'), 'seller')).toBe(false);
    expect(can('mark_fulfilled', st('paid', { fulfilmentMethod: 'shipping' }), 'seller')).toBe(true);
    expect(can('mark_fulfilled', st('agreed', { fulfilmentMethod: 'shipping' }), 'seller')).toBe(false);
    expect(can('complete', st('fulfilled'), 'buyer')).toBe(true);
    expect(can('complete', st('fulfilled'), 'seller')).toBe(false);
  });

  it('cancel is reachable from every state before fulfilled, and no later', () => {
    const before: DealStatus[] = ['cart', 'submitted', 'negotiating', 'agreed', 'paid'];
    for (const s of DEAL_STATUSES) {
      expect(can('cancel', st(s), 'buyer')).toBe(before.includes(s));
    }
    expect(can('cancel', st('cart'), 'seller')).toBe(false); // seller never sees carts
    expect(can('cancel', st('paid'), 'seller')).toBe(true);
  });

  it('fulfilment details after agreement only', () => {
    expect(can('set_fulfilment', st('agreed'), 'buyer')).toBe(true);
    expect(can('set_fulfilment', st('paid'), 'seller')).toBe(true);
    expect(can('set_fulfilment', st('negotiating'), 'seller')).toBe(false);
    expect(can('set_fulfilment', st('fulfilled'), 'seller')).toBe(false);
  });

  it('whose turn it is', () => {
    expect(isMyTurn(st('submitted', { liveOfferBy: 'buyer' }), 'seller')).toBe(true);
    expect(isMyTurn(st('submitted', { liveOfferBy: 'buyer' }), 'buyer')).toBe(false);
    expect(isMyTurn(st('paid'), 'seller')).toBe(true);
    expect(isMyTurn(st('fulfilled'), 'buyer')).toBe(true);
    expect(isMyTurn(st('completed'), 'buyer')).toBe(false);
  });
});
