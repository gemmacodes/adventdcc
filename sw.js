// Minimal offline cache so the app installs & opens without a connection.
const CACHE = "dcc-advent-v25";
const ASSETS = [
  "./","./index.html","./styles.css","./config.js","./app.js",
  "./days.json","./manifest.webmanifest","./icon.svg"
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Always fetch content fresh when possible so you can edit days.json; fall back to cache offline.
  if (url.pathname.endsWith("days.json")) {
    e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
