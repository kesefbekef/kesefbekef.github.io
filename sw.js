// מאפשר לאפליקציה להיפתח גם בלי אינטרנט — ומהר
const CACHE = 'kesef-20261019141420';
// קבצים שנשמרים מיד בהתקנה (הספריות הכבדות — אקסל/PDF — נשמרות רק בפעם הראשונה שמשתמשים בהן)
const FILES = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/db.js', 'js/parse.js', 'js/categories.js', 'js/importer.js', 'js/exporter.js', 'js/sync.js', 'js/lock.js', 'js/help.js', 'js/config.js', 'js/track.js', 'vendor/supabase.js',
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
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const mine = url.origin === location.origin;
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
