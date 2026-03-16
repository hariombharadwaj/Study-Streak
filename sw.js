// ============================================================
// CHAIN — Service Worker  v10
// Cache: chain-v10  |  Fonts: chain-fonts-v2
//
// TIMEZONE: All times in IST (UTC+5:30). Fixed offset, no DST.
//
// ALARM SYSTEM (v2 — full alarm ring):
//   • App sends reminder times (IST HH:MM) via postMessage → stored in IDB.
//   • SW checks times on every navigation fetch + periodicsync + interval.
//   • When alarm fires:
//       - If app is OPEN & VISIBLE  → posts ALARM_RING to app → app plays loud ring + modal
//       - If app is BACKGROUNDED/CLOSED → fires persistent notification with Snooze/Dismiss actions
//   • Snooze reschedules +10 min in SW memory (no IDB write, fire-and-forget).
//   • Dismiss just closes the notification.
//
// Caching strategy:
//   • App shell  → cache-first, background revalidate
//   • Fonts      → stale-while-revalidate, separate long-lived cache
//   • Everything else → network-first, cache fallback
// ============================================================

const C        = 'chain-v10';
const FONTS    = 'chain-fonts-v2';
const SCOPE    = self.registration.scope;
const APP_URL  = SCOPE;

// IST = UTC + 5h 30m
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function _istNow(){
  const nowMs  = Date.now();
  const istMs  = nowMs + IST_OFFSET_MS;
  const d      = new Date(istMs);
  const h      = d.getUTCHours();
  const m      = d.getUTCMinutes();
  const y      = d.getUTCFullYear();
  const mo     = String(d.getUTCMonth()+1).padStart(2,'0');
  const day    = String(d.getUTCDate()).padStart(2,'0');
  return { h, m, mins: h*60+m, iso: `${y}-${mo}-${day}` };
}

// ── In-memory alarm state ─────────────────────────────────────
let _alarmTimes     = [];
let _alarmEnabled   = false;
let _lastFiredTimes = {};  // { 'HH:MM': 'YYYY-MM-DD' }
let _snoozedTimes   = {};  // { 'HH:MM_snooze': targetMins } ephemeral

// ── SW-side IDB ──────────────────────────────────────────────
const SW_IDB_NAME  = 'chain_sw_alarms';
const SW_IDB_STORE = 'config';

function swIDBOpen(){
  return new Promise((res, rej) => {
    const r = indexedDB.open(SW_IDB_NAME, 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore(SW_IDB_STORE, {keyPath:'k'});
    r.onsuccess = e => res(e.target.result);
    r.onerror   = () => rej();
  });
}
function swIDBGet(key){
  return swIDBOpen().then(db => new Promise(res => {
    const tx  = db.transaction(SW_IDB_STORE, 'readonly');
    const req = tx.objectStore(SW_IDB_STORE).get(key);
    req.onsuccess = () => res(req.result ? req.result.v : null);
    req.onerror   = () => res(null);
  })).catch(() => null);
}
function swIDBSet(key, val){
  return swIDBOpen().then(db => new Promise(res => {
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

// ── Read streak from app IDB ──────────────────────────────────
async function _readStreak(){
  let streak = 0;
  try {
    const appIDB = await new Promise(res => {
      const r = indexedDB.open('chain_backup', 1);
      r.onupgradeneeded = e => e.target.result.createObjectStore('kv', {keyPath:'k'});
      r.onsuccess = e => res(e.target.result);
      r.onerror   = () => res(null);
    });
    if(appIDB){
      streak = await new Promise(res => {
        try {
          const tx  = appIDB.transaction('kv', 'readonly');
          const req = tx.objectStore('kv').get('ch_streak');
          req.onsuccess = () => res(req.result ? (req.result.v || 0) : 0);
          req.onerror   = () => res(0);
        } catch(e){ res(0); }
      });
    }
  } catch(e){ streak = 0; }
  return streak;
}

// ── Notification icon SVG (inline, no external file needed) ──
const ICON_SVG = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%2314532d'/><text y='.9em' font-size='70' x='15'>🔗</text></svg>`;

// ── Build notification body messages ─────────────────────────
function _buildNotifBody(streak, time){
  const msgs = [
    `🔗 Day ${streak} streak on the line! Log your 4h study now.`,
    `🔥 ${streak} days strong — don't let today break the chain!`,
    `⏰ Study reminder (${time} IST) — ${streak} day streak waiting!`,
    `💪 Chain of ${streak} days! Open app & log your session.`,
    `📚 BPSC prep reminder — ${streak} day streak. Keep going!`,
  ];
  return msgs[Math.floor(Math.random() * msgs.length)];
}

// ── Core alarm check ─────────────────────────────────────────
async function checkAndFireAlarms(){
  if(!_alarmEnabled || !_alarmTimes.length) return;

  const ist  = _istNow();
  let fired  = false;

  // Build full list: regular times + any active snooze times
  const allSlots = [
    ..._alarmTimes.map(t => ({ key: t, label: t, mins: t.split(':').map(Number).reduce((h,m)=>h*60+m) })),
    ...Object.entries(_snoozedTimes).map(([k,mins]) => ({ key: k, label: k.replace('_snooze',''), mins, isSnooze: true }))
  ];

  for(const slot of allSlots){
    const lastFiredOn = slot.isSnooze ? '' : (_lastFiredTimes[slot.key] || '');
    // Fire window: within 2 min of target (tighter than before for snooze accuracy)
    const inWindow = ist.mins >= slot.mins && ist.mins <= slot.mins + 2;
    const notFiredToday = slot.isSnooze ? true : (lastFiredOn !== ist.iso);

    if(inWindow && notFiredToday){
      if(!slot.isSnooze) _lastFiredTimes[slot.key] = ist.iso;
      else delete _snoozedTimes[slot.key];
      fired = true;

      const streak = await _readStreak();

      // Check if app window is open AND visible
      const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const visibleClient = windowClients.find(c => c.visibilityState === 'visible');

      if(visibleClient){
        // App is open & focused → send message → app plays full in-app alarm ring
        visibleClient.postMessage({
          type:   'ALARM_RING',
          time:   slot.label,
          streak: streak
        });
      } else {
        // App backgrounded/closed → fire persistent notification
        const body = _buildNotifBody(streak, slot.label);
        await self.registration.showNotification('⏰ CHAIN Study Alarm', {
          body,
          icon:              ICON_SVG,
          badge:             ICON_SVG,
          vibrate:           [300, 150, 300, 150, 600, 150, 300],
          tag:               `chain-alarm-${slot.key}`,
          renotify:          true,
          requireInteraction: true,   // stays on screen until tapped
          silent:            false,
          actions: [
            { action: 'open',    title: '📖 Open App' },
            { action: 'snooze',  title: '💤 Snooze 10m' }
          ],
          data: { url: SCOPE, time: slot.label, alarmKey: slot.key }
        });
      }
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
      .catch(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    Promise.all([
      caches.keys().then(keys => Promise.all(
        keys.filter(k => k !== C && k !== FONTS).map(k => caches.delete(k))
      )),
      loadAlarmConfig()
    ]).then(() => self.clients.claim())
  );
});

// ── FETCH ────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  if(e.request.mode === 'navigate') checkAndFireAlarms().catch(() => {});

  if(e.request.method !== 'GET') return;
  const url = e.request.url;

  // Google Fonts — stale-while-revalidate
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

  // App shell — cache-first + background update
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

// ── PERIODIC SYNC — background wakeup (hourly on Android) ────
self.addEventListener('periodicsync', e => {
  if(e.tag === 'chain-alarm-check'){
    e.waitUntil(loadAlarmConfig().then(checkAndFireAlarms));
  }
});

// ── NOTIFICATION CLICK ────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};

  if(e.action === 'snooze'){
    // Snooze: schedule +10 min from now in memory
    const ist    = _istNow();
    const snoozeKey  = (data.alarmKey || data.time || 'snooze') + '_snooze';
    _snoozedTimes[snoozeKey] = ist.mins + 10;
    // Show a quick confirmation notification
    e.waitUntil(
      self.registration.showNotification('💤 Snoozed 10 min', {
        body:    'CHAIN will remind you again shortly.',
        icon:    ICON_SVG,
        tag:     'chain-snooze-confirm',
        silent:  true,
        vibrate: [50]
      })
    );
    return;
  }

  // 'open' action or tapping notification body → open/focus app
  e.waitUntil(
    self.clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
      for(const c of list){
        if(c.url.startsWith(SCOPE) && 'focus' in c) return c.focus();
      }
      if(self.clients.openWindow) return self.clients.openWindow(SCOPE);
    })
  );
});

// ── MESSAGE — from app to SW ──────────────────────────────────
self.addEventListener('message', e => {
  if(!e.data) return;

  if(e.data.type === 'SKIP_WAITING'){
    self.skipWaiting();
    return;
  }

  if(e.data.type === 'ALARM_CONFIG'){
    _alarmTimes   = e.data.times   || [];
    _alarmEnabled = e.data.enabled || false;
    if(e.data.resetFired) _lastFiredTimes = {};
    saveAlarmConfig().then(checkAndFireAlarms).catch(() => {});
    return;
  }

  if(e.data.type === 'CHECK_ALARMS'){
    loadAlarmConfig().then(checkAndFireAlarms).catch(() => {});
    return;
  }
});
