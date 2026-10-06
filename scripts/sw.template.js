/* Resellable service worker. Generated into dist/sw.js by scripts/build-sw.mjs. */
/* global self, caches, URL, Response */

const VERSION = '__VERSION__';
const SHELL = `shell-${VERSION}`;
const SHARE_INBOX = 'share-inbox';
/** App shell (static HTML pages) and hashed static assets from this build. */
const PRECACHE = __PRECACHE__;

// Never handled here: per-user data, auth flow, and authenticated images.
const NETWORK_ONLY = /^\/(api|auth|img)\//;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Web Share Target: photos shared from the gallery → Batch from photos.
  if (req.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET' || NETWORK_ONLY.test(url.pathname)) return;

  // Pages: network first (fresh shell after deploys), cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => {
        const cache = await caches.open(SHELL);
        return (
          (await cache.match(url.pathname, { ignoreSearch: true })) ||
          (await cache.match('/offline')) ||
          new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
        );
      }),
    );
    return;
  }

  // Hashed build assets never change: cache first.
  if (url.pathname.startsWith('/_astro/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
  }
});

async function receiveShare(req) {
  try {
    const form = await req.formData();
    const files = form.getAll('photos').filter((f) => typeof f !== 'string' && f.size > 0);
    const inbox = await caches.open(SHARE_INBOX);
    const stamp = Date.now();
    await Promise.all(
      files.map((f, i) =>
        inbox.put(
          `/share-inbox/${stamp}-${i}`,
          new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name || `shared-${i}.jpg`) } }),
        ),
      ),
    );
  } catch {
    /* fall through to the batch page, which shows whatever arrived */
  }
  return Response.redirect('/sell/batch?shared=1', 303);
}
