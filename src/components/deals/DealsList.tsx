import { useEffect, useState } from 'preact/hooks';
import { DEAL_STATUS_LABELS } from '../../../shared/deals';
import type { DealSummary } from '../../../shared/dealTypes';
import { formatMoney } from '../../../shared/money';
import { canSell } from '../../../shared/roles';
import { api, errorMessage } from '../../lib/api';
import { getSession } from '../../lib/session';
import { useToasts } from '../sell/fields';
import { Img } from '../shop/bits';

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(ms: number) {
  const mins = Math.round((ms - Date.now()) / 60000);
  if (Math.abs(mins) < 60) return rtf.format(mins, 'minute');
  const hrs = Math.round(mins / 60);
  if (Math.abs(hrs) < 24) return rtf.format(hrs, 'hour');
  return rtf.format(Math.round(hrs / 24), 'day');
}

export default function DealsList() {
  const [as, setAs] = useState<'buying' | 'selling'>(new URLSearchParams(location.search).get('as') === 'selling' ? 'selling' : 'buying');
  const [seller, setSeller] = useState(false);
  const [deals, setDeals] = useState<DealSummary[] | null>(null);
  const toast = useToasts();

  useEffect(() => {
    void getSession().then((s) => setSeller(!!s && canSell(s.user.role)));
  }, []);

  useEffect(() => {
    setDeals(null);
    history.replaceState(null, '', as === 'selling' ? '?as=selling' + location.hash : location.pathname + location.hash);
    api<{ deals: DealSummary[] }>(`/api/deals?as=${as}`)
      .then((r) => setDeals(r.deals))
      .catch((err) => toast.push({ kind: 'error', text: errorMessage(err) }));
  }, [as]);

  const open = (deals ?? []).filter((d) => !['completed', 'cancelled'].includes(d.status));
  const closed = (deals ?? []).filter((d) => ['completed', 'cancelled'].includes(d.status));

  return (
    <div class="deals-list">
      <div class="toolbar-row">
        {seller && (
          <div class="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={as === 'buying'} class={`chip ${as === 'buying' ? 'on' : ''}`} onClick={() => setAs('buying')}>
              Buying
            </button>
            <button type="button" role="tab" aria-selected={as === 'selling'} class={`chip ${as === 'selling' ? 'on' : ''}`} onClick={() => setAs('selling')}>
              Selling
            </button>
          </div>
        )}
        <a class="btn btn-ghost" href="/cart">
          Cart
        </a>
      </div>

      {!deals ? (
        <p class="muted">Loading…</p>
      ) : deals.length === 0 ? (
        <div class="panel empty">
          <h2>No deals yet</h2>
          <p class="muted">{as === 'buying' ? 'Send a cart to a seller to start one.' : 'Deals appear here when buyers send you their carts.'}</p>
        </div>
      ) : (
        <>
          <DealRows list={open} />
          {closed.length > 0 && (
            <details class="closed">
              <summary>Completed &amp; cancelled ({closed.length})</summary>
              <DealRows list={closed} />
            </details>
          )}
        </>
      )}

      {as === 'selling' && seller && <PaymentNote onToast={toast.push} />}
      {toast.view}
    </div>
  );
}

function DealRows({ list }: { list: DealSummary[] }) {
  return (
    <ul class="deal-rows">
      {list.map((d) => (
        <li key={d.id}>
          <a class={`deal-row ${d.needsAttention ? 'attention' : ''}`} href={`/deal?id=${d.id}`}>
            <span class="dr-thumbs" aria-hidden="true">
              {d.thumbs.length ? d.thumbs.map((t) => <Img key={t} src={t} alt="" />) : <Img src={null} alt="" />}
            </span>
            <span class="dr-main">
              <strong>
                {d.needsAttention && <span class="unread-dot" aria-label="Needs you" />}
                {d.other.name ?? (d.me === 'buyer' ? 'Seller' : 'Buyer')}
              </strong>
              <span class="muted small">
                #{d.id} · {d.lineCount} line{d.lineCount === 1 ? '' : 's'} · {ago(d.lastActivityAt)}
              </span>
            </span>
            <span class="dr-side">
              <span class={`tag deal-status s-${d.status}`}>{DEAL_STATUS_LABELS[d.status]}</span>
              {d.amount != null && (
                <span class="num small">
                  {formatMoney(d.amount)} <span class="muted">{d.amountLabel}</span>
                </span>
              )}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Seller's free-text "how to pay" (e.g. UPI ID), shown on agreed deals. */
function PaymentNote({ onToast }: { onToast: ReturnType<typeof useToasts>['push'] }) {
  const [note, setNote] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  useEffect(() => {
    void getSession().then((s) => {
      setNote(s?.user.paymentNote ?? '');
      setSaved(s?.user.paymentNote ?? '');
    });
  }, []);
  if (note === null) return null;
  return (
    <section class="panel" id="payment">
      <h2 class="section-title">How buyers pay you</h2>
      <p class="muted small">Shown to buyers once a price is agreed. For example: UPI ID, bank transfer details, or "cash on pickup".</p>
      <textarea rows={3} maxLength={500} value={note} placeholder="UPI: yourname@bank" onInput={(e) => setNote(e.currentTarget.value)} />
      <button
        type="button"
        class="btn"
        disabled={note === saved}
        onClick={async () => {
          try {
            await api('/api/me', { method: 'PATCH', body: { paymentNote: note || null } });
            setSaved(note);
            onToast({ kind: 'ok', text: 'Saved.' });
          } catch (err) {
            onToast({ kind: 'error', text: errorMessage(err) });
          }
        }}
      >
        Save
      </button>
    </section>
  );
}
