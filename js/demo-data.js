// 🎭 נתוני הדגמה — משפחה מדומה (שמות בדויים) שממלאת כל מסך וכל תכונה. נשמר רק במאגר ההדגמה, לא בענן.
const iso = (y, m, d) => new Date(y, m, d, 12).toISOString();
let n = 0;
const id = () => 'demo' + (++n).toString(36);

export function demoData(now = new Date()) {
  n = 0;
  const Y = now.getFullYear(), M = now.getMonth(), D = Math.min(now.getDate(), 28);
  const people = [
    { id: 'p_dad', name: 'דני', e: '🧔' }, { id: 'p_mom', name: 'רותי', e: '👩' },
    { id: 'p_kid1', name: 'נועה', e: '👧' }, { id: 'p_kid2', name: 'איתי', e: '👦' },
  ];
  const tx = [];
  const add = (y, m, d, desc, amount, cat, extra = {}) => tx.push({ id: id(), msg: id(), raw: `${desc} ${amount}`, desc, cat, source: 'text',
    created: iso(y, m, d), date: iso(y, m, d), amount, total: amount, inst: 0, who: extra.who || 'p_dad', pay: extra.pay || 'credit', ...extra });
  // שלושה חודשים אחורה + החודש
  for (let k = 3; k >= 0; k--) {
    const y = new Date(Y, M - k, 1).getFullYear(), m = new Date(Y, M - k, 1).getMonth(), last = k === 0 ? D : 28;
    const day = d => Math.min(d, last);
    add(y, m, day(1), 'משכורת', 12500, 'income', { who: 'p_dad', pay: 'transfer' });
    add(y, m, day(1), 'משכורת', 9200, 'income', { who: 'p_mom', pay: 'transfer' });
    if (k === 1) add(y, m, day(14), 'החזר הוצאות מהעבודה', 340, 'income', { who: 'p_mom', pay: 'transfer', noMaaser: true });
    add(y, m, day(20), 'קצבת ילדים', 345, 'income', { who: 'p_mom', pay: 'transfer' });
    add(y, m, day(3), 'חשמל', 430 + k * 15, 'home', { pay: 'standing' });
    add(y, m, day(5), 'ארנונה', 620, 'home', { pay: 'standing' });
    add(y, m, day(8), 'ועד בית', 150, 'home', { pay: 'standing' });
    add(y, m, day(9), 'סלקום', 89, 'subs', { pay: 'standing' });
    add(y, m, day(9), 'נטפליקס', 50, 'subs');
    add(y, m, day(2), 'רמי לוי', 640 + k * 30, 'food', { who: 'p_mom' });
    add(y, m, day(10), 'שופרסל', 420, 'food', { who: 'p_mom' });
    add(y, m, day(17), 'אושר עד', 530 + (k === 0 ? 700 : 0), 'food');
    add(y, m, day(12), 'ירקן', 95, 'food', { who: 'p_mom', pay: 'cash' });
    add(y, m, day(6), 'דלק', 280, 'car');
    add(y, m, day(19), 'פנגו חניה', 35, 'car', { pay: 'bit' });
    add(y, m, day(11), 'פיצה', 120, 'rest', { who: 'p_kid1', pay: 'cash' });
    add(y, m, day(15), 'וולט', 160 + (k === 0 ? 260 : 0), 'rest');
    add(y, m, day(4), 'חוג כדורגל', 180, 'kids', { who: 'p_kid2' });
    add(y, m, day(13), 'סופר פארם', 75, 'health', { who: 'p_mom' });
    add(y, m, day(7), 'צדקה', 300, 'give');
    add(y, m, day(16), 'אוכל לכלב', 120, 'c_dog');
    if (k === 2) add(y, m, day(18), 'נעליים לנועה', 260, 'clothes', { who: 'p_kid1' });
    if (k === 0) add(y, m, day(1), 'גלידה', 15, 'rest', { who: 'p_kid2', pay: 'cash' });
  }
  // 🏷️ אירוע: בר מצווה של איתי (החודש)
  for (const [d, desc, a, cat] of [[2, 'אולם', 6500, 'fun'], [4, 'צלם', 1800, 'fun'], [6, 'חליפה לאיתי', 650, 'clothes'], [7, 'תפילין', 2200, 'kids']])
    add(Y, M, Math.min(d, D), desc, a, cat, { tags: ['בר_מצווה'] });
  // 🕎 חגים: פסח וחגי תשרי — השנה ושנה שעברה (בשביל ההשוואה)
  const chag = (y, m, d, desc, a, cat, tag) => add(y, m, d, desc, a, cat, { tags: [tag] });
  for (const [y, f] of [[Y, 1], [Y - 1, .85]]) {
    chag(y, 3, 1, 'קניות לפסח', Math.round(1900 * f), 'food', 'פסח'); chag(y, 3, 3, 'כלים חדשים לפסח', Math.round(480 * f), 'home', 'פסח');
    chag(y, 8, 10, 'קניות לראש השנה', Math.round(1250 * f), 'food', 'חגים'); chag(y, 8, 25, 'סוכה וקישוטים', Math.round(700 * f), 'fun', 'חגים');
  }
  // 💳 תשלומים: ספה ב-12 תשלומים (נגמרים בקרוב)
  tx.push({ id: id(), msg: id(), raw: 'ספה 6000 ב-12 תשלומים', desc: 'ספה', cat: 'home', source: 'text', created: iso(Y, M - 10, 10), date: iso(Y, M - 10, 10), amount: 500, total: 6000, inst: 12, who: 'p_dad', pay: 'credit' });

  const kv = {
    people, me: 'p_dad',
    cats: { c_dog: { n: 'הכלב', e: '🐶', c: '#F97316', custom: true } },
    budgets: { food: 2600, rest: 450, c_dog: 150, fun: 400 },
    learned: {},
    goals: {
      g_wed: { n: 'חתונה של יוסי', e: '💍', target: 20000, date: `${Y + 1}-06`, dep: [{ d: iso(Y, M - 2, 1), a: 6000, w: 'p_dad' }, { d: iso(Y, M - 1, 1), a: 2500, w: 'p_mom' }, { d: iso(Y, M, 1), a: 2500, w: 'p_dad' }] },
      g_car: { n: 'רכב חדש', e: '🚗', target: 40000, date: '', dep: [{ d: iso(Y, M - 1, 5), a: 4000, w: 'p_dad' }] },
    },
    maaser: { pct: 10, since: '' },
    pocket: {
      rate: { stars: 10, nis: 5 },
      p_kid1: { goal: { n: 'אופניים', target: 400 }, mv: [{ id: id(), d: iso(Y, M - 1, 2), a: 100, note: 'דמי כיס', src: 'dep' }, { id: id(), d: iso(Y, M - 1, 20), a: 25, note: '50⭐ כוכבים', src: 'stars' }, { id: id(), d: iso(Y, M, 3), a: -30, note: 'ספר', src: 'spend' }, { id: id(), d: iso(Y, M, 5), a: 150, note: 'מתנה מסבתא', src: 'dep' }] },
      p_kid2: { goal: null, mv: [{ id: id(), d: iso(Y, M, 1), a: 50, note: 'דמי כיס', src: 'dep' }] },
    },
    debts: {
      d_david: { name: 'דוד', dir: 'lent', kind: 'loan', total: 1500, note: 'לרכב', d: iso(Y, M - 2, 1), plan: { n: 3, start: new Date(Y, M - 2, 5, 12).toISOString().slice(0, 10) }, pay: [{ d: iso(Y, M - 2, 5), a: 500 }] },
      d_gemach: { name: 'גמ"ח יד ביד', dir: 'borrowed', kind: 'gemach', total: 5000, note: 'הלוואה לשיפוץ', d: iso(Y, M - 3, 1), plan: { n: 10, start: new Date(Y, M - 3, 1, 12).toISOString().slice(0, 10) }, pay: [{ d: iso(Y, M - 3, 1), a: 500 }, { d: iso(Y, M - 2, 1), a: 500 }, { d: iso(Y, M - 1, 1), a: 500 }] },
      d_split: { name: 'משפחת לוי', dir: 'lent', kind: 'split', total: 450, note: 'צימר בגליל', d: iso(Y, M, 2), plan: null, pay: [] },
    },
  };
  return { tx, kv };
}
