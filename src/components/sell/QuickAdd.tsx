import { useRef, useState } from 'preact/hooks';
import type { Condition, Item } from '../../../shared/items';
import { parseMoney } from '../../../shared/money';
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

/**
 * One screen: photos, title, quantity, price, condition. Everything else is
 * tucked under "More details". "Save & add another" keeps category, tags and
 * condition for the next item.
 */
export default function QuickAdd() {
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [title, setTitle] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [price, setPrice] = useState('');
  const [condition, setCondition] = useState<Condition>('new');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [description, setDescription] = useState('');
  const [listNow, setListNow] = useState(true);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(0);
  const titleRef = useRef<HTMLInputElement>(null);
  const toast = useToasts();

  const update = (p: PendingPhoto) => setPhotos((all) => all.map((x) => (x.key === p.key ? { ...x, ...p, result: x.result } : x)));
  const addFiles = (files: File[]) => setPhotos((all) => [...all, ...startProcessing(files, update)]);
  const remove = (key: string) =>
    setPhotos((all) => {
      const gone = all.find((p) => p.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return all.filter((p) => p.key !== key);
    });

  function reset() {
    photos.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
    setPhotos([]);
    setTitle('');
    setQuantity(1);
    setPrice('');
    setDescription('');
    setErrors({});
    // category, tags and condition carry over to the next item
  }

  async function save(another: boolean) {
    const parsed = parseMoney(price);
    const errs: Record<string, string> = {};
    if (listNow && !title.trim()) errs.title = 'Add a title (or untick "List now" to save a draft).';
    if (Number.isNaN(parsed)) errs.price = 'Enter an amount like 350 or 349.50, or leave empty.';
    if (photos.some((p) => p.state === 'processing')) errs.photos = 'Wait for photos to finish processing.';
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setBusy('Saving…');
    let item: Item;
    try {
      ({ item } = await api<{ item: Item }>('/api/items', {
        method: 'POST',
        body: {
          title,
          quantity,
          price: parsed,
          condition,
          category: category || null,
          tags,
          description: description || null,
          status: listNow ? 'listed' : 'draft',
        },
      }));
    } catch (err) {
      setBusy(null);
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else toast.push({ kind: 'error', text: errorMessage(err) });
      return;
    }

    // Item exists now; upload photos in order so the first stays the cover.
    const ready = photos.filter((p) => p.state === 'ready');
    let failed = 0;
    for (const [i, p] of ready.entries()) {
      setBusy(`Uploading photo ${i + 1} of ${ready.length}…`);
      try {
        await api(`/api/items/${item.id}/photos`, { method: 'POST', body: photoForm(await p.result) });
      } catch {
        failed++;
      }
    }
    setBusy(null);
    setSaved((n) => n + 1);

    const href = `/sell/item?id=${item.id}`;
    const name = item.title || 'Draft';
    if (failed) {
      toast.push({ kind: 'error', text: `Saved "${name}", but ${failed} photo(s) failed to upload.`, href, linkText: 'Retry' });
    } else if (another) {
      toast.push({ kind: 'ok', text: `Saved "${name}"${ready.length ? ` with ${ready.length} photo(s)` : ''}.`, href, linkText: 'Edit' });
    }
    if (another || failed) {
      reset();
      window.scrollTo({ top: 0 });
      titleRef.current?.focus({ preventScroll: true });
    } else {
      location.href = href;
    }
  }

  const ready = photos.filter((p) => p.state !== 'error').length;

  return (
    <form
      class="quick-add"
      onSubmit={(e) => {
        e.preventDefault();
        void save(true);
      }}
    >
      <section class="panel">
        <h2 class="section-title">Photos</h2>
        <PhotoButtons onFiles={addFiles} disabled={!!busy} remaining={MAX_PHOTOS - ready} />
        <PendingTray photos={photos} onRemove={remove} />
        {errors.photos && <p class="field-error">{errors.photos}</p>}
      </section>

      <section class="panel">
        <Field label="Title" error={errors.title}>
          <input
            ref={titleRef}
            type="text"
            value={title}
            autocomplete="off"
            enterKeyHint="next"
            placeholder="ESP32-WROOM-32 dev board"
            onInput={(e) => setTitle(e.currentTarget.value)}
            onKeyDown={(e) => {
              // Enter moves on to price instead of saving a half-filled item.
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.form?.querySelector<HTMLInputElement>('.money input')?.focus();
              }
            }}
          />
        </Field>

        <div class="row-2">
          <Field label="Quantity" error={errors.quantity}>
            <QuantityStepper value={quantity} onChange={setQuantity} />
          </Field>
          <Field label="Price each" error={errors.price} hint="Empty = make an offer">
            <MoneyInput value={price} onInput={setPrice} />
          </Field>
        </div>

        <ConditionPicker value={condition} onChange={setCondition} />

        <details class="more" open={more} onToggle={(e) => setMore((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>
            More details
            {(category || tags) && !more && (
              <span class="muted small"> · {[category, tags].filter(Boolean).join(' · ')}</span>
            )}
          </summary>
          <Field label="Category" error={errors.category} hint="Kept for the next item">
            <CategoryInput value={category} onInput={setCategory} />
          </Field>
          <Field label="Tags" error={errors.tags} hint="Comma-separated. Kept for the next item">
            <input type="text" value={tags} autocomplete="off" placeholder="wifi, bluetooth, 3.3v" onInput={(e) => setTags(e.currentTarget.value)} />
          </Field>
          <Field label="Description" error={errors.description}>
            <textarea rows={4} value={description} onInput={(e) => setDescription(e.currentTarget.value)} />
          </Field>
        </details>

        <label class="check">
          <input type="checkbox" checked={listNow} onChange={(e) => setListNow(e.currentTarget.checked)} />
          <span>List now (untick to save as a draft)</span>
        </label>
      </section>

      <div class="action-bar">
        {busy ? (
          <p class="busy">
            <span class="dot pulse" /> {busy}
          </p>
        ) : (
          saved > 0 && <p class="muted small">{saved} saved this session</p>
        )}
        <div class="actions">
          <button type="button" class="btn btn-ghost" disabled={!!busy} onClick={() => void save(false)}>
            Save
          </button>
          <button type="submit" class="btn" disabled={!!busy}>
            Save &amp; add another
          </button>
        </div>
      </div>
      {toast.view}
    </form>
  );
}
