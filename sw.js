importScripts("./sw.config.js");

const build = new URL(self.location.href).searchParams.get("build") || "1";
const CACHE_NAME = `${CACHE_PREFIX}-${build}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./offline.html",
  "./css/styles.css",
  "./js/app.js",
  "./js/sea-routes.js",
  "./js/pwa-update.js",
  "./js/cloud-sync.js",
  "./js/cloud-share.js",
  "./js/cloud-sync-data.js",
  "./deploy-version.js",
  "./cloud-sync.config.json",
  "./version.json",
  "./manifest.webmanifest",
  "./pwa.config.json",
  "./sw.config.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./privacy.html",
  "./terms.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  const path = url.pathname.replace(/\/$/, "");
  if (
    /\/(?:js\/[^/]+\.js|deploy-version\.js|css\/styles\.css|version\.json|index\.html|cloud-sync\.runtime\.json|cloud-sync\.config\.json)$/.test(
      path
    )
  ) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (data.type === "PURGE_CACHES") {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))));
  }
});

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(CACHE_NAME);
      try {
        await cache.put(request, res.clone());
      } catch {
        /* body already read */
      }
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const offline = await caches.match("./offline.html");
      if (offline) return offline;
    }
    throw new Error("offline");
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then(async (res) => {
      if (res?.ok) {
        try {
          await cache.put(request, res.clone());
        } catch {
          /* ignore */
        }
      }
      return res;
    })
  if (cached) {
    networkPromise.catch(() => {});
    return cached;
  }
  const network = await networkPromise.catch(() => null);
  return network || new Response("offline", { status: 503 });
}