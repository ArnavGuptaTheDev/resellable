import { UPLOAD } from '../../shared/config';

export interface ProcessedImage {
  main: Blob;
  thumb: Blob;
}

type Source = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

const dims = (s: Source) =>
  s instanceof HTMLImageElement ? { w: s.naturalWidth, h: s.naturalHeight } : { w: s.width, h: s.height };

/** Decodes with EXIF orientation applied. Falls back to <img> where createImageBitmap can't read the file. */
async function decode(file: Blob): Promise<Source> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Scales so the long edge is at most maxPx, halving in steps first so large
 * reductions (4000px → 400px) stay sharp instead of aliasing.
 */
function resize(src: Source, maxPx: number): HTMLCanvasElement {
  let { w, h } = dims(src);
  const scale = Math.min(1, maxPx / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  let cur: Source = src;
  while (w / 2 >= tw * 1.5 && h / 2 >= th * 1.5) {
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    cur = draw(cur, w, h);
  }
  return draw(cur, tw, th);
}

function draw(src: Source, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** WebP if the browser can encode it (it silently returns PNG otherwise), else JPEG. Steps quality down to fit maxBytes. */
async function encode(canvas: HTMLCanvasElement, quality: number, maxBytes: number): Promise<Blob> {
  let c = canvas;
  for (let attempt = 0; attempt < 8; attempt++) {
    const q = Math.max(0.5, quality - attempt * 0.08);
    let blob = await toBlob(c, 'image/webp', q);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(c, 'image/jpeg', q);
    if (!blob) throw new Error('This browser could not encode the image.');
    if (blob.size <= maxBytes) return blob;
    // Still too big at the lowest quality: shrink 15% and try again.
    if (q === 0.5) c = draw(c, Math.round(c.width * 0.85), Math.round(c.height * 0.85));
  }
  throw new Error('Could not make the image small enough.');
}

/** Turns a camera/gallery file into an upload-ready main image and thumbnail. */
export async function processImage(file: File): Promise<ProcessedImage> {
  if (!file.type.startsWith('image/') && !/\.(heic|heif)$/i.test(file.name)) {
    throw new Error(`${file.name} is not an image.`);
  }
  let src: Source;
  try {
    src = await decode(file);
  } catch {
    throw new Error(`Couldn't read ${file.name}. Try a JPEG or PNG.`);
  }
  try {
    const mainCanvas = resize(src, UPLOAD.mainMaxPx);
    const main = await encode(mainCanvas, UPLOAD.mainQuality, UPLOAD.mainMaxBytes);
    // Thumbnail from the already-reduced main canvas: faster, same quality.
    const thumb = await encode(resize(mainCanvas, UPLOAD.thumbMaxPx), UPLOAD.thumbQuality, UPLOAD.thumbMaxBytes);
    return { main, thumb };
  } finally {
    if ('close' in src) src.close();
  }
}

export function photoForm(p: ProcessedImage): FormData {
  const ext = (b: Blob) => (b.type === 'image/webp' ? 'webp' : 'jpg');
  const form = new FormData();
  form.append('main', p.main, `main.${ext(p.main)}`);
  form.append('thumb', p.thumb, `thumb.${ext(p.thumb)}`);
  return form;
}
