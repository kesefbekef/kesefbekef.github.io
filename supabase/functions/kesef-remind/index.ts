// כסף בכיף — 🔔 תזכורת לטלפון לפני תשלום קבוע ("בעוד 3 ימים: שכירות 4,200 ₪").
// רץ פעם ביום מ-pg_cron (עם הסוד של השרת). לכל משפחה שיש בה הורה עם התראות פעילות:
// מחשב את התשלומים הקבועים (שהוגדרו + שזוהו לבד) — ושולח להורים על מה שהיום הוא יום התזכורת שלו.
// בשבת לא שולחים: ביום שישי נשלחת גם התזכורת של שבת.
// התזמון: cron.job "kesef-remind" — 0 5 * * * (נוצר ישירות במסד, כמו monthly-summary, כי יש בו סוד)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

(globalThis as any).window = globalThis;
const { fixedPayments, REMIND_DEFAULT } = await import('./shared/fixed.js');
const { catOf, applyCustomCats } = await import('./shared/categories.js');

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
webpush.setVapidDetails(Deno.env.get('ZMAN_VAPID_SUBJECT')!, Deno.env.get('ZMAN_VAPID_PUBLIC')!, Deno.env.get('ZMAN_VAPID_PRIVATE')!);
const fmt = (n: number) => Math.round(n).toLocaleString('he-IL') + ' ₪';
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysTxt = (n: number) => n <= 0 ? 'היום' : n === 1 ? 'מחר' : `בעוד ${n} ימים`;

async function all(q: any) { const out: any[] = []; for (let from = 0; ; from += 1000) { const { data, error } = await q.range(from, from + 999); if (error) throw error; out.push(...data); if (data.length < 1000) return out; } }

Deno.serve(async req => {
  if (!Deno.env.get('CRON_SECRET') || req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return new Response('forbidden', { status: 403 });
  const body = await req.json().catch(() => ({}));
  const dry = !!body.dry; // בדיקה: מחשב בלי לשלוח
  const il = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const today = new Date(il.getFullYear(), il.getMonth(), il.getDate(), 12);
  if (il.getDay() === 6 && !body.force) return Response.json({ skipped: 'shabbat' });
  // היום (ובשישי — גם שבת)
  const days = new Set([ymd(today)]); if (il.getDay() === 5) days.add(ymd(new Date(today.getTime() + 864e5)));
  async function compute(hh: string) {
    const kv = Object.fromEntries(((await sb.from('kv').select('key,value').eq('household_id', hh).in('key', ['recurring', 'budgets', 'cats'])).data || []).map((r: any) => [r.key, r.value]));
    applyCustomCats(kv.cats || {});
    const since = new Date(today.getFullYear(), today.getMonth() - 4, 1).toISOString();
    const tx = (await all(sb.from('tx').select('data').eq('household_id', hh).eq('deleted', false).gte('data->>date', since).order('id'))).map((r: any) => r.data);
    const list = fixedPayments(tx, today, kv.recurring || {}, { detected: kv.budgets?._remind ?? REMIND_DEFAULT }).filter((f: any) => f.kind === 'fixed');
    const due = list.filter((f: any) => f.alert && days.has(ymd(new Date(f.alert))));
    return { due, rules: Object.keys(kv.recurring || {}).length, fixed: list.length, withAlert: list.filter((f: any) => f.alert).length,
      nextAlerts: list.filter((f: any) => f.alert).map((f: any) => ymd(new Date(f.alert))).sort().slice(0, 5) };
  }

  // בדיקה יבשה למשפחה מסוימת — גם בלי התראות פעילות (מחזיר רק מספרים, בלי פרטים)
  if (dry && body.household) {
    const r = await compute(body.household);
    return Response.json({ dry: true, rules: r.rules, fixed: r.fixed, withAlert: r.withAlert, dueToday: r.due.length, nextAlerts: r.nextAlerts });
  }
  const { data: subs, error } = await sb.from('kesef_push_subs').select('user_id');
  if (error) return new Response(error.message, { status: 500 });
  const uids = [...new Set((subs ?? []).map((s: any) => s.user_id))];
  if (!uids.length) return Response.json({ sent: 0, households: 0 });
  let mq = sb.from('members').select('household_id,user_id').eq('role', 'parent').in('user_id', uids);
  if (body.household) mq = mq.eq('household_id', body.household);
  const { data: parents } = await mq;
  const byHH: Record<string, string[]> = {};
  for (const m of parents ?? []) (byHH[m.household_id] ||= []).push(m.user_id);

  const report: any[] = []; let sent = 0;
  for (const [hh, us] of Object.entries(byHH)) {
    try {
      const { due } = await compute(hh);
      if (!due.length) { report.push({ hh, due: 0 }); continue; }
      const msgs = due.map((f: any) => {
        const n = Math.round((new Date(ymd(new Date(f.next)) + 'T12:00:00').getTime() - new Date(ymd(today) + 'T12:00:00').getTime()) / 864e5);
        return { title: `🔔 ${daysTxt(n)}: ${f.desc}`, body: `${catOf(f.cat).e} ${f.variable ? 'בערך ' : ''}${fmt(f.amount)} · ${new Date(f.next).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })}${f.rule ? '' : ' (זיהינו שזה קבוע)'}`, tag: `kesef-remind-${f.desc}` };
      });
      if (dry) { report.push({ hh, dry: true, msgs }); continue; }
      const { data: ss } = await sb.from('kesef_push_subs').select('*').in('user_id', us);
      for (const m of msgs) for (const s of ss ?? []) {
        try { await webpush.sendNotification(s.sub, JSON.stringify({ ...m, url: './?v=rec' }), { TTL: 12 * 3600, urgency: 'normal' }); sent++; }
        catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await sb.from('kesef_push_subs').delete().eq('endpoint', s.endpoint); else console.warn('push', e?.statusCode, e?.body); }
      }
      report.push({ hh, due: msgs.length });
    } catch (e) { report.push({ hh, error: String(e) }); }
  }
  return Response.json({ sent, report });
});
