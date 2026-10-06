import { useEffect, useRef, useState } from 'preact/hooks';
import type { BundleView, CatalogCard } from '../../../shared/catalog';
import { CONDITIONS, CONDITION_LABELS } from '../../../shared/items';
import { api, errorMessage } from '../../lib/api';
import { getSession } from '../../lib/session';
import { BundleCard, ItemCard } from './bits';

interface Filters {
  q: string;
  category: string;
  condition: string;
  price: '' | 'priced' | 'offer';
  bundles: boolean;
}

interface Result {
  items: CatalogCard[];
  total: number;
  bundles: BundleView[];
  pageSize: number;
}

/** Filters live in the URL so back/forward and shared links keep them. */
function readUrl(): Filters {
  const p = new URLSearchParams(location.search);
  const price = p.get('price');
  return {
    q: p.get('q') ?? '',
    category: p.get('category') ?? '',
    condition: p.get('condition') ?? '',
    price: price === 'priced' || price === 'offer' ? price : '',
    bundles: p.get('kind') === 'bundles',
  };
}

function toParams(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.category) p.set('category', f.category);
  if (f.condition) p.set('condition', f.condition);
  if (f.price) p.set('price', f.price);
  if (f.bundles) p.set('kind', 'bundles');
  return p;
}

export default function Browse() {
  const [f, setF] = useState<Filters>(readUrl);
  const [data, setData] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<{ name: string; count: number }[]>([]);
  const [me, setMe] = useState<number | null>(null);
  const req = useRef(0);

  useEffect(() => {
    void getSession().then((s) => setMe(s?.user.id ?? null));
    void api<{ categories: { name: string; count: number }[] }>('/api/catalog/categories')
      .then((r) => setCategories(r.categories))
      .catch(() => {});
  }, []);

  async function load(append = false) {
    const id = ++req.current;
    setLoading(true);
    const params = toParams(f);
    if (append) params.set('offset', String(data?.items.length ?? 0));
    try {
      const res = await api<Result>(`/api/catalog?${params}`);
      if (id !== req.current) return;
      setData((prev) => (append && prev ? { ...res, items: [...prev.items, ...res.items], bundles: prev.bundles } : res));
      setError(null);
    } catch (err) {
      if (id === req.current) setError(errorMessage(err));
    } finally {
      if (id === req.current) setLoading(false);
    }
  }

  useEffect(() => {
    const qs = toParams(f).toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
    const t = setTimeout(() => void load(), f.q ? 250 : 0);
    return () => clearTimeout(t);
  }, [f.q, f.category, f.condition, f.price, f.bundles]);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((x) => ({ ...x, [k]: v }));
  const filtered = !!(f.category || f.condition || f.price || f.bundles || f.q.trim());
  const items = data?.items ?? [];
  const bundles = data?.bundles ?? [];

  return (
    <div class="browse">
      <div class="search-bar">
        <input
          type="search"
          placeholder="Search parts, sensors, boards…"
          aria-label="Search"
          value={f.q}
          enterKeyHint="search"
          onInput={(e) => set('q', e.currentTarget.value)}
        />
      </div>

      <div class="filter-row" role="group" aria-label="Filters">
        <select value={f.category} onChange={(e) => set('category', e.currentTarget.value)} aria-label="Category" disabled={f.bundles}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} ({c.count})
            </option>
          ))}
        </select>
        <select value={f.condition} onChange={(e) => set('condition', e.currentTarget.value)} aria-label="Condition" disabled={f.bundles}>
          <option value="">Any condition</option>
          {CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {CONDITION_LABELS[c]}
            </option>
          ))}
        </select>
        <select value={f.price} onChange={(e) => set('price', e.currentTarget.value as Filters['price'])} aria-label="Price" disabled={f.bundles}>
          <option value="">Any price</option>
          <option value="priced">Has a price</option>
          <option value="offer">Make an offer</option>
        </select>
        <button type="button" class={`chip ${f.bundles ? 'on' : ''}`} aria-pressed={f.bundles} onClick={() => set('bundles', !f.bundles)}>
          Bundles only
        </button>
        {filtered && (
          <button type="button" class="chip" onClick={() => setF({ q: '', category: '', condition: '', price: '', bundles: false })}>
            Clear
          </button>
        )}
      </div>

      {error && <p class="tag tag-danger block">{error}</p>}

      {bundles.length > 0 && (
        <section class="bundles-strip" aria-label="Bundles">
          {!f.bundles && <h2 class="section-title">Bundles</h2>}
          <div class={f.bundles ? 'card-grid' : 'card-row'}>
            {bundles.map((b) => (
              <BundleCard key={b.id} bundle={b} />
            ))}
          </div>
        </section>
      )}

      {!f.bundles && (
        <section aria-label="Items" aria-busy={loading}>
          {data && (
            <p class="result-count muted small">
              {data.total} {data.total === 1 ? 'item' : 'items'}
              {f.q.trim() && <> for “{f.q.trim()}”</>}
            </p>
          )}
          <div class="card-grid">
            {items.map((i) => (
              <ItemCard key={i.id} item={i} mine={i.seller.id === me} />
            ))}
          </div>
          {data && items.length < data.total && (
            <button type="button" class="btn btn-ghost load-more" disabled={loading} onClick={() => void load(true)}>
              Load more
            </button>
          )}
        </section>
      )}

      {!loading && data && !items.length && !bundles.length && (
        <div class="panel empty">
          <h2>{filtered ? 'Nothing matches' : 'Nothing listed yet'}</h2>
          <p class="muted">{filtered ? 'Try fewer filters or a shorter search.' : 'When sellers list items they show up here.'}</p>
        </div>
      )}
    </div>
  );
}
