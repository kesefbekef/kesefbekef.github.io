// הפקת קובץ אקסל חי: לשונית "הוצאות" (קטגוריה ברשימה נפתחת) + לשונית "סיכום" שמחושבת בנוסחאות מתוך ההוצאות
// משנים קטגוריה בלשונית ההוצאות — הסיכום מתעדכן לבד. גרפים אמיתיים של אקסל (פסי צבע בתא), לא תווים.
import { CATS, catOf } from './categories.js';
import { PAY } from './parse.js';

let loading;
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  loading ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/exceljs.min.js';
    s.onload = () => res(window.ExcelJS);
    s.onerror = () => rej(new Error('לא הצלחתי לטעון את יוצר האקסל'));
    document.head.appendChild(s);
  });
  return loading;
}

const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
export const KINDS = { day: 'יומי', week: 'שבועי', month: 'חודשי', year: 'שנתי', range: 'בין תאריכים' };
const d0 = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const fmtD = d => d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' });

export function periodRange(kind, anchor) {
  if (kind === 'range') {
    const start = d0(anchor.from), end = new Date(d0(anchor.to).getTime() + 864e5);
    return { start, end, label: `${fmtD(start)} – ${fmtD(anchor.to)}` };
  }
  const a = d0(anchor);
  if (kind === 'day') return { start: a, end: new Date(a.getTime() + 864e5), label: a.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) };
  if (kind === 'week') {
    const start = new Date(a); start.setDate(a.getDate() - a.getDay());
    const end = new Date(start); end.setDate(start.getDate() + 7);
    return { start, end, label: `שבוע ${fmtD(start)} – ${fmtD(new Date(end - 864e5))}` };
  }
  if (kind === 'year') return { start: new Date(a.getFullYear(), 0, 1), end: new Date(a.getFullYear() + 1, 0, 1), label: `שנת ${a.getFullYear()}` };
  return { start: new Date(a.getFullYear(), a.getMonth(), 1), end: new Date(a.getFullYear(), a.getMonth() + 1, 1), label: `${MONTHS[a.getMonth()]} ${a.getFullYear()}` };
}
export function shiftAnchor(kind, a, n) {
  const d = new Date(a);
  if (kind === 'day') d.setDate(d.getDate() + n);
  else if (kind === 'week') d.setDate(d.getDate() + 7 * n);
  else if (kind === 'year') d.setFullYear(d.getFullYear() + n);
  else d.setMonth(d.getMonth() + n);
  return d;
}
// תשלומים: כל תשלום נספר בחודש שלו
function occurrences(t) {
  const d = new Date(t.date);
  if (!(t.inst > 1)) return [{ t, date: d, amount: t.amount, k: 0 }];
  const out = [];
  for (let k = 0; k < t.inst; k++) out.push({ t, date: new Date(d.getFullYear(), d.getMonth() + k, d.getDate(), 12), amount: t.amount, k });
  return out;
}
export function collect(tx, start, end) {
  return tx.filter(t => !t.skip).flatMap(occurrences).filter(o => o.date >= start && o.date < end).sort((a, b) => a.date - b.date);
}
export function quickStats(tx, kind, anchor) {
  const { start, end, label } = periodRange(kind, anchor);
  const occ = collect(tx, start, end);
  const exp = occ.filter(o => o.t.cat !== 'income').reduce((s, o) => s + o.amount, 0);
  const inc = occ.filter(o => o.t.cat === 'income').reduce((s, o) => s + o.amount, 0);
  return { label, count: occ.length, n: occ.length, exp, inc };
}

// ---------- עיצוב ----------
const argb = hex => 'FF' + hex.slice(1).toUpperCase();
function tint(hex, a) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const m = c => Math.round(c + (255 - c) * (1 - a)).toString(16).padStart(2, '0');
  return '#' + m(r) + m(g) + m(b);
}
const fill = hex => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb(hex) } });
const FONT = 'Arial';
const NIS = '#,##0 "₪";[Red]-#,##0 "₪";""';     // שלילי באדום, אפס ריק
const PCT = '0%;-0%;""';
const thin = { style: 'thin', color: { argb: 'FFE5E7EB' } };
const box = { top: thin, bottom: thin, left: thin, right: thin };
const C = { purple: '#7C3AED', pink: '#EC4899', orange: '#F97316', green: '#16A34A', red: '#E11D48', teal: '#0D9488', blue: '#2563EB', dark: '#1F1B2E', soft: '#F7F5FF', yellow: '#FEF9C3' };
const white = { argb: 'FFFFFFFF' };

function band(ws, row, text, color, size, height, cols = 6) {
  ws.mergeCells(row, 1, row, cols);
  const c = ws.getCell(row, 1);
  c.value = text; c.fill = fill(color);
  c.font = { name: FONT, size, bold: true, color: white };
  c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  ws.getRow(row).height = height;
}
function section(ws, row, text, cols = 6) {
  ws.mergeCells(row, 1, row, cols);
  const c = ws.getCell(row, 1);
  c.value = text; c.font = { name: FONT, size: 14, bold: true, color: { argb: argb(C.purple) } };
  c.border = { bottom: { style: 'medium', color: { argb: argb(C.pink) } } };
  ws.getRow(row).height = 26;
}
function header(ws, row, titles) {
  titles.forEach((t, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = t; c.fill = fill(C.dark); c.border = box;
    c.font = { name: FONT, bold: true, color: white };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  ws.getRow(row).height = 24;
}
// שורה: ערכים (מחרוזת, מספר, או { f: נוסחה })
function cells(ws, row, values, { bg, fmts = [], bold = false, colors = [] } = {}) {
  values.forEach((v, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = v && typeof v === 'object' && v.f ? { formula: v.f } : v; c.border = box;
    if (bg) c.fill = fill(bg);
    if (fmts[i]) c.numFmt = fmts[i];
    c.font = { name: FONT, bold: bold || i === 0, color: colors[i] ? { argb: argb(colors[i]) } : undefined };
    c.alignment = { horizontal: i === 0 ? 'right' : 'center', vertical: 'middle' };
  });
  ws.getRow(row).height = 20;
}
// 📊 פס צבעוני אמיתי בתוך התא (גרף של אקסל), לפי הערך בתא
function dataBar(ws, ref, color) {
  ws.addConditionalFormatting({ ref, rules: [{ type: 'dataBar', priority: 1, cfvo: [{ type: 'num', value: 0 }, { type: 'max' }], color: { argb: argb(color) }, gradient: false }] });
}

// ---------- בניית הקובץ ----------
const SH_TX = 'הוצאות';
const q = s => `'${s}'`; // שם גיליון בנוסחה
const SRC = { text: 'צ׳אט', voice: 'הקלטה', file: 'קובץ מהבנק', plus: 'הוספה ידנית', recurring: 'קבוע', maaser: 'מעשר' };

export async function buildWorkbook({ tx, budgets, people = [], kind, anchor }) {
  const whoName = id => { const p = people.find(x => x.id === id); return p ? `${p.e} ${p.name}` : ''; };
  const ExcelJS = await loadExcelJS();
  const { start, end, label } = periodRange(kind, anchor);
  const occ = collect(tx, start, end);
  const days = Math.round((end - start) / 864e5);
  const factor = kind === 'year' ? 12 : kind === 'month' ? 1 : days / 30;
  const budgetOf = id => (budgets[id] ?? (budgets._mode === 'auto' ? (budgets._auto?.[id] ?? 0) : CATS[id]?.budget ?? 0)) * factor;
  const catIds = Object.keys(CATS), catName = id => `${CATS[id].e} ${CATS[id].n}`;
  const INC = '💰 הכנסה';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'כסף בכיף'; wb.created = new Date();
  wb.calcProperties = { fullCalcOnLoad: true }; // אקסל מחשב את הכל בפתיחה

  // ===== גיליון ההוצאות (מקור האמת — הסיכום מחושב ממנו) =====
  const wt = wb.addWorksheet(SH_TX, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  wt.columns = [
    { header: 'תאריך', key: 'date', width: 12 }, { header: 'מה', key: 'desc', width: 30 }, { header: 'קטגוריה ▾', key: 'cat', width: 22 },
    { header: 'סכום', key: 'amount', width: 13 }, { header: 'מי', key: 'who', width: 13 }, { header: 'איך שולם', key: 'pay', width: 15 }, { header: 'הערה', key: 'note', width: 34 },
  ];
  wt.getRow(1).eachCell(c => { c.fill = fill(C.purple); c.font = { name: FONT, bold: true, color: white }; c.alignment = { horizontal: 'center', vertical: 'middle' }; c.border = box; });
  wt.getRow(1).height = 26;
  const catFill = {}; for (const id of catIds) catFill[catName(id)] = tint(CATS[id].c, .22);
  occ.forEach((o, i) => {
    const t = o.t, income = t.cat === 'income';
    const note = [t.inst > 1 ? `תשלום ${o.k + 1} מתוך ${t.inst} (סה״כ ${Math.round(t.total)} ₪)` : '', o.amount < 0 ? 'זיכוי / החזר' : '', (t.tags || []).map(g => '#' + g).join(' '), t.note || '', t.source && SRC[t.source] && t.source !== 'text' ? SRC[t.source] : ''].filter(Boolean).join(' · ');
    const row = wt.addRow({ date: new Date(Date.UTC(o.date.getFullYear(), o.date.getMonth(), o.date.getDate())), desc: t.desc, cat: income ? INC : catName(t.cat),
      amount: o.amount, who: whoName(t.who), pay: t.pay ? `${PAY[t.pay].e} ${PAY[t.pay].n}` : '', note });
    row.eachCell({ includeEmpty: true }, c => { c.font = { name: FONT, color: income ? { argb: argb(C.green) } : undefined, bold: income }; c.fill = fill(i % 2 ? '#FFFFFF' : C.soft); c.border = box; c.alignment = { vertical: 'middle' }; });
    row.getCell('date').numFmt = 'dd/mm/yyyy'; row.getCell('date').alignment = { horizontal: 'center' };
    row.getCell('amount').numFmt = NIS; row.getCell('amount').alignment = { horizontal: 'center' };
    row.getCell('cat').alignment = { horizontal: 'right' };
  });
  const last = Math.max(2, wt.rowCount), DATA_ROWS = last + 200; // מקום ל-200 שורות שהמשתמש יוסיף בעצמו
  // 🎨 צבע הקטגוריה מתעדכן כשמשנים אותה (עיצוב מותנה — לא צבע קבוע)
  catIds.forEach((id, k) => wt.addConditionalFormatting({ ref: `C2:C${DATA_ROWS}`, rules: [{ type: 'containsText', operator: 'containsText', text: CATS[id].n, priority: k + 1, style: { fill: fill(catFill[catName(id)]) } }] }));
  wt.addConditionalFormatting({ ref: `C2:C${DATA_ROWS}`, rules: [{ type: 'containsText', operator: 'containsText', text: 'הכנסה', priority: catIds.length + 1, style: { fill: fill(tint(C.green, .22)), font: { bold: true, color: { argb: argb(C.green) } } } }] });
  // ▾ רשימה נפתחת של קטגוריות — אי אפשר להקליד שם שגוי
  const LIST = 'רשימות';
  const wl = wb.addWorksheet(LIST, { state: 'veryHidden' });
  [...catIds.map(catName), INC].forEach((n, i) => { wl.getCell(i + 1, 1).value = n; });
  const listRef = `${q(LIST)}!$A$1:$A$${catIds.length + 1}`;
  for (let r = 2; r <= DATA_ROWS; r++) wt.getCell(r, 3).dataValidation = { type: 'list', allowBlank: true, formulae: [listRef], showErrorMessage: true, errorTitle: 'קטגוריה', error: 'בוחרים מהרשימה (החץ ▾ ליד התא)' };
  wt.autoFilter = { from: 'A1', to: `G${last}` };
  // טווחי הנוסחאות (כולל שורות שיתווספו)
  const R_CAT = `${q(SH_TX)}!$C$2:$C$${DATA_ROWS}`, R_AMT = `${q(SH_TX)}!$D$2:$D$${DATA_ROWS}`, R_WHO = `${q(SH_TX)}!$E$2:$E$${DATA_ROWS}`, R_PAY = `${q(SH_TX)}!$F$2:$F$${DATA_ROWS}`;
  const sumCat = name => `SUMIF(${R_CAT},"${name}",${R_AMT})`;
  const F_EXP = `SUMIF(${R_CAT},"<>${INC}",${R_AMT})`, F_INC = sumCat(INC), F_N = `COUNTA(${R_AMT})`;

  // ===== גיליון הסיכום (הכל נוסחאות) =====
  const ws = wb.addWorksheet('סיכום', { views: [{ rightToLeft: true, showGridLines: false }] });
  ws.columns = [{ width: 28 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 24 }, { width: 6 }];
  band(ws, 1, `💰 כסף בכיף — סיכום ${KINDS[kind]}`, C.purple, 20, 42);
  band(ws, 2, label, C.pink, 14, 26);
  band(ws, 3, `✏️ משנים קטגוריה בלשונית "${SH_TX}" (חץ ▾ ליד התא) — והסיכום כאן מתעדכן לבד`, C.orange, 11, 22);

  let r = 5;
  const kpis = [['הכנסות', { f: F_INC }, C.green, NIS], ['הוצאות', { f: F_EXP }, C.red, NIS], ['נשאר', { f: `${F_INC}-${F_EXP}` }, C.purple, NIS], ['חיסכון', { f: `IF(${F_INC}=0,0,(${F_INC}-${F_EXP})/${F_INC})` }, C.teal, PCT], ['תנועות', { f: F_N }, C.blue, '0']];
  kpis.forEach(([t, v, col, f], i) => {
    const h = ws.getCell(r, i + 1), c = ws.getCell(r + 1, i + 1);
    h.value = t; h.fill = fill(col); h.font = { name: FONT, bold: true, color: white }; h.alignment = { horizontal: 'center' };
    c.value = { formula: v.f }; c.numFmt = f; c.fill = fill(tint(col, .15)); c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.font = { name: FONT, size: 16, bold: true, color: { argb: argb(col) } };
  });
  ws.getRow(r).height = 22; ws.getRow(r + 1).height = 34;
  r += 3;

  // לפי קטגוריות — ממוין לפי ההוצאה בפועל עכשיו; הסכומים עצמם נוסחאות
  section(ws, r++, '🎯 לפי קטגוריות');
  header(ws, r++, ['קטגוריה', 'הוצאה', 'תקציב', 'מהתקציב', 'חלק מההוצאות']);
  const totalRow = r + catIds.length;
  const byNow = catIds.map(id => ({ id, v: occ.filter(o => o.t.cat === id).reduce((s, o) => s + o.amount, 0) })).sort((a, b) => b.v - a.v);
  const catStart = r;
  for (const { id } of byNow) {
    const b = budgetOf(id), c = CATS[id];
    cells(ws, r, [catName(id), { f: sumCat(catName(id)) }, b || null, b ? { f: `IF(C${r}=0,"",B${r}/C${r})` } : null, { f: `IF($B$${totalRow}=0,0,B${r}/$B$${totalRow})` }],
      { bg: tint(c.c, .14), fmts: [null, NIS, NIS, PCT, PCT] });
    r++;
  }
  cells(ws, r, ['סה״כ', { f: `SUM(B${catStart}:B${r - 1})` }, { f: `SUM(C${catStart}:C${r - 1})` }, null, null], { bg: '#E9E5FF', fmts: [null, NIS, NIS], bold: true });
  dataBar(ws, `E${catStart}:E${r - 1}`, C.pink);
  // 🚨 מעל התקציב — אדום
  ws.addConditionalFormatting({ ref: `D${catStart}:D${r - 1}`, rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: ['1'], priority: 1, style: { font: { bold: true, color: { argb: argb(C.red) } }, fill: fill('#FEE2E2') } }] });
  r += 2;

  // איך שילמנו
  const pays = [...new Set(occ.filter(o => o.t.cat !== 'income' && o.t.pay).map(o => o.t.pay))];
  if (pays.length) {
    section(ws, r++, '👛 איך שילמנו');
    header(ws, r++, ['אמצעי תשלום', 'סכום', 'חלק מההוצאות']);
    const PC = { credit: C.blue, cash: C.green, transfer: C.teal, bit: C.pink, standing: C.purple, check: C.orange };
    const p0 = r;
    for (const k of pays) {
      const nm = `${PAY[k].e} ${PAY[k].n}`;
      cells(ws, r, [nm, { f: `SUMIFS(${R_AMT},${R_PAY},"${nm}",${R_CAT},"<>${INC}")` }, { f: `IF($B$${totalRow}=0,0,B${r}/$B$${totalRow})` }], { bg: tint(PC[k] || C.purple, .12), fmts: [null, NIS, PCT] });
      r++;
    }
    dataBar(ws, `C${p0}:C${r - 1}`, C.blue);
    r++;
  }

  // לפי בני הבית
  const whos = [...new Set(occ.map(o => o.t.who).filter(id => id && people.find(p => p.id === id)))];
  if (whos.length) {
    section(ws, r++, '👨‍👩‍👧 לפי בני הבית');
    header(ws, r++, ['מי', 'הוצאות', 'הכנסות', 'חלק מההוצאות']);
    const WC = ['#3B82F6', '#EC4899', '#F59E0B', '#A855F7', '#14B8A6', '#F43F5E'], w0 = r;
    whos.forEach((id, i) => {
      const nm = whoName(id);
      cells(ws, r, [nm, { f: `SUMIFS(${R_AMT},${R_WHO},"${nm}",${R_CAT},"<>${INC}")` }, { f: `SUMIFS(${R_AMT},${R_WHO},"${nm}",${R_CAT},"${INC}")` }, { f: `IF($B$${totalRow}=0,0,B${r}/$B$${totalRow})` }],
        { bg: tint(WC[i % WC.length], .12), fmts: [null, NIS, NIS, PCT], colors: [null, null, C.green] });
      r++;
    });
    dataBar(ws, `D${w0}:D${r - 1}`, C.purple);
    r++;
  }

  // 🏷️ אירועים (תגיות) — מהשורות עצמן (ההערה)
  const tags = [...new Set(occ.flatMap(o => o.t.tags || []))];
  if (tags.length) {
    section(ws, r++, '🏷️ לפי אירועים');
    header(ws, r++, ['אירוע', 'הוצאות']);
    const R_NOTE = `${q(SH_TX)}!$G$2:$G$${DATA_ROWS}`;
    for (const g of tags) { cells(ws, r, ['#' + g, { f: `SUMIFS(${R_AMT},${R_NOTE},"*#${g}*",${R_CAT},"<>${INC}")` }], { bg: tint(C.purple, .1), fmts: [null, NIS] }); r++; }
    r++;
  }

  // לפי זמן — רק כשזה נותן תמונה: שנה/טווח ארוך = חודשים; חודש = שבועות (לא 31 שורות של ימים)
  const R_DATE = `${q(SH_TX)}!$A$2:$A$${DATA_ROWS}`;
  const xl = d => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 864e5); // מספר התאריך של אקסל
  const between = (a, b) => `${R_DATE},">="&${xl(a)},${R_DATE},"<"&${xl(b)}`;
  if (kind === 'year' || (kind === 'range' && days > 62)) {
    section(ws, r++, '📅 לפי חודשים');
    header(ws, r++, ['חודש', 'הכנסות', 'הוצאות', 'נשאר']);
    const m0 = r;
    for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d < end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const nx = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      cells(ws, r, [`${MONTHS[d.getMonth()]} ${d.getFullYear()}`, { f: `SUMIFS(${R_AMT},${R_CAT},"${INC}",${between(d, nx)})` }, { f: `SUMIFS(${R_AMT},${R_CAT},"<>${INC}",${between(d, nx)})` }, { f: `B${r}-C${r}` }],
        { bg: (r - m0) % 2 ? '#FFFFFF' : C.soft, fmts: [null, NIS, NIS, NIS], colors: [null, C.green, C.red] });
      r++;
    }
    dataBar(ws, `C${m0}:C${r - 1}`, C.pink); r++;
  } else if (days >= 14) {
    section(ws, r++, '📆 לפי שבועות');
    header(ws, r++, ['שבוע', 'הוצאות', 'הכנסות']);
    const w0 = r;
    for (let d = new Date(start); d < end; d = new Date(d.getTime() + 7 * 864e5)) {
      const nx = new Date(Math.min(d.getTime() + 7 * 864e5, end.getTime()));
      cells(ws, r, [`${fmtD(d)} – ${fmtD(new Date(nx - 864e5))}`, { f: `SUMIFS(${R_AMT},${R_CAT},"<>${INC}",${between(d, nx)})` }, { f: `SUMIFS(${R_AMT},${R_CAT},"${INC}",${between(d, nx)})` }],
        { bg: (r - w0) % 2 ? '#FFFFFF' : C.soft, fmts: [null, NIS, NIS], colors: [null, C.red, C.green] });
      r++;
    }
    dataBar(ws, `B${w0}:B${r - 1}`, C.pink); r++;
  }

  // 💡 תובנות — גם הן נוסחאות, כדי שישתנו עם הנתונים
  section(ws, r++, '💡 תובנות');
  const tip = (f) => { ws.mergeCells(r, 1, r, 5); const c = ws.getCell(r, 1); c.value = { formula: f }; c.fill = fill(C.yellow); c.font = { name: FONT, size: 11 }; c.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true }; ws.getRow(r).height = 22; r++; };
  tip(`IF(B${totalRow}=0,"• אין הוצאות בתקופה הזו.","• ההוצאה הגדולה: "&INDEX(A${catStart}:A${totalRow - 1},MATCH(MAX(B${catStart}:B${totalRow - 1}),B${catStart}:B${totalRow - 1},0))&" — "&TEXT(MAX(B${catStart}:B${totalRow - 1})/B${totalRow},"0%")&" מההוצאות.")`);
  tip(`IF(B6=0,"• עוד לא נרשמו הכנסות.",IF(B6>=B7,"• 🏆 נשארו "&TEXT(B6-B7,"#,##0")&" ₪ מההכנסות ("&TEXT((B6-B7)/B6,"0%")&").","• 📉 ההוצאות גבוהות מההכנסות ב-"&TEXT(B7-B6,"#,##0")&" ₪."))`);
  tip(`IF(COUNTIF(D${catStart}:D${totalRow - 1},">1")=0,"• ✅ אף קטגוריה לא עברה את התקציב.","• 🚨 "&COUNTIF(D${catStart}:D${totalRow - 1},">1")&" קטגוריות עברו את התקציב (מסומנות באדום למעלה).")`);
  ws.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  // ===== איך משתמשים =====
  const wh = wb.addWorksheet('איך משתמשים', { views: [{ rightToLeft: true, showGridLines: false }] });
  wh.columns = [{ width: 90 }];
  const lines = [
    ['💰 כסף בכיף — איך משתמשים בקובץ הזה', C.purple, 18, true],
    ['', null], ['📋 לשונית "הוצאות"', C.pink, 14, true],
    ['כל שורה היא הוצאה או הכנסה אחת. אפשר לשנות כל דבר: שם, סכום, מי, איך שולם.', null],
    ['▾ קטגוריה: לוחצים על התא ← חץ קטן ← בוחרים מהרשימה. אי אפשר להקליד שם שלא ברשימה.', null],
    ['➕ אפשר להוסיף שורות חדשות מתחת לאחרונות — הן ייכנסו לסיכום לבד.', null],
    ['', null], ['📊 לשונית "סיכום"', C.pink, 14, true],
    ['כל המספרים שם מחושבים מלשונית ההוצאות. שיניתם קטגוריה? הסיכום מתעדכן ברגע.', null],
    ['הפסים הצבעוניים הם גרפים: פס ארוך = חלק גדול מההוצאות.', null],
    ['אדום בעמודת "מהתקציב" = הקטגוריה עברה את התקציב שלה.', null],
    ['', null], ['💡 טיפים', C.pink, 14, true],
    ['הקובץ עובד באקסל, בגוגל שיטס ובנומברס. אם המספרים לא מתעדכנים — לחצו F9 (באקסל) או שמרו ופתחו מחדש.', null],
    ['שינוי בקובץ לא משפיע על האפליקציה. כדי לשנות באפליקציה — נוגעים בהוצאה בצ\'אט או בלשונית התנועות.', null],
    ['רוצים ניתוח? העלו את הקובץ ל-Claude וכתבו: "נתח את ההוצאות והצע איפה אפשר לחסוך".', null],
  ];
  lines.forEach(([t, col, size, bold], i) => { const c = wh.getCell(i + 1, 1); c.value = t; c.font = { name: FONT, size: size || 12, bold: !!bold, color: col ? { argb: argb(col) } : undefined }; c.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true }; wh.getRow(i + 1).height = size ? 30 : 22; });

  const buf = await wb.xlsx.writeBuffer();
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const tag = kind === 'range' ? `${iso(start)}_${iso(new Date(end - 864e5))}` : kind === 'year' ? start.getFullYear() : kind === 'month' ? `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}` : iso(start);
  return { blob: new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name: `כסף-בכיף-${KINDS[kind]}-${tag}.xlsx` };
}
