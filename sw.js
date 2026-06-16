// Bump this version whenever a cached core asset changes, so installed PWAs
// (cache-first) drop the old cache on activate and fetch the updated files.
const CACHE_NAME = 'nexshare-cache-v2';
const CORE_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/transfer.js',
  './js/particles.js',
  './js/qr-code.js',
  './manifest.webmanifest',
  './assets/logo.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((networkRes) => {
          if (!networkRes || networkRes.status !== 200 || networkRes.type !== 'basic') {
            return networkRes;
          }
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          return networkRes;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
