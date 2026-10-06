import { useEffect, useState } from 'preact/hooks';
import type { CartView } from '../../../shared/dealTypes';
import { formatMoney, parseMoney } from '../../../shared/money';
import { api, errorMessage } from '../../lib/api';
import { notifyCartChanged } from '../../lib/badges';
import { MoneyInput, useToasts } from '../sell/fields';
import { Lines, Totals } from './Lines';

/** One cart per seller. Each is submitted separately as a deal with an opening offer. */
export default function CartPage() {
  const [carts, setCarts] = useState<CartView[] | null>(null);
  const toast = useToasts();

  async function load() {
    try {
      setCarts((await api<{ carts: CartView[] }>('/api/cart')).carts);
    } catch (err) {
      toast.push({ kind: 'error', text: errorMessage(err) });
    }
  }
  useEffect(() => {
    void load();
  }, []);

  if (!carts) return <p class="muted">Loading…</p>;
  if (!carts.length) {
    return (
      <div class="panel empty">
        <h2>Your cart is empty</h2>
        <p class="muted">Add items or bundles from a seller, then send the whole cart with your offer.</p>
        <a class="btn" href="/">Browse</a>
      </div>
    );
  }
  return (
    <div class="carts">
      {carts.length > 1 && <p class="muted">You have carts with {carts.length} sellers. Each one becomes its own deal.</p>}
      {carts.map((c) => (
        <Cart key={c.dealId} cart={c} reload={load} onError={(t) => toast.push({ kind: 'error', text: t })} />
      ))}
      {toast.view}
    </div>
  );
}

function Cart({ cart, reload, onError }: { cart: CartView; reload: () => Promise<void>; onError: (t: string) => void }) {
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const call = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
      notifyCartChanged();
    } catch (err) {
      onError(errorMessage(err));
      await reload();
    }
  };
  const base = `/api/deals/${cart.dealId}/lines`;
  const parsed = parseMoney(amount);
  const opening = amount === '' ? cart.totals.proposedTotal : parsed;

  async function submit() {
    if (opening == null || Number.isNaN(opening)) return onError('Enter your offer for the whole cart.');
    setBusy(true);
    try {
      await api(`/api/deals/${cart.dealId}/submit`, { method: 'POST', body: { amount: opening, message: message || null } });
      notifyCartChanged();
      location.href = `/deal?id=${cart.dealId}`;
    } catch (err) {
      onError(errorMessage(err));
      setBusy(false);
      await reload();
    }
  }

  async function empty() {
    if (!confirm(`Remove everything from your cart with ${cart.seller.name ?? 'this seller'}?`)) return;
    await call(() => api(`/api/deals/${cart.dealId}/cancel`, { method: 'POST', body: {} }));
  }

  return (
    <section class="panel cart">
      <header class="cart-head">
        <h2>From {cart.seller.name ?? 'seller'}</h2>
        <button type="button" class="btn btn-ghost small-btn" onClick={() => void empty()}>
          Empty
        </button>
      </header>
      <Lines
        lines={cart.lines}
        editable
        canPropose
        onQty={(l, q) => call(() => api(`${base}/${l.id}`, { method: 'PATCH', body: { quantity: q } }))}
        onPropose={(l, p) => call(() => api(`${base}/${l.id}`, { method: 'PATCH', body: { proposedUnitPrice: p } }))}
        onRemove={(l) => call(() => api(`${base}/${l.id}`, { method: 'DELETE' }))}
      />
      <Totals {...cart.totals} />

      <div class="submit-box">
        <label class="field">
          <span>Your offer for the whole cart</span>
          <MoneyInput
            value={amount}
            onInput={setAmount}
            placeholder={cart.totals.proposedTotal != null ? String(cart.totals.proposedTotal / 100) : 'amount'}
          />
          <em class="field-hint">
            {cart.totals.proposedTotal != null ? `Leave empty to offer ${formatMoney(cart.totals.proposedTotal)}.` : 'Enter a price for each make-an-offer line, or an overall amount.'}
          </em>
        </label>
        <label class="field">
          <span>Message (optional)</span>
          <textarea rows={2} maxLength={2000} value={message} placeholder="Pickup this weekend works for me." onInput={(e) => setMessage(e.currentTarget.value)} />
        </label>
        <button type="button" class="btn" disabled={busy || opening == null || Number.isNaN(opening)} onClick={() => void submit()}>
          {busy ? 'Sending…' : `Send offer${opening != null && !Number.isNaN(opening) ? ` · ${formatMoney(opening)}` : ''}`}
        </button>
      </div>
    </section>
  );
}
