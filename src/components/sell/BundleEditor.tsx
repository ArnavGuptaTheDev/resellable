import { useEffect, useMemo, useState } from 'preact/hooks';
import type { BundleView } from '../../../shared/catalog';
import type { InventoryItem, Item } from '../../../shared/items';
import { formatMoney, parseMoney, toMajorString } from '../../../shared/money';
import { ApiError, api, errorMessage } from '../../lib/api';
import { Field, MoneyInput, useToasts } from './fields';

interface Line {
  itemId: number;
  quantity: number;
}

/**
 * Create (/sell/bundle?items=1,2,3) or edit (/sell/bundle?id=7) a bundle.
 * Pricing: a fixed bundle price, or a percent off the sum of component prices
 * (only when every component has a price; the server enforces this too).
 */
export default function BundleEditor() {
  const params = new URLSearchParams(location.search);
  const editId = Number(params.get('id')) || null;
  const [inventory, setInventory] = useState<InventoryItem[] | null>(null);
  const [bundle, setBundle] = useState<BundleView | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [mode, setMode] = useState<'fixed' | 'percent_off'>('percent_off');
  const [fixed, setFixed] = useState('');
  const [percent, setPercent] = useState('10');
  const [status, setStatus] = useState<'listed' | 'hidden'>('listed');
  const [coverId, setCoverId] = useState<number | null>(null);
  const [coverChoices, setCoverChoices] = useState<{ id: number; thumbUrl: string }[] | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToasts();

  useEffect(() => {
    void api<{ items: InventoryItem[] }>('/api/items/mine?limit=500').then((r) => setInventory(r.items));
    if (editId) {
      api<{ bundle: BundleView }>(`/api/bundles/${editId}`)
        .then(({ bundle: b }) => {
          setBundle(b);
          setTitle(b.title);
          setDescription(b.description ?? '');
          setLines(b.components.map((c) => ({ itemId: c.itemId, quantity: c.quantity })));
          setMode(b.pricingMode);
          setFixed(toMajorString(b.fixedPrice));
          setPercent(String(b.percentOff ?? 10));
          setStatus(b.status);
          setCoverId(b.coverPhotoId);
        })
        .catch((err) => setError(err instanceof ApiError && err.status === 404 ? 'Bundle not found.' : errorMessage(err)));
    } else {
      const ids = (params.get('items') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
      setLines([...new Set(ids)].map((itemId) => ({ itemId, quantity: 1 })));
    }
  }, []);

  const byId = useMemo(() => new Map((inventory ?? []).map((i) => [i.id, i])), [inventory]);
  const comps = lines.map((l) => ({ ...l, item: byId.get(l.itemId) }));
  const unpriced = comps.filter((c) => c.item && c.item.price == null);
  // Preview at base prices; the saved bundle shows the exact figure with tier pricing.
  const baseSum = unpriced.length ? null : comps.reduce((s, c) => s + (c.item?.price ?? 0) * c.quantity, 0);
  const pct = parseInt(percent, 10);
  const preview = mode === 'fixed' ? parseMoney(fixed) : baseSum != null && !Number.isNaN(pct) ? Math.round((baseSum * (100 - pct)) / 100) : null;

  useEffect(() => {
    if (unpriced.length && mode === 'percent_off') setMode('fixed');
  }, [unpriced.length]);

  const candidates = (inventory ?? [])
    .filter((i) => !lines.some((l) => l.itemId === i.id) && i.status !== 'hidden')
    .filter((i) => !search.trim() || i.title.toLowerCase().includes(search.trim().toLowerCase()))
    .slice(0, 8);

  const setQty = (itemId: number, q: number) => setLines((ls) => ls.map((l) => (l.itemId === itemId ? { ...l, quantity: Math.max(1, q) } : l)));

  async function loadCovers() {
    const all: { id: number; thumbUrl: string }[] = [];
    for (const l of lines) {
      try {
        const { item } = await api<{ item: Item }>(`/api/items/${l.itemId}`);
        all.push(...item.photos.map((p) => ({ id: p.id, thumbUrl: p.thumbUrl })));
      } catch {
        /* skip */
      }
    }
    setCoverChoices(all);
  }

  async function save() {
    setError(null);
    const body: Record<string, unknown> = {
      title,
      description: description || null,
      items: lines,
      pricingMode: mode,
      status,
      ...(mode === 'fixed' ? { fixedPrice: parseMoney(fixed) } : { percentOff: pct }),
    };
    if (mode === 'fixed' && (parseMoney(fixed) == null || Number.isNaN(parseMoney(fixed)))) return setError('Enter the bundle price.');
    if (coverChoices || editId) body.coverPhotoId = coverId;
    setBusy(true);
    try {
      const res = editId
        ? await api<{ bundle: BundleView }>(`/api/bundles/${editId}`, { method: 'PATCH', body })
        : await api<{ bundle: BundleView }>('/api/bundles', { method: 'POST', body });
      if (!editId) {
        location.href = `/sell/bundle?id=${res.bundle.id}&created=1`;
        return;
      }
      setBundle(res.bundle);
      toast.push({ kind: 'ok', text: 'Bundle saved.', href: `/bundle?id=${res.bundle.id}`, linkText: 'View' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (error && editId && !bundle) return <p class="tag tag-danger block">{error}</p>;
  if (!inventory) return <p class="muted">Loading…</p>;

  return (
    <form
      class="editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {params.has('created') && <p class="tag tag-ok block">Bundle created.</p>}

      <section class="panel">
        <Field label="Bundle title">
          <input type="text" required value={title} placeholder="Build a Robot" onInput={(e) => setTitle(e.currentTarget.value)} />
        </Field>
        <Field label="Description">
          <textarea rows={3} value={description} onInput={(e) => setDescription(e.currentTarget.value)} />
        </Field>
      </section>

      <section class="panel">
        <h2 class="section-title">
          Items <span class="num muted">{lines.length}</span>
        </h2>
        {lines.length === 0 && <p class="muted">Add items from your inventory below.</p>}
        <ul class="bundle-lines">
          {comps.map((c) => (
            <li key={c.itemId}>
              <span class="inv-thumb">{c.item?.coverThumbUrl ? <img src={c.item.coverThumbUrl} alt="" /> : <span>—</span>}</span>
              <span class="bl-main">
                <strong>{c.item?.title || `Item #${c.itemId}`}</strong>
                <span class="muted small">
                  {c.item?.price != null ? `${formatMoney(c.item.price)} each` : 'no price'} · {c.item?.quantity ?? '?'} in stock
                </span>
              </span>
              <span class="stepper compact">
                <button type="button" class="icon-btn" aria-label="Fewer" onClick={() => setQty(c.itemId, c.quantity - 1)}>
                  −
                </button>
                <input type="number" min={1} class="num" value={c.quantity} aria-label="Quantity in bundle" onInput={(e) => setQty(c.itemId, parseInt(e.currentTarget.value, 10) || 1)} />
                <button type="button" class="icon-btn" aria-label="More" onClick={() => setQty(c.itemId, c.quantity + 1)}>
                  +
                </button>
              </span>
              <button type="button" class="icon-btn" aria-label="Remove from bundle" onClick={() => setLines((ls) => ls.filter((l) => l.itemId !== c.itemId))}>
                ×
              </button>
            </li>
          ))}
        </ul>
        <div class="picker">
          <input type="search" placeholder="Add an item: search your inventory" value={search} onInput={(e) => setSearch(e.currentTarget.value)} />
          {search.trim() && (
            <ul class="picker-results">
              {candidates.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setLines((ls) => [...ls, { itemId: i.id, quantity: 1 }]);
                      setSearch('');
                    }}
                  >
                    + {i.title || 'Untitled'} <span class="muted small">{i.price != null ? formatMoney(i.price) : 'no price'}</span>
                  </button>
                </li>
              ))}
              {!candidates.length && <li class="muted small">No matches.</li>}
            </ul>
          )}
        </div>
      </section>

      <section class="panel">
        <h2 class="section-title">Pricing</h2>
        <fieldset class="segmented">
          <legend>Price as</legend>
          <label>
            <input type="radio" name="mode" checked={mode === 'percent_off'} disabled={unpriced.length > 0} onChange={() => setMode('percent_off')} />
            <span>Percent off</span>
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === 'fixed'} onChange={() => setMode('fixed')} />
            <span>Fixed price</span>
          </label>
        </fieldset>
        {unpriced.length > 0 && (
          <p class="muted small">Percent off needs every item priced. Without a price: {unpriced.map((c) => c.item?.title || `#${c.itemId}`).join(', ')}.</p>
        )}
        {mode === 'fixed' ? (
          <Field label="Bundle price">
            <MoneyInput value={fixed} onInput={setFixed} placeholder="e.g. 999" />
          </Field>
        ) : (
          <Field label="Percent off the items' total">
            <input type="number" inputMode="numeric" min={0} max={100} class="num" value={percent} onInput={(e) => setPercent(e.currentTarget.value)} />
          </Field>
        )}
        <dl class="facts bundle-math">
          <div>
            <dt>Items separately</dt>
            <dd class="num">{bundle?.componentsSum != null ? formatMoney(bundle.componentsSum) : baseSum != null ? formatMoney(baseSum) : '—'}</dd>
          </div>
          <div>
            <dt>Bundle price</dt>
            <dd class="num">{preview != null && !Number.isNaN(preview) ? formatMoney(preview) : '—'}</dd>
          </div>
          {bundle && (
            <div>
              <dt>Can make now</dt>
              <dd class="num">{bundle.available}</dd>
            </div>
          )}
        </dl>
        <p class="muted small">Before saving, the total uses base prices. After saving, it includes quantity tiers.</p>
      </section>

      <section class="panel">
        <h2 class="section-title">Cover &amp; visibility</h2>
        {coverChoices ? (
          <ul class="thumbs">
            <li class={`thumb pick ${coverId == null ? 'on' : ''}`}>
              <button type="button" onClick={() => setCoverId(null)}>
                Auto
              </button>
            </li>
            {coverChoices.map((p) => (
              <li key={p.id} class={`thumb pick ${coverId === p.id ? 'on' : ''}`}>
                <button type="button" onClick={() => setCoverId(p.id)} aria-label="Use as cover">
                  <img src={p.thumbUrl} alt="" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <button type="button" class="btn btn-ghost" disabled={!lines.length} onClick={() => void loadCovers()}>
            Choose cover photo
          </button>
        )}
        <label class="check">
          <input type="checkbox" checked={status === 'listed'} onChange={(e) => setStatus(e.currentTarget.checked ? 'listed' : 'hidden')} />
          <span>Listed (untick to hide the bundle)</span>
        </label>
      </section>

      {error && <p class="tag tag-danger block">{error}</p>}

      <div class="action-bar">
        <a class="btn btn-ghost" href="/sell/bundles">
          All bundles
        </a>
        <div class="actions">
          {bundle && (
            <a class="btn btn-ghost" href={`/bundle?id=${bundle.id}`}>
              View
            </a>
          )}
          <button type="submit" class="btn" disabled={busy || !lines.length || !title.trim()}>
            {editId ? 'Save' : 'Create bundle'}
          </button>
        </div>
      </div>
      {toast.view}
    </form>
  );
}
