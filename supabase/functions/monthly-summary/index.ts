// סיכום חודשי במייל — רץ ב-1 לכל חודש (pg_cron), שולח לכל הורה את הסיכום של החודש שעבר + קובץ אקסל
import ExcelJS from 'npm:exceljs@4.4.0';
import nodemailer from 'npm:nodemailer@6.9.15';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// קוד האקסל של האפליקציה מצפה ל-window.ExcelJS
(globalThis as any).window = globalThis;
(globalThis as any).ExcelJS = ExcelJS;
const xp = await import('./shared/exporter.js');
const { CATS, catOf } = await import('./shared/categories.js');

const APP = 'https://kesefbekef.github.io/';
const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const fmt = (n: number) => Math.round(n).toLocaleString('he-IL') + ' ₪';
const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);

async function all(q: any) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q.range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

function summaryHTML(name: string, label: string, tx: any[], budgets: any, anchor: Date) {
  const { start, end } = xp.periodRange('month', anchor);
  const occ = xp.collect(tx, start, end);
  const inc = occ.filter((o: any) => o.t.cat === 'income').reduce((s: number, o: any) => s + o.amount, 0);
  const exp = occ.filter((o: any) => o.t.cat !== 'income').reduce((s: number, o: any) => s + o.amount, 0);
  const byCat: Record<string, number> = {};
  for (const o of occ) if (o.t.cat !== 'income') byCat[o.t.cat] = (byCat[o.t.cat] || 0) + o.amount;
  const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const budgetOf = (c: string) => budgets?.[c] ?? (CATS as any)[c]?.budget ?? 0;
  const over = top.filter(([c, v]) => budgetOf(c) > 0 && v > budgetOf(c));
  const bal = inc - exp;
  const row = ([c, v]: [string, number]) => { const k = catOf(c), b = budgetOf(c), p = b ? Math.min(100, Math.round(v / b * 100)) : 0;
    return `<tr><td style="padding:8px 0;font-size:15px">${k.e} ${esc(k.n)}</td><td style="padding:8px 0;text-align:left;font-weight:bold;font-size:15px">${fmt(v)}</td></tr>
      <tr><td colspan="2" style="padding:0 0 6px"><div style="height:8px;border-radius:8px;background:#EEE"><div style="height:8px;width:${p}%;border-radius:8px;background:${v > b && b ? '#E11D48' : '#EC4899'}"></div></div>
      <div style="font-size:12px;color:#777;margin-top:3px">${b ? `מתוך תקציב ${fmt(b)}` : ''}</div></td></tr>`; };
  const tip = over.length
    ? `🚨 החודש עברתם את התקציב ב: ${over.map(([c]) => `${catOf(c).e} ${esc(catOf(c).n)}`).join(', ')}. כדאי לבדוק שם — שם הכי קל לחסוך.`
    : top.length ? `👏 כל הכבוד! עמדתם בתקציב בכל הקטגוריות. הכי הרבה יצא על ${catOf(top[0][0]).e} ${esc(catOf(top[0][0]).n)}.` : '';
  return `<!doctype html><html dir="rtl" lang="he"><body style="margin:0;background:#F4F1FF;font-family:Arial,sans-serif;color:#1F1B2E">
  <div style="max-width:560px;margin:0 auto;padding:18px">
    <div style="background:linear-gradient(135deg,#7C3AED,#EC4899,#F97316);background-color:#EC4899;border-radius:22px;padding:24px;color:#fff;text-align:center">
      <div style="font-size:15px;opacity:.9">כסף בכיף ✨ · ${esc(name)}</div>
      <div style="font-size:26px;font-weight:bold;margin-top:6px">הסיכום של ${esc(label)}</div>
    </div>
    <table style="width:100%;margin-top:14px;border-spacing:8px 0"><tr>
      <td style="background:#fff;border-radius:16px;padding:14px;text-align:center"><div style="font-size:13px;color:#777">💰 נכנס</div><div style="font-size:21px;font-weight:bold;color:#16A34A">${fmt(inc)}</div></td>
      <td style="background:#fff;border-radius:16px;padding:14px;text-align:center"><div style="font-size:13px;color:#777">💸 יצא</div><div style="font-size:21px;font-weight:bold;color:#E11D48">${fmt(exp)}</div></td>
      <td style="background:#fff;border-radius:16px;padding:14px;text-align:center"><div style="font-size:13px;color:#777">⚖️ מאזן</div><div style="font-size:21px;font-weight:bold;color:${bal >= 0 ? '#16A34A' : '#E11D48'}">${bal < 0 ? '-' : ''}${fmt(Math.abs(bal))}</div></td>
    </tr></table>
    ${top.length ? `<div style="background:#fff;border-radius:18px;padding:16px;margin-top:14px"><div style="font-weight:bold;font-size:17px;margin-bottom:6px">🎯 לאן הלך הכסף</div><table style="width:100%;border-collapse:collapse">${top.slice(0, 6).map(row).join('')}</table></div>` : ''}
    ${tip ? `<div style="background:#FEF9C3;border-radius:18px;padding:14px;margin-top:14px;font-size:15px">${tip}</div>` : ''}
    <div style="text-align:center;margin-top:18px"><a href="${APP}" style="display:inline-block;background:#EC4899;color:#fff;text-decoration:none;font-weight:bold;padding:13px 26px;border-radius:30px">פתיחת האפליקציה</a></div>
    <div style="font-size:13px;color:#777;text-align:center;margin-top:14px">📎 מצורף קובץ אקסל צבעוני עם כל הפרטים</div>
    <div style="font-size:12px;color:#999;text-align:center;margin-top:18px">לא רוצים את המייל הזה? באפליקציה: ⚙️ ← אזור אישי ← "📧 סיכום חודשי למייל"</div>
  </div></body></html>`;
}

Deno.serve(async req => {
  if (!Deno.env.get('CRON_SECRET') || req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return new Response('forbidden', { status: 403 });
  const body = await req.json().catch(() => ({}));
  const user = Deno.env.get('GMAIL_USER'), pass = Deno.env.get('GMAIL_APP_PASSWORD');
  const dry = !!body.dry; // בדיקה: בונה הכל בלי לשלוח
  if (!dry && (!user || !pass)) return new Response('missing GMAIL_USER / GMAIL_APP_PASSWORD', { status: 500 });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const mail = dry ? null : nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass: pass.replace(/\s/g, '') } });

  // החודש שעבר (שעון ישראל)
  const il = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const anchor = new Date(il.getFullYear(), il.getMonth() - (body.thisMonth ? 0 : 1), 15, 12); // thisMonth — רק לבדיקה
  const label = `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;

  let q = sb.from('members').select('household_id,user_id').eq('role', 'parent').eq('monthly_email', true);
  if (body.household) q = q.eq('household_id', body.household);
  const { data: parents, error } = await q;
  if (error) return new Response(error.message, { status: 500 });
  const byHH: Record<string, string[]> = {};
  for (const m of parents!) (byHH[m.household_id] ||= []).push(m.user_id);

  const report: any[] = [];
  for (const [hh, uids] of Object.entries(byHH)) {
    try {
      const { data: h } = await sb.from('households').select('name').eq('id', hh).single();
      const tx = (await all(sb.from('tx').select('data').eq('household_id', hh).eq('deleted', false).order('id'))).map(r => r.data);
      const kv = Object.fromEntries(((await sb.from('kv').select('key,value').eq('household_id', hh)).data || []).map((r: any) => [r.key, r.value]));
      const st = xp.quickStats(tx, 'month', anchor);
      if (!st.count) { report.push({ hh, skipped: 'no tx' }); continue; }
      const wb = await xp.buildWorkbook({ tx, budgets: kv.budgets || {}, people: kv.people || [], kind: 'month', anchor });
      const xlsx = new Uint8Array(await wb.blob.arrayBuffer());
      const html = summaryHTML(h?.name || 'המשפחה', label, tx, kv.budgets || {}, anchor);
      if (dry) { report.push({ hh, dry: true, count: st.count, xlsxBytes: xlsx.length, htmlChars: html.length, parents: uids.length }); continue; }
      for (const uid of uids) {
        const { data: u } = await sb.auth.admin.getUserById(uid);
        const to = body.test_to || u?.user?.email;
        if (!to) continue;
        await mail!.sendMail({ from: `"כסף בכיף ✨" <${user}>`, to, subject: `📊 הסיכום של ${label} — כסף בכיף`, html,
          attachments: [{ filename: wb.name, content: xlsx }] });
        report.push({ hh, sent: true });
        if (body.test_to) break;
      }
    } catch (e) { report.push({ hh, error: String(e) }); }
  }
  return Response.json({ label, report });
});
