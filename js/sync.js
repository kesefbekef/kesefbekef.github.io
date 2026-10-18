// סנכרון בין הטלפונים של בני הבית דרך Supabase.
// הנתונים נשמרים קודם כל במכשיר (עובד גם בלי אינטרנט), ונשלחים לענן ברקע.
import { CONFIG } from './config.js';
import * as db from './db.js';

let sb = null, hh = null, channel = null, onRemote = null, flushing = false;
export const enabled = () => !!(CONFIG.url && CONFIG.key);
export const household = () => hh;

let loading;
function loadLib() {
  if (window.supabase) return Promise.resolve();
  loading ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/supabase.js'; s.onload = res; s.onerror = () => { loading = null; rej(new Error('lib')); };
    document.head.appendChild(s);
  });
  return loading;
}
async function client() {
  if (sb) return sb;
  await loadLib();
  sb = window.supabase.createClient(CONFIG.url, CONFIG.key, { auth: { persistSession: true, autoRefreshToken: true } });
  return sb;
}

const HEB_ERR = {
  'Invalid login credentials': 'המייל או הסיסמה לא נכונים',
  'User already registered': 'המייל הזה כבר רשום — נסה "כניסה"',
  'Password should be at least 6 characters': 'הסיסמה צריכה להיות לפחות 6 תווים',
  'bad code': 'הקוד לא נמצא. בדוק שהעתקת נכון',
  'Email not confirmed': 'צריך לאשר את המייל (או לכבות אישור מייל ב-Supabase)',
};
const nice = e => {
  const m = e?.message || String(e);
  const k = Object.keys(HEB_ERR).find(x => m.includes(x));
  return k ? HEB_ERR[k] : (/fetch|network/i.test(m) ? 'אין חיבור לאינטרנט' : m);
};

// ---------- כניסה ----------
export async function user() {
  if (!enabled()) return null;
  const c = await client();
  return (await c.auth.getSession()).data.session?.user || null;
}
export async function signIn(email, password) {
  const { error } = await (await client()).auth.signInWithPassword({ email, password });
  if (error) throw new Error(nice(error));
}
export async function signUp(email, password) {
  const { data, error } = await (await client()).auth.signUp({ email, password });
  if (error) throw new Error(nice(error));
  if (!data.session) throw new Error(HEB_ERR['Email not confirmed']);
}
export async function signOut() {
  stop(); hh = null;
  await db.setKV('household', null, true);
  await (await client()).auth.signOut();
}

// ---------- משפחה ----------
export async function loadHousehold() {
  const { data, error } = await (await client()).rpc('my_household');
  if (error) throw new Error(nice(error));
  hh = data?.[0] || null;
  await db.setKV('household', hh, true);
  return hh;
}
export async function createHousehold(name) {
  const { error } = await (await client()).rpc('create_household', { hname: name });
  if (error) throw new Error(nice(error));
  await loadHousehold();
  await pushEverything();
  return hh;
}
export async function joinHousehold(code) {
  const { error } = await (await client()).rpc('join_household', { code });
  if (error) throw new Error(nice(error));
  await loadHousehold();
  await pushEverything();
  return hh;
}

export const isParent = () => !hh || hh.role !== 'child';

// ניהול משפחה (רק להורים — נאכף גם בשרת)
export async function listMembers() {
  const { data, error } = await (await client()).rpc('list_members');
  if (error) throw new Error(nice(error));
  return data || [];
}
export async function setRole(uid, role) {
  const { error } = await (await client()).rpc('set_member_role', { target: uid, new_role: role });
  if (error) throw new Error(/last parent/.test(error.message) ? 'חייב להישאר לפחות הורה אחד' : nice(error));
}
export async function removeMember(uid) {
  const { error } = await (await client()).rpc('remove_member', { target: uid });
  if (error) throw new Error(/last parent/.test(error.message) ? 'חייב להישאר לפחות הורה אחד' : nice(error));
}

// ---------- תור שליחה (עובד גם כשאין רשת) ----------
async function enqueue(op) {
  const box = await db.getKV('outbox', []);
  // שינוי חדש לאותה רשומה מחליף את הישן
  const key = op.t === 'kv' ? 'kv:' + op.key : 'tx:' + op.id;
  const next = box.filter(o => (o.t === 'kv' ? 'kv:' + o.key : 'tx:' + o.id) !== key);
  next.push(op);
  await db.setKV('outbox', next, true);
  flush();
}

export async function flush() {
  if (!hh || flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const c = await client();
    let box = await db.getKV('outbox', []);
    while (box.length) {
      const batch = box.slice(0, 200);
      const txRows = batch.filter(o => o.t === 'tx' || o.t === 'del').map(o =>
        o.t === 'del' ? { household_id: hh.id, id: o.id, data: {}, deleted: true } : { household_id: hh.id, id: o.id, data: o.data, deleted: false });
      const kvRows = batch.filter(o => o.t === 'kv').map(o => ({ household_id: hh.id, key: o.key, value: o.value }));
      if (txRows.length) { const { error } = await c.from('tx').upsert(txRows); if (error) throw error; }
      if (kvRows.length) { const { error } = await c.from('kv').upsert(kvRows); if (error) throw error; }
      // מוחקים מהתור רק את מה שנשלח (שינוי חדש יותר לאותה רשומה נשאר)
      box = (await db.getKV('outbox', [])).filter(o => !batch.some(b => b.t === o.t && b.id === o.id && b.key === o.key && b.at === o.at));
      await db.setKV('outbox', box, true);
    }
    status('ok');
  } catch (e) { console.warn('sync flush', e); status('wait'); }
  finally { flushing = false; }
}

async function pushEverything() {
  for (const t of await db.allTx()) await enqueue({ t: 'tx', id: t.id, data: t, at: Date.now() });
  for (const k of ['budgets', 'learned', 'people']) {
    const v = await db.getKV(k, null);
    if (v && (Array.isArray(v) ? v.length : Object.keys(v).length)) await enqueue({ t: 'kv', key: k, value: v, at: Date.now() });
  }
}

// ---------- קבלת שינויים מהטלפונים האחרים ----------
async function applyTx(row) {
  if (row.deleted) await db.delTx(row.id, true);
  else await db.putTx(row.data, true);
}
async function applyKv(row) {
  if (['budgets', 'learned', 'people'].includes(row.key)) await db.setKV(row.key, row.value, true);
}

export async function pull() {
  if (!hh) return 0;
  const c = await client();
  const since = await db.getKV('lastSync', '1970-01-01T00:00:00Z');
  let latest = since, n = 0;
  for (const table of ['tx', 'kv']) {
    let from = since;
    for (;;) {
      const { data, error } = await c.from(table).select('*').eq('household_id', hh.id).gt('updated_at', from).order('updated_at').limit(1000);
      if (error) throw error;
      for (const row of data) { table === 'tx' ? await applyTx(row) : await applyKv(row); n++; }
      if (data.length) { from = data[data.length - 1].updated_at; if (from > latest) latest = from; }
      if (data.length < 1000) break;
    }
  }
  await db.setKV('lastSync', latest, true);
  return n;
}

function subscribe() {
  stop();
  channel = sb.channel('hh-' + hh.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tx', filter: `household_id=eq.${hh.id}` }, async p => { await applyTx(p.new); onRemote?.(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kv', filter: `household_id=eq.${hh.id}` }, async p => { await applyKv(p.new); onRemote?.(); })
    .subscribe();
}
function stop() { if (channel) { sb.removeChannel(channel); channel = null; } }

// ---------- מצב ----------
let statusCb = null;
function status(s) { statusCb?.(s); }

/** מופעל בעליית האפליקציה. מחזיר { user, household } */
export async function start({ onRemoteChange, onStatus }) {
  onRemote = onRemoteChange; statusCb = onStatus;
  db.hooks.tx = t => hh && enqueue({ t: 'tx', id: t.id, data: t, at: Date.now() });
  db.hooks.del = id => hh && enqueue({ t: 'del', id, at: Date.now() });
  db.hooks.kv = (key, value) => hh && enqueue({ t: 'kv', key, value, at: Date.now() });
  if (!enabled()) return { user: null, household: null };
  try {
    const u = await user();
    if (!u) return { user: null, household: null };
    hh = await db.getKV('household', null);
    try { await loadHousehold(); } catch { /* בלי רשת — נשתמש במה ששמור */ }
    if (hh) {
      await flush();
      if (await pull()) onRemote?.();
      subscribe();
      window.addEventListener('online', async () => { await flush(); if (await pull()) onRemote?.(); });
      document.addEventListener('visibilitychange', async () => { if (!document.hidden) { await flush(); if (await pull()) onRemote?.(); } });
    }
    return { user: u, household: hh };
  } catch (e) { console.warn('sync start', e); status('wait'); return { user: null, household: hh }; }
}

/** אחרי כניסה/הצטרפות */
export async function connected() {
  await db.setKV('lastSync', '1970-01-01T00:00:00Z', true);
  await flush();
  await pull();
  subscribe();
}
