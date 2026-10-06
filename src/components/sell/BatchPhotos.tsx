import { useEffect, useRef, useState } from 'preact/hooks';
import type { InventoryItem, Item } from '../../../shared/items';
import { parseMoney, toMajorString } from '../../../shared/money';
import { ApiError, api, errorMessage } from '../../lib/api';
import { photoForm, processImage } from '../../lib/images';
import { MoneyInput, useToasts } from './fields';

interface Job {
  key: string;
  name: string;
  state: 'queued' | 'processing' | 'uploading' | 'done' | 'error';
  error?: string;
}

const MAX_BATCH = 200;
const UPLOAD_CONCURRENCY = 2;

/**
 * Select many photos; each becomes a draft item with that photo. Processing
 * is sequential (memory), uploads overlap a little (network). Below, every
 * draft can be filled in inline: title → qty → price, Enter moves on.
 */
export default function BatchPhotos() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [drafts, setDrafts] = useState<InventoryItem[] | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const toast = useToasts();

  const setJob = (key: string, patch: Partial<Job>) => setJobs((all) => all.map((j) => (j.key === key ? { ...j, ...patch } : j)));

  async function loadDrafts() {
    try {
      const res = await api<{ items: InventoryItem[] }>('/api/items/mine?status=draft&limit=500');
      // Oldest first so they appear in the order the photos were taken/picked.
      setDrafts(res.items.slice().reverse());
    } catch (err) {
      toast.push({ kind: 'error', text: errorMessage(err) });
    }
  }

  useEffect(() => {
    void loadDrafts();
    if (new URLSearchParams(location.search).has('shared')) void takeShared();
  }, []);

  /** Photos shared from the phone's gallery (Web Share Target): the service worker parks them in a cache. */
  async function takeShared() {
    history.replaceState(null, '', location.pathname + location.hash);
    if (!('caches' in window)) return;
    try {
      const inbox = await caches.open('share-inbox');
      const keys = await inbox.keys();
      const files: File[] = [];
      for (const key of keys) {
        const res = await inbox.match(key);
        if (res) {
          const blob = await res.blob();
          const name = decodeURIComponent(res.headers.get('X-Filename') ?? 'shared.jpg');
          files.push(new File([blob], name, { type: blob.type }));
        }
        await inbox.delete(key);
      }
      if (files.length) {
        toast.push({ kind: 'ok', text: `Received ${files.length} shared photo${files.length > 1 ? 's' : ''}.` });
        void run(files);
      }
    } catch {
      toast.push({ kind: 'error', text: 'Could not read the shared photos. Pick them here instead.' });
    }
  }

  async function run(files: File[]) {
    const batch = files.slice(0, MAX_BATCH).map((f, i) => ({ file: f, key: `${Date.now()}-${i}` }));
    if (files.length > MAX_BATCH) toast.push({ kind: 'error', text: `Only the first ${MAX_BATCH} photos were added.` });
    setJobs((all) => [...all, ...batch.map(({ file, key }) => ({ key, name: file.name, state: 'queued' as const }))]);

    const uploads = new Set<Promise<void>>();
    for (const { file, key } of batch) {
      setJob(key, { state: 'processing' });
      let processed;
      try {
        processed = await processImage(file);
      } catch (err) {
        setJob(key, { state: 'error', error: err instanceof Error ? err.message : 'Could not read photo.' });
        continue;
      }
      // Keep at most N uploads in flight while the next photo is processed.
      while (uploads.size >= UPLOAD_CONCURRENCY) await Promise.race(uploads);
      setJob(key, { state: 'uploading' });
      const up = api<{ item: Item }>('/api/items/drafts', { method: 'POST', body: photoForm(processed) })
        .then(({ item }) => {
          setJob(key, { state: 'done' });
          setDrafts((d) => [...(d ?? []), { ...item, coverThumbUrl: item.photos[0]?.thumbUrl ?? null, photoCount: item.photos.length }]);
        })
        .catch((err) => setJob(key, { state: 'error', error: errorMessage(err) }))
        .finally(() => uploads.delete(up));
      uploads.add(up);
    }
    await Promise.all(uploads);
  }

  const done = jobs.filter((j) => j.state === 'done').length;
  const failed = jobs.filter((j) => j.state === 'error');
  const active = jobs.some((j) => j.state === 'queued' || j.state === 'processing' || j.state === 'uploading');

  return (
    <div class="batch">
      <section class="panel">
        <h2 class="section-title">1 · Pick photos</h2>
        <p class="muted">Each photo becomes its own draft item. Pick as many as you like (up to {MAX_BATCH} at a time).</p>
        <button type="button" class="btn" onClick={() => pick.current?.click()}>
          Choose photos
        </button>
        <input
          ref={pick}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = '';
            if (files.length) void run(files);
          }}
        />
        {jobs.length > 0 && (
          <div class="progress" aria-live="polite">
            <div class="bar" style={{ '--p': `${(100 * (done + failed.length)) / jobs.length}%` }} />
            <p class="num">
              {done} / {jobs.length} uploaded{failed.length ? ` · ${failed.length} failed` : ''}
              {active ? ' · keep this page open' : ''}
            </p>
            {failed.length > 0 && (
              <ul class="failures">
                {failed.map((j) => (
                  <li key={j.key}>
                    <span class="mono">{j.name}</span>: {j.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section class="panel" id="drafts">
        <h2 class="section-title">
          2 · Fill in drafts <span class="num muted">{drafts?.length ?? ''}</span>
        </h2>
        <p class="muted small">Type a title, Enter, quantity, Enter, price, Enter → next row. Changes save as you go.</p>
        {drafts === null ? (
          <p class="muted">Loading…</p>
        ) : drafts.length === 0 ? (
          <p class="muted">No drafts. Pick some photos above.</p>
        ) : (
          <DraftRows drafts={drafts} setDrafts={setDrafts} onToast={toast.push} />
        )}
      </section>
      {toast.view}
    </div>
  );
}

function DraftRows({
  drafts,
  setDrafts,
  onToast,
}: {
  drafts: InventoryItem[];
  setDrafts: (fn: (d: InventoryItem[] | null) => InventoryItem[] | null) => void;
  onToast: ReturnType<typeof useToasts>['push'];
}) {
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const readyIds = drafts.filter((d) => d.title.trim()).map((d) => d.id);

  const replace = (row: InventoryItem) => setDrafts((d) => d && d.map((x) => (x.id === row.id ? row : x)));
  const drop = (id: number) => setDrafts((d) => d && d.filter((x) => x.id !== id));

  async function listReady() {
    setBusy(true);
    try {
      const res = await api<{ updated: number }>('/api/items/bulk', { method: 'POST', body: { ids: readyIds, action: 'list' } });
      setDrafts((d) => d && d.filter((x) => !readyIds.includes(x.id)));
      onToast({ kind: 'ok', text: `Listed ${res.updated} item(s).`, href: '/sell', linkText: 'Inventory' });
    } catch (err) {
      onToast({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  /** Enter jumps to the next input; past the last field of a row, to the next row's title. */
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Enter') return;
    const target = e.target as HTMLElement;
    if (!(target instanceof HTMLInputElement)) return;
    e.preventDefault();
    const inputs = [...(listRef.current?.querySelectorAll<HTMLInputElement>('input[data-nav]') ?? [])];
    const next = inputs[inputs.indexOf(target) + 1];
    if (next) {
      next.focus();
      next.select();
    } else target.blur();
  }

  return (
    <>
      <ol class="draft-rows" ref={listRef} onKeyDown={onKeyDown}>
        {drafts.map((d) => (
          <DraftRow key={d.id} draft={d} onSaved={replace} onRemoved={drop} onError={(t) => onToast({ kind: 'error', text: t })} />
        ))}
      </ol>
      <div class="draft-footer">
        <button type="button" class="btn" disabled={busy || !readyIds.length} onClick={() => void listReady()}>
          List {readyIds.length} with a title
        </button>
      </div>
    </>
  );
}

function DraftRow({
  draft,
  onSaved,
  onRemoved,
  onError,
}: {
  draft: InventoryItem;
  onSaved: (row: InventoryItem) => void;
  onRemoved: (id: number) => void;
  onError: (msg: string) => void;
}) {
  const [title, setTitle] = useState(draft.title);
  const [qty, setQty] = useState(String(draft.quantity));
  const [price, setPrice] = useState(toMajorString(draft.price));
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  async function patch(body: Record<string, unknown>) {
    setState('saving');
    try {
      const { item } = await api<{ item: Item }>(`/api/items/${draft.id}`, { method: 'PATCH', body });
      onSaved({ ...draft, title: item.title, quantity: item.quantity, price: item.price, status: item.status });
      setState('saved');
      return item;
    } catch (err) {
      setState('error');
      onError(err instanceof ApiError ? `${draft.title || 'Draft'}: ${errorMessage(err)}` : errorMessage(err));
      return null;
    }
  }

  function saveTitle() {
    if (title.trim() !== draft.title) void patch({ title });
  }
  function saveQty() {
    const n = parseInt(qty, 10);
    if (Number.isNaN(n) || n < 0) return setQty(String(draft.quantity));
    if (n !== draft.quantity) void patch({ quantity: n });
  }
  function savePrice() {
    const v = parseMoney(price);
    if (Number.isNaN(v)) return setPrice(toMajorString(draft.price));
    if (v !== draft.price) void patch({ price: v });
  }
  async function listNow() {
    const item = await patch({ title, status: 'listed' });
    if (item) onRemoved(draft.id);
  }
  async function hide() {
    const item = await patch({ status: 'hidden' });
    if (item) onRemoved(draft.id);
  }

  return (
    <li class={`draft-row ${state}`}>
      <a class="inv-thumb" href={`/sell/item?id=${draft.id}`} title="Open full editor">
        {draft.coverThumbUrl ? <img src={draft.coverThumbUrl} alt="" loading="lazy" /> : <span>no photo</span>}
      </a>
      <input
        data-nav
        class="d-title"
        type="text"
        placeholder="Title"
        aria-label="Title"
        enterKeyHint="next"
        value={title}
        onInput={(e) => setTitle(e.currentTarget.value)}
        onBlur={saveTitle}
      />
      <input
        data-nav
        class="d-qty num"
        type="number"
        inputMode="numeric"
        min={0}
        aria-label="Quantity"
        enterKeyHint="next"
        value={qty}
        onInput={(e) => setQty(e.currentTarget.value)}
        onBlur={saveQty}
      />
      <span class="d-price">
        <MoneyInput compact nav value={price} onInput={setPrice} onBlur={savePrice} />
      </span>
      <span class="d-actions">
        <button type="button" class="btn" disabled={!title.trim() || state === 'saving'} onClick={() => void listNow()}>
          List
        </button>
        <button type="button" class="icon-btn" title="Hide this draft" aria-label="Hide this draft" onClick={() => void hide()}>
          ×
        </button>
      </span>
    </li>
  );
}
