// Minimal offline cache so the app installs & opens without a connection.
const CACHE = "dcc-advent-v43";
const ASSETS = [
  "./","./index.html","./styles.css","./config.js","./strings.js","./app.js",
  "./days.json","./manifest.webmanifest","./icon.svg","./samu-portrait.jpg"
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // Always fetch content fresh when possible so you can edit days.json; fall back to cache offline.
  if (url.pathname.endsWith("days.json") || url.pathname.endsWith("strings.js")) {
    e.respondWith(fetch(e.request).then(async response => {
      if (!response.ok) throw new Error(`Contenido: ${response.status}`);
      const cache = await caches.open(CACHE);
      try { await cache.put(e.request, response.clone()); }
      catch(error){ console.warn("No se pudo actualizar el contenido sin conexión.", error); }
      return response;
    }).catch(async error => {
      const cached = await caches.match(e.request);
      if (cached) return cached;
      throw error;
    }));
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
