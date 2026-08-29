const CACHE_NAME = "mushaf-offline-v1";
const NUM_PAGES = 604;
const NUM_SURAHS = 114;

function buildFileList() {
  const files = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];
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
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of clientsList) {
    client.postMessage({ type: "offline-cache-progress", done, total });
  }
}

async function cacheAllWithProgress(cache, files) {
  const total = files.length;
  let done = 0;
  let idx = 0;
  const CONCURRENCY = 12;

  async function worker() {
    while (idx < files.length) {
      const i = idx++;
      const url = files[i];
      try {
        const existing = await cache.match(url);
        if (!existing) {
          const res = await fetch(url);
          if (res && res.ok) await cache.put(url, res);
        }
      } catch (e) {
        // Individual file failures are fine — the app falls back to the
        // live API for anything it can't find in cache.
      }
      done++;
      if (done % 15 === 0 || done === total) broadcastProgress(done, total);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  broadcastProgress(total, total);
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const files = buildFileList();
    await cacheAllWithProgress(cache, files);
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    try {
      const res = await fetch(event.request);
      if (res && res.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(event.request, res.clone());
      }
      return res;
    } catch (e) {
      return cached || Response.error();
    }
  })());
});
