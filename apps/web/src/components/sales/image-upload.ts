/**
 * A picture chosen on a phone, made small enough to live in a database row.
 *
 * A camera photo is 3–5MB; a product tile is 160px across and a printed logo is
 * a few hundred. Resizing here rather than on the server is deliberate: the
 * bytes never leave the device at full size, the API needs no image library and
 * no multipart parser, and a shop on a slow connection uploads 30KB instead of
 * 4MB. Everything used is native to the browser — `createImageBitmap`, a canvas
 * and `toDataURL`.
 */
export interface ResizedImage {
  readonly mime: 'image/webp' | 'image/jpeg';
  readonly dataBase64: string;
  /** For showing what was picked before it is saved. */
  readonly previewUrl: string;
}

export async function resizeImage(file: File, maxEdge: number): Promise<ResizedImage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('This browser cannot resize the picture');
  // White behind it: a transparent PNG turned into JPEG would come out black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  /*
   * WebP where it exists — roughly a third of the JPEG for the same picture —
   * and JPEG everywhere else. Checked by asking the canvas what it produced,
   * because a browser that cannot encode WebP silently returns a PNG.
   */
  const webp = canvas.toDataURL('image/webp', 0.82);
  const url = webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.82);
  const mime = url.startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg';

  return { mime, dataBase64: url.slice(url.indexOf(',') + 1), previewUrl: url };
}
