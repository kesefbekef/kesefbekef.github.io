// שמירת הנתונים בתוך המכשיר (IndexedDB) — נשמר גם אחרי סגירת האפליקציה
// 🎭 מצב הדגמה: מאגר נפרד לגמרי — הנתונים האמיתיים לא נגעים
export const DEMO = (() => { try { return localStorage.getItem('kesef-demo') === '1'; } catch { return false; } })();
const DB_NAME = DEMO ? 'kesef-bekef-demo' : 'kesef-bekef';
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('tx', { keyPath: 'id' });
      db.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function store(name, mode) {
  return (await open()).transaction(name, mode).objectStore(name);
}
const done = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

// הסנכרון נרשם כאן כדי לשמוע על כל שינוי מקומי (remote=true — שינוי שהגיע מטלפון אחר)
export const hooks = { tx: null, del: null, kv: null };
const SYNCED_KV = ['budgets', 'learned', 'people', 'cats', 'goals', 'maaser', 'pocket', 'debts'];

export async function allTx() { return done((await store('tx', 'readonly')).getAll()); }
export async function putTx(t, remote = false) { const r = await done((await store('tx', 'readwrite')).put(t)); if (!remote) hooks.tx?.(t); return r; }
export async function delTx(id, remote = false) { const r = await done((await store('tx', 'readwrite')).delete(id)); if (!remote) hooks.del?.(id); return r; }
export async function getKV(key, fallback) {
  const v = await done((await store('kv', 'readonly')).get(key));
  return v === undefined ? fallback : v;
}
export async function setKV(key, val, remote = false) {
  const r = await done((await store('kv', 'readwrite')).put(val, key));
  if (!remote && SYNCED_KV.includes(key)) hooks.kv?.(key, val);
  return r;
}

export async function exportAll() {
  return { version: 1, exported: new Date().toISOString(), tx: await allTx(),
    budgets: await getKV('budgets', {}), learned: await getKV('learned', {}), people: await getKV('people', []), cats: await getKV('cats', {}), goals: await getKV('goals', {}), maaser: await getKV('maaser', {}), pocket: await getKV('pocket', {}), debts: await getKV('debts', {}) };
}
export async function importAll(data) {
  if (!data || !Array.isArray(data.tx)) throw new Error('קובץ גיבוי לא תקין');
  for (const t of data.tx) await putTx(t);
  if (data.budgets) await setKV('budgets', data.budgets);
  if (data.learned) await setKV('learned', data.learned);
  if (data.people) await setKV('people', data.people);
  for (const k of ['cats', 'goals', 'maaser', 'pocket', 'debts']) if (data[k]) await setKV(k, data[k]);
}

// מעבר משפחה: מוחקים מהמכשיר את נתוני המשפחה הקודמת (בענן הם נשארים אצלה)
export async function clearFamilyData() {
  const db = await open();
  await done(db.transaction('tx', 'readwrite').objectStore('tx').clear());
  for (const k of ['budgets', 'learned', 'people', 'outbox', 'outboxRejected', 'lastSync', 'household', 'me', 'base:budgets', 'base:learned', 'base:people', 'cats', 'base:cats', 'goals', 'base:goals', 'maaser', 'base:maaser', 'pocket', 'base:pocket', 'debts', 'base:debts'])
    await done(db.transaction('kv', 'readwrite').objectStore('kv').delete(k));
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// 🎭 איפוס נתוני ההדגמה: מרוקנים את המאגר במקום למחוק אותו (מחיקה נתקעת כשהאפליקציה פתוחה)
export async function clearAll() {
  if (!DEMO) throw new Error('only in demo');
  const db = await open();
  await done(db.transaction('tx', 'readwrite').objectStore('tx').clear());
  await done(db.transaction('kv', 'readwrite').objectStore('kv').clear());
}
