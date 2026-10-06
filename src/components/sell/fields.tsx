import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { UPLOAD } from '../../../shared/config';
import { CONDITIONS, CONDITION_LABELS, type Condition } from '../../../shared/items';
import { parseMoney } from '../../../shared/money';
import { api } from '../../lib/api';
import { processImage, type ProcessedImage } from '../../lib/images';

// ------------------------------------------------------------------ pending photos

export interface PendingPhoto {
  key: string;
  name: string;
  /** Object URL of the thumbnail once processed. */
  preview: string | null;
  state: 'processing' | 'ready' | 'error';
  error?: string;
  result: Promise<ProcessedImage>;
}

let seq = 0;

/**
 * Starts processing files one at a time (phones run out of memory decoding
 * many 12 MP photos in parallel) and reports progress through `onUpdate`.
 */
export function startProcessing(files: File[], onUpdate: (p: PendingPhoto) => void): PendingPhoto[] {
  let chain: Promise<unknown> = Promise.resolve();
  return files.map((file) => {
    const p: PendingPhoto = { key: `p${++seq}`, name: file.name, preview: null, state: 'processing', result: null! };
    p.result = new Promise<ProcessedImage>((resolve, reject) => {
      chain = chain.then(async () => {
        try {
          const out = await processImage(file);
          onUpdate({ ...p, state: 'ready', preview: URL.createObjectURL(out.thumb) });
          resolve(out);
        } catch (err) {
          onUpdate({ ...p, state: 'error', error: err instanceof Error ? err.message : 'Could not process photo.' });
          reject(err);
        }
      });
    });
    p.result.catch(() => {}); // handled via state
    return p;
  });
}

/** Camera + gallery buttons. `capture` opens the rear camera directly on phones. */
export function PhotoButtons({ onFiles, disabled, remaining }: { onFiles: (f: File[]) => void; disabled?: boolean; remaining: number }) {
  const take = useRef<HTMLInputElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const handle = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])].slice(0, remaining);
    input.value = '';
    if (files.length) onFiles(files);
  };
  const off = disabled || remaining <= 0;
  return (
    <div class="photo-buttons">
      <button type="button" class="btn" disabled={off} onClick={() => take.current?.click()}>
        <CameraIcon /> Take photo
      </button>
      <button type="button" class="btn btn-ghost" disabled={off} onClick={() => pick.current?.click()}>
        <GalleryIcon /> Choose
      </button>
      <input ref={take} type="file" accept="image/*" capture="environment" hidden onChange={handle} />
      <input ref={pick} type="file" accept="image/*" multiple hidden onChange={handle} />
      <span class="muted small">{remaining > 0 ? `up to ${remaining} more` : 'photo limit reached'}</span>
    </div>
  );
}

export function PendingTray({ photos, onRemove }: { photos: PendingPhoto[]; onRemove: (key: string) => void }) {
  if (!photos.length) return null;
  return (
    <ul class="thumbs">
      {photos.map((p, i) => (
        <li key={p.key} class={`thumb ${p.state}`}>
          {p.preview ? <img src={p.preview} alt={`Photo ${i + 1}`} /> : <span class="thumb-state">{p.state === 'error' ? '!' : '…'}</span>}
          {i === 0 && p.state !== 'error' && <span class="cover-badge">cover</span>}
          {p.state === 'error' && <span class="thumb-error" title={p.error}>{p.error}</span>}
          <button type="button" class="thumb-x" aria-label={`Remove photo ${i + 1}`} onClick={() => onRemove(p.key)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

export const MAX_PHOTOS = UPLOAD.maxPhotosPerItem;

// ------------------------------------------------------------------ inputs

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class={`field ${error ? 'has-error' : ''}`}>
      <span>{label}</span>
      {children}
      {error ? <em class="field-error">{error}</em> : hint ? <em class="field-hint">{hint}</em> : null}
    </label>
  );
}

/** Price in major units. Empty means "make an offer". */
export function MoneyInput(props: {
  value: string;
  onInput: (v: string) => void;
  id?: string;
  placeholder?: string;
  onBlur?: () => void;
  compact?: boolean;
  /** Joins the parent's Enter-to-next-field navigation (data-nav). */
  nav?: boolean;
}) {
  const bad = props.value !== '' && Number.isNaN(parseMoney(props.value));
  return (
    <span class={`money ${props.compact ? 'compact' : ''}`}>
      <span class="money-sym" aria-hidden="true">₹</span>
      <input
        id={props.id}
        data-nav={props.nav || undefined}
        enterKeyHint={props.nav ? 'next' : undefined}
        onKeyDown={(e) => {
          // Inline (compact) editors commit on Enter by blurring, unless a parent handles navigation.
          if (e.key === 'Enter' && props.compact && !props.nav) e.currentTarget.blur();
        }}
        type="text"
        inputMode="decimal"
        autocomplete="off"
        class="num"
        placeholder={props.placeholder ?? 'offer'}
        aria-invalid={bad}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onBlur={props.onBlur}
      />
    </span>
  );
}

export function QuantityStepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <span class="stepper">
      <button type="button" class="icon-btn" aria-label="Decrease quantity" onClick={() => onChange(Math.max(0, value - 1))}>
        −
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        class="num"
        value={value}
        onInput={(e) => {
          const n = parseInt(e.currentTarget.value, 10);
          onChange(Number.isNaN(n) ? 0 : Math.max(0, n));
        }}
      />
      <button type="button" class="icon-btn" aria-label="Increase quantity" onClick={() => onChange(value + 1)}>
        +
      </button>
    </span>
  );
}

export function ConditionPicker({ value, onChange, name = 'condition' }: { value: Condition; onChange: (c: Condition) => void; name?: string }) {
  return (
    <fieldset class="segmented">
      <legend>Condition</legend>
      {CONDITIONS.map((c) => (
        <label key={c}>
          <input type="radio" name={name} value={c} checked={value === c} onChange={() => onChange(c)} />
          <span>{CONDITION_LABELS[c]}</span>
        </label>
      ))}
    </fieldset>
  );
}

let categoriesCache: Promise<string[]> | null = null;
export function useCategories(): string[] {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    categoriesCache ??= api<{ categories: string[] }>('/api/items/categories')
      .then((r) => r.categories)
      .catch(() => []);
    void categoriesCache.then(setList);
  }, []);
  return list;
}

/** Free text with suggestions from existing categories. */
export function CategoryInput({ value, onInput, id = 'category' }: { value: string; onInput: (v: string) => void; id?: string }) {
  const categories = useCategories();
  return (
    <>
      <input type="text" id={id} list={`${id}-list`} autocomplete="off" value={value} placeholder="e.g. Microcontrollers" onInput={(e) => onInput(e.currentTarget.value)} />
      <datalist id={`${id}-list`}>
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </>
  );
}

// ------------------------------------------------------------------ toast

export interface ToastMsg {
  id: number;
  text: string;
  kind: 'ok' | 'error';
  href?: string;
  linkText?: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const push = (t: Omit<ToastMsg, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), t.kind === 'error' ? 8000 : 4000);
  };
  const view = (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <p key={t.id} class={`toast ${t.kind}`}>
          {t.text}
          {t.href && (
            <a href={t.href}>{t.linkText ?? 'View'}</a>
          )}
        </p>
      ))}
    </div>
  );
  return { push, view };
}

// ------------------------------------------------------------------ icons

function CameraIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function GalleryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <path d="M3 16l5-5 4 4 3-3 6 6" />
      <circle cx="16" cy="9" r="1.5" />
    </svg>
  );
}
