import { UPLOAD } from '../../shared/config';

export type ImageType = (typeof UPLOAD.types)[number];

/** Sniffs the real format from magic bytes; never trust the declared type alone. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

export interface CheckedImage {
  bytes: ArrayBuffer;
  type: ImageType;
}

/** Validates one uploaded file: present, within size, declared and actual type allowed and matching. */
export async function checkImage(
  file: File | string | null,
  maxBytes: number,
  label: string,
): Promise<CheckedImage | string> {
  if (!file || typeof file === 'string') return `Missing ${label} image.`;
  if (file.size === 0) return `${label} image is empty.`;
  if (file.size > maxBytes) return `${label} image is too large (max ${Math.round(maxBytes / 1024)} KB).`;
  const bytes = await file.arrayBuffer();
  const actual = sniffImageType(new Uint8Array(bytes, 0, Math.min(16, bytes.byteLength)));
  if (!actual || !(UPLOAD.types as readonly string[]).includes(file.type) || actual !== file.type) {
    return `${label} image must be WebP or JPEG.`;
  }
  return { bytes, type: actual };
}

const EXT: Record<ImageType, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg' };

/** Immutable, unguessable keys. Not tied to an item, so duplicated items can share them. */
export function newPhotoKeys(mainType: ImageType, thumbType: ImageType) {
  const id = crypto.randomUUID();
  return { main: `photos/${id}.${EXT[mainType]}`, thumb: `photos/${id}-t.${EXT[thumbType]}` };
}

/** Stores main + thumbnail. Returns the keys. */
export async function putPhoto(bucket: R2Bucket, main: CheckedImage, thumb: CheckedImage) {
  const keys = newPhotoKeys(main.type, thumb.type);
  await Promise.all([
    bucket.put(keys.main, main.bytes, { httpMetadata: { contentType: main.type } }),
    bucket.put(keys.thumb, thumb.bytes, { httpMetadata: { contentType: thumb.type } }),
  ]);
  return keys;
}
