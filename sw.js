const C = 'chain-v9';
const FONTS = 'chain-fonts-v2';
const APP_URL = self.registration.scope + 'index.html';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(C).then(c => c.addAll([APP_URL, self.registration.scope])).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== C && k !== FONTS).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;

  // Google Fonts — stale-while-revalidate
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    e.respondWith(caches.open(FONTS).then(c =>
      c.match(e.request).then(cached => {
        const net = fetch(e.request).then(r => { c.put(e.request, r.clone()); return r; }).catch(() => null);
        return cached || net;
      })
    ));
    return;
  }

  // App HTML — cache first, network fallback (offline-first)
  if (url.endsWith('/') || url.includes('index.html')) {
    e.respondWith(
      caches.match(e.request).then(r => {
        if (r) {
          fetch(e.request).then(resp => {
            if (resp && resp.status === 200) {
              caches.open(C).then(c => c.put(e.request, resp));
            }
          }).catch(() => {});
          return r;
        }
        return fetch(e.request).then(resp => {
          if (resp && resp.status === 200) {
            caches.open(C).then(c => c.put(e.request, resp.clone()));
          }
          return resp;
        }).catch(() => caches.match(APP_URL));
      })
    );
    return;
  }

  // Everything else — network first, cache fallback
  e.respondWith(
    fetch(e.request).then(r => {
      if (r && r.status === 200 && r.type === 'basic') {
        caches.open(C).then(c => c.put(e.request, r.clone()));
      }
      return r;
    }).catch(() => caches.match(e.request) || caches.match(APP_URL))
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
