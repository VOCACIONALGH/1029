self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("fetch", () => {
    // Nenhum cache extra
});
