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

// ------------------------------------------------------------------ push notifications

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Resellable', body: event.data ? event.data.text() : '' };
  }
  const url = data.url || '/deals';
  event.waitUntil(
    (async () => {
      // Open pages refresh straight away (badges, the deal being viewed).
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) w.postMessage({ type: 'push', url });
      await self.registration.showNotification(data.title || 'Resellable', {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        tag: data.tag || undefined,
        renotify: !!data.tag,
        data: { url },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/deals', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Reuse an open window: the exact page if open, else any app window.
      const exact = windows.find((w) => w.url === target);
      if (exact) return exact.focus();
      const any = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (any) {
        await any.focus();
        return any.navigate(target);
      }
      return self.clients.openWindow(target);
    })(),
  );
});

// The browser rotated the subscription: re-subscribe and tell the server (the session cookie goes with it).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch('/api/push/key', { credentials: 'same-origin' });
      if (!res.ok) return;
      const { publicKey } = await res.json();
      if (!publicKey) return;
      const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((publicKey.length + 3) % 4));
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)),
      });
      // CSRF: the server requires the per-session token; fetch it from /api/me first.
      const me = await fetch('/api/me', { credentials: 'same-origin' });
      if (!me.ok) return;
      const { csrfToken } = await me.json();
      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(sub.toJSON()),
      });
    })(),
  );
});
