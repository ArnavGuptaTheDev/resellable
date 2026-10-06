/**
 * Header badges: units in carts and deals that need the user.
 * The Shell polls /api/deals/attention; components announce changes here.
 */
export interface Attention {
  deals: number;
  cartUnits: number;
}

export function renderBadges(a: Attention) {
  document.querySelectorAll<HTMLElement>('[data-badge="cart"]').forEach((el) => {
    el.textContent = a.cartUnits ? String(a.cartUnits) : '';
    el.hidden = !a.cartUnits;
  });
  document.querySelectorAll<HTMLElement>('[data-badge="deals"]').forEach((el) => {
    el.textContent = a.deals ? String(a.deals) : '';
    el.hidden = !a.deals;
  });
}

export function notifyCartChanged(a?: Attention) {
  if (a) renderBadges(a);
  document.dispatchEvent(new CustomEvent('attention:refresh'));
}
