// מאפשר לאפליקציה להיפתח גם בלי אינטרנט
const CACHE = 'kesef-20261018231042';
const FILES = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/db.js', 'js/parse.js', 'js/categories.js', 'js/importer.js', 'js/exporter.js', 'js/sync.js', 'js/lock.js', 'js/help.js', 'js/config.js', 'vendor/supabase.js', 'vendor/exceljs.min.js', 'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs', 'vendor/xlsx.full.min.js',
  'manifest.webmanifest', 'guide/', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// קודם מהרשת (כדי לקבל עדכונים), ואם אין רשת — מהעותק השמור
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => {
    if (r.ok && new URL(e.request.url).origin === location.origin) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request)));
});
