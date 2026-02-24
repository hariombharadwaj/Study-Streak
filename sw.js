// ============================================================
// CHAIN — Service Worker  (sw.js)
// Cache:  chain-v9  |  Fonts: chain-fonts-v2
//
// TIMEZONE: All times in IST (UTC+5:30). Fixed offset, no DST.
//
// ALARM SYSTEM:
//   App sends reminder times (IST HH:MM) via postMessage → stored in IDB.
//   SW checks times on every navigation fetch + periodicsync.
//   Fires real notifications even when app is backgrounded/screen off.
//
// Caching strategy:
//   • App shell  → cache-first, background revalidate
//   • Fonts       → stale-while-revalidate, separate long-lived cache
//   • Everything else → network-first, cache fallback
// ============================================================

const C        = 'chain-v9';
const FONTS    = 'chain-fonts-v2';
const SCOPE    = self.registration.scope;
const APP_URL  = SCOPE;

// IST = UTC + 5h 30m = UTC + 330 minutes (no DST, always fixed)
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ── IST date/time helpers ─────────────────────────────────────
function _istNow(){
  // Returns an object with IST hour, minute, and YYYY-MM-DD date string
  const nowMs  = Date.now();
  const istMs  = nowMs + IST_OFFSET_MS;
  const istDate = new Date(istMs);
  const h   = istDate.getUTCHours();
  const m   = istDate.getUTCMinutes();
  const y   = istDate.getUTCFullYear();
  const mo  = String(istDate.getUTCMonth()+1).padStart(2,'0');
  const d   = String(istDate.getUTCDate()).padStart(2,'0');
  return { h, m, mins: h*60+m, iso: `${y}-${mo}-${d}` };
}

// ── In-memory alarm state (persisted across SW restarts via IDB) ──
let _alarmTimes   = [];   // ['15:00','20:00','22:00'] — IST times
let _alarmEnabled = false;
let _lastFiredTimes = {}; // { 'HH:MM': 'YYYY-MM-DD' } — IST date last fired

// ── Simple SW-side IDB for alarm persistence ─────────────────
const SW_IDB_NAME  = 'chain_sw_alarms';
const SW_IDB_STORE = 'config';

function swIDBOpen(){
  return new Promise((res, rej) => {
    const r = indexedDB.open(SW_IDB_NAME, 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore(SW_IDB_STORE, {keyPath:'k'});
    r.onsuccess = e => res(e.target.result);
    r.onerror   = ()  => rej();
  });
}
function swIDBGet(key){
  return swIDBOpen().then(db => new Promise((res) => {
    const tx  = db.transaction(SW_IDB_STORE, 'readonly');
    const req = tx.objectStore(SW_IDB_STORE).get(key);
    req.onsuccess = () => res(req.result ? req.result.v : null);
    req.onerror   = () => res(null);
  })).catch(() => null);
}
function swIDBSet(key, val){
  return swIDBOpen().then(db => new Promise((res) => {
    const tx = db.transaction(SW_IDB_STORE, 'readwrite');
    tx.objectStore(SW_IDB_STORE).put({k: key, v: val});
    tx.oncomplete = () => res();
    tx.onerror    = () => res();
  })).catch(() => {});
}

// ── Load / save alarm config ──────────────────────────────────
async function loadAlarmConfig(){
  const cfg = await swIDBGet('alarm_config');
  if(cfg){
    _alarmTimes     = cfg.times      || [];
    _alarmEnabled   = cfg.enabled    || false;
    _lastFiredTimes = cfg.firedTimes || {};
  }
}
async function saveAlarmConfig(){
  await swIDBSet('alarm_config', {
    times:      _alarmTimes,
    enabled:    _alarmEnabled,
    firedTimes: _lastFiredTimes
  });
}

// ── Core alarm check ─────────────────────────────────────────
// All time comparisons are in IST. Alarm times stored as IST HH:MM.
async function checkAndFireAlarms(){
  if(!_alarmEnabled || !_alarmTimes.length) return;

  const ist = _istNow();
  let fired = false;

  for(const time of _alarmTimes){
    const [th, tm]   = time.split(':').map(Number);
    const targetMins = th * 60 + tm;
    const lastFiredOn = _lastFiredTimes[time] || '';

    // Fire window: within 15 min after target IST time, not already fired today (IST)
    if(ist.mins >= targetMins && ist.mins <= targetMins + 15 && lastFiredOn !== ist.iso){
      _lastFiredTimes[time] = ist.iso;
      fired = true;

      // Read streak from app's IDB for a personalised message
      let streak = 0;
      try {
        const appIDB = await new Promise((res) => {
          const r = indexedDB.open('chain_backup', 1);
          r.onsuccess = e => res(e.target.result);
          r.onerror   = ()  => res(null);
        });
        if(appIDB){
          streak = await new Promise(res => {
            const tx  = appIDB.transaction('kv', 'readonly');
            const req = tx.objectStore('kv').get('ch_streak');
            req.onsuccess = () => res(req.result ? (req.result.v || 0) : 0);
            req.onerror   = () => res(0);
          });
        }
      } catch(e){ streak = 0; }

      const msgs = [
        `🔗 Streak: ${streak} days! Don't break the chain today!`,
        `🔥 ${streak} days strong! Log your 4h study session now!`,
        `⏰ Time to study! Day ${streak} streak is counting on you!`,
        `💪 ${streak} day streak — keep it alive! Log your session.`,
      ];
      const body = msgs[Math.floor(Math.random() * msgs.length)];

      await self.registration.showNotification('CHAIN 🔗', {
        body,
        icon:  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="%2314532d"/><text y=".9em" font-size="70" x="15">🔗</text></svg>',
        badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="%2314532d"/><text y=".9em" font-size="70" x="15">🔗</text></svg>',
        vibrate:           [200, 100, 200, 100, 200],
        tag:               `chain-reminder-${time}`, // replaces old notif for same slot
        renotify:          true,
        requireInteraction: false,
        data: { url: SCOPE, time }
      });
    }
  }

  if(fired) await saveAlarmConfig();
}

// ── INSTALL ───────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(C)
      .then(c  => c.add(APP_URL))
      .then(()  => self.skipWaiting())
      .catch(() => self.skipWaiting()) // activate even if offline during install
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    Promise.all([
      // Delete old caches
      caches.keys().then(keys => Promise.all(
        keys.filter(k => k !== C && k !== FONTS).map(k => caches.delete(k))
      )),
      // Load alarm config so SW is ready immediately after activation
      loadAlarmConfig()
    ]).then(() => self.clients.claim())
  );
});

// ── FETCH ────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  // Piggyback alarm check on every page navigation (non-blocking)
  if(e.request.mode === 'navigate') checkAndFireAlarms().catch(() => {});

  if(e.request.method !== 'GET') return;
  const url = e.request.url;

  // Google Fonts — stale-while-revalidate, long-lived separate cache
  if(url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')){
    e.respondWith(
      caches.open(FONTS).then(c =>
        c.match(e.request).then(cached => {
          const net = fetch(e.request)
            .then(r => { if(r && r.ok) c.put(e.request, r.clone()); return r; })
            .catch(() => null);
          return cached || net;
        })
      )
    );
    return;
  }

  // App shell (.html or scope root) — cache-first + silent background update
  if(url === SCOPE || url.endsWith('/') || /\.html(\?.*)?$/.test(url)){
    e.respondWith(
      caches.open(C).then(c =>
        c.match(e.request).then(cached => {
          const net = fetch(e.request).then(resp => {
            if(resp && resp.status === 200) c.put(e.request, resp.clone());
            return resp;
          }).catch(() => null);
          if(cached){ net.catch(() => {}); return cached; }
          return net || caches.match(APP_URL);
        })
      )
    );
    return;
  }

  // Everything else — network-first, cache fallback
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if(r && r.status === 200){
          caches.open(C).then(c => c.put(e.request, r.clone()));
        }
        return r;
      })
      .catch(() =>
        caches.match(e.request).then(r => r || caches.match(APP_URL))
      )
  );
});

// ── PERIODIC SYNC — Android background wakeup (hourly) ───────
self.addEventListener('periodicsync', e => {
  if(e.tag === 'chain-alarm-check'){
    e.waitUntil(loadAlarmConfig().then(checkAndFireAlarms));
  }
});

// ── NOTIFICATION CLICK — open/focus the app ──────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
      for(const c of list){
        if(c.url.startsWith(SCOPE) && 'focus' in c) return c.focus();
      }
      if(clients.openWindow) return clients.openWindow(SCOPE);
    })
  );
});

// ── MESSAGE — from app to SW ──────────────────────────────────
self.addEventListener('message', e => {
  if(!e.data) return;

  // Force SW update (called when new version detected)
  if(e.data.type === 'SKIP_WAITING'){
    self.skipWaiting();
    return;
  }

  // App syncs alarm config whenever user enables/changes reminders
  if(e.data.type === 'ALARM_CONFIG'){
    _alarmTimes   = e.data.times   || [];
    _alarmEnabled = e.data.enabled || false;
    if(e.data.resetFired) _lastFiredTimes = {}; // reset so new times fire fresh
    saveAlarmConfig().then(checkAndFireAlarms).catch(() => {});
    return;
  }

  // Manual test trigger (dev use)
  if(e.data.type === 'CHECK_ALARMS'){
    loadAlarmConfig().then(checkAndFireAlarms).catch(() => {});
    return;
  }
});
