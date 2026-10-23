// 📅 זיהוי תשלומים קבועים ותשלומים שנגמרים — משותף לאפליקציה ולשרת (יומן הטלפון)
const ym = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// 🔔 תזכורת לפני תשלום: days = כמה ימים לפני (0 = בלי). alert = היום שבו מזכירים
const alertOf = (next, days) => { if (!(days > 0)) return null; const a = new Date(next); a.setDate(a.getDate() - days); return a; };
export const REMIND_DEFAULT = 3;
// קבועות: אותו תיאור, בערך אותו סכום, בחודשיים שונים לפחות (ואחד מהם החודש או בחודש שעבר)
// opt.detected = כמה ימים לפני להזכיר על מה שזוהה לבד (0 = בלי)
export function fixedPayments(tx, now = new Date(), rules = {}, opt = {}) {
  const dDays = opt.detected ?? REMIND_DEFAULT;
  const m = ym(now), prevM = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1)), out = [];
  const byDesc = new Map();
  // מה שנרשם ע"י קבוע (גם קבוע שהופסק) לא "מזוהה" שוב כקבוע — אחרת קבוע שהפסקתם ממשיך להזכיר
  for (const t of tx) if (t && t.cat !== 'income' && !(t.inst > 1) && t.desc && t.source !== 'recurring' && !t.skip) { const k = t.desc.trim(); (byDesc.get(k) || byDesc.set(k, []).get(k)).push(t); }
  for (const [desc, list] of byDesc) {
    const months = new Set(list.map(t => ym(new Date(t.date))));
    if (!(months.has(m) || months.has(prevM)) || months.size < 2) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const last = list[list.length - 1], lastD = new Date(last.date);
    // קבוע = חודש אחרי חודש: שתי הפעמים האחרונות בהפרש של בערך חודש (לא קנייה שנתית כמו "סוכה")
    const gap = (lastD - new Date(list[list.length - 2].date)) / 864e5; if (gap < 20 || gap > 45) continue;
    const amts = list.slice(-3).map(t => t.amount); if (Math.max(...amts) - Math.min(...amts) > last.amount * .15) continue;
    const next = new Date(lastD.getFullYear(), lastD.getMonth() + 1, lastD.getDate(), 12);
    if (next < now) next.setMonth(next.getMonth() + 1);
    const remind = new Date(next); remind.setDate(remind.getDate() - 1);
    out.push({ kind: 'fixed', desc, amount: last.amount, cat: last.cat, next, remind, days: dDays, alert: alertOf(next, dDays) });
  }
  // 🔁 קבועים שהוגדרו ידנית — עדיפים על מה שזוהה לבד
  for (const [id, r] of Object.entries(rules || {})) {
    if (!r || r.paused || r.cat === 'income' || !(r.amount > 0)) continue;
    const next = nextRuleDate(r, now); if (!next) continue;
    if ((r.skip || []).includes(ym(next))) continue; // החודש הזה דולג או סומן 'אותו תשלום'
    const i = out.findIndex(o => o.desc === r.desc); if (i >= 0) out.splice(i, 1);
    const remind = new Date(next); remind.setDate(remind.getDate() - 1);
    const days = r.remind ?? REMIND_DEFAULT;
    out.push({ kind: 'fixed', rule: id, desc: r.desc, amount: r.amount, cat: r.cat, next, remind, variable: !!r.variable, days, alert: alertOf(next, days) });
  }
  // תשלומים שנגמרים בחודשיים הקרובים
  for (const t of tx) if (t && t.inst > 1) {
    const st = new Date(t.date), end = new Date(st.getFullYear(), st.getMonth() + t.inst - 1, st.getDate(), 12);
    if (end < now || end > new Date(now.getFullYear(), now.getMonth() + 2, now.getDate())) continue;
    out.push({ kind: 'inst', desc: t.desc, amount: t.amount, cat: t.cat, inst: t.inst, next: end, remind: end });
  }
  return out.sort((a, b) => a.next - b.next);
}

// 🔁 הקבוע הבא של כלל: { day, start 'YYYY-MM', end 'YYYY-MM'|'', paused }
export function nextRuleDate(r, now = new Date()) {
  const day = Math.min(28, Math.max(1, r.day || 1));
  let d = new Date(now.getFullYear(), now.getMonth(), day, 12);
  if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d = new Date(now.getFullYear(), now.getMonth() + 1, day, 12);
  const m = ym(d);
  if (r.start && m < r.start) d = new Date(+r.start.slice(0, 4), +r.start.slice(5, 7) - 1, day, 12);
  if (r.end && ym(d) > r.end) return null;
  return d;
}
// החודשים שבהם הכלל צריך להירשם עד היום (כולל) — מתחילים מ-start
export function dueMonths(r, now = new Date()) {
  if (!r || r.paused || !r.start) return [];
  const day = Math.min(28, Math.max(1, r.day || 1)), out = [];
  let y = +r.start.slice(0, 4), m = +r.start.slice(5, 7) - 1;
  for (let k = 0; k < 120; k++, m++) {
    const d = new Date(y, m, day, 12); if (d > now) break;
    const key = ym(d); if (r.end && key > r.end) break;
    out.push(key);
  }
  return out;
}
