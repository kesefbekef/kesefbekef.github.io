// מאפשר לאפליקציה להיפתח גם בלי אינטרנט — ומהר
const CACHE = 'kesef-20261023130331';
// קבצים שנשמרים מיד בהתקנה (הספריות הכבדות — אקסל/PDF — נשמרות רק בפעם הראשונה שמשתמשים בהן)
const FILES = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/db.js', 'js/parse.js', 'js/categories.js', 'js/importer.js', 'js/exporter.js', 'js/sync.js', 'js/lock.js', 'js/help.js', 'js/demo-data.js', 'js/fixed.js', 'js/whats-new.js', 'js/review.js', 'js/config.js', 'js/track.js', 'vendor/supabase.js',
  'manifest.webmanifest', 'guide/', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png', 'icons/icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // מוחקים רק עותקים ישנים של כסף בכיף — לא נוגעים באפליקציות אחרות באותה כתובת
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('kesef-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// קודם מהעותק בטלפון (פתיחה מיידית), ובמקביל מביאים גרסה טרייה מהרשת לפעם הבאה.
// עדכון אמיתי של האפליקציה מגיע דרך גרסה חדשה של הקובץ הזה (מוחלף בכל העלאה).
// באותה כתובת יושבות גם אפליקציות אחרות (/zman/, /lomdim/ …) — נוגעים רק במה ששייך לכסף בכיף
const BASE = new URL('./', location).pathname;
const OWN_DIRS = ['guide', 'css', 'js', 'vendor', 'icons', 'admin'];
function isOurs(url) {
  if (url.origin !== location.origin || !url.pathname.startsWith(BASE)) return false;
  const rest = url.pathname.slice(BASE.length);
  if (!rest.includes('/')) return rest === '' || rest.includes('.'); // השורש וקבצי השורש (index.html, manifest…)
  return OWN_DIRS.includes(rest.split('/')[0]);
}
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const mine = isOurs(url);
  if (url.origin === location.origin && !mine) return; // אפליקציה אחרת — הדפדפן מטפל לבד
  const fonts = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!mine && !fonts) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: mine });
    const net = fetch(e.request, mine ? { cache: 'no-cache' } : {}).then(r => {
      if (r.ok || r.type === 'opaque') c.put(e.request, r.clone());
      return r;
    });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net.catch(async () => (e.request.mode === 'navigate' && await c.match('./')) || Response.error());
  }));
});

// 🔔 התראה מהשרת (קטגוריה הגיעה ל-90% / 100% מהתקציב)
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: 'כסף בכיף', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'כסף בכיף ✨', {
    body: d.body || '', tag: d.tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', dir: 'rtl', lang: 'he', data: { url: d.url || './' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const w = list.find(c => isOurs(new URL(c.url)));
    return w ? w.focus().then(c => c.navigate?.(url) || c) : self.clients.openWindow(url);
  }));
});
