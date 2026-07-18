// This gets overwritten automatically by the deploy workflow
// (.github/workflows/deploy-pages.yml) with the short commit SHA on every
// push — so every deploy gets a fresh cache name and no one gets stuck on
// an old cached copy. The value below only matters for local testing.
const CACHE_VERSION = "local-dev";
const CACHE_NAME = `endgame-${CACHE_VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/engine.js",
  "./js/board.js",
  "./js/ai-worker.js",
  "./js/network.js",
  "./js/main.js",
  "./icons/icon-16.png",
  "./icons/icon-32.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

// Third-party origins the app depends on at runtime (rules engine, WebRTC
// signaling client, webfonts). These are cached the first time they're
// fetched successfully, so single-player and local two-player keep working
// offline after the first visit. Online play still needs a live connection.
const RUNTIME_CACHE_ORIGINS = [
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isRuntimeCandidate(url) {
  return RUNTIME_CACHE_ORIGINS.some((origin) => url.startsWith(origin));
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = request.url;

  // Navigations: try the network first (so people get the latest app shell
  // when online), fall back to the cached shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", resp.clone()));
          return resp;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  const sameOrigin = url.startsWith(self.location.origin);

  if (sameOrigin || isRuntimeCandidate(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((resp) => {
            if (resp && resp.ok) {
              const clone = resp.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return resp;
          })
          .catch(() => cached);
        // Stale-while-revalidate: serve cache instantly if present, refresh in background.
        return cached || network;
      })
    );
  }
});
