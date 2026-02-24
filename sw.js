// ============================================================
// CHAIN — Service Worker  (sw.js)
// Cache:  chain-v9  |  Fonts: chain-fonts-v2
// Strategy:
//   • App shell  → cache-first, background revalidate
//   • Fonts       → stale-while-revalidate, separate long-lived cache
//   • Everything else → network-first, cache fallback
// ============================================================

const C     = 'chain-v9';
const FONTS = 'chain-fonts-v2';

// Resolve app URL flexibly — works whether served as index.html,
// chain-v9.html, or any other filename at the scope root.
const SCOPE   = self.registration.scope;   // e.g. https://example.com/
const APP_URL = SCOPE;                     // cache the scope root

// ── INSTALL: pre-cache the app shell ────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(C)
      .then(c => c.add(APP_URL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())  // activate even if offline during install
  );
});

// ── ACTIVATE: purge old caches ───────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== C && k !== FONTS).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;

  // ── Google Fonts: stale-while-revalidate ──────────────────
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    e.respondWith(
      caches.open(FONTS).then(c =>
        c.match(e.request).then(cached => {
          const net = fetch(e.request)
            .then(r => { if (r && r.ok) c.put(e.request, r.clone()); return r; })
            .catch(() => null);
          return cached || net;
        })
      )
    );
    return;
  }

  // ── App shell (.html or scope root): cache-first + bg update ──
  if (url === SCOPE || url.endsWith('/') || /\.html(\?.*)?$/.test(url)) {
    e.respondWith(
      caches.open(C).then(c =>
        c.match(e.request).then(cached => {
          const net = fetch(e.request).then(resp => {
            if (resp && resp.status === 200) c.put(e.request, resp.clone());
            return resp;
          }).catch(() => null);

          if (cached) { net.catch(() => {}); return cached; }
          return net || caches.match(APP_URL);
        })
      )
    );
    return;
  }

  // ── Everything else: network-first, cache fallback ────────
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r && r.status === 200) {
          caches.open(C).then(c => c.put(e.request, r.clone()));
        }
        return r;
      })
      .catch(() =>
        caches.match(e.request).then(r => r || caches.match(APP_URL))
      )
  );
});

// ── MESSAGE: trigger SW update from app code ─────────────────
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
