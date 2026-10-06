import { useEffect, useState } from 'preact/hooks';
import { ITEM_STATUSES, STATUS_LABELS, type Condition, type Item, type ItemStatus } from '../../../shared/items';
import { parseMoney, toMajorString } from '../../../shared/money';
import { ApiError, api, errorMessage } from '../../lib/api';
import { photoForm } from '../../lib/images';
import {
  CategoryInput,
  ConditionPicker,
  Field,
  MAX_PHOTOS,
  MoneyInput,
  PendingTray,
  PhotoButtons,
  QuantityStepper,
  startProcessing,
  useToasts,
  type PendingPhoto,
} from './fields';

interface Form {
  title: string;
  quantity: number;
  price: string;
  condition: Condition;
  category: string;
  tags: string;
  description: string;
  status: ItemStatus;
}

const toForm = (i: Item): Form => ({
  title: i.title,
  quantity: i.quantity,
  price: toMajorString(i.price),
  condition: i.condition,
  category: i.category ?? '',
  tags: i.tags.join(', '),
  description: i.description ?? '',
  status: i.status,
});

export default function ItemEditor() {
  const id = Number(new URLSearchParams(location.search).get('id'));
  const [item, setItem] = useState<Item | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [uploads, setUploads] = useState<PendingPhoto[]>([]);
  const toast = useToasts();

  useEffect(() => {
    if (!Number.isInteger(id) || id <= 0) return setNotFound(true);
    api<{ item: Item }>(`/api/items/${id}`)
      .then(({ item }) => {
        setItem(item);
        setForm(toForm(item));
        document.title = `${item.title || 'Draft'} · Resellable`;
      })
      .catch((err) => (err instanceof ApiError && err.status === 404 ? setNotFound(true) : toast.push({ kind: 'error', text: errorMessage(err) })));
  }, [id]);

  if (notFound) {
    return (
      <div class="panel">
        <h2>Item not found</h2>
        <p class="muted">It may belong to someone else, or the link is wrong.</p>
        <a class="btn" href="/sell">Back to inventory</a>
      </div>
    );
  }
  if (!item || !form) return <p class="muted">Loading…</p>;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => f && { ...f, [k]: v });
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(item));

  async function save() {
    const price = parseMoney(form!.price);
    if (Number.isNaN(price)) return setErrors({ price: 'Enter an amount like 350 or 349.50, or leave empty.' });
    setBusy('Saving…');
    setErrors({});
    try {
      const res = await api<{ item: Item }>(`/api/items/${item!.id}`, {
        method: 'PATCH',
        body: {
          title: form!.title,
          quantity: form!.quantity,
          price,
          condition: form!.condition,
          category: form!.category || null,
          tags: form!.tags,
          description: form!.description || null,
          status: form!.status,
        },
      });
      setItem(res.item);
      setForm(toForm(res.item));
      toast.push({ kind: 'ok', text: 'Saved.' });
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else toast.push({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function duplicate() {
    if (dirty && !confirm('You have unsaved changes. Duplicate the saved version anyway?')) return;
    setBusy('Duplicating…');
    try {
      const res = await api<{ item: Item }>(`/api/items/${item!.id}/duplicate`, { method: 'POST' });
      location.href = `/sell/item?id=${res.item.id}&copied=1`;
    } catch (err) {
      toast.push({ kind: 'error', text: errorMessage(err) });
      setBusy(null);
    }
  }

  // Photos: added photos upload immediately (in order), independent of Save.
  const onUpdate = (p: PendingPhoto) => setUploads((all) => all.map((x) => (x.key === p.key ? { ...x, ...p, result: x.result } : x)));
  async function addFiles(files: File[]) {
    const pending = startProcessing(files, onUpdate);
    setUploads((all) => [...all, ...pending]);
    for (const p of pending) {
      try {
        const processed = await p.result;
        await api(`/api/items/${item!.id}/photos`, { method: 'POST', body: photoForm(processed) });
        setUploads((all) => all.filter((x) => x.key !== p.key));
        if (p.preview) URL.revokeObjectURL(p.preview);
      } catch (err) {
        if (err instanceof ApiError) onUpdate({ ...p, state: 'error', error: errorMessage(err) });
      }
    }
    const res = await api<{ item: Item }>(`/api/items/${item!.id}`);
    setItem((cur) => cur && { ...cur, photos: res.item.photos });
  }

  async function removePhoto(photoId: number) {
    if (!confirm('Remove this photo?')) return;
    try {
      await api(`/api/items/${item!.id}/photos/${photoId}`, { method: 'DELETE' });
      setItem((cur) => cur && { ...cur, photos: cur.photos.filter((p) => p.id !== photoId) });
    } catch (err) {
      toast.push({ kind: 'error', text: errorMessage(err) });
    }
  }

  async function makeCover(photoId: number) {
    const ids = [photoId, ...item!.photos.map((p) => p.id).filter((x) => x !== photoId)];
    try {
      const res = await api<{ item: Item }>(`/api/items/${item!.id}/photos/order`, { method: 'PUT', body: { ids } });
      setItem((cur) => cur && { ...cur, photos: res.item.photos });
    } catch (err) {
      toast.push({ kind: 'error', text: errorMessage(err) });
    }
  }

  const copied = new URLSearchParams(location.search).has('copied');
  const remaining = MAX_PHOTOS - item.photos.length - uploads.filter((u) => u.state !== 'error').length;

  return (
    <form
      class="editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {copied && <p class="tag tag-ok block">This is a copy, saved as a draft. Edit it and list it when ready.</p>}

      <section class="panel">
        <h2 class="section-title">
          Photos <span class="num muted">{item.photos.length}</span>
        </h2>
        {item.photos.length > 0 && (
          <ul class="thumbs">
            {item.photos.map((p, i) => (
              <li key={p.id} class="thumb ready">
                <a href={p.url} target="_blank" rel="noopener">
                  <img src={p.thumbUrl} alt={`Photo ${i + 1}`} loading="lazy" />
                </a>
                {i === 0 ? (
                  <span class="cover-badge">cover</span>
                ) : (
                  <button type="button" class="cover-btn" onClick={() => void makeCover(p.id)}>
                    make cover
                  </button>
                )}
                <button type="button" class="thumb-x" aria-label={`Remove photo ${i + 1}`} onClick={() => void removePhoto(p.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <PendingTray photos={uploads} onRemove={(k) => setUploads((all) => all.filter((x) => x.key !== k))} />
        <PhotoButtons onFiles={(f) => void addFiles(f)} remaining={remaining} />
      </section>

      <section class="panel">
        <Field label="Title" error={errors.title}>
          <input type="text" value={form.title} autocomplete="off" onInput={(e) => set('title', e.currentTarget.value)} />
        </Field>
        <div class="row-2">
          <Field label="Quantity in stock" error={errors.quantity}>
            <QuantityStepper value={form.quantity} onChange={(n) => set('quantity', n)} />
          </Field>
          <Field label="Price each" error={errors.price} hint="Empty = make an offer">
            <MoneyInput value={form.price} onInput={(v) => set('price', v)} />
          </Field>
        </div>
        <ConditionPicker value={form.condition} onChange={(c) => set('condition', c)} />
        <Field label="Category" error={errors.category}>
          <CategoryInput value={form.category} onInput={(v) => set('category', v)} />
        </Field>
        <Field label="Tags" error={errors.tags} hint="Comma-separated">
          <input type="text" value={form.tags} autocomplete="off" onInput={(e) => set('tags', e.currentTarget.value)} />
        </Field>
        <Field label="Description" error={errors.description}>
          <textarea rows={5} value={form.description} onInput={(e) => set('description', e.currentTarget.value)} />
        </Field>
        <Field label="Status" error={errors.status}>
          <select value={form.status} onChange={(e) => set('status', e.currentTarget.value as ItemStatus)}>
            {ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
        <p class="muted small">Price tiers (e.g. 5+ for a lower price) and bundles arrive in milestone 4.</p>
      </section>

      <div class="action-bar">
        {busy ? (
          <p class="busy">
            <span class="dot pulse" /> {busy}
          </p>
        ) : (
          <p class="muted small">{dirty ? 'Unsaved changes' : 'All changes saved'}</p>
        )}
        <div class="actions">
          <button type="button" class="btn btn-ghost" disabled={!!busy} onClick={() => void duplicate()}>
            Duplicate
          </button>
          <button type="submit" class="btn" disabled={!!busy || !dirty}>
            Save
          </button>
        </div>
      </div>
      {toast.view}
    </form>
  );
}
