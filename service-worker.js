// service-worker.js - cache básico para GitHub Pages PWA
const CACHE_NAME = "scanner-cache-v1";
const FILES = [ "/", "/index.html", "/styles.css", "/js/main.js", "/js/ui.js", "/js/camera.js", "/manifest.json" ];

self.addEventListener("install", (evt) => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (evt) => {
  evt.waitUntil(clients.claim());
});

self.addEventListener("fetch", (evt) => {
  evt.respondWith(
    caches.match(evt.request).then((cached) => cached || fetch(evt.request))
  );
});
