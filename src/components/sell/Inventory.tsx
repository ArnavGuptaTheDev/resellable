import { useEffect, useRef, useState } from 'preact/hooks';
import { CONDITION_LABELS, ITEM_STATUSES, STATUS_LABELS, type InventoryItem, type ItemStatus } from '../../../shared/items';
import { formatMoney, parseMoney, toMajorString } from '../../../shared/money';
import { api, errorMessage } from '../../lib/api';
import { MoneyInput, useCategories, useToasts } from './fields';

interface ListResponse {
  items: InventoryItem[];
  total: number;
  counts: Partial<Record<ItemStatus, number>>;
}

const PAGE = 100;

export default function Inventory() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<ItemStatus | ''>('');
  const [category, setCategory] = useState('');
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [catPrompt, setCatPrompt] = useState<string | null>(null);
  const categories = useCategories();
  const toast = useToasts();
  const reqId = useRef(0);

  async function load(append = false) {
    const id = ++reqId.current;
    setLoading(true);
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(append ? (data?.items.length ?? 0) : 0) });
    if (q.trim()) params.set('q', q.trim());
    if (status) params.set('status', status);
    if (category) params.set('category', category);
    try {
      const res = await api<ListResponse>(`/api/items/mine?${params}`);
      if (id !== reqId.current) return; // a newer search superseded this one
      setData((prev) => (append && prev ? { ...res, items: [...prev.items, ...res.items] } : res));
      if (!append) setSelected(new Set());
    } catch (err) {
      toast.push({ kind: 'error', text: errorMessage(err) });
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }

  // Debounced reload on filter changes.
  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, status, category]);

  const patchRow = (row: InventoryItem) =>
    setData((d) => d && { ...d, items: d.items.map((i) => (i.id === row.id ? { ...i, ...row } : i)) });

  async function bulk(action: 'list' | 'hide' | 'draft' | 'set_category', extra: Record<string, unknown> = {}) {
    if (!selected.size) return;
    setBulkBusy(true);
    try {
      const res = await api<{ updated: number; skipped: number }>('/api/items/bulk', {
        method: 'POST',
        body: { ids: [...selected], action, ...extra },
      });
      toast.push({
        kind: res.skipped ? 'error' : 'ok',
        text: `Updated ${res.updated} item(s).${res.skipped ? ` Skipped ${res.skipped} without a title.` : ''}`,
      });
      setCatPrompt(null);
      await load();
    } catch (err) {
      toast.push({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBulkBusy(false);
    }
  }

  const items = data?.items ?? [];
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const total = Object.values(data?.counts ?? {}).reduce((a, b) => a + (b ?? 0), 0);

  return (
    <div class="inventory">
      <div class="toolbar">
        <a class="btn" href="/sell/add">+ Quick add</a>
        <a class="btn btn-ghost" href="/sell/batch">Batch add</a>
        <a class="btn btn-ghost" href="/api/items/export.csv" download>
          Export CSV
        </a>
      </div>

      {(data?.counts.draft ?? 0) > 0 && (
        <p class="drafts-note">
          <span class="tag tag-warn">{data!.counts.draft} drafts</span> waiting for a title and price.{' '}
          <a href="/sell/batch#drafts">Fill them in</a>
        </p>
      )}

      <div class="filters">
        <input type="search" placeholder="Search title, description, tags" value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label="Search inventory" />
        <select value={category} onChange={(e) => setCategory(e.currentTarget.value)} aria-label="Filter by category">
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div class="chips" role="group" aria-label="Filter by status">
        <button type="button" class={`chip ${status === '' ? 'on' : ''}`} onClick={() => setStatus('')}>
          All <span class="num">{total}</span>
        </button>
        {ITEM_STATUSES.map((s) => (
          <button key={s} type="button" class={`chip ${status === s ? 'on' : ''}`} onClick={() => setStatus(s)}>
            {STATUS_LABELS[s]} <span class="num">{data?.counts[s] ?? 0}</span>
          </button>
        ))}
      </div>

      {items.length > 0 && (
        <label class="check select-all">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))}
          />
          <span>
            Select all shown <span class="muted">({items.length})</span>
          </span>
        </label>
      )}

      <ul class="inv-list" aria-busy={loading}>
        {items.map((item) => (
          <Row key={item.id} item={item} checked={selected.has(item.id)} onToggle={() => toggle(item.id)} onSaved={patchRow} onError={(t) => toast.push({ kind: 'error', text: t })} />
        ))}
      </ul>

      {!loading && items.length === 0 && (
        <div class="panel empty">
          {total === 0 ? (
            <>
              <h2>Nothing here yet</h2>
              <p class="muted">Add your first item. It takes about 20 seconds.</p>
              <a class="btn" href="/sell/add">+ Quick add</a>
            </>
          ) : (
            <p class="muted">No items match these filters.</p>
          )}
        </div>
      )}

      {data && items.length < data.total && (
        <button type="button" class="btn btn-ghost load-more" disabled={loading} onClick={() => void load(true)}>
          Load more ({data.total - items.length} left)
        </button>
      )}

      {selected.size > 0 && (
        <div class="bulk-bar" role="region" aria-label="Bulk actions">
          <span class="num">{selected.size} selected</span>
          {catPrompt === null ? (
            <div class="actions">
              <button type="button" class="btn" disabled={bulkBusy} onClick={() => void bulk('list')}>
                List
              </button>
              <button type="button" class="btn btn-ghost" disabled={bulkBusy} onClick={() => void bulk('hide')}>
                Hide
              </button>
              <button type="button" class="btn btn-ghost" disabled={bulkBusy} onClick={() => void bulk('draft')}>
                To draft
              </button>
              <button type="button" class="btn btn-ghost" disabled={bulkBusy} onClick={() => setCatPrompt('')}>
                Set category
              </button>
              <button type="button" class="btn btn-ghost" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </div>
          ) : (
            <form
              class="actions"
              onSubmit={(e) => {
                e.preventDefault();
                void bulk('set_category', { category: catPrompt || null });
              }}
            >
              <input type="text" list="bulk-cat" autoFocus placeholder="Category (empty clears)" value={catPrompt} onInput={(e) => setCatPrompt(e.currentTarget.value)} />
              <datalist id="bulk-cat">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              <button type="submit" class="btn" disabled={bulkBusy}>
                Apply
              </button>
              <button type="button" class="btn btn-ghost" onClick={() => setCatPrompt(null)}>
                Cancel
              </button>
            </form>
          )}
        </div>
      )}
      {toast.view}
    </div>
  );
}

function Row({
  item,
  checked,
  onToggle,
  onSaved,
  onError,
}: {
  item: InventoryItem;
  checked: boolean;
  onToggle: () => void;
  onSaved: (row: InventoryItem) => void;
  onError: (msg: string) => void;
}) {
  const [qty, setQty] = useState(String(item.quantity));
  const [price, setPrice] = useState(toMajorString(item.price));
  const [saving, setSaving] = useState(false);

  // Keep inputs in sync when the row is reloaded.
  useEffect(() => setQty(String(item.quantity)), [item.quantity]);
  useEffect(() => setPrice(toMajorString(item.price)), [item.price]);

  async function save(field: 'quantity' | 'price') {
    let value: number | null;
    if (field === 'quantity') {
      value = parseInt(qty, 10);
      if (Number.isNaN(value) || value < 0) return setQty(String(item.quantity));
      if (value === item.quantity) return;
    } else {
      value = parseMoney(price);
      if (Number.isNaN(value)) return setPrice(toMajorString(item.price));
      if (value === item.price) return;
    }
    setSaving(true);
    try {
      const res = await api<{ item: InventoryItem }>(`/api/items/${item.id}`, { method: 'PATCH', body: { [field]: value } });
      onSaved({ ...item, quantity: res.item.quantity, price: res.item.price, updatedAt: res.item.updatedAt });
    } catch (err) {
      onError(`${item.title || 'Item'}: ${errorMessage(err)}`);
      setQty(String(item.quantity));
      setPrice(toMajorString(item.price));
    } finally {
      setSaving(false);
    }
  }

  const href = `/sell/item?id=${item.id}`;
  return (
    <li class={`inv-row ${checked ? 'selected' : ''} ${saving ? 'saving' : ''}`}>
      <input type="checkbox" class="inv-check" checked={checked} onChange={onToggle} aria-label={`Select ${item.title || 'draft'}`} />
      <a class="inv-thumb" href={href} tabIndex={-1} aria-hidden="true">
        {item.coverThumbUrl ? <img src={item.coverThumbUrl} alt="" loading="lazy" /> : <span>no photo</span>}
      </a>
      <div class="inv-main">
        <a class="inv-title" href={href}>
          {item.title || <em class="muted">Untitled draft</em>}
        </a>
        <span class="muted small">
          {[item.category, CONDITION_LABELS[item.condition], item.photoCount ? `${item.photoCount} photo${item.photoCount > 1 ? 's' : ''}` : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span class={`tag status-${item.status}`}>{STATUS_LABELS[item.status]}</span>
      </div>
      <label class="inv-qty">
        <span class="visually-hidden">Quantity</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          class="num"
          value={qty}
          onInput={(e) => setQty(e.currentTarget.value)}
          onBlur={() => void save('quantity')}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span class="unit muted">qty</span>
      </label>
      <label class="inv-price">
        <span class="visually-hidden">Price each</span>
        <MoneyInput compact value={price} onInput={setPrice} onBlur={() => void save('price')} />
        <span class="unit muted">{item.price == null ? 'offer' : formatMoney(item.price)}</span>
      </label>
    </li>
  );
}
