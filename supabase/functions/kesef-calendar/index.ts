// כסף בכיף — 📆 יומן (ICS) לתשלומים קבועים, תשלומים שנגמרים והחזרי הלוואות. נקרא עם מפתח סודי אישי (?t=…)
// ?t=demo — יומן לדוגמה מנתוני ההדגמה (משפחה מדומה) — לבדיקה ולמדריך
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
(globalThis as any).window = globalThis;
const { fixedPayments, REMIND_DEFAULT } = await import('./shared/fixed.js');
const { demoData } = await import('./shared/demo-data.js');
const { catOf, applyCustomCats } = await import('./shared/categories.js');

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const pad = (n: number) => String(n).padStart(2, '0');
const day = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const esc = (s: string) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
// שורות ICS עד 75 בתים (עברית = 2 בתים לאות)
const fold = (l: string) => { const out: string[] = []; let cur = '', n = 0; const enc = new TextEncoder();
  for (const ch of l) { const b = enc.encode(ch).length; if (n + b > 73) { out.push(cur); cur = ' '; n = 1; } cur += ch; n += b; }
  out.push(cur); return out.join('\r\n'); };
const nis = (n: number) => Math.round(n).toLocaleString('he-IL') + '₪';

// אירוע של יום שלם ביום התשלום. התראה ב-9:00, כמה ימים לפני (days; 0 = ביום עצמו)
const trig = (days: number) => days > 0 ? `TRIGGER:-P${days - 1}DT15H` : 'TRIGGER:PT9H';
function event(uid: string, date: Date, title: string, desc: string, rrule = '', days = 1, alarmTxt = '') {
  const end = new Date(date); end.setDate(end.getDate() + 1);
  return ['BEGIN:VEVENT', fold(`UID:${uid}@kesefbekef`), `DTSTAMP:${day(new Date())}T000000Z`, `DTSTART;VALUE=DATE:${day(date)}`, `DTEND;VALUE=DATE:${day(end)}`,
    ...(rrule ? [rrule] : []), fold(`SUMMARY:${esc(title)}`), fold(`DESCRIPTION:${esc(desc)}`), 'TRANSP:TRANSPARENT',
    ...(days >= 0 ? ['BEGIN:VALARM', 'ACTION:DISPLAY', fold(`DESCRIPTION:${esc(alarmTxt || title)}`), trig(days), 'END:VALARM'] : []), 'END:VEVENT'].join('\r\n');
}
// מזהה קצר ויציב לאירוע (שורת UID עד 75 בתים)
const hid = (str: string) => { let h = 5381; for (const ch of str) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0; return h.toString(36); };
const inTxt = (n: number) => n <= 0 ? 'היום' : n === 1 ? 'מחר' : `בעוד ${n} ימים`;

Deno.serve(async req => {
  const t = new URL(req.url).searchParams.get('t') || '';
  const il = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  let kv: any, tx: any[] = [], demo = false;
  if (t === 'demo') { const d = demoData(il); kv = d.kv; tx = d.tx; demo = true; }
  else {
    if (!/^[0-9a-f]{32,}$/.test(t)) return new Response('not found', { status: 404 });
    const { data: tok } = await sb.from('kesef_cal_tokens').select('household_id').eq('token', t).maybeSingle();
    if (!tok) return new Response('not found', { status: 404 });
    const hh = tok.household_id;
    kv = Object.fromEntries(((await sb.from('kv').select('key,value').eq('household_id', hh)).data || []).map((r: any) => [r.key, r.value]));
    for (let from = 0; ; from += 1000) {
      const { data } = await sb.from('tx').select('data').eq('household_id', hh).eq('deleted', false).order('id').range(from, from + 999);
      tx.push(...(data ?? []).map((r: any) => r.data));
      if (!data || data.length < 1000) break;
    }
  }
  applyCustomCats(kv.cats || {});
  const ev: string[] = [];
  for (const f of fixedPayments(tx, il, kv.recurring || {}, { detected: kv.budgets?._remind ?? REMIND_DEFAULT })) {
    const c = catOf(f.cat);
    // 🔔 התזכורת ביומן — לפי מה שנבחר בקבוע (בלי / יום / 3 ימים / שבוע). "בלי" = אירוע בלי התראה
    if (f.kind === 'fixed') ev.push(event(`fixed-${hid(f.desc)}`, f.next, `${c.e} ${f.desc} ${f.rule && !f.variable ? '' : 'בערך '}${nis(f.amount)}`,
      `${f.rule ? 'תשלום קבוע (הקבועים שלי)' : 'תשלום קבוע שזוהה לבד'} בכסף בכיף. ${f.variable ? 'בערך ' : ''}${nis(f.amount)} כל חודש.`, 'RRULE:FREQ=MONTHLY;COUNT=12',
      f.days > 0 ? f.days : -1, `🔔 ${inTxt(f.days)}: ${f.desc} ${nis(f.amount)}`));
    else ev.push(event(`inst-${hid(f.desc)}-${day(f.next)}`, f.next, `💳 נגמרים התשלומים: ${f.desc}`, `התשלום האחרון (${f.inst}/${f.inst}). מהחודש הבא מתפנים ${nis(f.amount)} בחודש.`));
  }
  // ➗ החזרי הלוואות לפי לוח התשלומים
  for (const [id, x] of Object.entries(kv.debts || {}) as [string, any][]) {
    if (!x?.plan?.n || !x.plan.start) continue;
    const paid = (x.pay || []).reduce((s: number, p: any) => s + p.a, 0); if (paid >= x.total) continue;
    const per = x.total / x.plan.n, st = new Date(x.plan.start + 'T12:00:00');
    for (let k = Math.floor(paid / per + 1e-6); k < x.plan.n; k++) {
      const d = new Date(st); d.setMonth(st.getMonth() + k);
      if (d < new Date(il.getFullYear(), il.getMonth() - 1, 1)) continue;
      ev.push(event(`debt-${id}-${k}`, d, x.dir === 'lent' ? `🤝 ${x.name} אמור/ה להחזיר ${nis(per)}` : `🙏 להחזיר ל${x.name} ${nis(per)}`, `תשלום ${k + 1} מתוך ${x.plan.n}${x.note ? ' · ' + x.note : ''}`, '', 1));
    }
  }
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//kesefbekef//HE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', fold(`X-WR-CALNAME:💰 כסף בכיף${demo ? ' (דוגמה)' : ''}`), fold('X-WR-CALDESC:תשלומים קבועים\\, תשלומים שנגמרים והחזרי הלוואות'), 'X-APPLE-CALENDAR-COLOR:#EC4899', 'X-WR-TIMEZONE:Asia/Jerusalem', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H', ...ev, 'END:VCALENDAR'].join('\r\n');
  return new Response(ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'max-age=3600' } });
});
