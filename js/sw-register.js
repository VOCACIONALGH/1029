// sw-register.js - registra o service worker (PWA)
export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/service-worker.js");
    // opcional: console
    console.log("Service Worker registrado.");
  } catch (err) {
    console.warn("Falha ao registrar Service Worker:", err);
  }
}
