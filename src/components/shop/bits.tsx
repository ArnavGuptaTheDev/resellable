import { useRef, useState } from 'preact/hooks';
import type { BundleView, CatalogCard } from '../../../shared/catalog';
import type { Photo } from '../../../shared/items';
import { CONDITION_LABELS } from '../../../shared/items';
import { formatMoney } from '../../../shared/money';
import type { Tier } from '../../../shared/pricing';

export function Price({ price, tiers = [], large }: { price: number | null; tiers?: Tier[]; large?: boolean }) {
  if (price == null) return <span class={`price offer ${large ? 'large' : ''}`}>Make an offer</span>;
  const best = tiers.length ? tiers[tiers.length - 1]! : null;
  return (
    <span class={`price ${large ? 'large' : ''}`}>
      <span class="num">{formatMoney(price)}</span>
      {best && (
        <span class="tier-hint">
          {best.minQty}+ <span class="num">{formatMoney(best.unitPrice)}</span>
        </span>
      )}
    </span>
  );
}

export function TierTable({ price, tiers }: { price: number; tiers: Tier[] }) {
  const rows = [{ minQty: 1, unitPrice: price }, ...tiers];
  return (
    <table class="tiers">
      <caption class="visually-hidden">Price per unit by quantity</caption>
      <thead>
        <tr>
          <th scope="col">Quantity</th>
          <th scope="col">Each</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t, i) => {
          const next = rows[i + 1];
          return (
            <tr key={t.minQty}>
              <td class="num">{next ? (next.minQty - 1 === t.minQty ? t.minQty : `${t.minQty}–${next.minQty - 1}`) : `${t.minQty}+`}</td>
              <td class="num">{formatMoney(t.unitPrice)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Img({ src, alt, eager }: { src: string | null; alt: string; eager?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <span class="img-missing" role="img" aria-label={alt || 'No photo'}>
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="1" />
          <path d="M3 15l5-5 4 4 3-3 6 6" />
        </svg>
      </span>
    );
  }
  return <img src={src} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" onError={() => setBroken(true)} />;
}

export function ItemCard({ item, mine }: { item: CatalogCard; mine?: boolean }) {
  const out = item.quantity === 0;
  return (
    <a class={`card ${out ? 'out' : ''}`} href={`/item?id=${item.id}`}>
      <span class="card-img">
        <Img src={item.coverThumbUrl} alt="" />
        {out && <span class="card-flag">Out of stock</span>}
        {mine && !out && <span class="card-flag mine">Yours</span>}
      </span>
      <span class="card-body">
        <span class="card-title">{item.title}</span>
        <Price price={item.price} tiers={item.tiers} />
        <span class="card-meta muted">
          {CONDITION_LABELS[item.condition]}
          {item.quantity > 1 && ` · ${item.quantity} in stock`}
        </span>
      </span>
    </a>
  );
}

export function BundleCard({ bundle }: { bundle: BundleView }) {
  return (
    <a class={`card bundle-card ${bundle.available ? '' : 'out'}`} href={`/bundle?id=${bundle.id}`}>
      <span class="card-img">
        <Img src={bundle.coverThumbUrl} alt="" />
        <span class="card-flag bundle">Bundle · {bundle.components.length} items</span>
      </span>
      <span class="card-body">
        <span class="card-title">{bundle.title}</span>
        <Price price={bundle.price} />
        <span class="card-meta">
          {bundle.saving ? <span class="save">Save {formatMoney(bundle.saving)}</span> : null}
          {!bundle.available && <span class="muted"> Unavailable</span>}
        </span>
      </span>
    </a>
  );
}

/** Swipeable photo gallery: scroll-snap strip plus thumbnails. */
export function Gallery({ photos, title }: { photos: Photo[]; title: string }) {
  const strip = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  if (!photos.length) {
    return (
      <div class="gallery empty">
        <Img src={null} alt="No photos" />
      </div>
    );
  }
  const go = (i: number) => {
    const el = strip.current?.children[i] as HTMLElement | undefined;
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
  };
  return (
    <div class="gallery">
      <div
        class="gallery-strip"
        ref={strip}
        tabIndex={0}
        aria-label={`${title} photos`}
        onScroll={(e) => {
          const el = e.currentTarget;
          setIndex(Math.round(el.scrollLeft / el.clientWidth));
        }}
      >
        {photos.map((p, i) => (
          <a key={p.id} class="gallery-slide" href={p.url} target="_blank" rel="noopener">
            <Img src={p.url} alt={`${title}, photo ${i + 1} of ${photos.length}`} eager={i === 0} />
          </a>
        ))}
      </div>
      {photos.length > 1 && (
        <div class="gallery-thumbs" role="tablist" aria-label="Choose photo">
          {photos.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`Photo ${i + 1}`}
              class={i === index ? 'on' : ''}
              onClick={() => go(i)}
            >
              <Img src={p.thumbUrl} alt="" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
