// LocalTune service worker template.
// scripts/build.mjs injects the build version and the precache list below.

const VERSION = '__VERSION__';
const CACHE = `localtune-${VERSION}`;
const PRECACHE = __PRECACHE__;
const NAVIGATION_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE);
      // An update is ready when an older worker is still active. skipWaiting
      // stays under the page's control (see the message handler).
      if (self.registration.active) {
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) client.postMessage({ type: 'update-ready' });
      }
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key.startsWith('localtune-') && key !== CACHE).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function cacheFirst(request) {
  // Range requests must go straight to the network: Cache.put rejects a 206
  // partial response, and the audio element relies on ranges for streaming.
  if (request.headers.has('range')) return fetch(request);
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.status === 200 && response.type === 'basic') {
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (response.status === 200 && response.type === 'basic') {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = (await cache.match(request)) || (fallbackUrl && (await cache.match(fallbackUrl)));
    if (cached) return cached;
    throw new Error('offline and not cached');
  }
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } catch {
    return (
      (await cache.match(request)) ||
      (await cache.match('./index.html')) ||
      (await cache.match('./')) ||
      Response.error()
    );
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (url.pathname.endsWith('/sw.js')) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.pathname.endsWith('/manifest.webmanifest')) {
    event.respondWith(networkFirst(request, './manifest.webmanifest'));
    return;
  }

  // Demo files are streamed with Range requests; leave them to the network so
  // the browser can seek and the Cache API never sees a 206 response.
  if (url.pathname.includes('/demo/')) return;

  // Hashed /assets/ and every other same-origin GET: cache-first.
  event.respondWith(cacheFirst(request));
});
