// 🔔 התראה למנהל על תקלה (שלוש האפליקציות): פוש לטלפון + מייל.
// נקרא מהטריגר על app_errors עם { id, kind: 'new' | 'fixed' }. קורא את השורה בעצמו, ושולח פעם אחת בלבד.
// אותה תקלה (אותה אפליקציה ואותה הודעה) שחוזרת — התראה אחת בשעה, עם ×N.
// פרטיות: שם ומייל של המשתמש — רק בהתראה למנהל.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';
import nodemailer from 'npm:nodemailer@6.9.14';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
webpush.setVapidDetails(Deno.env.get('ZMAN_VAPID_SUBJECT')!, Deno.env.get('ZMAN_VAPID_PUBLIC')!, Deno.env.get('ZMAN_VAPID_PRIVATE')!);

const APPS: Record<string, string> = { kesef: '💰 כסף בכיף', zman: '⏰ זמן בכיף', lomdim: '🎮 לומדים בכיף' };
const ADMIN_URL = 'https://kesefbekef.github.io/admin/';
const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const ilTime = (d: string) => new Date(d).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

// משפט פשוט בעברית
const KIND: Record<string, string> = { import: 'העלאת קובץ נכשלה', auth: 'כניסה / הרשמה נכשלה', sync: 'סנכרון נכשל', feedback: 'משוב לא נשלח', server: 'קריאה לשרת נכשלה' };
function simple(e: any) {
  const m = String(e.message || ''), f = m.match(/^⚠️\s*([\w-]+):\s*(.*)$/s);
  if (f) return `⚠️ משתמש נתקע — ${KIND[f[1]] || f[1]}: ${f[2]}`;
  return `💥 קריסה: ${m}${e.source ? ` (${e.source})` : ''}`;
}

async function who(e: any) {
  // התקלה נשלחת בלי התחברות; את המשתמש מוצאים לפי המכשיר (app_presence)
  let uid = e.user_id;
  if (!uid && e.device_id) {
    const { data } = await sb.from('app_presence').select('user_id').eq('device_id', e.device_id).not('user_id', 'is', null).limit(1);
    uid = data?.[0]?.user_id;
  }
  if (!uid) return { text: `משתמש לא מחובר · ${e.device || 'מכשיר לא ידוע'}`, uid: null };
  const { data } = await sb.auth.admin.getUserById(uid);
  const u = data?.user, name = u?.user_metadata?.name || u?.user_metadata?.full_name || '';
  return { text: `${name ? name + ' · ' : ''}${u?.email || 'משתמש'} · ${e.device || ''}`, uid };
}

async function admins() {
  const { data } = await sb.from('app_admins').select('user_id');
  const ids = (data ?? []).map((r: any) => r.user_id);
  const emails: string[] = [];
  for (const id of ids) { const { data: u } = await sb.auth.admin.getUserById(id); if (u?.user?.email) emails.push(u.user.email); }
  return { ids, emails };
}

async function push(ids: string[], payload: string) {
  let sent = 0;
  const { data: a } = await sb.from('admin_push_subs').select('endpoint, sub').in('user_id', ids);
  for (const s of a ?? []) {
    try { await webpush.sendNotification(s.sub, payload, { TTL: 24 * 3600, urgency: 'high' }); sent++; }
    catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await sb.from('admin_push_subs').delete().eq('endpoint', s.endpoint); }
  }
  return sent;
}

Deno.serve(async req => {
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id), kind = body.kind === 'fixed' ? 'fixed' : 'new';
  if (!id) return new Response('no id', { status: 400 });
  const { data: e } = await sb.from('app_errors').select('*').eq('id', id).maybeSingle();
  if (!e) return new Response('not found', { status: 404 });
  const col = kind === 'new' ? 'alerted_at' : 'fix_alerted_at';
  if (e[col]) return Response.json({ skipped: 'already' });
  if (kind === 'fixed' && !e.fixed_at) return Response.json({ skipped: 'not fixed' });
  // תופסים את "השליחה" (כדי שלא תצא פעמיים)
  const { data: claimed } = await sb.from('app_errors').update({ [col]: new Date().toISOString() }).eq('id', id).is(col, null).select('id');
  if (!claimed?.length) return Response.json({ skipped: 'race' });

  // אותה תקלה בשעה האחרונה כבר נשלחה? — לא מציפים
  const since = new Date(Date.now() - 3600e3).toISOString();
  const { count: n24 } = await sb.from('app_errors').select('id', { count: 'exact', head: true }).eq('app', e.app).eq('message', e.message).gte('at', new Date(Date.now() - 864e5).toISOString());
  if (kind === 'new') {
    const { count: recent } = await sb.from('app_errors').select('id', { count: 'exact', head: true }).eq('app', e.app).eq('message', e.message).neq('id', id).eq('alert_sent', true).gte('alerted_at', since);
    if ((recent ?? 0) > 0) return Response.json({ skipped: 'throttled' });
  }

  const app = APPS[e.app] || e.app, w = await who(e), what = simple(e), when = ilTime(kind === 'new' ? e.at : e.fixed_at);
  const times = (n24 ?? 1) > 1 ? ` ×${n24} ב-24 שעות` : '';
  const title = kind === 'new' ? `${what.startsWith('💥') ? '💥' : '⚠️'} תקלה ב${app}${times}` : `✅ תוקן ב${app}`;
  const line = kind === 'new' ? what.replace(/^(⚠️|💥)\s*/, '') : `${what.replace(/^(⚠️|💥)\s*/, '')}${e.fixed_note ? ` — ${e.fixed_note}` : ''}`;
  const { ids, emails } = await admins();
  if (kind === 'new') await sb.from('app_errors').update({ alert_sent: true }).eq('id', id);
  const sent = await push(ids, JSON.stringify({ title, body: `${line}\n👤 ${w.text} · 🕐 ${when}`.slice(0, 300), tag: `err-${e.id}-${kind}`, url: ADMIN_URL }));

  let mailed = 0;
  const user = Deno.env.get('GMAIL_USER'), pass = Deno.env.get('GMAIL_APP_PASSWORD');
  if (user && pass && emails.length) {
    const mail = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass: pass.replace(/\s/g, '') } });
    const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6;max-width:520px">
      <h2 style="margin:0 0 10px">${esc(title)}</h2>
      <p style="margin:0 0 8px"><b>${kind === 'new' ? 'מה קרה' : 'מה תוקן'}:</b> ${esc(line)}</p>
      <p style="margin:0 0 8px"><b>אצל מי:</b> ${esc(w.text)}</p>
      <p style="margin:0 0 8px"><b>מתי:</b> ${esc(when)} (שעון ישראל)${e.version ? ` · גרסה ${esc(e.version)}` : ''}</p>
      <p style="margin:16px 0"><a href="${ADMIN_URL}" style="background:#EC4899;color:#fff;padding:10px 18px;border-radius:12px;text-decoration:none">📊 ללוח הבקרה</a></p>
      <p style="color:#888;font-size:13px">התראה אוטומטית. אותה תקלה שחוזרת — לכל היותר התראה אחת בשעה.</p></div>`;
    try { await mail.sendMail({ from: `"לוח בקרה ✨" <${user}>`, to: emails.join(','), subject: title, html }); mailed = emails.length; }
    catch (err) { console.warn('mail', String(err)); }
  }
  return Response.json({ ok: true, kind, sent, mailed });
});
