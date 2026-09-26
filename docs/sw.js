/* sw.js — keep the app shell on the phone so it opens without a connection. */
var CACHE = 'scanner-v7';
var SHELL = [
  './', 'index.html', 'app.css', 'manifest.webmanifest',
  'js/imaging.js', 'js/pdf.js', 'js/tables.js', 'js/store.js', 'js/lock.js', 'js/ui.js', 'js/worker.js',
  'js/vendor/pdfjs/pdf.min.js', 'js/vendor/pdfjs/pdf.worker.min.js',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;

  /* Page loads go to the network first, so a new build shows the moment the
     phone is online; the cache is the fallback when it is not. Other assets
     stay cache-first for speed and offline. */
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); }).catch(function () { });
        return res;
      }).catch(function () {
        return caches.match(e.request).then(function (hit) { return hit || caches.match('index.html'); });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); }).catch(function () { });
        return res;
      });
    })
  );
});
