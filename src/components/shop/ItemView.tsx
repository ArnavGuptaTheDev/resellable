import { useEffect, useState } from 'preact/hooks';
import type { CatalogItemDetail } from '../../../shared/catalog';
import { CONDITION_LABELS, STATUS_LABELS } from '../../../shared/items';
import { formatMoney } from '../../../shared/money';
import { ApiError, api, errorMessage } from '../../lib/api';
import AddToCart from './AddToCart';
import { Gallery, Price, TierTable } from './bits';

export default function ItemView() {
  const id = Number(new URLSearchParams(location.search).get('id'));
  const [item, setItem] = useState<CatalogItemDetail | null>(null);
  const [own, setOwn] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ item: CatalogItemDetail; own: boolean; canEdit: boolean }>(`/api/catalog/items/${id}`)
      .then((r) => {
        setItem(r.item);
        setOwn(r.own);
        setCanEdit(r.canEdit);
        document.title = `${r.item.title || 'Item'} · Resellable`;
      })
      .catch((err) => setError(err instanceof ApiError && err.status === 404 ? 'not_found' : errorMessage(err)));
  }, [id]);

  if (error === 'not_found') {
    return (
      <div class="panel">
        <h2>Item not available</h2>
        <p class="muted">It may have been sold, hidden, or the link is wrong.</p>
        <a class="btn" href="/">Browse</a>
      </div>
    );
  }
  if (error) return <p class="tag tag-danger block">{error}</p>;
  if (!item) return <p class="muted">Loading…</p>;

  const notForSale = item.status !== 'listed';
  return (
    <article class="detail">
      <Gallery photos={item.photos} title={item.title} />

      <div class="detail-info">
        <p class="eyebrow">{item.category ?? 'Uncategorized'}</p>
        <h1 class="detail-title">{item.title || 'Untitled draft'}</h1>
        <Price price={item.price} large />
        {item.price == null && <p class="muted small">No asking price. Add it to your cart with the price you'd pay.</p>}
        {item.price != null && item.tiers.length > 0 && <TierTable price={item.price} tiers={item.tiers} />}

        <dl class="facts">
          <div>
            <dt>Condition</dt>
            <dd>{CONDITION_LABELS[item.condition]}</dd>
          </div>
          <div>
            <dt>In stock</dt>
            <dd class="num">{item.quantity}</dd>
          </div>
          <div>
            <dt>Seller</dt>
            <dd>{item.seller.name ?? 'Seller'}</dd>
          </div>
          {notForSale && (
            <div>
              <dt>Status</dt>
              <dd>
                <span class={`tag status-${item.status}`}>{STATUS_LABELS[item.status]}</span>
              </dd>
            </div>
          )}
        </dl>

        {item.status === 'listed' && (
          <AddToCart kind="item" refId={item.id} price={item.price} tiers={item.tiers} available={item.quantity} own={own} />
        )}

        {canEdit && (
          <p>
            <a class="btn btn-ghost" href={`/sell/item?id=${item.id}`}>
              Edit this item
            </a>
          </p>
        )}

        {item.description && <div class="description">{item.description}</div>}

        {item.tags.length > 0 && (
          <ul class="tag-list" aria-label="Tags">
            {item.tags.map((t) => (
              <li key={t}>
                <a class="tag" href={`/?q=${encodeURIComponent(t)}`}>
                  {t}
                </a>
              </li>
            ))}
          </ul>
        )}

        {item.bundles.length > 0 && (
          <section class="in-bundles">
            <h2 class="section-title">Also in bundles</h2>
            <ul>
              {item.bundles.map((b) => (
                <li key={b.id}>
                  <a href={`/bundle?id=${b.id}`}>{b.title}</a>
                  {b.price != null && <span class="num"> · {formatMoney(b.price)}</span>}
                  {!b.available && <span class="muted"> · unavailable</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </article>
  );
}
