import { useEffect, useRef, useState } from 'preact/hooks';
import { DEAL_STATUS_LABELS, denyReason, type DealAction, type DealState } from '../../../shared/deals';
import type { DealView, ReservedView, TimelineEntry } from '../../../shared/dealTypes';
import { formatMoney, parseMoney } from '../../../shared/money';
import { ApiError, api, errorMessage } from '../../lib/api';
import { notifyCartChanged } from '../../lib/badges';
import { MoneyInput, useToasts } from '../sell/fields';
import { Lines, Totals } from './Lines';

const POLL_MS = 4000;
const STEPS = ['submitted', 'negotiating', 'agreed', 'paid', 'fulfilled', 'completed'] as const;

export default function DealPage() {
  const id = Number(new URLSearchParams(location.search).get('id'));
  const [deal, setDeal] = useState<DealView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToasts();
  const version = useRef<number | null>(null);
  const seen = useRef(0); // timeline length last rendered (the poller closes over stale state)
  const timelineEnd = useRef<HTMLDivElement>(null);

  async function load(force = false) {
    try {
      const qs = !force && version.current != null ? `?since=${version.current}` : '';
      const res = await api<{ deal?: DealView; unchanged?: boolean }>(`/api/deals/${id}${qs}`);
      if (res.deal) {
        const grew = seen.current > 0 && seen.current < res.deal.timeline.length;
        seen.current = res.deal.timeline.length;
        version.current = res.deal.updatedAt;
        setDeal(res.deal);
        document.title = `Deal #${res.deal.id} · ${DEAL_STATUS_LABELS[res.deal.status]} · Resellable`;
        if (grew) requestAnimationFrame(() => timelineEnd.current?.scrollIntoView({ block: 'nearest' }));
        notifyCartChanged();
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
    }
  }

  // Poll while the tab is visible; refresh immediately when it becomes visible again.
  useEffect(() => {
    void load(true);
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), POLL_MS);
    const onVis = () => document.visibilityState === 'visible' && void load();
    // A push notification arrived while this page is open: fetch now instead of waiting for the next poll.
    const onPush = () => void load();
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('deal:refresh', onPush);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('deal:refresh', onPush);
    };
  }, [id]);

  if (notFound) {
    return (
      <div class="panel">
        <h2>Deal not found</h2>
        <a class="btn" href="/deals">All deals</a>
      </div>
    );
  }
  if (!deal) return <p class="muted">Loading…</p>;

  const state: DealState = {
    status: deal.status,
    liveOfferBy: deal.liveOffer?.by ?? null,
    fulfilmentMethod: deal.fulfilmentMethod,
    lineCount: deal.lines.filter((l) => l.removedAt == null).length,
  };
  const can = (a: DealAction) => denyReason(a, state, deal.me) === null;
  const other = deal.me === 'buyer' ? deal.seller : deal.buyer;

  async function act(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await fn();
      if (done) toast.push({ kind: 'ok', text: done });
    } catch (err) {
      toast.push({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
      await load(true);
    }
  }
  const post = (path: string, body: unknown = {}) => api(`/api/deals/${deal.id}/${path}`, { method: 'POST', body });
  const activeLines = deal.lines.filter((l) => l.removedAt == null);

  return (
    <div class="deal">
      <header class="deal-head">
        <div>
          <p class="eyebrow">
            Deal #{deal.id} · you are the {deal.me}
          </p>
          <h1 class="deal-title">
            {deal.me === 'buyer' ? 'Buying from' : 'Selling to'} {other.name ?? (deal.me === 'buyer' ? 'seller' : 'buyer')}
          </h1>
        </div>
        <span class={`tag deal-status s-${deal.status}`}>{DEAL_STATUS_LABELS[deal.status]}</span>
      </header>

      {deal.status !== 'cancelled' && (
        <ol class="steps" aria-label="Progress">
          {STEPS.map((s) => {
            const idx = STEPS.indexOf(s);
            const cur = STEPS.indexOf(deal.status as (typeof STEPS)[number]);
            return (
              <li key={s} class={idx < cur ? 'done' : idx === cur ? 'current' : ''} aria-current={idx === cur ? 'step' : undefined}>
                {DEAL_STATUS_LABELS[s]}
              </li>
            );
          })}
        </ol>
      )}

      <div class="deal-grid">
        <div class="deal-side">
          <section class="panel">
            <h2 class="section-title">
              {deal.reserved.length ? 'What was agreed' : 'Cart'} <span class="num muted">{activeLines.length}</span>
            </h2>
            {can('edit_lines') && <p class="muted small">Changing the cart withdraws the live offer; a new offer is needed after.</p>}
            <Lines
              lines={activeLines}
              editable={can('edit_lines')}
              canPropose={deal.me === 'buyer'}
              warnings={['submitted', 'negotiating'].includes(deal.status)}
              onQty={(l, q) => act(() => api(`/api/deals/${deal.id}/lines/${l.id}`, { method: 'PATCH', body: { quantity: q } }))}
              onPropose={(l, p) => act(() => api(`/api/deals/${deal.id}/lines/${l.id}`, { method: 'PATCH', body: { proposedUnitPrice: p } }))}
              onRemove={(l) =>
                confirm(`Remove "${l.title}" from this deal?`) ? act(() => api(`/api/deals/${deal.id}/lines/${l.id}`, { method: 'DELETE' })) : Promise.resolve()
              }
            />
            {!deal.reserved.length && <Totals {...deal.totals} />}
            {deal.reserved.length > 0 && <Reserved reserved={deal.reserved} lines={activeLines} />}
          </section>

          {(deal.status === 'submitted' || deal.status === 'negotiating') && (
            <OfferPanel deal={deal} canAccept={can('accept')} canOffer={can('offer')} busy={busy} act={act} post={post} />
          )}

          {['agreed', 'paid', 'fulfilled', 'completed'].includes(deal.status) && (
            <AgreedPanel deal={deal} can={can} busy={busy} act={act} post={post} />
          )}

          {can('cancel') && deal.status !== 'cart' && (
            <button
              type="button"
              class="btn btn-ghost danger cancel-btn"
              disabled={busy}
              onClick={() => {
                const reason = prompt(
                  deal.status === 'agreed' || deal.status === 'paid'
                    ? 'Cancel this agreed deal? Reserved stock goes back to the seller. Optional reason:'
                    : 'Cancel this deal? Optional reason:',
                );
                if (reason !== null) void act(() => post('cancel', { reason }), 'Deal cancelled.');
              }}
            >
              Cancel deal
            </button>
          )}
        </div>

        <section class="panel timeline-panel" aria-label="Timeline and chat">
          <h2 class="section-title">Timeline</h2>
          <ol class="timeline">
            {deal.timeline.map((e) => (
              <Entry key={e.id} e={e} me={deal.me} />
            ))}
          </ol>
          <div ref={timelineEnd} />
          {can('message') && <Composer onSend={(body) => act(() => post('messages', { body }))} />}
        </section>
      </div>
      {toast.view}
    </div>
  );
}

function OfferPanel({
  deal,
  canAccept,
  canOffer,
  busy,
  act,
  post,
}: {
  deal: DealView;
  canAccept: boolean;
  canOffer: boolean;
  busy: boolean;
  act: (fn: () => Promise<unknown>, done?: string) => Promise<void>;
  post: (path: string, body?: unknown) => Promise<unknown>;
}) {
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const live = deal.liveOffer;
  const parsed = parseMoney(amount);
  const valid = parsed != null && !Number.isNaN(parsed);

  return (
    <section class="panel offer-panel">
      <h2 class="section-title">Offer</h2>
      {live ? (
        <div class={`live-offer ${live.by === deal.me ? 'mine' : 'theirs'}`}>
          <p class="eyebrow">{live.by === deal.me ? 'Your offer · waiting for them' : 'Their offer · your move'}</p>
          <p class="offer-amount num">{formatMoney(live.amount)}</p>
          {live.message && <p class="offer-msg">“{live.message}”</p>}
          {canAccept && (
            <button
              type="button"
              class="btn accept-btn"
              disabled={busy}
              onClick={() => {
                if (confirm(`Agree to ${formatMoney(live.amount)} for the whole cart? Stock is reserved straight away.`)) {
                  void act(() => post('accept', { offerId: live.id }), 'Agreed!');
                }
              }}
            >
              Accept {formatMoney(live.amount)}
            </button>
          )}
        </div>
      ) : (
        <p class="tag tag-warn block">The cart changed, so the last offer was withdrawn. Either side can make a new one.</p>
      )}
      {canOffer && (
        <form
          class="counter"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            void act(async () => {
              await post('offers', { amount: parsed, message: message || null });
              setAmount('');
              setMessage('');
            }, 'Offer sent.');
          }}
        >
          <label class="field">
            <span>{live ? 'Counter-offer for the whole cart' : 'New offer for the whole cart'}</span>
            <MoneyInput value={amount} onInput={setAmount} placeholder={deal.totals.proposedTotal != null ? String(deal.totals.proposedTotal / 100) : 'amount'} />
          </label>
          <input type="text" maxLength={2000} placeholder="Message (optional)" value={message} onInput={(e) => setMessage(e.currentTarget.value)} />
          <button type="submit" class="btn btn-ghost" disabled={busy || !valid}>
            Send offer
          </button>
        </form>
      )}
    </section>
  );
}

function AgreedPanel({
  deal,
  can,
  busy,
  act,
  post,
}: {
  deal: DealView;
  can: (a: DealAction) => boolean;
  busy: boolean;
  act: (fn: () => Promise<unknown>, done?: string) => Promise<void>;
  post: (path: string, body?: unknown) => Promise<unknown>;
}) {
  const [method, setMethod] = useState<'shipping' | 'pickup' | null>(deal.fulfilmentMethod);
  const [notes, setNotes] = useState(deal.fulfilmentNotes ?? '');
  useEffect(() => {
    setMethod(deal.fulfilmentMethod);
    setNotes(deal.fulfilmentNotes ?? '');
  }, [deal.fulfilmentMethod, deal.fulfilmentNotes]);
  const dirty = method !== deal.fulfilmentMethod || notes !== (deal.fulfilmentNotes ?? '');

  return (
    <section class="panel agreed-panel">
      <h2 class="section-title">Agreed</h2>
      <p class="offer-amount num">{deal.agreedTotal != null ? formatMoney(deal.agreedTotal) : '—'}</p>

      <div class="pay-note">
        <p class="eyebrow">How to pay</p>
        {deal.paymentNote ? (
          <p class="mono">{deal.paymentNote}</p>
        ) : (
          <p class="muted small">
            {deal.me === 'seller' ? (
              <>
                You haven't added payment details. <a href="/deals?as=selling#payment">Add them</a> so buyers know how to pay.
              </>
            ) : (
              'The seller has not added payment details yet. Ask in the chat.'
            )}
          </p>
        )}
        <p class="muted small">Payment happens outside Resellable.</p>
      </div>

      {can('set_fulfilment') ? (
        <form
          class="fulfil"
          onSubmit={(e) => {
            e.preventDefault();
            if (method) void act(() => post('fulfilment', { method, notes }), 'Saved.');
          }}
        >
          <fieldset class="segmented">
            <legend>Hand-over</legend>
            {(['pickup', 'shipping'] as const).map((m) => (
              <label key={m}>
                <input type="radio" name="method" checked={method === m} onChange={() => setMethod(m)} />
                <span>{m === 'pickup' ? 'Pickup' : 'Shipping'}</span>
              </label>
            ))}
          </fieldset>
          <textarea rows={2} maxLength={1000} placeholder={method === 'shipping' ? 'Address, courier, tracking…' : 'Where and when…'} value={notes} onInput={(e) => setNotes(e.currentTarget.value)} />
          <button type="submit" class="btn btn-ghost" disabled={busy || !method || !dirty}>
            Save hand-over details
          </button>
        </form>
      ) : (
        deal.fulfilmentMethod && (
          <p>
            <strong>{deal.fulfilmentMethod === 'pickup' ? 'Pickup' : 'Shipping'}</strong>
            {deal.fulfilmentNotes && <span class="muted"> · {deal.fulfilmentNotes}</span>}
          </p>
        )
      )}

      <div class="next-steps">
        {can('mark_paid') && (
          <button type="button" class="btn" disabled={busy} onClick={() => confirm('Confirm you have received the payment?') && void act(() => post('paid'), 'Marked paid.')}>
            I've been paid
          </button>
        )}
        {deal.status === 'paid' && deal.me === 'seller' && (
          <button
            type="button"
            class="btn"
            disabled={busy || !can('mark_fulfilled')}
            title={can('mark_fulfilled') ? undefined : 'Choose pickup or shipping first'}
            onClick={() => void act(() => post('fulfilled'), 'Marked as handed over.')}
          >
            {deal.fulfilmentMethod === 'shipping' ? 'Mark shipped' : 'Mark picked up'}
          </button>
        )}
        {can('complete') && (
          <button type="button" class="btn" disabled={busy} onClick={() => void act(() => post('complete'), 'Thanks! Deal complete.')}>
            I received it
          </button>
        )}
        {deal.status === 'agreed' && deal.me === 'buyer' && <p class="muted small">Pay the seller, then they mark it paid.</p>}
        {deal.status === 'fulfilled' && deal.me === 'seller' && <p class="muted small">Waiting for the buyer to confirm they received it.</p>}
        {deal.status === 'completed' && <p class="tag tag-ok block">Completed.</p>}
      </div>
    </section>
  );
}

/** Contents taken from stock at agreement (deal_stock_moves): bundles as they were then. */
function Reserved({ reserved, lines }: { reserved: ReservedView[]; lines: DealView['lines'] }) {
  const bundleLines = lines.filter((l) => l.kind === 'bundle');
  if (!bundleLines.length) return null;
  return (
    <div class="reserved">
      {bundleLines.map((l) => {
        const parts = reserved.filter((r) => r.lineId === l.id);
        return (
          <details key={l.id} open>
            <summary>
              {l.title} ×{l.quantity}: contents at agreement
            </summary>
            <ul>
              {parts.map((p) => (
                <li key={p.itemId}>
                  <a href={`/item?id=${p.itemId}`}>{p.title}</a> <span class="num muted">
                    {p.perUnit} × {l.quantity} = {p.quantity}
                  </span>
                  {p.restoredAt && <span class="muted small"> · returned to stock</span>}
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}

const time = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function Entry({ e, me }: { e: TimelineEntry; me: 'buyer' | 'seller' }) {
  const who = (s: 'buyer' | 'seller' | null) => (s == null ? 'System' : s === me ? 'You' : s === 'buyer' ? 'Buyer' : 'Seller');
  if (e.type === 'message') {
    return (
      <li class={`t-msg ${e.by === me ? 'mine' : 'theirs'}`}>
        <p class="bubble">{e.body}</p>
        <span class="t-meta">
          {who(e.by)} · {time(e.at)}
        </span>
      </li>
    );
  }
  if (e.type === 'offer') {
    return (
      <li class={`t-offer ${e.by === me ? 'mine' : 'theirs'} ${e.state}`}>
        <p class="bubble">
          <span class="eyebrow">
            {who(e.by)} offered{e.state !== 'live' && ` · ${e.state}`}
          </span>
          <span class="num offer-line">{formatMoney(e.offer.amount)}</span>
          {e.offer.message && <span class="offer-msg">“{e.offer.message}”</span>}
        </p>
        <span class="t-meta">{time(e.at)}</span>
      </li>
    );
  }
  const d = e.data as Record<string, unknown>;
  let text: string;
  switch (e.kind) {
    case 'status':
      text = `${who(e.by)} → ${DEAL_STATUS_LABELS[d.to as keyof typeof DEAL_STATUS_LABELS] ?? String(d.to)}${d.reason ? ` (“${String(d.reason)}”)` : ''}`;
      break;
    case 'offer_voided':
      text = 'Cart changed: the live offer was withdrawn';
      break;
    case 'line_changed':
      text = `${who(e.by)} changed a line: quantity ${String(d.from)} → ${String(d.to)}`;
      break;
    case 'line_removed':
      text = `${who(e.by)} removed a line`;
      break;
    case 'fulfilment':
      text = `${who(e.by)} set hand-over: ${d.method === 'pickup' ? 'pickup' : 'shipping'}${d.notes ? ` (${String(d.notes)})` : ''}`;
      break;
    default:
      text = e.kind;
  }
  return (
    <li class="t-event">
      <span>{text}</span> <span class="t-meta">{time(e.at)}</span>
    </li>
  );
}

function Composer({ onSend }: { onSend: (body: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  return (
    <form
      class="composer"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setSending(true);
        await onSend(text.trim());
        setText('');
        setSending(false);
      }}
    >
      <label class="visually-hidden" for="chat">
        Message
      </label>
      <textarea
        id="chat"
        rows={1}
        maxLength={2000}
        placeholder="Message…"
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <button type="submit" class="btn" disabled={sending || !text.trim()}>
        Send
      </button>
    </form>
  );
}
