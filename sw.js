/*
 * sw.js — SleepSensor service worker
 *
 * Makes the app installable and fully usable offline. The app does no network
 * I/O at runtime (all processing is on-device), so once the shell plus the
 * TensorFlow.js CDN bundle are cached the app works with no connection at all.
 *
 * Strategy:
 *   - install : pre-cache the app shell (failures on individual files are
 *               tolerated so a missing optional asset can't break activation)
 *   - activate: drop caches from previous versions
 *   - fetch   : cache-first for same-origin app-shell assets,
 *               stale-while-revalidate for the TF.js CDN bundle,
 *               network-first (falling back to cache) for everything else
 */

const CACHE_NAME = 'sleepsensor-v4';

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/index.css',
  '/js/app.js',
  '/js/audio-engine.js',
  '/js/audio-worklet-processor.js',
  '/js/classifier.js',
  '/js/features.js',
  '/js/model-weights.js',
  '/js/storage.js',
  '/js/timeline.js',
  '/js/charts.js',
  '/js/wake-lock.js',
  '/js/utils.js',
];

const TFJS_HOST = 'cdn.jsdelivr.net';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.allSettled(
        APP_SHELL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
            console.warn('[sw] pre-cache skipped', url, err && err.message);
          })
        )
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting' || (event.data && event.data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // TF.js bundle from the allowed CDN: stale-while-revalidate
  if (url.hostname === TFJS_HOST) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (sameOrigin) {
    const isShell =
      APP_SHELL.includes(url.pathname) ||
      url.pathname.startsWith('/js/') ||
      url.pathname.startsWith('/css/') ||
      url.pathname.startsWith('/assets/');
    if (isShell || request.mode === 'navigate') {
      // Changed to networkFirst to ensure fresh files are served when online,
      // avoiding the aggressive caching problem.
      event.respondWith(networkFirst(request));
      return;
    }
  }

  event.respondWith(networkFirst(request));
});

async function cacheFirst(request, isNavigate) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && res.ok && res.type !== 'opaque') cache.put(request, res.clone());
    return res;
  } catch (err) {
    if (isNavigate) {
      const fallback = await cache.match('/index.html');
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(request);
    if (res && res.ok && res.type !== 'opaque') cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || fetch(request);
}
