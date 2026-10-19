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
  'too many tries': 'יותר מדי ניסיונות. נסה שוב בעוד שעה',
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
  try { await flush(); } catch { /* בלי רשת — מה שלא נשלח נשאר בטלפון */ }
  stop(); hh = null;
  await db.setKV('household', null, true);
  await db.setKV('lastUser', null, true);
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
  const { data, error } = await (await client()).rpc('join_household', { code });
  if (error) throw new Error(nice(error));
  if (!data) throw new Error(HEB_ERR['bad code']);
  await loadHousehold();
  await pushEverything();
  return hh;
}

export const isParent = () => !hh || hh.role !== 'child';

export async function renameHousehold(name) {
  const { error } = await (await client()).rpc('rename_household', { new_name: name });
  if (error) throw new Error(nice(error));
  await loadHousehold();
}
export async function leaveHousehold() {
  const { error } = await (await client()).rpc('leave_household');
  if (error) throw new Error(/last parent/.test(error.message) ? 'אתה ההורה היחיד — קודם תהפוך מישהו אחר להורה' : nice(error));
  stop(); hh = null;
  await db.clearFamilyData();
}
// 🔑 שכחתי סיסמה — נשלח מייל עם קישור; הקישור פותח את האפליקציה ושם בוחרים סיסמה חדשה
export async function resetPassword(email) {
  const { error } = await (await client()).auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) throw new Error(/rate|seconds/i.test(error.message) ? 'כבר שלחנו מייל — חכה דקה ונסה שוב' : nice(error));
}
// בודק סיסמה בלי לצאת מהחשבון (לפתיחת נעילה כששכחו את הקוד)
export async function checkPassword(password) {
  const u = await user();
  if (!u?.email) throw new Error('אין חשבון מחובר במכשיר הזה');
  const { error } = await (await client()).auth.signInWithPassword({ email: u.email, password });
  if (error) throw new Error(nice(error));
}
export async function changePassword(pw) {
  const { error } = await (await client()).auth.updateUser({ password: pw });
  if (error) throw new Error(nice(error));
}

export async function saveFeedback(row) {
  if (!enabled() || !(await user())) return false;
  const { error } = await (await client()).from('feedback').insert({ ...row, household_id: hh?.id || null });
  return !error;
}

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
const opKey = o => o.t === 'kv' ? 'kv:' + o.key : 'tx:' + o.id;
async function enqueue(...ops) {
  const box = await db.getKV('outbox', []);
  // שינוי חדש לאותה רשומה מחליף את הישן
  const keys = new Set(ops.map(opKey));
  const next = box.filter(o => !keys.has(opKey(o)));
  next.push(...ops);
  await db.setKV('outbox', next, true);
  flush();
}

// ---------- מיזוג: כששני טלפונים שומרים יחד, שומרים את השינויים של שניהם ----------
// base = הגרסה האחרונה שהטלפון הזה קיבל מהענן. מה שהשתנה מקומית מאז — מנצח; כל השאר — מהענן.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function merge3(base, local, remote) {
  if (Array.isArray(local) || Array.isArray(remote)) {
    const m = l => new Map((l || []).map(x => [x.id, x]));
    const B = m(base), L = m(local), R = m(remote), out = [];
    for (const id of new Set([...R.keys(), ...L.keys()])) {
      const v = !same(L.get(id), B.get(id)) ? L.get(id) : R.get(id);
      if (v) out.push(v);
    }
    return out;
  }
  const b = base || {}, l = local || {}, r = remote || {}, out = {};
  for (const k of new Set([...Object.keys(r), ...Object.keys(l)])) {
    const v = !same(l[k], b[k]) ? l[k] : r[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
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
      const rejected = [];
      if (txRows.length) await send(c, 'tx', txRows, rejected);
      for (const row of kvRows) {
        // ממזגים עם מה שכבר בענן (אולי טלפון אחר שמר בינתיים)
        const { data: cur, error } = await c.from('kv').select('value').eq('household_id', hh.id).eq('key', row.key).maybeSingle();
        if (error) throw error;
        const base = await db.getKV('base:' + row.key, null);
        if (cur && base !== null) row.value = merge3(base, row.value, cur.value);
        if (await send(c, 'kv', [row], rejected)) {
          await db.setKV('base:' + row.key, row.value, true);
          if (!same(row.value, await db.getKV(row.key, null))) { await db.setKV(row.key, row.value, true); remoteChanged(); }
        }
      }
      if (rejected.length) {
        const parked = await db.getKV('outboxRejected', []);
        await db.setKV('outboxRejected', [...parked, ...rejected].slice(-200), true);
      }
      // מוחקים מהתור רק את מה שנשלח (שינוי חדש יותר לאותה רשומה נשאר)
      box = (await db.getKV('outbox', [])).filter(o => !batch.some(b => b.t === o.t && b.id === o.id && b.key === o.key && b.at === o.at));
      await db.setKV('outbox', box, true);
    }
    status('ok');
  } catch (e) { console.warn('sync flush', e); status('wait'); }
  finally { flushing = false; }
}

// שולח שורות. אם השרת דוחה (לא בעיית רשת) — שולח אחת-אחת ומדלג על מה שנדחה, כדי שלא ייתקע הכל
async function send(c, table, rows, rejected) {
  const { error } = await c.from(table).upsert(rows);
  if (!error) return true;
  if (!error.code || !navigator.onLine) throw error;
  if (rows.length === 1) { console.warn('sync rejected', table, error); rejected.push({ table, row: rows[0], error: error.message }); return false; }
  for (const r of rows) await send(c, table, [r], rejected);
  return true;
}

async function pushEverything() {
  const ops = (await db.allTx()).map(t => ({ t: 'tx', id: t.id, data: t, at: Date.now() }));
  for (const k of ['budgets', 'learned', 'people', 'cats']) {
    const v = await db.getKV(k, null);
    if (v && (Array.isArray(v) ? v.length : Object.keys(v).length)) ops.push({ t: 'kv', key: k, value: v, at: Date.now() });
  }
  if (ops.length) await enqueue(...ops);
}

// ---------- קבלת שינויים מהטלפונים האחרים ----------
async function applyTx(row) {
  if (row.deleted) await db.delTx(row.id, true);
  else await db.putTx(row.data, true);
}
async function applyKv(row) {
  if (!['budgets', 'learned', 'people', 'cats'].includes(row.key)) return;
  const pending = (await db.getKV('outbox', [])).find(o => o.t === 'kv' && o.key === row.key);
  if (pending) {
    // יש כאן שינוי שעוד לא נשלח — ממזגים, ולא דורסים אותו
    const merged = merge3(await db.getKV('base:' + row.key, null), pending.value, row.value);
    await db.setKV(row.key, merged, true);
    pending.value = merged;
    const box = await db.getKV('outbox', []);
    await db.setKV('outbox', box.map(o => o.t === 'kv' && o.key === row.key ? { ...o, value: merged } : o), true);
  } else await db.setKV(row.key, row.value, true);
  await db.setKV('base:' + row.key, row.value, true);
}

// רענון מסך אחד לכמה שינויים שמגיעים ביחד (במקום 300 רענונים)
let remoteT;
function remoteChanged() { clearTimeout(remoteT); remoteT = setTimeout(() => onRemote?.(), 250); }

export async function pull() {
  if (!hh) return 0;
  const c = await client();
  const since = await db.getKV('lastSync', '1970-01-01T00:00:00Z');
  let latest = since, n = 0;
  for (const table of ['tx', 'kv']) {
    let from = new Date(Math.max(0, Date.parse(since) - 10000)).toISOString();
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
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tx', filter: `household_id=eq.${hh.id}` }, async p => { await applyTx(p.new); remoteChanged(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kv', filter: `household_id=eq.${hh.id}` }, async p => { await applyKv(p.new); remoteChanged(); })
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
    await db.setKV('lastUser', { id: u.id, email: u.email }, true);
    hh = await db.getKV('household', null);
    try { await loadHousehold(); } catch { /* בלי רשת — נשתמש במה ששמור */ }
    if (hh) {
      // לא מחכים לרשת — האפליקציה כבר עובדת עם מה ששמור בטלפון
      refresh().then(() => subscribe()).catch(e => { console.warn('sync start', e); status('wait'); });
      listen();
    }
    return { user: u, household: hh };
  } catch (e) {
    // תקלה (בדרך כלל בלי אינטרנט) — אם יש משפחה שמורה, ממשיכים כרגיל עם מה שבטלפון
    console.warn('sync start', e); status('wait');
    const saved = hh || await db.getKV('household', null);
    const last = await db.getKV('lastUser', null);
    if (saved && last) { hh = saved; listen(); return { user: last, household: hh }; }
    return { user: null, household: null };
  }
}

async function refresh() { await flush(); if (await pull()) remoteChanged(); }
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener('online', () => refresh().then(() => { if (!channel && sb) subscribe(); }).catch(() => status('wait')));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().catch(() => status('wait')); });
}

/** אחרי כניסה/הצטרפות */
export async function connected() {
  await db.setKV('lastSync', '1970-01-01T00:00:00Z', true);
  await flush();
  await pull();
  subscribe();
  listen();
}

// 📧 סיכום חודשי למייל (להורים)
export async function getMonthlyEmail() {
  const { data, error } = await (await client()).rpc('my_monthly_email');
  if (error) throw new Error(nice(error));
  return data !== false;
}
export async function setMonthlyEmail(on) {
  const { error } = await (await client()).rpc('set_monthly_email', { on_: !!on });
  if (error) throw new Error(nice(error));
}
