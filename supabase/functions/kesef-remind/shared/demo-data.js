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
  // 🔁 קבועים: נרשמים עם מספר קבוע לכל (כלל, חודש) — כמו באפליקציה האמיתית
  const ymk = (y, m) => `${new Date(y, m, 1).getFullYear()}-${String(new Date(y, m, 1).getMonth() + 1).padStart(2, '0')}`;
  const addRec = (rid, y, m, d, desc, amount, cat, extra = {}) => tx.push({ id: `rec_${rid}_${ymk(y, m)}`, msg: `rec_${rid}_${ymk(y, m)}`, raw: `🔁 ${desc} ${amount}`, desc, cat, source: 'recurring', rec: rid,
    created: iso(y, m, d), date: iso(y, m, d), amount, total: amount, inst: 0, who: extra.who || 'p_dad', pay: extra.pay || (cat === 'income' ? 'transfer' : 'standing'), ...extra });
  // שלושה חודשים אחורה + החודש
  for (let k = 3; k >= 0; k--) {
    const y = new Date(Y, M - k, 1).getFullYear(), m = new Date(Y, M - k, 1).getMonth(), last = k === 0 ? D : 28;
    const day = d => Math.min(d, last);
    addRec('r_sal1', y, m, 1, 'משכורת', 12500, 'income', { who: 'p_dad' });
    addRec('r_sal2', y, m, 1, 'משכורת', 9200, 'income', { who: 'p_mom' });
    if (k === 1) add(y, m, day(14), 'החזר הוצאות מהעבודה', 340, 'income', { who: 'p_mom', pay: 'transfer', noMaaser: true });
    add(y, m, day(20), 'קצבת ילדים', 345, 'income', { who: 'p_mom', pay: 'transfer' });
    if (k === 0 && D >= 3) addRec('r_elec', y, m, 3, 'חשמל', 470, 'home', { estimate: true }); else if (k > 0) addRec('r_elec', y, m, 3, 'חשמל', 430 + k * 15, 'home');
    if (k > 0 || D >= 5) addRec('r_arnona', y, m, 5, 'ארנונה', 620, 'home');
    if (k > 0 || D >= 8) addRec('r_vaad', y, m, 8, 'ועד בית', 150, 'home');
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
    if (k > 0 || D >= 4) addRec('r_chug', y, m, 4, 'חוג כדורגל', 180, 'kids', { who: 'p_kid2' });
    add(y, m, day(13), 'סופר פארם', 75, 'health', { who: 'p_mom' });
    add(y, m, day(7), 'צדקה', 300, 'give');
    // 🛡️ ביטוחים + 💝 תרומה קבועה + 🏥 בריאות
    if (k > 0 || D >= 10) addRec('r_ins', y, m, 10, 'ביטוח רכב — הראל', 320, 'ins', { pay: 'standing' });
    if (k > 0 || D >= 10) addRec('r_insh', y, m, 10, 'ביטוח בריאות מכבי שלי', 140, 'ins', { pay: 'standing' });
    if (k > 0 || D >= 12) addRec('r_give', y, m, 12, 'תרומה קבועה — ישיבה', 150, 'give', { pay: 'standing' });
    if (k === 1) add(y, m, day(21), 'קופת חולים — השתתפות עצמית', 45, 'health', { who: 'p_mom' });
    if (k === 0) add(y, m, day(3), 'בית מרקחת', 60, 'health', { who: 'p_mom' });
    if (k === 0) add(y, m, day(5), 'תרומה לגמ"ח של השכונה', 200, 'give', { extraGive: true, pay: 'cash' });
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
  // 📄 מקובץ הבנק (מדומה): השם שונה, ושורת "🏦 בבנק כתוב" שומרת את הטקסט המקורי. אחד מהם לפי כלל שנשמר
  const file = (y, m, d, desc, bank, amount, cat) => add(y, m, d, desc, amount, cat, { source: 'file', raw: 'עוש-דוגמה.xlsx', bankDesc: bank, fp: `${iso(y, m, d).slice(0, 10)}|${amount.toFixed(2)}|${bank}`, pay: 'standing', fileKind: 'bank', msg: `demofile_${m}`, created: iso(y, m, 20) });
  for (let k = 2; k >= 1; k--) {
    const y = new Date(Y, M - k, 1).getFullYear(), m = new Date(Y, M - k, 1).getMonth();
    file(y, m, 13, 'פלאפון של נועה', `הו"ק פלאפון ${4100 + k}`, 59, 'subs');
    file(y, m, 16, 'גן של איתי', `העב' לאחר-נייד 05${k}7`, 900, 'kids');
  }
  // 💳 תשלומים: ספה ב-12 תשלומים (נגמרים בקרוב)
  tx.push({ id: id(), msg: id(), raw: 'ספה 6000 ב-12 תשלומים', desc: 'ספה', cat: 'home', source: 'text', created: iso(Y, M - 10, 10), date: iso(Y, M - 10, 10), amount: 500, total: 6000, inst: 12, who: 'p_dad', pay: 'credit' });

  const start = ymk(Y, M - 3);
  const kv = {
    recurring: {
      r_sal1: { desc: 'משכורת', amount: 12500, cat: 'income', day: 1, start, end: '', who: 'p_dad' },
      r_sal2: { desc: 'משכורת', amount: 9200, cat: 'income', day: 1, start, end: '', who: 'p_mom' },
      r_elec: { desc: 'חשמל', amount: 470, cat: 'home', day: 3, start, end: '', variable: true },
      r_arnona: { desc: 'ארנונה', amount: 620, cat: 'home', day: 5, start, end: '' },
      r_vaad: { desc: 'ועד בית', amount: 150, cat: 'home', day: 8, start, end: '' },
      r_ins: { desc: 'ביטוח רכב — הראל', amount: 320, cat: 'ins', day: 10, start, end: '' },
      r_insh: { desc: 'ביטוח בריאות מכבי שלי', amount: 140, cat: 'ins', day: 10, start, end: '' },
      r_give: { desc: 'תרומה קבועה — ישיבה', amount: 150, cat: 'give', day: 12, start, end: '' },
      r_chug: { desc: 'חוג כדורגל', amount: 180, cat: 'kids', day: 4, start, end: ymk(Y, M + 5), who: 'p_kid2' },
      r_rentin: { desc: 'שכירות שנכנסת', amount: 3800, cat: 'income', day: 28, start: ymk(Y, M + 1), end: '', paused: false },
    },
    people, me: 'p_dad',
    cats: { c_dog: { n: 'הכלב', e: '🐶', c: '#F97316', custom: true } },
    budgets: { _mode: 'auto', food: 2600, rest: 450, c_dog: 150, fun: 400 },
    learned: {},
    lists: Object.fromEntries([2, 1].map(k => { const mm = new Date(Y, M - k, 1).getMonth(); return [`demofile_${mm}`, { kind: 'bank', bank: 'לאומי', files: ['עוש-דוגמה.xlsx'] }]; })),
    rules: { rl_phone: { match: 'הוק פלאפון', bank: 'הו"ק פלאפון 4101', name: 'פלאפון של נועה', cat: 'subs', created: iso(Y, M - 2, 14) } },
    goals: {
      g_wed: { n: 'חתונה של יוסי', e: '💍', target: 20000, date: `${Y + 1}-06`, dep: [{ d: iso(Y, M - 2, 1), a: 6000, w: 'p_dad' }, { d: iso(Y, M - 1, 1), a: 2500, w: 'p_mom' }, { d: iso(Y, M, 1), a: 2500, w: 'p_dad' }] },
      g_car: { n: 'רכב חדש', e: '🚗', target: 40000, date: '', dep: [{ d: iso(Y, M - 1, 5), a: 4000, w: 'p_dad' }] },
    },
    maaser: { pct: 10, since: '', incOff: { 'קצבת ילדים': false }, deduct: true, deductCats: ['health'], giveCounts: true,
      dist: [{ id: 'm1', name: 'ישיבת אור החיים', v: 40, unit: 'pct', done: true }, { id: 'm2', name: 'משפחת כהן (סיוע)', v: 500, unit: 'nis', done: true },
        { id: 'm3', name: 'קופת העיר', v: 20, unit: 'pct', done: false }, { id: 'm4', name: 'גמ"ח כלים', v: 300, unit: 'nis', done: false }] },
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
