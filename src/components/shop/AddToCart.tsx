import { useState } from 'preact/hooks';
import { formatMoney, parseMoney } from '../../../shared/money';
import { unitPriceFor, type Tier } from '../../../shared/pricing';
import { api, errorMessage } from '../../lib/api';
import { notifyCartChanged } from '../../lib/badges';
import { MoneyInput, QuantityStepper } from '../sell/fields';

interface Props {
  kind: 'item' | 'bundle';
  refId: number;
  /** Unit price (bundle price for bundles); null = make an offer. */
  price: number | null;
  tiers?: Tier[];
  available: number;
  own: boolean;
}

/**
 * Quantity + (for make-an-offer items) the price the buyer would pay.
 * Priced items can optionally carry a proposed lower price per unit.
 */
export default function AddToCart({ kind, refId, price, tiers = [], available, own }: Props) {
  const [qty, setQty] = useState(1);
  const [offer, setOffer] = useState('');
  const [propose, setPropose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (own) return <p class="muted small">This is your listing.</p>;
  if (available <= 0) return <p class="tag tag-danger block">{kind === 'bundle' ? 'Unavailable right now.' : 'Out of stock.'}</p>;

  const unit = kind === 'item' ? unitPriceFor({ price, tiers }, qty) : price;
  const needsOffer = unit == null;
  const parsed = parseMoney(offer);
  const offerBad = (needsOffer || propose) && offer !== '' && Number.isNaN(parsed);

  async function add() {
    if (needsOffer && (parsed == null || Number.isNaN(parsed))) {
      setMsg({ ok: false, text: 'Enter the price you would pay per unit.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await api<{ dealId: number; cartUnits: number; deals: number }>('/api/cart/lines', {
        method: 'POST',
        body: {
          [kind === 'item' ? 'itemId' : 'bundleId']: refId,
          quantity: qty,
          proposedUnitPrice: needsOffer || (propose && offer) ? parsed : null,
        },
      });
      notifyCartChanged(res);
      setMsg({ ok: true, text: `Added ${qty} to your cart.` });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="buy-box">
      <div class="buy-row">
        <label class="field">
          <span>Quantity</span>
          <QuantityStepper value={qty} onChange={(n) => setQty(Math.min(Math.max(1, n), available))} />
        </label>
        {needsOffer ? (
          <label class="field">
            <span>Your price each</span>
            <MoneyInput value={offer} onInput={setOffer} placeholder="your offer" />
          </label>
        ) : (
          <div class="field">
            <span>{qty > 1 ? `${qty} × ${formatMoney(unit!)}` : 'Price'}</span>
            <strong class="num buy-total">{formatMoney(unit! * qty)}</strong>
          </div>
        )}
      </div>
      {!needsOffer && (
        <label class="check small">
          <input type="checkbox" checked={propose} onChange={(e) => setPropose(e.currentTarget.checked)} />
          <span>Propose a different price</span>
        </label>
      )}
      {propose && !needsOffer && (
        <label class="field">
          <span>Your price each</span>
          <MoneyInput value={offer} onInput={setOffer} placeholder={String((unit ?? 0) / 100)} />
        </label>
      )}
      {offerBad && <p class="field-error">Enter an amount like 300 or 299.50.</p>}
      <button type="button" class="btn buy-btn" disabled={busy || offerBad} onClick={() => void add()}>
        {busy ? 'Adding…' : 'Add to cart'}
      </button>
      {msg && (
        <p class={`tag block ${msg.ok ? 'tag-ok' : 'tag-danger'}`} role="status">
          {msg.text} {msg.ok && <a href="/cart">View cart →</a>}
        </p>
      )}
      <p class="muted small">Nothing is charged. You agree a price with the seller, then pay them directly.</p>
    </div>
  );
}
