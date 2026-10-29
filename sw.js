/* Service worker — two separate caches so app updates never re-download the Quran data.
 *
 *  SHELL_CACHE  index.html, manifest, icons (+ anything fetched at runtime, e.g. web fonts).
 *               Served network-first, so a new index.html shows up by itself —
 *               you do NOT need to touch this file when only index.html changes.
 *
 *  DATA_CACHE   ~1,300 files under ./data/ (pages, fonts, translations).
 *               Served cache-first and never deleted on update. Only bump DATA_CACHE
 *               if the files inside ./data/ themselves change.
 */
const SHELL_CACHE = "mushaf-shell";
const DATA_CACHE = "mushaf-data-v1";
const NUM_PAGES = 604;
const NUM_SURAHS = 114;
const NETWORK_TIMEOUT_MS = 3500; // off-grid / weak signal: fall back to the cached copy quickly

const SHELL_FILES = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

function dataFiles() {
  const files = [];
  for (let i = 1; i <= NUM_PAGES; i++) {
    files.push(`./data/pages/page_${String(i).padStart(3, "0")}.json`);
    files.push(`./data/fonts/p${i}.woff2`);
  }
  for (let i = 1; i <= NUM_SURAHS; i++) {
    files.push(`./data/translations/surah_${String(i).padStart(3, "0")}.json`);
  }
  return files;
}

async function broadcastProgress(done, total) {
  const list = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of list) client.postMessage({ type: "offline-cache-progress", done, total });
}

/* Fill DATA_CACHE. A file is only downloaded if it isn't already in ANY cache — so users
   coming from the old single-cache version (mushaf-offline-vN) get their data copied across
   instead of re-downloaded. */
async function fillDataCache() {
  const cache = await caches.open(DATA_CACHE);
  const files = dataFiles();
  const missing = [];
  for (const url of files) {
    if (await cache.match(url)) continue;
    const old = await caches.match(url); // searches every cache, including legacy ones
    if (old) await cache.put(url, old);
    else missing.push(url);
  }
  if (!missing.length) return; // nothing to download → no progress banner either

  let done = 0, idx = 0;
  const total = missing.length;
  async function worker() {
    while (idx < missing.length) {
      const url = missing[idx++];
      try {
        const res = await fetch(url);
        if (res && res.ok) await cache.put(url, res);
      } catch (e) { /* the app falls back to the live API for anything missing */ }
      done++;
      if (done % 15 === 0 || done === total) broadcastProgress(done, total);
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  broadcastProgress(total, total);
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL_FILES.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: "reload" })); // bypass the browser's HTTP cache
        if (res && res.ok) await shell.put(url, res);
      } catch (e) { /* offline during install — existing cached copy (if any) stays */ }
    }));
    await fillDataCache();
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, DATA_CACHE];
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isDataRequest(url) {
  return url.origin === self.location.origin && url.pathname.includes("/data/");
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await Promise.race([
      fetch(request, { cache: "no-cache" }), // always revalidate, ignore the HTTP cache
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS)),
    ]);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(request, { ignoreSearch: true });
    return cached || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Quran data: cache-first, never refetched unless missing.
  if (isDataRequest(url)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const res = await fetch(request);
        if (res && res.ok) (await caches.open(DATA_CACHE)).put(request, res.clone());
        return res;
      } catch (e) { return Response.error(); }
    })());
    return;
  }

  // The app itself (page load, index.html, manifest, icons): network-first with offline fallback.
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Third-party (e.g. Google Fonts, live API fallbacks): cache-first, filled at runtime.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const res = await fetch(request);
      if (res && (res.ok || res.type === "opaque")) (await caches.open(SHELL_CACHE)).put(request, res.clone());
      return res;
    } catch (e) { return Response.error(); }
  })());
});
