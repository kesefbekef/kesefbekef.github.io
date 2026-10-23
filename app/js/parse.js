// הופך משפט חופשי ("סופר 230 ודלק מאה" / "ספה 6000 ב-12 תשלומים" / "אתמול פיצה 85") לרשומות
const ONES = { 'אחת':1,'אחד':1,'שתיים':2,'שניים':2,'שלוש':3,'שלושה':3,'ארבע':4,'ארבעה':4,'חמש':5,'חמישה':5,'שש':6,'שישה':6,'שבע':7,'שבעה':7,'שמונה':8,'תשע':9,'תשעה':9,'עשר':10,'עשרה':10 };
const TENS = { 'עשרים':20,'שלושים':30,'ארבעים':40,'חמישים':50,'שישים':60,'שבעים':70,'שמונים':80,'תשעים':90 };

function numWord(tok) {
  for (const t of [tok, tok.replace(/^[ובה]/, ''), tok.replace(/^[ובה]{2}/, '')]) {
    if (t in ONES || t in TENS || ['מאה','מאתיים','מאות','אלף','אלפיים','אלפים'].includes(t)) return t;
  }
  return null;
}

// "מאה שמונים" → "180", "אלף ומאתיים" → "1200", "חמש עשרה" → "15"
// שמות מקומות עם מילת מספר — לא הופכים לספרות ("באר שבע" ולא "באר 7")
const KEEP_NUM_WORDS = /(באר|בבאר|לבאר|מבאר)\s+שבע|שבע\s+(כוכבים|ברכות)|כפר\s+שמונה/g;
export function wordsToDigits(text) {
  const keep = [];
  text = String(text).replace(KEEP_NUM_WORDS, m => { keep.push(m); return `\u0001${keep.length - 1}\u0001`; });
  const res = wordsToDigits0(text);
  return keep.length ? res.replace(/\u0001(\d+)\u0001/g, (_, i) => keep[+i]) : res;
}
function wordsToDigits0(text) {
  const out = [];
  let total = 0, cur = 0, inRun = false, prevOnes = false;
  let runStart = 0, runToks = [];
  const flush = () => {
    if (inRun) {
      // "חניה 20 אחת" / "פיצה אחת" — "אחת"/"אחד" לבד זו מילה (כמות), לא הסכום 1
      if (runToks.length === 1 && /^(ו|ה)?(אחת|אחד)$/.test(runToks[0])) { out.length = runStart; out.push(runToks[0]); }
      else out.push(String(total + cur));
    }
    total = cur = 0; inRun = false; prevOnes = false; runToks = [];
  };
  for (const tok of text.split(/\s+/)) {
    const w = numWord(tok);
    if (!w) { flush(); out.push(tok); continue; }
    if (!inRun) runStart = out.length;
    runToks.push(tok);
    // "במאה" → "ב" נשאר כמילה כדי לא לאבד הקשר
    if (!inRun && tok !== w) out.push(tok.slice(0, tok.length - w.length));
    inRun = true;
    if (w in ONES) {
      if ((w === 'עשרה' || w === 'עשר') && prevOnes) cur += 10;
      else cur += ONES[w];
      prevOnes = ONES[w] < 10;
      continue;
    }
    prevOnes = false;
    if (w in TENS) cur += TENS[w];
    else if (w === 'מאה') cur += 100;
    else if (w === 'מאתיים') cur += 200;
    else if (w === 'מאות') cur = (cur || 1) * 100;
    else if (w === 'אלף' || w === 'אלפים') { total += (cur || 1) * 1000; cur = 0; }
    else if (w === 'אלפיים') total += 2000;
  }
  flush();
  return out.filter(Boolean).join(' ');
}

// מטבע — רק כמילה שלמה ("משחק" לא מאבד את ה"שח")
const CURRENCY = /(^|\s|\d)(ש"ח|ש״ח|שח|שקלים|שקל|ש'|nis)(?=$|\s|[.,!?])/gi;

// אמצעי תשלום
export const PAY = {
  credit:   { n: 'אשראי',      e: '💳' },
  cash:     { n: 'מזומן',      e: '💵' },
  transfer: { n: 'העברה',      e: '🏦' },
  bit:      { n: 'ביט/פייבוקס', e: '📱' },
  standing: { n: 'הוראת קבע',  e: '🔁' },
  check:    { n: "צ'ק",        e: '📝' },
};
// מילה שלמה, עם אותיות שימוש לפניה ("בביט", "ובאשראי") — "ביטוח" כבר לא נחשב ביט
const PAY_PRE = '(?:^|[\\s(,])(?:[ובהלמש]{1,2}-?)?';
const PAY_END = '(?=$|[\\s),.!?:;])';
const payRe = (words, flags = '') => new RegExp(PAY_PRE + '(?:' + words + ')' + PAY_END, flags);
const PAY_WORDS = [
  [payRe('מזומן|מזומנים|קאש|cash', 'i'), 'cash'],
  [payRe('הוראת קבע|הו"ק|הוק'), 'standing'],
  [payRe('ביט|bit|פייבוקס|paybox|פיי בוקס', 'i'), 'bit'],
  [payRe("צ'ק|צ'קים|צק|שיק|המחאה"), 'check'],
  [payRe('העברה בנקאית|העברה|העברתי|העברנו'), 'transfer'],
  [payRe('אשראי|ויזה|visa|מאסטרקארד|ישראכרט|אמקס', 'i'), 'credit'],
  [/(?:^|[\s(,])ו?ב(?:ה)?כרטיס(?=$|[\s),.!?:;])/, 'credit'],   // "בכרטיס" (אבל "כרטיס לסרט" הוא לא אמצעי תשלום)
];
const normPay = t => ' ' + String(t || '').replace(/[׳`]/g, "'").replace(/״/g, '"') + ' ';
export function detectPay(text) {
  const s = normPay(text);
  const hit = PAY_WORDS.find(([re]) => re.test(s));
  return hit ? hit[1] : null;
}
const PAY_STRIP = /(^|\s)(?:ו?ב|ו|ב)?-?(כרטיס אשראי|מזומנים|מזומן|קאש|אשראי|ביט|פייבוקס|פיי בוקס|העברה בנקאית|העברה|הוראת קבע|הו"ק|צ'ק|צ׳ק|שיק|ויזה|ישראכרט|אמקס)(?=\s|$|[.,!?])/g;
const PAY_STRIP_CARD = /(^|\s)ו?ב(?:ה)?כרטיס(?=\s|$|[.,!?])/g;

const FILLER =/(^|\s)ו?(שילמתי|שילמנו|קניתי|קנינו|הוצאתי|הוצאנו|עלה|עלתה|עלו|סה"כ|סה״כ)(?=\s|$)/g;
// מילה כללית שהיא לא שם של הוצאה ("הוצאה 100" ← צריך לשאול "על מה?")
const GENERIC = /(^|\s)(הוצאה|הוצאות|ההוצאה)(?=\s|$)/g;
const LEAD = /^(וגם|גם|ועוד|עוד|ו|ב|על|של)\s+/;
const TRAIL = /\s+(ב|על|של|ל|ו|וגם|גם)$/;

function cleanDesc(s) {
  let t = String(s || '').replace(/₪/g, ' ').replace(CURRENCY, '$1 ').replace(PAY_STRIP, ' ').replace(PAY_STRIP_CARD, ' ')
    .replace(FILLER, ' ').replace(GENERIC, ' ')
    .replace(/[,+\-–—:;!?()[\]]/g, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/(^|\s)[/\\"']+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) t = t.replace(TRAIL, '').replace(LEAD, '').trim();
  return /^(ו|ב|ל|של|על|גם|וגם)$/.test(t) ? '' : t;
}

const DAY_WORDS = /(^|\s)(?:ו|מ)?(שלשום|אתמול|היום)(?=\s|$|[.,!?])/g;
function dayOffset(text) {
  if (/שלשום/.test(text)) return -2;
  if (/אתמול/.test(text)) return -1;
  return 0;
}

// "ב-5.10" / "12/9" / "3.10.26" — תאריך, לא סכום
const DATE_RE = /(^|\s)(בתאריך\s*|תאריך\s*|ב\s?|מ\s?|עד\s?)?-?\s?(\d{1,2})([./])(\d{1,2})(?:[./](\d{4}|\d{2}))?(?![\d./])/g;
const pad = n => String(n).padStart(2, '0');
function takeDate(text, now) {
  let date = null;
  const out = text.replace(DATE_RE, (m, pre, word, d, sep, mo, y) => {
    d = +d; mo = +mo;
    if (date || d < 1 || d > 31 || mo < 1 || mo > 12) return m;
    const strong = sep === '/' || !!word || !!y;
    if (!strong) {
      // "סופר 230 5.10" — תאריך רק אם יש סכום אחר, ואין במשפט סכומים עם נקודה עשרונית
      const rest = text.replace(m, ' ');
      if (!/\d/.test(rest) || /\d\.\d/.test(rest)) return m;
    }
    let year = y ? (y.length === 2 ? 2000 + +y : +y) : now.getFullYear();
    let dt = new Date(year, mo - 1, d, 12);
    if (dt.getMonth() !== mo - 1) return m;                                 // 31.2
    if (!y && dt - now > 31 * 864e5) dt = new Date(year - 1, mo - 1, d, 12); // "28.12" שנכתב בינואר = השנה שעברה
    date = dt;
    return pre + ' ';
  });
  return { text: out, date };
}

const round2 = n => Math.round(n * 100) / 100;
const isInt = s => /^\d+$/.test(s);
// "לפארם" (אחרי הסכום, "וגם 50 לפארם") ← "פארם". מילים שה-ל שלהן היא חלק מהמילה נשארות.
const L_NATIVE = /^(לחם|לחמים|לחמניה|לחמניות|לחמנייה|לימון|לימונים|לבן|לבנה|לבנים|לגו|לפטופ|לוח|לוחות|ליברה|לונה|לימודים|לאומי|לאומית|לק)$/;
function stripFor(desc) {
  const [w, ...rest] = desc.split(' ');
  return w.length >= 4 && w[0] === 'ל' && !L_NATIVE.test(w) ? [w.slice(1), ...rest].join(' ') : desc;
}

function parseOne(src, now) {
  let text = wordsToDigits(String(src || '').trim());
  text = text.replace(/(\d),(\d{3})(?!\d)/g, '$1$2').replace(/₪/g, ' ').replace(/(^|\s)\d{1,2}:\d{2}(?=\s|$)/g, ' ');

  let installments = 0, per = false;
  // "12 תשלומים של 500" = 500 לכל תשלום. "1200 ב-3 תשלומים" = 1200 בסך הכל
  text = text.replace(/(?:ב|ל)?-?\s*(\d+)\s*תשלומים(?:\s+(?:של|כל אחד|כל תשלום|כ"א)\s*-?\s*(\d+(?:\.\d+)?))?/, (_, n, p) => {
    installments = parseInt(n, 10);
    if (p) { per = true; return ` ${round2(+p * installments)} `; }
    return ' ';
  });
  if (installments > 1 && !per) {
    text = text.replace(/(\d+(?:\.\d+)?)\s*(?:ש"ח\s*|שקל\s*)?(?:לתשלום|כל תשלום|בכל תשלום)/, (_, p) => ` ${round2(+p * installments)} `);
  }

  const dt = takeDate(text, now);
  text = dt.text;
  let off = dayOffset(text);
  text = text.replace(DAY_WORDS, ' ');
  let date = null;
  if (dt.date) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    off = Math.round((dt.date - today) / 864e5);
    date = `${dt.date.getFullYear()}-${pad(dt.date.getMonth() + 1)}-${pad(dt.date.getDate())}`;
  }

  const parts = text.split(/(\d+(?:\.\d+)?)/);
  let texts = parts.filter((_, i) => i % 2 === 0), nums = parts.filter((_, i) => i % 2 === 1);
  if (!nums.length) return [];
  const empty = t => !cleanDesc(t);

  // מספר קטן שהוא חלק מהשם: "2 גלידות 30" (כמות), "כביש 6 45" (מספר כביש) — לא סכום נפרד
  const numberFirst = () => empty(texts[0]) && !empty(texts[texts.length - 1]);
  for (let changed = true; changed && nums.length > 1;) {
    changed = false;
    if (numberFirst()) break;
    for (let j = 0; j < nums.length - 1 && !changed; j++) {
      const n = nums[j];
      if (!isInt(n)) continue;
      if (j === 0 && empty(texts[0]) && !empty(texts[1]) && +n <= 20) {
        texts.splice(0, 2, texts[0] + ' ' + n + ' ' + texts[1]); nums.splice(0, 1); changed = true;
      } else if (!empty(texts[j]) && empty(texts[j + 1]) && +n <= 99) {
        texts.splice(j, 2, texts[j] + ' ' + n + ' ' + texts[j + 1]); nums.splice(j, 1); changed = true;
      }
    }
  }

  const item = (desc, amount, inst) => ({ desc, amount: parseFloat(amount), installments: inst, dayOffset: off,
    ...(date ? { date } : {}), ...(desc ? {} : { needsName: true }) });

  if (nums.length === 1) return [item(cleanDesc(texts[0] + ' ' + texts[1]), nums[0], installments)];

  // "סופר 230 דלק 100" — התיאור לפני המספר; "230 סופר 100 דלק" — התיאור אחריו
  const nf = numberFirst(), last = nums.length - 1;
  return nums.map((n, j) => {
    let desc = cleanDesc(nf ? texts[j + 1] : texts[j]);
    // "סופר 230 וגם 50 לפארם" — לסכום האחרון אין שם לפניו, השם אחריו
    if (!nf && !desc && j === last && !empty(texts[last + 1])) desc = stripFor(cleanDesc(texts[last + 1]));
    return item(desc, n, 0);
  });
}

// פיצול להערות: מה שאחרי ". " / שורה חדשה / " - " / בתוך סוגריים — הערה, לא חלק מהשם
function splitNotes(raw) {
  const notes = [];
  const t = String(raw || '').replace(/\r/g, '').replace(/\(([^)]*)\)?/g, (_, n) => { if (n.trim()) notes.push(n.trim()); return ' '; });
  const segs = t.split(/\n+|[.!?]+\s+|\s[-–—]+\s/).map(s => s.replace(/[.!?]+\s*$/, '').trim()).filter(Boolean);
  return { segs, notes };
}

/**
 * מחזיר מערך רשומות: [{desc, amount, installments, dayOffset, date?, note?, needsName?}]
 *  amount — הסכום הכולל (בתשלומים: הכל ביחד; app.js מחלק ב-installments)
 *  date — 'YYYY-MM-DD' כשנכתב תאריך מפורש ("ב-5.10"); dayOffset כבר מחושב בהתאם
 *  note — טקסט ההערה (אחרי נקודה / שורה חדשה / מקף / בסוגריים)
 *  needsName — true כשאין שם ("הוצאה 100", "100") — desc ריק, כדאי לשאול "על מה?"
 * או מערך ריק אם לא נמצא סכום
 */
export function parseMessage(raw, now = new Date()) {
  const { segs, notes } = splitNotes(String(raw || '').trim());
  if (!segs.length) return [];
  let main = segs[0];
  const extra = [];
  for (const s of segs.slice(1)) {
    if (!parseOne(main, now).length) { main += ' ' + s; continue; }
    if (parseOne(s, now).length) { extra.push(s); continue; }
    // "ספה 6000 - 12 תשלומים" / "סופר 230. אתמול" — שייך לרשומה, לא הערה
    const bare = cleanDesc(takeDate(s, now).text.replace(DAY_WORDS, ' ').replace(/(?:ב|ל)?-?\s*\S+\s*תשלומים/, ' '));
    if (!bare || /תשלומים/.test(s) && s.split(/\s+/).length <= 4) main += ' ' + s;
    else notes.push(s);
  }
  const first = parseOne(main, now);
  if (!first.length) return [];
  const items = [...first, ...extra.flatMap(s => parseOne(s, now).map(it =>
    // תאריך/יום שנכתב ברשומה הראשונה חל גם על השאר
    it.date || it.dayOffset ? it : { ...it, dayOffset: first[0].dayOffset, ...(first[0].date ? { date: first[0].date } : {}) }))];
  const note = notes.join(' · ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return note ? items.map(it => ({ ...it, note })) : items;
}

// "ודלק" → "דלק" רק אם זה עוזר לזהות
export function stripVav(desc) {
  return /^ו[^ו]/.test(desc) ? desc.slice(1) : desc;
}

// 🏷️ תגיות אירוע: "מתנה 300 #בר_מצווה" → tags ['בר_מצווה'], והטקסט בלי התגית
export function takeTags(text) {
  const tags = [];
  const rest = text.replace(/#([\p{L}\p{N}_]{1,30})/gu, (_, t) => { tags.push(t); return ' '; }).replace(/\s+/g, ' ').trim();
  return { tags: [...new Set(tags)], text: rest };
}
export const cleanTag = s => String(s || '').replace(/^#+/, '').trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 30);
