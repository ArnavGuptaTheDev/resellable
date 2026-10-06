import { useEffect, useState } from 'preact/hooks';
import type { BundleView } from '../../../shared/catalog';
import { formatMoney } from '../../../shared/money';
import { ApiError, api, errorMessage } from '../../lib/api';
import AddToCart from './AddToCart';
import { Img, Price } from './bits';

export default function BundlePage() {
  const id = Number(new URLSearchParams(location.search).get('id'));
  const [bundle, setBundle] = useState<BundleView | null>(null);
  const [own, setOwn] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ bundle: BundleView; own: boolean; canEdit: boolean }>(`/api/catalog/bundles/${id}`)
      .then((r) => {
        setBundle(r.bundle);
        setOwn(r.own);
        setCanEdit(r.canEdit);
        document.title = `${r.bundle.title} · Resellable`;
      })
      .catch((err) => setError(err instanceof ApiError && err.status === 404 ? 'not_found' : errorMessage(err)));
  }, [id]);

  if (error === 'not_found') {
    return (
      <div class="panel">
        <h2>Bundle not available</h2>
        <a class="btn" href="/?kind=bundles">See bundles</a>
      </div>
    );
  }
  if (error) return <p class="tag tag-danger block">{error}</p>;
  if (!bundle) return <p class="muted">Loading…</p>;

  const short = bundle.components.filter((c) => c.stock < c.quantity || (c.status !== 'listed' && c.status !== 'sold_out'));
  return (
    <article class="detail">
      <div class="gallery">
        <div class="gallery-strip">
          <span class="gallery-slide">
            <Img src={bundle.coverUrl} alt={bundle.title} eager />
          </span>
        </div>
      </div>

      <div class="detail-info">
        <p class="eyebrow">
          Bundle · {bundle.components.length} items{bundle.status === 'hidden' && ' · hidden'}
        </p>
        <h1 class="detail-title">{bundle.title}</h1>
        <Price price={bundle.price} large />

        <dl class="facts bundle-math">
          {bundle.componentsSum != null && (
            <div>
              <dt>Bought separately</dt>
              <dd class="num">{formatMoney(bundle.componentsSum)}</dd>
            </div>
          )}
          {bundle.saving != null && bundle.saving > 0 && (
            <div>
              <dt>You save</dt>
              <dd class="num save">
                {formatMoney(bundle.saving)}
                {bundle.pricingMode === 'percent_off' && ` (${bundle.percentOff}%)`}
              </dd>
            </div>
          )}
          <div>
            <dt>Available</dt>
            <dd class="num">{bundle.available > 0 ? bundle.available : 'Unavailable'}</dd>
          </div>
          <div>
            <dt>Seller</dt>
            <dd>{bundle.seller.name ?? 'Seller'}</dd>
          </div>
        </dl>

        {bundle.available === 0 && short.length > 0 && (
          <p class="tag tag-warn block">Short on: {short.map((c) => c.title).join(', ')}</p>
        )}

        {bundle.status === 'listed' && bundle.price != null && (
          <AddToCart kind="bundle" refId={bundle.id} price={bundle.price} available={bundle.available} own={own} />
        )}

        {canEdit && (
          <p>
            <a class="btn btn-ghost" href={`/sell/bundle?id=${bundle.id}`}>
              Edit this bundle
            </a>
          </p>
        )}

        {bundle.description && <div class="description">{bundle.description}</div>}

        <section>
          <h2 class="section-title">What's inside</h2>
          <ul class="components">
            {bundle.components.map((c) => (
              <li key={c.itemId}>
                <a href={`/item?id=${c.itemId}`} class="comp-thumb" tabIndex={-1} aria-hidden="true">
                  <Img src={c.thumbUrl} alt="" />
                </a>
                <span class="comp-main">
                  <a href={`/item?id=${c.itemId}`}>{c.title}</a>
                  <span class="muted small">
                    {c.unitPrice != null ? `${formatMoney(c.unitPrice)} each` : 'make an offer'}
                    {c.stock < c.quantity && <span class="short"> · only {c.stock} left</span>}
                  </span>
                </span>
                <span class="num comp-qty">×{c.quantity}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </article>
  );
}
