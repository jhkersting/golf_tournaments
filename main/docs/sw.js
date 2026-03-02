const SW_VERSION = "2026-03-02-v2";
const STATIC_CACHE = `golf-static-${SW_VERSION}`;
const DATA_CACHE = `golf-data-${SW_VERSION}`;
const SCOPE_PATH = new URL(self.registration.scope).pathname;

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./admin.html",
  "./edit.html",
  "./enter.html",
  "./scoreboard.html",
  "./hole-map.html",
  "./styles.css",
  "./theme.js",
  "./nav.js",
  "./pwa.js",
  "./app.js",
  "./admin.js",
  "./edit.js",
  "./enter.js",
  "./scoreboard.js",
  "./hole-map.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
];

function isDocsPath(pathname) {
  return pathname.startsWith(SCOPE_PATH);
}

function isHoleDataPath(pathname) {
  return pathname.includes("/golf_course_hole_geo_data/data/");
}

async function networkFirst(request, cacheName, fallbackUrl = null) {
  const cache = await caches.open(cacheName);
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      await cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (_) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    throw new Error("No cached response");
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then(async (response) => {
      if (response && response.ok) {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    void networkPromise;
    return cached;
  }

  const network = await networkPromise;
  if (network) return network;
  throw new Error("No response available");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== STATIC_CACHE && key !== DATA_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const docsRequest = isDocsPath(url.pathname);
  const holeDataRequest = isHoleDataPath(url.pathname);

  if (!docsRequest && !holeDataRequest) return;

  if (holeDataRequest) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, STATIC_CACHE, "./hole-map.html"));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
});
