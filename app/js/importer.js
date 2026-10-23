// קריאת קבצי אקסל / CSV מכל חברות האשראי והבנקים, וזיהוי העמודות אוטומטית
import { CATS, classify, isIncome } from './categories.js';

let xlsxLoading;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxLoading ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/xlsx.full.min.js';
    s.onload = () => res(window.XLSX);
    s.onerror = () => rej(new Error('לא הצלחתי לטעון את קורא האקסל'));
    document.head.appendChild(s);
  });
  return xlsxLoading;
}

// CSV מבנקים ישראליים מגיע לפעמים בקידוד windows-1255
function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1255').decode(buf); }
}

// ---------- PDF: קריאת הטקסט ושחזור הטבלה לפי מיקום העמודות ----------
async function readPdfRows(file) {
  const pdfjs = await import('../vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    pages.push((await page.getTextContent()).items
      .filter(i => i.str && i.str.trim())
      .map(i => ({ s: i.str.trim(), x: i.transform[4] + i.width / 2, y: i.transform[5] })));
  }
  const out = pdfSheets(pages);
  if (!out) throw Object.assign(new Error('scanned'), { scanned: true, pages: pdf.numPages });
  out[0].meta = { pages: pdf.numPages };
  return out;
}

// כותרת שבורה לשתי שורות ("סכום" / "חיוב", "תאריך" / "עסקה" — כאל): מצרפים כל מילה לזו שמעליה באותה עמודה
function joinHeader(a, b) {
  const cl = a.items.map(i => ({ x: i.x, s: i.s }));
  for (const it of b.items) {
    const c = cl.find(c => Math.abs(c.x - it.x) < 30);
    if (c) c.s += ' ' + it.s; else cl.push({ x: it.x, s: it.s });
  }
  return cl.sort((p, q) => q.x - p.x);
}

/** הטקסט מכל עמוד ([{s,x,y}]) ← גיליון. null = אין טקסט (סרוק) */
export function pdfSheets(pages) {
  const rows = [], text = [];
  let cols = null; // מרכזי העמודות לפי שורת הכותרת
  for (const items of pages) {
    // קיבוץ לשורות לפי גובה
    const lines = [];
    for (const it of [...items].sort((a, b) => b.y - a.y)) {
      const line = lines.find(l => Math.abs(l.y - it.y) < 3);
      if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
    }
    for (let k = 0; k < lines.length; k++) {
      const l = lines[k], its = l.items.sort((a, b) => b.x - a.x); // מימין לשמאל
      const strs = its.map(i => i.s);
      text.push(strs.join(' '));
      if (headerMap(strs)) { cols = its.map(i => i.x); rows.push(strs); continue; }
      const nx = lines[k + 1];
      if (nx && l.y - nx.y < 22 && its.length >= 2) {
        const hj = joinHeader(l, nx);
        if (headerMap(hj.map(c => c.s))) { cols = hj.map(c => c.x); rows.push(hj.map(c => c.s)); k++; continue; }
      }
      if (!cols) { rows.push([strs.join(' ')]); continue; }
      const row = new Array(cols.length).fill('');
      for (const it of its) {
        let best = 0;
        cols.forEach((cx, k) => { if (Math.abs(cx - it.x) < Math.abs(cols[best] - it.x)) best = k; });
        row[best] = row[best] ? row[best] + ' ' + it.s : it.s;
      }
      rows.push(row);
    }
  }
  if (!rows.length) return null;
  if (cols && extract([rows]).items.length) return [rows];
  // אין טבלה מסודרת — קוראים כל שורה כטקסט:
  // 🏦 דף חשבון (תאריך · תיאור · סכום · יתרה) ואחרת 💳 פירוט אשראי (תאריך · בית עסק · סכום)
  const st = statementLines(text) || cardLines(text);
  return [st || rows];
}

// 💳 פירוט אשראי כשורות טקסט: תאריך, שם בית העסק, סכום עסקה ואולי סכום חיוב (הוא הקובע), ופירוט נוסף
const CAMT_RE = /(?:₪\s*)?-?\d{1,3}(?:,\d{3})*\.\d{2}-?(?:\s*₪)?/g;
const CDATE_RE = /\d{1,2}[./]\d{1,2}[./]\d{2,4}/;
export function cardLines(lines) {
  const num = v => { let x = String(v).replace(/[₪,\s]/g, ''); if (/-$/.test(x)) x = '-' + x.slice(0, -1); return parseFloat(x); };
  const out = [];
  for (const l0 of lines) {
    const l = norm(l0), d = l.match(CDATE_RE); if (!d) continue;
    const rest = l.slice(d.index + d[0].length), am = [...rest.matchAll(CAMT_RE)];
    if (!am.length) continue;
    const clean = t => t.replace(CDATE_RE, ' ').replace(/(^|\s)[-₪](?=\s|$)/g, ' ').replace(/[₪]/g, ' ').replace(/\s+/g, ' ').trim();
    const head = rest.slice(0, am[0].index), mid = rest.slice(am[0].index, am[am.length - 1].index + am[am.length - 1][0].length);
    let desc = clean(head);
    const tail = clean(rest.slice(am[am.length - 1].index + am[am.length - 1][0].length));
    if (!/[א-תa-z]/i.test(desc)) { desc = tail; }
    if (!/[א-תa-z]/i.test(desc) || /^סה.?כ/.test(desc)) continue;
    const vals = am.map(a => Math.abs(num(a[0]))).filter(v => !isNaN(v));
    let v = vals.length > 1 && vals[1] ? vals[1] : vals[0]; // סכום החיוב (העמודה השנייה) כשיש
    if (!v) continue;
    // מינוס = זיכוי. בקובץ מימין לשמאל המינוס יכול לצאת כתו נפרד ליד ה־₪
    if (/(^|\s)-(\s|₪|$)|-\s*₪|\d-|-\d/.test(head.slice(-3) + mid)) v = -v;
    out.push([d[0], desc, v, desc === tail ? '' : tail]);
  }
  return out.length >= 2 ? [['תאריך', 'בית העסק', 'סכום', 'פירוט נוסף'], ...out] : null;
}

// 🏦 דף חשבון כשורות טקסט: לכל שורה תאריך, תיאור, סכום אחד (זכות או חובה — העמודה הריקה נעלמת) ויתרה.
// האם זה זכות או חובה — לפי השינוי ביתרה מהשורה הקודמת / הבאה. מחזיר גיליון עם כותרת "תאריך · תיאור · סכום · יתרה"
const NUM = '-?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?-?';
const ST_RE = new RegExp(`^(\\d{1,2}[./]\\d{1,2}[./]\\d{2,4})\\s*(.+?)\\s+₪?\\s*(${NUM})\\s*₪?\\s+₪?\\s*(${NUM})\\s*₪?$`);
export function statementLines(lines) {
  const num = v => { let x = String(v).replace(/,/g, ''); if (/-$/.test(x)) x = '-' + x.slice(0, -1); return parseFloat(x); };
  const out = [];
  for (const l of lines) {
    const m = norm(l).match(ST_RE); if (!m) continue;
    const amt = Math.abs(num(m[3])), bal = num(m[4]);
    if (!(amt > 0) || isNaN(bal)) continue;
    out.push({ date: m[1], desc: m[2].trim(), amt, bal });
  }
  if (out.length < 2) return null;
  const near = (a, b) => Math.abs(a - b) < 0.015, INC = /משכורת|העברה אלי|זיכוי|החזר|קצבה|מענק|ריבית זכות/;
  // הכיוון של הקובץ: ישן ← חדש (יתרה = הקודמת ± סכום) או חדש ← ישן (יתרה = הבאה ± סכום) — מה שמתאים ליותר שורות
  const fit = dir => out.reduce((n, r, i) => { const o = out[i - dir]; return n + (o && (near(r.bal - o.bal, r.amt) || near(r.bal - o.bal, -r.amt)) ? 1 : 0); }, 0);
  const dir = fit(1) >= fit(-1) ? 1 : -1;
  // היתרות לא מסתדרות כמעט באף שורה — זה לא דף חשבון (למשל פירוט אשראי: סכום עסקה + סכום חיוב)
  if (fit(dir) < (out.length - 1) / 2) return null;
  for (let i = 0; i < out.length; i++) {
    const r = out[i], o = out[i - dir];
    if (o && near(r.bal - o.bal, r.amt)) r.sign = 1;          // היתרה עלתה בסכום = זכות (נכנס)
    else if (o && near(r.bal - o.bal, -r.amt)) r.sign = -1;   // היתרה ירדה = חובה (יצא)
    else r.sign = INC.test(r.desc) ? 1 : -1;                  // השורה הראשונה / לא מתאים — לפי המילים
  }
  return [['תאריך', 'תיאור', 'סכום', 'יתרה'], ...out.map(r => [r.date, r.desc, r.sign * r.amt, r.bal])];
}

export async function readSheets(file) {
  if (/\.pdf$/i.test(file.name)) return readPdfRows(file);
  const XLSX = await loadXLSX();
  const buf = await file.arrayBuffer();
  const wb = /\.(csv|txt)$/i.test(file.name)
    ? XLSX.read(decodeText(buf), { type: 'string', raw: true }) // בלי ניחוש תאריכים בפורמט אמריקאי
    : XLSX.read(buf, { type: 'array', cellDates: true });
  return wb.SheetNames.map(n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }));
}

// ניקוי: מירכאות, סימני כיוון נסתרים (לאומי / וואן זירו), וירידת שורה בתוך כותרת ("סכום\nחיוב" בכאל) = רווח
const norm = v => String(v ?? '').replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').replace(/["'״׳˝]/g, '').replace(/\s+/g, ' ').trim();

function pick(cells, words, avoid = []) {
  for (const w of words) {
    const i = cells.findIndex(c => c.includes(w) && !avoid.some(a => c.includes(a)));
    if (i >= 0) return i;
  }
  return -1;
}

function headerMap(row) {
  const cells = row.map(norm);
  if (cells.filter(Boolean).length < 3) return null;
  const m = {
    date: pick(cells, ['תאריך עסקה', 'תאריך רכישה', 'תאריך העסקה', 'תאריך', 'date'], ['ערך', 'חיוב']),
    chargeDate: pick(cells, ['תאריך חיוב', 'מועד חיוב']),
    desc: pick(cells, ['שם בית העסק', 'שם בית עסק', 'בית העסק', 'בית עסק', 'תיאור התנועה', 'תיאור הפעולה', 'תיאור', 'סוג תנועה', 'סוג הפעולה', 'הפעולה', 'פרטים', 'description']),
    amount: pick(cells, ['סכום חיוב', 'סכום החיוב', 'סכום בשח', 'סכום ב-₪', 'סכום פעולה', 'סכום', 'amount'], ['מקורי', 'מטבע', 'הנחה']),
    amount2: pick(cells, ['סכום עסקה', 'סכום העסקה'], ['מקורי']), // כשסכום החיוב עוד ריק (עסקה שטרם נקלטה — כאל)
    debit: pick(cells, ['חובה']),
    credit: pick(cells, ['זכות']),
    hint: pick(cells, ['קטגוריה', 'ענף']),
    notes: ['הערות', 'פירוט נוסף', 'סוג עסקה'].map(w => cells.findIndex(c => c.includes(w))).filter(i => i >= 0),
  };
  if (m.date < 0) m.date = pick(cells, ['תאריך']);
  if (m.desc < 0) m.desc = pick(cells, ['תאור'], ['מורחב']); if (m.desc < 0) m.desc = pick(cells, ['תאור']); // "תאור" בלי י' (לאומי / הבינלאומי)
  // עמודה אחת "זכות/חובה" (דיסקונט / מרכנתיל) = סכום עם סימן (מינוס = חובה), לא שתי עמודות
  if (m.debit >= 0 && m.debit === m.credit) { m.amount = m.debit; m.debit = m.credit = -1; }
  if (m.amount2 === m.amount) m.amount2 = -1;
  if (m.date < 0 || m.desc < 0 || (m.amount < 0 && m.debit < 0 && m.credit < 0)) return null;

  m.bank = m.debit >= 0 || m.credit >= 0 || cells.some(c => c.includes('יתרה'));
  return m;
}

export function parseDate(v) {
  if (v instanceof Date && !isNaN(v)) return new Date(v.getFullYear(), v.getMonth(), v.getDate(), 12);
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Math.round((v - 25569) * 864e5));
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
  }
  const s = norm(v);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], m[2] - 1, +m[3], 12);
  m = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; const d = new Date(y, m[2] - 1, +m[1], 12); return isNaN(d) ? null : d; }
  return null;
}

export function parseNum(v) {
  if (typeof v === 'number') return v;
  let s = norm(v).replace(/[₪,\s]|nis|ש"ח|שח/gi, '');
  if (!s) return NaN;
  if (/^-?[\d.]+-$/.test(s)) s = '-' + s.slice(0, -1);
  return parseFloat(s);
}

// שורה בבנק שהיא בעצם החיוב החודשי של כרטיס האשראי
const CC_RE = /(ישראכרט|כאל|ויזה|visa|מקס(?!\s*סטוק)|max(?!\s*stock)|לאומי קארד|אמריקן|אמקס|amex|דיינרס|diners|כרטיס אשראי|כרטיסי אשראי|חיוב כרטיס|כ\.א\.|פועלים כרט)/i;

// משיכת מזומן מהכספומט — הכסף רק עבר לארנק; ההוצאות עצמן נרשמות במזומן
const ATM_RE = /(משיכת מזומן|משיכה מכספומט|כספומט|מכשיר אוטומטי|atm)/i;

// העברה בין החשבונות שלי / לחיסכון — הכסף לא יצא מהבית
const OWN_RE = /(בין חשבונות|העברה עצמית|לחשבון שלי|מחשבון שלי|לפיקדון|מפיקדון|פיקדון|לחיסכון|לחסכון|קופת חיסכון|העברה לחשבון אחר שלי)/i;
// זיכוי מחנות בבנק (החזר / ביטול עסקה) — מוריד מההוצאות באותה קטגוריה, לא הכנסה
const REFUND_RE = /(זיכוי|החזר|ביטול עסקה|ביטול חיוב|ביטול)\s*/;

const HINT = { 'מזון': 'food', 'צריכה': 'food', 'סופרמרקט': 'food', 'מסעדות': 'rest', 'בתי קפה': 'rest', 'מזון מהיר': 'rest',
  'דלק': 'car', 'תחבורה': 'car', 'רכב': 'car', 'ביגוד': 'clothes', 'אופנה': 'clothes', 'הנעלה': 'clothes',
  'רפואה': 'health', 'בריאות': 'health', 'פארם': 'health', 'תקשורת': 'subs', 'מחשבים': 'subs', 'סלולר': 'subs',
  'ריהוט': 'home', 'בית': 'home', 'עירייה': 'home', 'עירוני': 'home', 'חשמל': 'home', 'גז': 'home',
  'פנאי': 'fun', 'בילוי': 'fun', 'תיירות': 'fun', 'טיסות': 'fun', 'מלונות': 'fun',
  'ילדים': 'kids', 'חינוך': 'kids', 'צעצועים': 'kids', 'תרומות': 'give', 'עמותות': 'give' };

function hintCat(hint) {
  const h = norm(hint);
  if (!h) return null;
  const k = Object.keys(HINT).find(w => h.includes(w));
  return k ? HINT[k] : null;
}

/** מכל הגיליונות → { kind, items: [{date, desc, amount, income, cat, note, ccCharge}] } */
export function extract(sheets, learned = {}) {
  const items = [];
  let kind = 'card';
  for (const rows of sheets) {
    let m = null;
    for (const row of rows) {
      const h = headerMap(row);
      if (h) { m = h; if (h.bank) kind = 'bank'; continue; }
      if (!m) continue;
      let date = parseDate(row[m.date]);
      const desc = norm(row[m.desc]);
      if (!date || !desc || /^סה.?כ/.test(desc)) continue;

      let amount, income = false;
      if (m.debit >= 0 || m.credit >= 0) {
        const d = m.debit >= 0 ? Math.abs(parseNum(row[m.debit])) : NaN, c = m.credit >= 0 ? Math.abs(parseNum(row[m.credit])) : NaN;
        if (d > 0) amount = d; else if (c > 0) { amount = c; income = true; } else continue;
      } else {
        let v = parseNum(row[m.amount]);
        if ((!v || isNaN(v)) && m.amount2 >= 0) v = parseNum(row[m.amount2]);
        if (!v || isNaN(v)) continue;
        if (m.bank) { income = v > 0; amount = Math.abs(v); }
        else amount = v; // באשראי: מספר שלילי = זיכוי/החזר
      }

      const note = m.notes.map(i => norm(row[i])).filter(Boolean).join(' · ');
      const inst = note.match(/תשלום\s*(\d+)\s*(?:מתוך|מ-|\/)\s*(\d+)/);
      if (inst && m.chargeDate >= 0) date = parseDate(row[m.chargeDate]) || date;

      let cat = income ? 'income' : classify(desc, learned), refund = false;
      if (cat === 'other' && !income) cat = hintCat(row[m.hint]) || 'other';
      // 🔄 זיכוי מחנות (למשל "זיכוי שופרסל") — מינוס בקטגוריה של החנות
      if (income && REFUND_RE.test(desc)) {
        const c = classify(desc.replace(REFUND_RE, ' '), learned);
        if (c !== 'other' && c !== 'income' && CATS[c]) { income = false; amount = -amount; cat = c; refund = true; }
        // "זיכוי" / "ביטול עסקה" מחנות שלא זיהינו — עדיין זיכוי (מוריד הוצאות), לא הכנסה. "החזר" לבד (החזר מס) — נשאר הכנסה
        else if (/זיכוי|ביטול/.test(desc)) { income = false; amount = -amount; cat = 'other'; refund = true; }
      }
      if (amount < 0 && !income) refund = true; // באשראי: זיכוי
      items.push({ date, desc, amount: Math.round(amount * 100) / 100, income, cat, note, refund,
        ccCharge: kind === 'bank' && !income && !refund && CC_RE.test(desc), atm: !income && !refund && ATM_RE.test(desc),
        own: kind === 'bank' && OWN_RE.test(desc) });
    }
  }
  return { kind, items };
}

// ---------- צילום מסך: זיהוי טקסט בתמונה (OCR) בחינם ----------
let tessLoading;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  tessLoading ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    s.onload = () => res(window.Tesseract);
    s.onerror = () => { tessLoading = null; rej(Object.assign(new Error('offline'), { offline: true })); };
    document.head.appendChild(s);
  });
  return tessLoading;
}

const SKIP_LINE = /(יתרה|סה.?כ|מסגרת|ניצול|לתשלום|חיוב הבא|מועד חיוב|כרטיס מסתיים)/;
const AMOUNT_RE = /[-+]?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|[-+]?\d+\.\d{1,2}|[-+]?\d+/g;
const DATE_RE = /(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/;

export function parseOcrText(text, learned = {}) {
  const items = [];
  const now = new Date();
  let lastDate = null;
  const toDate = (d, m, y) => {
    let yy = y ? (y.length === 2 ? 2000 + +y : +y) : now.getFullYear();
    let dt = new Date(yy, m - 1, +d, 12);
    if (!y && dt > now) dt = new Date(yy - 1, m - 1, +d, 12);
    return dt.getMonth() === m - 1 ? dt : null;
  };
  for (let line of text.split('\n')) {
    line = line.replace(/[|_~«»•]/g, ' ').replace(/\s+/g, ' ').trim();
    if (line.length < 3) continue;
    let date = null;
    const dm = line.match(DATE_RE);
    if (dm && +dm[1] <= 31 && +dm[2] <= 12) { date = toDate(dm[1], dm[2], dm[3]); line = line.replace(dm[0], ' '); }
    const rest = line.replace(/[₪]|ש"ח|ש״ח|nis/gi, ' ');
    const nums = (rest.match(AMOUNT_RE) || []).map(n => ({ raw: n, v: parseFloat(n.replace(/,/g, '')) }));
    const desc = rest.replace(AMOUNT_RE, ' ').replace(/[^\p{L}\s'"&-]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!nums.length) { if (date) lastDate = date; continue; }
    if (SKIP_LINE.test(line)) { if (date) lastDate = date; continue; }
    // שורה של תאריך בלבד (מספר בודד בלי טקסט ובלי ₪/נקודה עשרונית) — לא תנועה
    if (!/\.\d|₪/.test(line) && desc.replace(/\s/g, '').length < 2) continue;
    // סכום: עדיף מספר עם נקודה עשרונית, אחרת האחרון
    const amt = nums.find(n => /\.\d/.test(n.raw)) || nums[nums.length - 1];
    if (!amt.v || Math.abs(amt.v) > 100000) continue;
    const income = amt.raw.startsWith('+') || isIncome(desc);
    let cat = income ? 'income' : classify(desc, learned);
    items.push({ date: date || lastDate || new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12),
      desc: desc.replace(/\s/g, '').length >= 3 ? desc : '', needsDesc: desc.replace(/\s/g, '').length < 3,
      amount: Math.round(Math.abs(amt.v) * 100) / 100 * (amt.raw.startsWith('-') && !income ? -1 : 1),
      income, cat, note: 'מצילום מסך', ccCharge: false, atm: !income && ATM_RE.test(desc) });
  }
  return items;
}

export async function readImage(file, onProgress, learned = {}) {
  const T = await loadTesseract();
  const worker = await T.createWorker(['heb', 'eng'], 1, {
    logger: m => { if (m.status === 'recognizing text') onProgress?.(Math.round(m.progress * 100)); },
  });
  try {
    const { data } = await worker.recognize(file);
    return { kind: 'image', items: parseOcrText(data.text, learned), text: data.text };
  } finally { await worker.terminate(); }
}

// 🏦 איזה בנק / חברת אשראי — לפי שם הקובץ ו-8 השורות הראשונות (לפני הטבלה). רק השם — בלי תוכן
const BANKS = [['לאומי קארד|max|מקס', 'מקס'], ['ישראכרט', 'ישראכרט'], ['אמריקן אקספרס|amex', 'אמריקן אקספרס'], ['כאל|cal\\b|visa cal', 'כאל'],
  ['הבינלאומי|fibi|beinleumi', 'הבינלאומי'], ['לאומי|leumi', 'לאומי'], ['הפועלים|poalim', 'הפועלים'], ['מרכנתיל|mercantile', 'מרכנתיל'], ['דיסקונט|discount', 'דיסקונט'],
  ['מזרחי|טפחות|mizrahi', 'מזרחי טפחות'], ['ירושלים|jerusalem', 'ירושלים'], ['וואן.?זירו|one.?zero', 'וואן זירו'],
  ['יהב|yahav', 'יהב'], ['אוצר החייל|otsar', 'אוצר החייל'], ['מסד|massad', 'מסד'], ['פאגי|pagi', 'פאגי']];
export const BANK_NAMES = BANKS.map(b => b[1]);
export function detectBank(sheets, fileName = '') {
  const rows = (sheets?.[0] || []).map(r => (Array.isArray(r) ? r : [r]).join(' '));
  // 1) "בנק יהב" שחוזר בכותרת / בתחתית כל עמוד — הכי אמין (תנועה בודדת כמו "העברה לבנק לאומי" לא מנצחת)
  const cnt = {};
  for (const t of rows) for (const [re, name] of BANKS.slice(4)) if (new RegExp('בנק\\s*(' + re + ')', 'i').test(t)) cnt[name] = (cnt[name] || 0) + 1;
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 2) return top[0];
  // 2) רק מה שמעל שורת הכותרות (לא שורות התנועות) + שם הקובץ
  let hi = rows.findIndex(t => /יתרה|תאריך/.test(t) && /סכום|חובה|זכות|תיאור|פרטים/.test(t)); if (hi < 0) hi = 8;
  const head = rows.slice(0, Math.min(hi, 8)).join(' ') + ' ' + fileName;
  const hit = BANKS.find(([re]) => new RegExp(re, 'i').test(head));
  return hit ? hit[1] : top ? top[0] : 'לא זוהה';
}
export const isSupported = name => /\.(xlsx|xls|csv|txt|pdf)$/i.test(name);
export const isImage = name => /\.(png|jpe?g|heic|webp)$/i.test(name);
export { CATS };
