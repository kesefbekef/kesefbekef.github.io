// כסף בכיף — 🔔 התראה לטלפון כשקטגוריה מגיעה ל-90% / 100% מהתקציב.
// הטלפון שרשם הוצאה קורא לכאן (עם ההתחברות של המשתמש). השרת מחשב בעצמו (גם כשילד רשם), ושולח להורים.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

(globalThis as any).window = globalThis;
const xp = await import('./shared/exporter.js');
const { CATS, catOf, applyCustomCats } = await import('./shared/categories.js');

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
// אותו מפתח של "זמן בכיף" (אותו פרויקט)
webpush.setVapidDetails(Deno.env.get('ZMAN_VAPID_SUBJECT')!, Deno.env.get('ZMAN_VAPID_PUBLIC')!, Deno.env.get('ZMAN_VAPID_PRIVATE')!);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const fmt = (n: number) => Math.round(n).toLocaleString('he-IL') + ' ₪';

// שבת (בערך): משישי 16:00 עד מוצאי שבת 20:00 שעון ישראל — לא שולחים, נשלח אחרי שבת
function israelNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })); }
function isShabbat(d: Date) { const day = d.getDay(), h = d.getHours(); return (day === 5 && h >= 16) || (day === 6 && h < 20); }

async function sendTo(hh: string, except: string | null, payload: string) {
  const { data: parents } = await sb.from('members').select('user_id').eq('household_id', hh).eq('role', 'parent');
  const uids = (parents ?? []).map((p: any) => p.user_id).filter((u: string) => u !== except);
  if (!uids.length) return 0;
  const { data: subs } = await sb.from('kesef_push_subs').select('*').in('user_id', uids);
  let sent = 0;
  for (const s of subs ?? []) {
    try { await webpush.sendNotification(s.sub, payload, { TTL: 6 * 3600, urgency: 'normal' }); sent++; }
    catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await sb.from('kesef_push_subs').delete().eq('endpoint', s.endpoint); else console.warn('push', e?.statusCode, e?.body); }
  }
  return sent;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  const body = await req.json().catch(() => ({}));
  // בדיקה בלבד (עם הסוד של השרת): מחשב בלי לרשום ובלי לשלוח
  const dry = !!Deno.env.get('CRON_SECRET') && req.headers.get('x-cron-secret') === Deno.env.get('CRON_SECRET') && typeof body.household === 'string';
  let uid: string | null = null, hh: string;
  if (dry) hh = body.household;
  else {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = await sb.auth.getUser(token);
    if (!u?.user) return json({ error: 'not signed in' }, 401);
    uid = u.user.id;
    const { data: mem } = await sb.from('members').select('household_id').eq('user_id', uid).limit(1).maybeSingle();
    if (!mem) return json({ error: 'no household' }, 403);
    hh = mem.household_id;
  }
  const cats: string[] = Array.isArray(body.cats) ? body.cats.filter((c: any) => typeof c === 'string').slice(0, 30) : [];

  const now = israelNow(), shabbat = isShabbat(now);
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let sent = 0;

  // מה שחיכה לסוף שבת
  if (!shabbat && !dry) {
    const { data: waiting } = await sb.from('kesef_alerts').select('*').eq('household_id', hh).is('sent_at', null).eq('month', month);
    for (const a of waiting ?? []) {
      sent += await sendTo(hh, null, JSON.stringify({ title: a.title, body: a.body, url: './?v=budget', tag: `kesef-${a.cat}-${a.level}` }));
      await sb.from('kesef_alerts').update({ sent_at: new Date().toISOString() }).eq('household_id', hh).eq('cat', a.cat).eq('month', a.month).eq('level', a.level);
    }
  }
  if (!cats.length) return json({ sent });

  const kv = Object.fromEntries(((await sb.from('kv').select('key,value').eq('household_id', hh)).data || []).map((r: any) => [r.key, r.value]));
  applyCustomCats(kv.cats || {});
  const budgets = kv.budgets || {};
  const tx: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from('tx').select('data').eq('household_id', hh).eq('deleted', false).order('id').range(from, from + 999);
    tx.push(...(data ?? []).map((r: any) => r.data).filter((t: any) => !t.skip)); // ⏸️ לא נספר
    if (!data || data.length < 1000) break;
  }
  const { start, end } = xp.periodRange('month', new Date(now.getFullYear(), now.getMonth(), 15, 12));
  const occ = xp.collect(tx, start, end);
  const out: any[] = [];
  for (const cat of new Set(cats)) {
    if (cat === 'income' || !(CATS as any)[cat]) continue;
    // במצב אוטומטי: רק מה שהאפליקציה שמרה (הערכה שלא התייצבה = בלי תקציב = בלי התראה)
    const b = budgets[cat] ?? (budgets._mode === 'auto' ? (budgets._auto?.[cat] ?? 0) : (CATS as any)[cat].budget ?? 0);
    if (!(b > 0)) continue;
    const spent = occ.filter((o: any) => o.t.cat === cat).reduce((s: number, o: any) => s + o.amount, 0);
    const level = spent > b ? 100 : spent >= b * .9 ? 90 : 0;
    if (!level) { if (dry) out.push({ cat, level: 0, spent: Math.round(spent), budget: b }); continue; }
    const c = catOf(cat);
    if (dry) { out.push({ cat, level, spent: Math.round(spent), budget: b }); continue; }
    const title = level === 100 ? `🚨 עברתם את התקציב של ${c.e} ${c.n}` : `🔔 ${c.e} ${c.n}: נוצלו ${Math.round(spent / b * 100)}% מהתקציב`;
    const msg = level === 100 ? `הוצאו ${fmt(spent)} מתוך ${fmt(b)} החודש (חריגה של ${fmt(spent - b)})` : `נשארו ${fmt(b - spent)} מתוך ${fmt(b)} עד סוף החודש`;
    // נרשם פעם אחת בלבד (אם קפצנו ישר ל-100 — לא שולחים אחר כך גם 90)
    const rows = level === 100 ? [{ level: 100 }, { level: 90, sent_at: new Date().toISOString() }] : [{ level: 90 }];
    const { data: ins } = await sb.from('kesef_alerts').upsert(rows.map(r => ({ household_id: hh, cat, month, title, body: msg, ...r })), { onConflict: 'household_id,cat,month,level', ignoreDuplicates: true }).select('level');
    if (!(ins ?? []).some((r: any) => r.level === level)) continue; // כבר נשלח החודש
    if (shabbat) { out.push({ cat, level, waiting: 'shabbat' }); continue; }
    sent += await sendTo(hh, uid, JSON.stringify({ title, body: msg, url: './?v=budget', tag: `kesef-${cat}-${level}` }));
    await sb.from('kesef_alerts').update({ sent_at: new Date().toISOString() }).eq('household_id', hh).eq('cat', cat).eq('month', month).eq('level', level);
    out.push({ cat, level });
  }
  return json({ sent, alerts: out });
});
