const CACHE_NAME = "scanner-cache-v1";

const FILES = [
  "index.html",
  "manifest.json",

  "css/estrutura.css",
  "css/interface.css",

  "js/estrutura.js",
  "js/interface.js",
  "js/geometria.js",
  "js/exportacao.js"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(FILES))
  );
});

self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});
