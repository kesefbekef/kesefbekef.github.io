// 💌 מייל חד-פעמי לכל המשתמשים הרשומים: בקשת משוב. נשלח רק עם { confirm: true }. { dry: true } = רק סופר נמענים, בלי לשלוח.
// נשלח מאותה כתובת של המייל החודשי ("כסף בכיף ✨"), מייל נפרד לכל אחד (אף אחד לא רואה כתובות של אחרים).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import nodemailer from 'npm:nodemailer@6.9.14';

const APP = 'https://kesefbekef.github.io/';
const SUBJECT = 'כסף בכיף: מה הייתם משפרים?';
const HTML = `<!doctype html><html dir="rtl"><body style="margin:0;background:#F6F3FF;font-family:Arial,sans-serif"><div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <div style="background:#fff;border-radius:22px;padding:22px 20px;font-size:17px;line-height:1.75;color:#222">
    <p style="margin:0 0 14px;font-size:20px"><b>שלום!</b></p>
    <p style="margin:0 0 14px">עכשיו אנחנו רוצים לשמוע מכם. מה מפריע? מה מבלבל? מה הייתם רוצים שיהיה? כל הערה, גם הכי קטנה, עוזרת.</p>
    <p style="margin:0 0 14px"><b>הדרך הכי קלה:</b> בתוך האפליקציה, ⚙️ ← "💌 שליחת משוב". או פשוט לכתוב בצ'אט: "משוב: ..." ואת מה שבא לכם.</p>
    <p style="margin:0 0 14px">אפשר גם להשיב למייל הזה.</p>
    <p style="margin:0">תודה שאתם איתנו,</p>
    <div style="text-align:center;margin-top:22px"><a href="${APP}" style="display:inline-block;background:#EC4899;color:#fff;text-decoration:none;font-weight:bold;padding:12px 26px;border-radius:30px">💰 לפתוח את כסף בכיף</a></div>
  </div></div></body></html>`;
const TEXT = `שלום!\n\nעכשיו אנחנו רוצים לשמוע מכם. מה מפריע? מה מבלבל? מה הייתם רוצים שיהיה? כל הערה, גם הכי קטנה, עוזרת.\n\nהדרך הכי קלה: בתוך האפליקציה, ⚙️ ← "💌 שליחת משוב". או פשוט לכתוב בצ'אט: "משוב: ..." ואת מה שבא לכם.\n\nאפשר גם להשיב למייל הזה.\n\nתודה שאתם איתנו,\n\n${APP}`;

Deno.serve(async req => {
  if (!Deno.env.get('CRON_SECRET') || req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return new Response('forbidden', { status: 403 });
  const body = await req.json().catch(() => ({}));
  const dry = !body.confirm;
  const user = Deno.env.get('GMAIL_USER'), pass = Deno.env.get('GMAIL_APP_PASSWORD');
  if (!dry && (!user || !pass)) return new Response('missing GMAIL_USER / GMAIL_APP_PASSWORD', { status: 500 });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // כל חבר במשפחה של כסף בכיף, עם מייל מאומת — פעם אחת לכל כתובת
  const { data: members, error } = await sb.from('members').select('user_id');
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const ids = [...new Set((members ?? []).map((m: any) => m.user_id))];
  const emails = new Set<string>();
  for (const id of ids) { const { data } = await sb.auth.admin.getUserById(id); const u = data?.user; if (u?.email && u.email_confirmed_at) emails.add(u.email); }
  if (dry) return Response.json({ dry: true, recipients: emails.size });

  const mail = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass: pass!.replace(/\s/g, '') } });
  let sent = 0, failed = 0;
  for (const to of emails) {
    try { await mail.sendMail({ from: `"כסף בכיף ✨" <${user}>`, to, replyTo: user, subject: SUBJECT, text: TEXT, html: HTML }); sent++; }
    catch (e) { failed++; console.warn('feedback mail failed', String(e)); }
  }
  return Response.json({ sent, failed });
});
