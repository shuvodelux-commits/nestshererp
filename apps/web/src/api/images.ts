import { ApiError, loadConfig } from './client';

/**
 * An image the API serves, as a data URL.
 *
 * **An `<img src>` cannot carry an Authorization header.** Every endpoint here
 * is tenant-scoped and behind the guard, so pointing a tag straight at
 * `/api/v1/sales/invoice-logo` produced a 401 and a broken image — which is why
 * the logo never appeared on the invoice and why Save as JPG failed: the
 * canvas draw rejects on the first image it cannot load (owner-reported,
 * 2026-08-26).
 *
 * A data URL also solves the second half of the problem. The JPG export draws
 * the invoice through an SVG `foreignObject`, and a canvas is tainted by any
 * remote image drawn into it — `toDataURL` then throws a security error even
 * when the fetch succeeds. Bytes inlined as a data URL are same-origin by
 * definition, so they draw and export cleanly.
 *
 * Cached by path: a POS grid asks for the same forty pictures on every refresh,
 * and a page of products should cost one fetch each per session.
 */
const cache = new Map<string, Promise<string | null>>();

async function fetchOnce(path: string, token: string): Promise<string | null> {
  const { apiBaseUrl } = await loadConfig();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });

  // A product without a picture is a 404, and that is not an error here: the
  // tile draws its letters instead.
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new ApiError('IMAGE_UNAVAILABLE', 'That picture could not be loaded', response.status);
  }

  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => {
      resolve(String(reader.result));
    };
    reader.onerror = (): void => {
      reject(new Error('That picture could not be read'));
    };
    reader.readAsDataURL(blob);
  });
}

export function fetchImageDataUrl(path: string, token: string): Promise<string | null> {
  const existing = cache.get(path);
  if (existing !== undefined) return existing;

  const loading = fetchOnce(path, token).catch(() => null);
  cache.set(path, loading);
  return loading;
}

/** Called after an upload or a removal, so the next read sees the new bytes. */
export function forgetImage(path: string): void {
  cache.delete(path);
}
