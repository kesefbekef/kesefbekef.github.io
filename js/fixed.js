// 📅 זיהוי תשלומים קבועים ותשלומים שנגמרים — משותף לאפליקציה ולשרת (יומן הטלפון)
const ym = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// קבועות: אותו תיאור, בערך אותו סכום, בחודשיים שונים לפחות (ואחד מהם החודש או בחודש שעבר)
export function fixedPayments(tx, now = new Date()) {
  const m = ym(now), prevM = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1)), out = [];
  const byDesc = new Map();
  for (const t of tx) if (t && t.cat !== 'income' && !(t.inst > 1) && t.desc) { const k = t.desc.trim(); (byDesc.get(k) || byDesc.set(k, []).get(k)).push(t); }
  for (const [desc, list] of byDesc) {
    const months = new Set(list.map(t => ym(new Date(t.date))));
    if (!(months.has(m) || months.has(prevM)) || months.size < 2) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const last = list[list.length - 1], lastD = new Date(last.date);
    const amts = list.slice(-3).map(t => t.amount); if (Math.max(...amts) - Math.min(...amts) > last.amount * .15) continue;
    const next = new Date(lastD.getFullYear(), lastD.getMonth() + 1, lastD.getDate(), 12);
    if (next < now) next.setMonth(next.getMonth() + 1);
    const remind = new Date(next); remind.setDate(remind.getDate() - 1);
    out.push({ kind: 'fixed', desc, amount: last.amount, cat: last.cat, next, remind });
  }
  // תשלומים שנגמרים בחודשיים הקרובים
  for (const t of tx) if (t && t.inst > 1) {
    const st = new Date(t.date), end = new Date(st.getFullYear(), st.getMonth() + t.inst - 1, st.getDate(), 12);
    if (end < now || end > new Date(now.getFullYear(), now.getMonth() + 2, now.getDate())) continue;
    out.push({ kind: 'inst', desc: t.desc, amount: t.amount, cat: t.cat, inst: t.inst, next: end, remind: end });
  }
  return out.sort((a, b) => a.next - b.next);
}
