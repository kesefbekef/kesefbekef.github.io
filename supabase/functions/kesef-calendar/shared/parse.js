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
export function wordsToDigits(text) {
  const out = [];
  let total = 0, cur = 0, inRun = false, prevOnes = false;
  const flush = () => { if (inRun) out.push(String(total + cur)); total = cur = 0; inRun = false; prevOnes = false; };
  for (const tok of text.split(/\s+/)) {
    const w = numWord(tok);
    if (!w) { flush(); out.push(tok); continue; }
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

const CURRENCY = /(₪|ש"ח|ש״ח|שח|שקלים|שקל|nis)/gi;

// אמצעי תשלום
export const PAY = {
  credit:   { n: 'אשראי',      e: '💳' },
  cash:     { n: 'מזומן',      e: '💵' },
  transfer: { n: 'העברה',      e: '🏦' },
  bit:      { n: 'ביט/פייבוקס', e: '📱' },
  standing: { n: 'הוראת קבע',  e: '🔁' },
  check:    { n: "צ'ק",        e: '📝' },
};
const PAY_WORDS = [
  [/מזומן|קאש|cash/i, 'cash'],
  [/הוראת קבע|הו"ק|הו״ק|(^|\s)הוק(\s|$)/, 'standing'],
  [/ביט|bit|פייבוקס|paybox|פיי בוקס/i, 'bit'],
  [/צ'ק|צ׳ק|צק |שיק|המחאה/, 'check'],
  [/העברה|העברתי|העברנו/, 'transfer'],
  [/אשראי|כרטיס|ויזה|visa|מאסטרקארד|ישראכרט|אמקס/i, 'credit'],
];
export function detectPay(text) {
  const hit = PAY_WORDS.find(([re]) => re.test(text));
  return hit ? hit[1] : null;
}
const PAY_STRIP = /(^|\s)(ב|ו)?(מזומן|קאש|אשראי|כרטיס אשראי|כרטיס|ביט|פייבוקס|העברה בנקאית|העברה|הוראת קבע|צ'ק|צ׳ק|שיק)(?=\s|$)/g;

const FILLER =/(^|\s)(שילמתי|שילמנו|קניתי|קנינו|הוצאתי|הוצאנו|עלה|עלתה|עלו|סה"כ)(?=\s|$)/g;

function cleanDesc(s) {
  return s.replace(CURRENCY, '').replace(PAY_STRIP, ' ').replace(FILLER, ' ').replace(/[,+\-–:]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\s+(ב|על|של|ל)$/, '').replace(/^(ב|על)\s+/, '').trim();
}

function dayOffset(text) {
  if (/שלשום/.test(text)) return -2;
  if (/אתמול/.test(text)) return -1;
  return 0;
}

/**
 * מחזיר מערך רשומות: [{desc, amount, installments, dayOffset}]
 * או מערך ריק אם לא נמצא סכום
 */
export function parseMessage(raw) {
  let text = wordsToDigits(raw.trim());
  text = text.replace(/(\d),(\d{3})/g, '$1$2');

  let installments = 0;
  text = text.replace(/ב?-?\s*(\d+)\s*תשלומים/, (_, n) => { installments = parseInt(n, 10); return ' '; });

  const off = dayOffset(text);
  text = text.replace(/שלשום|אתמול|היום/g, ' ');

  const parts = text.split(/(\d+(?:\.\d+)?)/);
  const nums = [];
  for (let i = 1; i < parts.length; i += 2) nums.push(i);
  if (!nums.length) return [];

  if (nums.length === 1) {
    const i = nums[0];
    return [{ desc: cleanDesc(parts[i - 1] + ' ' + parts[i + 1]) || 'הוצאה', amount: parseFloat(parts[i]), installments, dayOffset: off }];
  }
  // "סופר 230 דלק 100" — התיאור לפני המספר; "230 סופר 100 דלק" — התיאור אחריו
  const numberFirst = !cleanDesc(parts[nums[0] - 1]);
  return nums.map(i => {
    const desc = cleanDesc(numberFirst ? parts[i + 1] : parts[i - 1]).replace(/^(וגם|גם)\s+/, '');
    return { desc: desc || 'הוצאה', amount: parseFloat(parts[i]), installments: 0, dayOffset: off };
  });
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
