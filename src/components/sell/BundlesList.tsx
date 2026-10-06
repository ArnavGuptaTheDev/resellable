import { useEffect, useState } from 'preact/hooks';
import type { BundleView } from '../../../shared/catalog';
import { formatMoney } from '../../../shared/money';
import { api, errorMessage } from '../../lib/api';

export default function BundlesList() {
  const [bundles, setBundles] = useState<BundleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ bundles: BundleView[] }>('/api/bundles/mine')
      .then((r) => setBundles(r.bundles))
      .catch((err) => setError(errorMessage(err)));
  }, []);

  if (error) return <p class="tag tag-danger block">{error}</p>;
  if (!bundles) return <p class="muted">Loading…</p>;

  return (
    <div class="inventory">
      <p class="muted">
        To make a bundle, select items in your <a href="/sell">inventory</a> and choose <strong>Create bundle</strong>.
      </p>
      {bundles.length === 0 ? (
        <div class="panel empty">
          <h2>No bundles yet</h2>
          <a class="btn" href="/sell">Go to inventory</a>
        </div>
      ) : (
        <ul class="inv-list">
          {bundles.map((b) => (
            <li key={b.id} class="inv-row bundle-row">
              <a class="inv-thumb" href={`/sell/bundle?id=${b.id}`} aria-hidden="true" tabIndex={-1}>
                {b.coverThumbUrl ? <img src={b.coverThumbUrl} alt="" loading="lazy" /> : <span>no photo</span>}
              </a>
              <div class="inv-main">
                <a class="inv-title" href={`/sell/bundle?id=${b.id}`}>
                  {b.title}
                </a>
                <span class="muted small">
                  {b.components.length} items · {b.price != null ? formatMoney(b.price) : 'no price'}
                  {b.saving ? ` · saves ${formatMoney(b.saving)}` : ''} · can make {b.available}
                </span>
                <span class={`tag ${b.status === 'listed' ? 'status-listed' : 'status-hidden'}`}>{b.status === 'listed' ? 'Listed' : 'Hidden'}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
