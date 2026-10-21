// 📅 מהיומן לאפליקציות (כסף בכיף + זמן בכיף): קורא את היומן של המשתמש (קישור iCal סודי, שמור מוצפן ב-Vault)
// (עד 5 יומנים למשתמש — כל אחד נקרא בנפרד) ושומר את האירועים ב-external_events — מחודש אחורה עד 3 חודשים קדימה. אירועים חוזרים נפרשים לפגישות בודדות.
// מי מפעיל: pg_cron כל 15 דקות (x-cron-secret) — לכל המשתמשים, או המשתמש עצמו (התחברות) — רק היומן שלו, מיד אחרי חיבור.
// התזמון: cron.job "calendar-import" — */15 * * * * (נוצר ישירות במסד, כמו monthly-summary, כי יש בו סוד)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import ICAL from 'npm:ical.js@1.5.0';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const MAX_BYTES = 5_000_000, MAX_EVENTS = 3000;

// רק כתובות ציבוריות ב-https (לא localhost / כתובת IP פנימית)
function safeUrl(u: string) {
  try {
    const x = new URL(u); if (x.protocol !== 'https:') return null;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^[\d.]+$/.test(h) || h.includes(':')) return null;
    return x.toString();
  } catch { return null; }
}
async function fetchIcs(url: string) {
  const u = safeUrl(url); if (!u) throw new Error('קישור לא תקין');
  const r = await fetch(u, { signal: AbortSignal.timeout(20000), headers: { Accept: 'text/calendar, */*' } });
  if (!r.ok) throw new Error(`היומן לא נפתח (${r.status})`);
  const buf = new Uint8Array(await r.arrayBuffer()); if (buf.length > MAX_BYTES) throw new Error('היומן גדול מדי');
  const txt = new TextDecoder().decode(buf); if (!txt.includes('BEGIN:VCALENDAR')) throw new Error('זה לא קובץ יומן (iCal)');
  return txt;
}
const iso = (t: any) => t.isDate ? `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}T00:00:00Z` : t.toJSDate().toISOString();

function parse(txt: string, from: Date, to: Date) {
  const comp = new ICAL.Component(ICAL.parse(txt));
  for (const tz of comp.getAllSubcomponents('vtimezone')) { try { ICAL.TimezoneService.register(tz); } catch { /* */ } }
  const vevents = comp.getAllSubcomponents('vevent');
  // חריגים של אירוע חוזר (RECURRENCE-ID) — מחברים לאירוע הראשי
  const masters = new Map<string, any>(), exceptions: any[] = [];
  for (const v of vevents) { const e = new ICAL.Event(v); if (e.isRecurrenceException()) exceptions.push(e); else masters.set(e.uid, e); }
  for (const ex of exceptions) { const m = masters.get(ex.uid); if (m) m.relateException(ex); }
  const out: any[] = [];
  const push = (uid: string, s: any, e: any, ev: any) => {
    const st = s.toJSDate(); if (st > to) return false;
    const en = e ? e.toJSDate() : st; if (en < from) return true;
    if ((ev.component.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED') return true;
    out.push({ uid, start: iso(s), end: e ? iso(e) : '', allDay: !!s.isDate, title: ev.summary || '', location: ev.location || '' });
    return out.length < MAX_EVENTS;
  };
  for (const [uid, ev] of masters) {
    if (!ev.startDate) continue;
    if (!ev.isRecurring()) { push(uid, ev.startDate, ev.endDate, ev); continue; }
    const it = ev.iterator(); let next: any, guard = 0;
    while ((next = it.next()) && guard++ < 2000) {
      const d = ev.getOccurrenceDetails(next);
      if (!push(uid, d.startDate, d.endDate, d.item)) break;
      if (d.startDate.toJSDate() > to) break;
    }
    if (out.length >= MAX_EVENTS) break;
  }
  return out;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  const body = await req.json().catch(() => ({}));
  const cron = !!Deno.env.get('CRON_SECRET') && req.headers.get('x-cron-secret') === Deno.env.get('CRON_SECRET');
  let only: string | null = null;
  if (!cron) {
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data } = await sb.auth.getUser(jwt); if (!data?.user) return json({ error: 'forbidden' }, 403);
    only = data.user.id;
  }
  const now = new Date(), from = new Date(now.getTime() - 31 * 864e5), to = new Date(now.getTime() + 92 * 864e5);
  // בדיקה בלבד (עם הסוד): קורא קישור לדוגמה ומחזיר רק מספרים — בלי לשמור
  if (cron && body.dry && body.test_url) {
    try { const ev = parse(await fetchIcs(body.test_url), from, to);
      return json({ dry: true, events: ev.length, allDay: ev.filter(e => e.allDay).length, sample: ev.slice(0, 3).map(e => ({ start: e.start, allDay: e.allDay, title: e.title })) });
    } catch (e) { return json({ dry: true, error: String((e as Error).message || e) }); }
  }
  const { data: list, error } = await sb.rpc('calendar_import_list', { p_user: only });
  if (error) return json({ error: error.message }, 500);
  const report: any[] = [];
  for (const c of list || []) {
    try { const ev = parse(await fetchIcs(c.url), from, to); const { data: n } = await sb.rpc('calendar_import_save', { p_cal: c.cal_id, p_events: ev }); report.push({ ok: n }); }
    catch (e) { await sb.rpc('calendar_import_save', { p_cal: c.cal_id, p_events: null, p_error: String((e as Error).message || e) }); report.push({ error: true }); }
  }
  return json({ users: report.length, report: only ? report : report.map(r => (r.error ? 'error' : 'ok')) });
});
