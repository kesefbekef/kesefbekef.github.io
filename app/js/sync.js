// סנכרון בין הטלפונים של בני הבית דרך Supabase.
// הנתונים נשמרים קודם כל במכשיר (עובד גם בלי אינטרנט), ונשלחים לענן ברקע.
import { CONFIG } from './config.js';
import * as db from './db.js';
import * as track from './track.js';

// 📊 נתוני שימוש כלליים למפתח (בלי תוכן) — ראו track.js
export const reportIssue = (m, s) => track.issue(m, s);
export const trackFail = (kind, details) => track.fail(kind, details);
if (!new URLSearchParams(location.search).has('bdika')) track.init({ app: 'kesef', url: CONFIG.url, key: CONFIG.key }); // 📱 בעמדת בדיקה — בלי מעקב

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
  if (error) { track.fail('auth', `signIn ${error.status || ''} ${error.code || error.message}`); throw new Error(nice(error)); }
}
export async function signUp(email, password) {
  const { data, error } = await (await client()).auth.signUp({ email, password });
  if (error) { track.fail('auth', `signUp ${error.status || ''} ${error.code || error.message}`); throw new Error(nice(error)); }
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
// 🔐 מעלים נתונים מהטלפון למשפחה רק אם הם מעולם לא היו של משפחה אחרת (טלפון חדש לפני הרשמה).
// אחרת — מנקים אותם קודם, כדי שנתונים של משפחה אחת לא יגיעו בטעות למשפחה אחרת
async function adoptLocalData() {
  const owner = await db.getKV('dataHousehold', null), synced = await db.getKV('lastSync', null);
  if ((owner && owner !== hh.id) || (!owner && synced)) { await db.clearFamilyData(); await db.setKV('household', hh, true); }
  else if (!owner) await pushEverything();
  await db.setKV('dataHousehold', hh.id, true);
}
export async function createHousehold(name) {
  const { error } = await (await client()).rpc('create_household', { hname: name });
  if (error) throw new Error(nice(error));
  await loadHousehold();
  await adoptLocalData();
  return hh;
}
export async function joinHousehold(code) {
  const { data, error } = await (await client()).rpc('join_household', { code });
  if (error) throw new Error(nice(error));
  if (!data) throw new Error(HEB_ERR['bad code']);
  await loadHousehold();
  await adoptLocalData();
  return hh;
}
// 🔐 הורה מחליף את קודי ההצטרפות — הקודים, הקישורים וה-QR הישנים מפסיקים לעבוד
export async function regenerateCodes() {
  const { error } = await (await client()).rpc('regenerate_codes');
  if (error) throw new Error(/not allowed/.test(error.message) ? 'רק הורה יכול להחליף קודים' : nice(error));
  await loadHousehold();
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
// 📊 האם המשתמש הוא המנהל (מציג כפתור ללוח הבקרה)
export async function isAdmin() {
  try { if (!enabled() || !(await user())) return false; const { data } = await (await client()).rpc('is_app_admin'); return data === true; }
  catch { return false; }
}
/** 📱 מה המנהל כבר אישר ✅ בעמדת הבדיקה — מפתחות "kesef|v|כותרת" (לאחרים: ריק) */
export async function bdikaApproved() {
  try { if (!enabled() || !(await user())) return []; const { data } = await (await client()).rpc('bdika_approved', { p_app: 'kesef' }); return Array.isArray(data) ? data : []; }
  catch { return []; }
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
      // 🔔 הוצאה חדשה/שונתה — מבקשים מהשרת לבדוק אם הקטגוריה הגיעה ל-90%/100% (השרת שולח להורים)
      const alertCats = [...new Set(batch.filter(o => o.t === 'tx' && o.data?.cat && o.data.cat !== 'income').map(o => o.data.cat))];
      if (alertCats.length) budgetAlert(alertCats);
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
  } catch (e) { console.warn('sync flush', e); track.fail('sync', 'flush ' + (e?.code || e?.message || e)); status('wait'); }
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
  for (const k of ['budgets', 'learned', 'people', 'cats', 'goals', 'maaser', 'pocket', 'debts', 'recurring', 'rules', 'lists']) {
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
  if (!['budgets', 'learned', 'people', 'cats', 'goals', 'maaser', 'pocket', 'debts', 'recurring', 'rules', 'lists'].includes(row.key)) return;
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
    // 🔐 החשבון עוד קיים בשרת? (נמחק / נחסם) — אם לא: מנתקים, מוחקים מהטלפון, וחוזרים למסך ההרשמה
    if (navigator.onLine) {
      const { error } = await (await client()).auth.getUser();
      if (error && (error.status === 401 || error.status === 403 || /not exist|not found|invalid claim/i.test(error.message || ''))) {
        stop(); hh = null;
        try { await (await client()).auth.signOut({ scope: 'local' }); } catch { /* */ }
        await db.clearFamilyData(); await db.setKV('lastUser', null, true);
        return { user: null, household: null, deleted: true };
      }
    }
    await db.setKV('lastUser', { id: u.id, email: u.email }, true);
    track.ping(sb);
    hh = await db.getKV('household', null);
    const prev = hh;
    let loaded = false;
    try { await loadHousehold(); loaded = true; } catch { /* בלי רשת — נשתמש במה ששמור */ }
    // 🔐 הוסרת מהמשפחה: השרת כבר לא מחזיר אותה — מוחקים מהטלפון את העותק של הנתונים שלה
    if (loaded && prev && !hh) { stop(); await db.clearFamilyData(); return { user: u, household: null, removed: prev.name || true }; }
    if (hh && !(await db.getKV('dataHousehold', null))) await db.setKV('dataHousehold', hh.id, true);
    if (hh) {
      // לא מחכים לרשת — האפליקציה כבר עובדת עם מה ששמור בטלפון
      refresh().then(() => subscribe()).catch(e => { console.warn('sync start', e); track.fail('sync', 'start ' + (e?.code || e?.message || e)); status('wait'); });
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

async function refresh() { track.ping(sb); await flush(); if (await pull()) remoteChanged(); }
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener('online', () => refresh().then(() => { if (!channel && sb) subscribe(); }).catch(() => status('wait')));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().catch(() => status('wait')); });
}

/** אחרי כניסה/הצטרפות */
export async function connected() {
  track.ping(sb);
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

// ---------- 🔔 התראות לטלפון (Web Push) — מפתח ציבורי משותף עם "זמן בכיף" ----------
export const VAPID_PUBLIC = 'BK8gkzX2KR60Q1uYUvrda0VHsqfpig72_Z1Uy2jhytvKl5uu3HbIYx93G_k53UQznMpv9bLfcPqepKRYUtGWsvI';
const b64u = s => { const p = '='.repeat((4 - s.length % 4) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); };
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export async function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ? 'on' : 'off';
}
export async function enablePush() {
  const u = await user();
  if (!u || !hh) throw new Error('צריך להיות מחוברים למשפחה');
  if (!pushSupported()) throw new Error('הטלפון הזה לא תומך בהתראות. באייפון צריך קודם להתקין את האפליקציה למסך הבית');
  if (await Notification.requestPermission() !== 'granted') throw new Error('לא ניתן אישור להתראות. אפשר לאשר בהגדרות הטלפון');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(VAPID_PUBLIC) });
  const j = sub.toJSON();
  const { error } = await (await client()).from('kesef_push_subs').upsert({ endpoint: j.endpoint, user_id: u.id, household_id: hh.id, sub: j, updated_at: new Date().toISOString() });
  if (error) throw new Error(nice(error));
}
export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) { try { await (await client()).from('kesef_push_subs').delete().eq('endpoint', sub.endpoint); } catch { /* */ } await sub.unsubscribe(); }
}
async function budgetAlert(cats) {
  try { await (await client()).functions.invoke('kesef-alert', { body: { cats } }); } catch (e) { console.warn('alert', e); track.fail('server', 'kesef-alert ' + (e?.message || e)); }
}

// ---------- 🧾 צילום קבלה (Supabase Storage, תיקייה פרטית לכל משפחה) ----------
export async function uploadReceipt(txId, blob) {
  if (!hh) throw new Error('צריך להיות מחוברים למשפחה כדי לשמור קבלה');
  if (!navigator.onLine) throw new Error('אין אינטרנט — נסו שוב כשיש קליטה');
  const path = `${hh.id}/${txId}.jpg`;
  const { error } = await (await client()).storage.from('receipts').upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
  if (error) throw new Error(nice(error));
  return path;
}
export async function receiptURL(path) {
  const { data, error } = await (await client()).storage.from('receipts').createSignedUrl(path, 600);
  if (error) throw new Error(nice(error));
  return data.signedUrl;
}
export async function deleteReceipt(path) {
  try { await (await client()).storage.from('receipts').remove([path]); } catch { /* */ }
}

// ---------- 📆 מנוי ליומן: מפתח סודי אישי (אפשר לבטל ולהחליף) ----------
export async function calendarURL(renew = false) {
  const u = await user(); if (!u || !hh) throw new Error('צריך להיות מחוברים למשפחה');
  const c = await client();
  let { data } = await c.from('kesef_cal_tokens').select('token').eq('user_id', u.id).maybeSingle();
  if (!data || renew) {
    const token = [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, '0')).join('');
    const { error } = await c.from('kesef_cal_tokens').upsert({ user_id: u.id, household_id: hh.id, token });
    if (error) throw new Error(nice(error));
    data = { token };
  }
  return `${CONFIG.url}/functions/v1/kesef-calendar?t=${data.token}`;
}

// ---------- 📥 מהיומן לאפליקציה: קישור iCal סודי של המשתמש (נשמר מוצפן בשרת; האירועים — רק שלו) ----------
// עד 5 יומנים למשתמש (למשל "היומן שלי" + "היומן המשפחתי")
export async function myCalendars() {
  const u = await user(); if (!u) return [];
  const { data } = await (await client()).from('user_calendars').select('id,label,host,last_sync,last_error,events,created_at').eq('user_id', u.id).order('created_at');
  return data || [];
}
export async function myCalendar() { return (await myCalendars())[0] || null; }
export async function connectCalendar(url, label = '') {
  const c = await client();
  const { data: host, error } = await c.rpc('set_my_calendar', { p_url: url, p_label: label || null });
  if (error) throw new Error(nice(error));
  const r = await c.functions.invoke('calendar-import', { body: {} }); // קורא עכשיו (ואחר כך כל 15 דקות)
  if (r.error) console.warn('calendar-import', r.error);
  return host;
}
export async function disconnectCalendar(id = null) {
  const { error } = await (await client()).rpc('clear_my_calendar', { p_id: id }); if (error) throw new Error(nice(error));
}
export async function upcomingEvents(days = 14, limit = 8) {
  const u = await user(); if (!u) return [];
  const now = new Date(), to = new Date(now.getTime() + days * 864e5);
  const { data } = await (await client()).from('external_events').select('uid,starts_at,ends_at,all_day,title,location')
    .eq('user_id', u.id).gte('starts_at', new Date(now.getTime() - 864e5).toISOString()).lte('starts_at', to.toISOString()).order('starts_at').limit(limit);
  return (data || []).filter(e => e.all_day ? e.starts_at.slice(0, 10) >= new Date().toISOString().slice(0, 10) : new Date(e.ends_at || e.starts_at) >= now);
}
