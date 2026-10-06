import { useEffect, useState } from 'preact/hooks';
import type { DealLineView } from '../../../shared/dealTypes';
import { formatMoney, parseMoney, toMajorString } from '../../../shared/money';
import { MoneyInput } from '../sell/fields';
import { Img } from '../shop/bits';

interface Props {
  lines: DealLineView[];
  /** Editing allowed at all. */
  editable: boolean;
  /** Proposed price input shown (buyer only). */
  canPropose: boolean;
  onQty: (line: DealLineView, qty: number) => Promise<void>;
  onPropose: (line: DealLineView, price: number | null) => Promise<void>;
  onRemove: (line: DealLineView) => Promise<void>;
  /** Stock / price-change warnings. Off once stock is reserved (agreed and later). */
  warnings?: boolean;
}

/** Cart / deal lines with inline quantity, proposed price and remove. */
export function Lines(props: Props) {
  return (
    <ul class="deal-lines">
      {props.lines.map((l) => (
        <Line key={l.id} line={l} {...props} />
      ))}
    </ul>
  );
}

function Line({ line, editable, canPropose, onQty, onPropose, onRemove, warnings = true }: Props & { line: DealLineView }) {
  const [qty, setQty] = useState(String(line.quantity));
  const [proposed, setProposed] = useState(toMajorString(line.proposedUnitPrice));
  const [busy, setBusy] = useState(false);
  useEffect(() => setQty(String(line.quantity)), [line.quantity]);
  useEffect(() => setProposed(toMajorString(line.proposedUnitPrice)), [line.proposedUnitPrice]);

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const commitQty = () => {
    const n = parseInt(qty, 10);
    if (Number.isNaN(n) || n < 1 || n === line.quantity) return setQty(String(line.quantity));
    void wrap(() => onQty(line, n));
  };
  const commitProposed = () => {
    const p = parseMoney(proposed);
    if (Number.isNaN(p) || p === line.proposedUnitPrice) return setProposed(toMajorString(line.proposedUnitPrice));
    void wrap(() => onPropose(line, p));
  };

  const href = line.kind === 'item' ? `/item?id=${line.refId}` : `/bundle?id=${line.refId}`;
  const changed = warnings && line.currentUnitPrice != null && line.listUnitPrice != null && line.currentUnitPrice !== line.listUnitPrice;
  const short = warnings && line.quantity > line.available;
  const unit = line.proposedUnitPrice ?? line.listUnitPrice;

  return (
    <li class={`deal-line ${busy ? 'busy' : ''}`}>
      <a class="dl-thumb" href={href} tabIndex={-1} aria-hidden="true">
        <Img src={line.thumbUrl} alt="" />
      </a>
      <div class="dl-main">
        <a href={href} class="dl-title">
          {line.kind === 'bundle' && <span class="tag tag-accent">Bundle</span>} {line.title}
        </a>
        <span class="muted small">
          {line.listUnitPrice != null ? `${formatMoney(line.listUnitPrice)} each` : 'make an offer'}
          {line.proposedUnitPrice != null && line.listUnitPrice != null && <> · you propose {formatMoney(line.proposedUnitPrice)}</>}
        </span>
        {changed && <span class="small warn-text">Price now {formatMoney(line.currentUnitPrice!)} each</span>}
        {short && <span class="small danger-text">Only {line.available} available</span>}
      </div>
      <div class="dl-controls">
        {editable ? (
          <label>
            <span class="visually-hidden">Quantity</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              class="num dl-qty"
              value={qty}
              onInput={(e) => setQty(e.currentTarget.value)}
              onBlur={commitQty}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          </label>
        ) : (
          <span class="num dl-qty-static">×{line.quantity}</span>
        )}
        {editable && canPropose && (
          <label class="dl-propose">
            <span class="visually-hidden">Your price each</span>
            <MoneyInput compact value={proposed} onInput={setProposed} onBlur={commitProposed} placeholder={line.listUnitPrice != null ? 'propose' : 'required'} />
          </label>
        )}
        <span class="num dl-sum">{unit != null ? formatMoney(unit * line.quantity) : '—'}</span>
        {editable && (
          <button type="button" class="icon-btn" aria-label={`Remove ${line.title}`} disabled={busy} onClick={() => void wrap(() => onRemove(line))}>
            ×
          </button>
        )}
      </div>
    </li>
  );
}

export function Totals({ listTotal, offerLines, proposedTotal }: { listTotal: number; offerLines: number; proposedTotal: number | null }) {
  return (
    <dl class="totals">
      <div>
        <dt>List total</dt>
        <dd class="num">
          {formatMoney(listTotal)}
          {offerLines > 0 && <span class="muted small"> + {offerLines} make-an-offer</span>}
        </dd>
      </div>
      <div>
        <dt>Your proposed total</dt>
        <dd class="num strong">{proposedTotal != null ? formatMoney(proposedTotal) : 'enter prices'}</dd>
      </div>
    </dl>
  );
}
