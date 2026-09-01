/*
 * SherERP's service worker (Phase 12.1, §5.23, D-24).
 *
 * It exists for two reasons, and deliberately does no more than those two:
 *
 *  1. **Installability.** D-24's gate begins "PWA installed", and a browser
 *     will not offer to install an app that has no service worker. Without
 *     this file the whole offline ladder has no bottom rung.
 *  2. **A launch that does not depend on the shop's internet.** The app shell
 *     is served from cache, so a counter PC on a bad line opens the till
 *     instead of a blank page.
 *
 * **It never caches the API.** Not one response, not for a second. Every
 * figure in this product — a balance, a stock count, a day's takings — is
 * read through `/api`, and a cached balance is a wrong balance shown with
 * confidence. Offline *data* is the local database of a later phase, which is
 * transactional and knows what it has not yet pushed; a cache that quietly
 * replays yesterday's JSON is not offline support, it is a lie with a fast
 * response time.
 *
 * Written by hand rather than generated, because the alternative is a build
 * plugin whose defaults include exactly the API caching this file refuses.
 */

/*
 * Bumping this name is what ships a new app shell: the new worker installs
 * beside the old one, waits, and the page offers "Update available — reload"
 * (owner decision 2026-08-31). It never activates over a running screen on its
 * own — a cashier halfway through a bill does not get their page swapped.
 */
const CACHE = 'sher-shell-v1';

/** The shell, not the data. Everything else is cached as it is first fetched. */
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // `reload` so an install never picks the shell out of the HTTP cache and
      // ships a build that is already stale.
      cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))).catch(() => undefined),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** The page asks for the swap when it is safe — never the other way round. */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isApi(url) {
  return url.pathname.startsWith('/api/') || url.pathname === '/config.json';
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The API and the runtime config are never cached, and never answered from
  // one. See the note at the top of this file.
  if (isApi(url)) return;

  // A navigation: try the network so a fresh build is picked up, fall back to
  // the cached shell so a bad line still opens the app.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/index.html', copy)).catch(() => undefined);
          return response;
        })
        .catch(async () => (await caches.match('/index.html')) ?? Response.error()),
    );
    return;
  }

  // Static assets: cache first. Vite fingerprints their names, so a cached
  // asset is never a stale version of a different file.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        }),
    ),
  );
});
