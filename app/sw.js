/* 缓存 App 外壳，数据接口不缓存（始终请求最新） */
var CACHE = 'rshnb-app-v1';
var SHELL = [
  '/app/',
  '/app/index.html',
  '/app/app.css',
  '/app/app.js',
  '/app/manifest.webmanifest',
  '/app/icons/icon-192.png',
  '/app/icons/icon-512.png',
  '/app/icons/icon-mask.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.indexOf('/app/') === 0) {
    e.respondWith(
      caches.match(e.request).then(function (hit) {
        return hit || fetch(e.request).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
          return res;
        });
      })
    );
  }
});