// Namae's service worker: keeps the app usable offline after the first visit. Registered by src/main.tsx in
// production builds only.
//
//   at install                    everything the app needs to start (PRECACHE, filled in by the build)
//   the page (a navigation to     network first, the cached copy only when the network fails or stalls
//     this directory itself)
//   assets/ (hashed by the build) cache first: a name never changes its content
//   art/ and fonts/               cache first: bump VERSION when a file changes under the same name
//   data/                         stale while revalidate: answer from the cache, refresh it in the background
//   everything else               network, falling back to the cache
//
// Nothing outside this directory is touched, and only GET requests are.

const VERSION = 'v1';
// The files the app starts from, relative to this directory: the hashed script and stylesheet, the art, the
// fonts, core.json. The build writes the list here (vite.config.ts); in the source it is empty.
const PRECACHE = ["assets/index-CzlSYoy4.css","assets/index-DBtWUkTx.js","art/apple-touch-icon.png","art/bamboo-left.webp","art/bamboo-right.webp","art/bunny-alright.webp","art/bunny-cheer.webp","art/bunny-hello.webp","art/bunny-lantern.webp","art/bunny-love.webp","art/bunny-nope.webp","art/bunny-oops.webp","art/bunny-pair.webp","art/bunny-sleep.webp","art/bunny-star.webp","art/bunny-wait.webp","art/bunny-write.webp","art/favicon.png","art/icon-192.png","art/lantern.webp","art/match-bamboo.webp","art/paper.webp","art/sky.webp","fonts/kiwi-maru-500-latin-ext.woff2","fonts/kiwi-maru-500-latin.woff2","fonts/nunito-variable-latin-ext.woff2","fonts/nunito-variable-latin.woff2","data/core.json","manifest.webmanifest"];
const PAGE = `namae-page-${VERSION}`;
const STATIC = `namae-static-${VERSION}`;
const DATA = `namae-data-${VERSION}`;
const KEEP = new Set([PAGE, STATIC, DATA]);

/** How long a navigation waits for the network before the cached page is shown instead. */
const PAGE_TIMEOUT_MS = 4000;
/** Hashed assets pile up across releases; the oldest beyond this many are dropped. */
const STATIC_LIMIT = 160;

const scope = new URL(self.registration.scope);

// A cached file answers every request for its address. Without this a server that sends `Vary: Origin`
// (as the preview server does) made the files fetched at install, by this worker, miss for the page's own
// requests for them, and the precache was there and never used.
const SAME_FILE = { ignoreVary: true };

/** Fetches one precache file into the cache its requests are answered from. A file that fails is left for later. */
async function precache(path) {
  const url = new URL(path, scope).href;
  const cache = await caches.open(path.startsWith('data/') ? DATA : STATIC);
  if (await cache.match(url, SAME_FILE)) return;
  try {
    const response = await fetch(url);
    if (response.ok && response.type === 'basic') await cache.put(url, response);
  } catch {
    // Offline in the middle of the install: what is missing is cached when the page asks for it.
  }
}

self.addEventListener('install', (event) => {
  // The page and everything it starts from are cached at install, so the very first offline visit already
  // works. The first page load itself happens before this worker is in control, and caches nothing.
  event.waitUntil(
    caches
      .open(PAGE)
      .then((cache) => cache.add(new Request(scope.href, { cache: 'reload' })))
      .catch(() => undefined)
      .then(() => Promise.all(PRECACHE.map(precache)))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith('namae-') && !KEEP.has(name)).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

function isFresh(response) {
  return response && response.ok && response.type === 'basic';
}

async function trim(cacheName, limit) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (const request of keys.slice(0, Math.max(0, keys.length - limit))) await cache.delete(request);
}

/** The app's page is this directory itself, or its index.html. Every other address in it is a file. */
function isAppPage(path) {
  return path === '' || path === 'index.html';
}

function isHtml(response) {
  return (response.headers.get('Content-Type') || '').toLowerCase().startsWith('text/html');
}

/**
 * The page: always try the network, so a new release shows on the next visit and a stale shell never sticks.
 * Only a navigation to the app's page comes here, and only an HTML answer is kept. Every navigation in the
 * directory used to, and its answer was stored as the page whatever it was: after someone opened a font
 * licence or core.json in the browser, the next offline or slow start showed that file in place of the app.
 */
async function page(request) {
  const cache = await caches.open(PAGE);
  const fromNetwork = fetch(request).then((response) => {
    if (isFresh(response) && isHtml(response)) void cache.put(scope.href, response.clone());
    return response;
  });
  // The network answer still updates the cache when it arrives after the timeout.
  fromNetwork.catch(() => undefined);
  const stalled = new Promise((resolve) => setTimeout(() => resolve(null), PAGE_TIMEOUT_MS));
  try {
    const first = await Promise.race([fromNetwork, stalled]);
    if (first) return first;
  } catch {
    // offline: fall through to the cache
  }
  return (await cache.match(scope.href, SAME_FILE)) ?? fromNetwork;
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request, SAME_FILE);
  if (hit) return hit;
  const response = await fetch(request);
  if (isFresh(response)) {
    void cache.put(request, response.clone()).then(() => trim(STATIC, STATIC_LIMIT));
  }
  return response;
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(DATA);
  const hit = await cache.match(event.request, SAME_FILE);
  const refresh = fetch(event.request)
    .then((response) => {
      if (isFresh(response)) void cache.put(event.request, response.clone());
      return response;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(refresh);
    return hit;
  }
  return (await refresh) ?? Response.error();
}

async function networkFirst(request) {
  const cache = await caches.open(STATIC);
  try {
    const response = await fetch(request);
    if (isFresh(response)) void cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request, SAME_FILE);
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const path = url.pathname.slice(scope.pathname.length);

  if (request.mode === 'navigate' && isAppPage(path)) {
    event.respondWith(page(request));
  } else if (path.startsWith('assets/') || path.startsWith('art/') || path.startsWith('fonts/')) {
    event.respondWith(cacheFirst(request));
  } else if (path.startsWith('data/')) {
    event.respondWith(staleWhileRevalidate(event));
  } else if (path !== 'sw.js') {
    event.respondWith(networkFirst(request));
  }
});
