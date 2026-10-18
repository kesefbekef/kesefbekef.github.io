// הפקת קובץ אקסל צבעוני: סיכום יומי / שבועי / חודשי / שנתי + טבלת תנועות נקייה
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
const dm = d => `${d.getDate()}.${d.getMonth() + 1}`;

// ---------- טווח תאריכים ----------
// ב-'range' העוגן הוא { from, to }
export function periodRange(kind, anchor) {
  if (kind === 'range') {
    const f = anchor.from, t = anchor.to;
    const start = new Date(f.getFullYear(), f.getMonth(), f.getDate()), end = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
    return { start, end, label: `${f.toLocaleDateString('he-IL')} – ${t.toLocaleDateString('he-IL')}` };
  }
  const y = anchor.getFullYear(), m = anchor.getMonth(), d = anchor.getDate();
  let start, end, label;
  if (kind === 'day') {
    start = new Date(y, m, d); end = new Date(y, m, d + 1);
    label = start.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } else if (kind === 'week') {
    start = new Date(y, m, d - anchor.getDay()); end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    const last = new Date(end - 864e5);
    label = `שבוע ${dm(start)}–${dm(last)}.${last.getFullYear()}`;
  } else if (kind === 'year') {
    start = new Date(y, 0, 1); end = new Date(y + 1, 0, 1); label = `שנת ${y}`;
  } else {
    start = new Date(y, m, 1); end = new Date(y, m + 1, 1); label = `${MONTHS[m]} ${y}`;
  }
  return { start, end, label };
}

export function shiftAnchor(kind, a, n) {
  if (kind === 'day') return new Date(a.getFullYear(), a.getMonth(), a.getDate() + n);
  if (kind === 'week') return new Date(a.getFullYear(), a.getMonth(), a.getDate() + 7 * n);
  if (kind === 'year') return new Date(a.getFullYear() + n, a.getMonth(), 1);
  return new Date(a.getFullYear(), a.getMonth() + n, 1);
}

// כל "מופע" של תנועה — קנייה בתשלומים מופיעה פעם בכל חודש
function occurrences(t) {
  const b = new Date(t.date);
  if (!(t.inst > 1)) return [{ t, date: b, amount: t.amount, k: 0 }];
  return Array.from({ length: t.inst }, (_, k) => {
    const last = new Date(b.getFullYear(), b.getMonth() + k + 1, 0).getDate();
    return { t, date: new Date(b.getFullYear(), b.getMonth() + k, Math.min(b.getDate(), last), 12), amount: t.amount, k };
  });
}

export function collect(tx, start, end) {
  return tx.flatMap(occurrences).filter(o => o.date >= start && o.date < end).sort((a, b) => a.date - b.date);
}

export function quickStats(tx, kind, anchor) {
  const { start, end, label } = periodRange(kind, anchor);
  const occ = collect(tx, start, end);
  const inc = occ.filter(o => o.t.cat === 'income').reduce((s, o) => s + o.amount, 0);
  const exp = occ.filter(o => o.t.cat !== 'income').reduce((s, o) => s + o.amount, 0);
  return { label, count: occ.length, inc, exp };
}

// ---------- עיצוב ----------
const argb = hex => 'FF' + hex.replace('#', '').toUpperCase();
function tint(hex, a) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const m = c => Math.round(c + (255 - c) * (1 - a)).toString(16).padStart(2, '0');
  return '#' + m(r) + m(g) + m(b);
}
const fill = hex => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb(hex) } });
const FONT = 'Arial';
const NIS = '#,##0.00 "₪"';
const NIS0 = '#,##0 "₪"';
const PCT = '0%';
const thin = { style: 'thin', color: { argb: 'FFE5E7EB' } };
const box = { top: thin, bottom: thin, left: thin, right: thin };
const C = { purple: '#7C3AED', pink: '#EC4899', orange: '#F97316', green: '#16A34A', red: '#E11D48', teal: '#0D9488', blue: '#2563EB', dark: '#1F1B2E', soft: '#F7F5FF', yellow: '#FEF9C3' };

function band(ws, row, text, color, size, height) {
  ws.mergeCells(row, 1, row, 6);
  const c = ws.getCell(row, 1);
  c.value = text; c.fill = fill(color);
  c.font = { name: FONT, size, bold: true, color: { argb: 'FFFFFFFF' } };
  c.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(row).height = height;
}
function section(ws, row, text) {
  ws.mergeCells(row, 1, row, 6);
  const c = ws.getCell(row, 1);
  c.value = text; c.font = { name: FONT, size: 14, bold: true, color: { argb: argb(C.purple) } };
  c.border = { bottom: { style: 'medium', color: { argb: argb(C.pink) } } };
  ws.getRow(row).height = 26;
}
function header(ws, row, titles) {
  titles.forEach((t, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = t; c.fill = fill(C.dark); c.border = box;
    c.font = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  ws.getRow(row).height = 22;
}
function cells(ws, row, values, { bg, fmts = [], bold = false, colors = [] } = {}) {
  values.forEach((v, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = v; c.border = box;
    if (bg) c.fill = fill(bg);
    if (fmts[i]) c.numFmt = fmts[i];
    c.font = { name: FONT, bold: bold || i === 0, color: colors[i] ? { argb: argb(colors[i]) } : undefined };
    c.alignment = { horizontal: i === 0 ? 'right' : 'center', vertical: 'middle' };
  });
  ws.getRow(row).height = 20;
}
const bar = (share, n = 20) => share > 0 ? '█'.repeat(Math.max(1, Math.round(share * n))) : '';

// ---------- בניית הקובץ ----------
export async function buildWorkbook({ tx, budgets, people = [], kind, anchor }) {
  const whoName = id => { const p = people.find(x => x.id === id); return p ? `${p.e} ${p.name}` : ''; };
  const ExcelJS = await loadExcelJS();
  const { start, end, label } = periodRange(kind, anchor);
  const occ = collect(tx, start, end);
  const exp = occ.filter(o => o.t.cat !== 'income'), incs = occ.filter(o => o.t.cat === 'income');
  const totalExp = exp.reduce((s, o) => s + o.amount, 0), totalInc = incs.reduce((s, o) => s + o.amount, 0);
  const days = Math.round((end - start) / 864e5);
  const factor = kind === 'year' ? 12 : kind === 'month' ? 1 : days / 30;
  const budgetOf = id => (budgets[id] ?? CATS[id].budget) * factor;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'כסף בכיף'; wb.created = new Date();

  // ===== גיליון 1: סיכום =====
  const ws = wb.addWorksheet('סיכום', { views: [{ rightToLeft: true, showGridLines: false }] });
  ws.columns = [{ width: 26 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 26 }];
  band(ws, 1, `💰 כסף בכיף — סיכום ${KINDS[kind]}`, C.purple, 20, 42);
  band(ws, 2, label, C.pink, 14, 26);
  band(ws, 3, `הופק ב-${new Date().toLocaleDateString('he-IL')} · ${occ.length} תנועות`, C.orange, 10, 18);

  let r = 5;
  const kpis = [['הכנסות', totalInc, C.green, NIS0], ['הוצאות', totalExp, C.red, NIS0], ['יתרה', totalInc - totalExp, C.purple, NIS0],
    ['חיסכון', totalInc ? (totalInc - totalExp) / totalInc : 0, C.teal, PCT], ['תנועות', occ.length, C.blue, '0']];
  kpis.forEach(([t, v, col, f], i) => {
    const h = ws.getCell(r, i + 1), c = ws.getCell(r + 1, i + 1);
    h.value = t; h.fill = fill(col); h.font = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' } }; h.alignment = { horizontal: 'center' };
    c.value = v; c.numFmt = f; c.fill = fill(tint(col, .15)); c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.font = { name: FONT, size: 16, bold: true, color: { argb: argb(col) } };
  });
  ws.getRow(r).height = 22; ws.getRow(r + 1).height = 34;
  r += 3;

  // לפי קטגוריות
  section(ws, r++, '🎯 לפי קטגוריות');
  header(ws, r++, ['קטגוריה', 'הוצאה', 'תקציב', '% מהתקציב', '% מההוצאות', 'גרף']);
  const byCat = Object.keys(CATS).map(id => ({ id, v: exp.filter(o => o.t.cat === id).reduce((s, o) => s + o.amount, 0) }))
    .sort((a, b) => b.v - a.v);
  for (const { id, v } of byCat) {
    const c = CATS[id], b = budgetOf(id), share = totalExp ? v / totalExp : 0, used = b ? v / b : 0;
    cells(ws, r, [`${c.e} ${c.n}`, v, b, used, share, bar(share)],
      { bg: tint(c.c, v ? .2 : .07), fmts: [null, NIS, NIS0, PCT, PCT], colors: [null, null, null, used > 1 ? C.red : null, null, c.c] });
    r++;
  }
  cells(ws, r++, ['סה״כ', totalExp, Object.keys(CATS).reduce((s, id) => s + budgetOf(id), 0), null, totalExp ? 1 : 0, ''],
    { bg: '#E9E5FF', fmts: [null, NIS, NIS0, null, PCT], bold: true });
  r++;

  // לפי אמצעי תשלום
  const byPay = {};
  for (const o of exp) { const k = o.t.pay || 'none'; byPay[k] = (byPay[k] || 0) + o.amount; }
  const pays = Object.entries(byPay).sort((a, b) => b[1] - a[1]);
  if (pays.length) {
    section(ws, r++, '👛 איך שילמנו');
    header(ws, r++, ['אמצעי תשלום', 'סכום', '% מההוצאות', '', '', 'גרף']);
    const PC = { credit: C.blue, cash: C.green, transfer: C.teal, bit: C.pink, standing: C.purple, check: C.orange, none: '#94A3B8' };
    for (const [k, v] of pays) {
      const p = k === 'none' ? { e: '❔', n: 'לא צוין' } : PAY[k];
      cells(ws, r++, [`${p.e} ${p.n}`, v, totalExp ? v / totalExp : 0, '', '', bar(totalExp ? v / totalExp : 0)],
        { bg: tint(PC[k], .15), fmts: [null, NIS, PCT], colors: [null, null, null, null, null, PC[k]] });
    }
    r++;
  }

  // לפי בני הבית
  if (people.length) {
    const byWho = {};
    for (const o of occ) { const k = o.t.who || 'none'; byWho[k] ??= { inc: 0, ex: 0 }; byWho[k][o.t.cat === 'income' ? 'inc' : 'ex'] += o.amount; }
    const rows = Object.entries(byWho).sort((a, b) => b[1].ex - a[1].ex);
    if (rows.length) {
      section(ws, r++, '👨‍👩‍👧 לפי בני הבית');
      header(ws, r++, ['מי', 'הוצאות', 'הכנסות', '% מההוצאות', '', 'גרף']);
      const WC = ['#3B82F6', '#EC4899', '#F59E0B', '#A855F7', '#14B8A6', '#F43F5E'];
      rows.forEach(([k, v], i) => {
        const col = k === 'none' ? '#94A3B8' : WC[i % WC.length], share = totalExp ? v.ex / totalExp : 0;
        cells(ws, r++, [k === 'none' ? '❔ לא צוין' : whoName(k), v.ex, v.inc || null, share, '', bar(share)],
          { bg: tint(col, .15), fmts: [null, NIS, NIS, PCT], colors: [null, null, C.green, null, null, col] });
      });
      r++;
    }
  }

  // פירוט לפי זמן: שנה → חודשים, חודש/שבוע → ימים
  const byMonths = kind === 'year' || (kind === 'range' && days > 62);
  if (byMonths) {
    section(ws, r++, '📅 לפי חודשים');
    header(ws, r++, ['חודש', 'הכנסות', 'הוצאות', 'יתרה', '', 'גרף הוצאות']);
    const months = [];
    for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d < end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const inM = o => o.date.getMonth() === d.getMonth() && o.date.getFullYear() === d.getFullYear();
      months.push({ n: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, inc: incs.filter(inM).reduce((s, o) => s + o.amount, 0), ex: exp.filter(inM).reduce((s, o) => s + o.amount, 0) });
    }
    const maxEx = Math.max(1, ...months.map(m => m.ex));
    months.forEach((m, i) => cells(ws, r++, [m.n, m.inc, m.ex, m.inc - m.ex, '', bar(m.ex / maxEx, 16)],
      { bg: i % 2 ? '#FFFFFF' : C.soft, fmts: [null, NIS0, NIS0, NIS0], colors: [null, C.green, C.red, m.inc - m.ex >= 0 ? C.green : C.red, null, C.pink] }));
    r++;
  } else if (days > 1) {
    section(ws, r++, '📆 לפי ימים');
    header(ws, r++, ['יום', 'הוצאות', 'הכנסות', 'תנועות', '', 'גרף הוצאות']);
    const list = [];
    for (let d = new Date(start); d < end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      const same = o => o.date.getFullYear() === d.getFullYear() && o.date.getMonth() === d.getMonth() && o.date.getDate() === d.getDate();
      list.push({ d, ex: exp.filter(same).reduce((s, o) => s + o.amount, 0), inc: incs.filter(same).reduce((s, o) => s + o.amount, 0), n: occ.filter(same).length });
    }
    const maxEx = Math.max(1, ...list.map(x => x.ex));
    list.forEach((x, i) => cells(ws, r++, [x.d.toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' }), x.ex || null, x.inc || null, x.n || null, '', bar(x.ex / maxEx, 16)],
      { bg: x.d.getDay() === 6 ? '#EDE9FE' : i % 2 ? '#FFFFFF' : C.soft, fmts: [null, NIS0, NIS0, '0'], colors: [null, C.red, C.green, null, null, C.pink] }));
    r++;
  }

  // תובנות
  section(ws, r++, '💡 תובנות');
  const tips = [];
  if (!occ.length) tips.push('אין תנועות בתקופה הזו.');
  const top = byCat.filter(x => x.v > 0);
  if (top[0]) tips.push(`ההוצאה הגדולה: ${CATS[top[0].id].e} ${CATS[top[0].id].n} — ${Math.round(top[0].v / totalExp * 100)}% מכלל ההוצאות.`);
  for (const { id, v } of top) if (v > budgetOf(id)) tips.push(`🚨 ${CATS[id].n} עבר את התקציב ב-${Math.round((v / budgetOf(id) - 1) * 100)}%.`);
  if (totalInc) tips.push(totalInc >= totalExp ? `🏆 נחסכו ${Math.round((totalInc - totalExp) / totalInc * 100)}% מההכנסות.` : `📉 ההוצאות גבוהות מההכנסות ב-${Math.round(totalExp - totalInc).toLocaleString('he-IL')} ₪.`);
  if (byPay.cash) tips.push(`💵 במזומן יצאו ${Math.round(byPay.cash).toLocaleString('he-IL')} ₪.`);
  if (byPay.none) tips.push(`❔ ב-${Math.round(byPay.none).toLocaleString('he-IL')} ₪ לא צוין אמצעי תשלום.`);
  tips.push('🤖 רוצה ניתוח מעמיק? העלה את הקובץ הזה ל-Claude וכתוב: "נתח את ההוצאות שלי והצע איפה אפשר לחסוך".');
  for (const t of tips) {
    ws.mergeCells(r, 1, r, 6);
    const c = ws.getCell(r, 1);
    c.value = '• ' + t; c.fill = fill(C.yellow); c.font = { name: FONT, size: 11 };
    c.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
    ws.getRow(r).height = 22; r++;
  }

  // ===== גיליון 2: תנועות (טבלה נקייה, טובה גם לניתוח AI) =====
  const wt = wb.addWorksheet('תנועות', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  wt.columns = [
    { header: 'תאריך', key: 'date', width: 12 }, { header: 'תיאור', key: 'desc', width: 26 }, { header: 'מה נכתב במקור', key: 'raw', width: 34 },
    { header: 'קטגוריה', key: 'cat', width: 20 }, { header: 'סכום', key: 'amount', width: 14 },
    { header: 'סוג', key: 'type', width: 10 }, { header: 'אמצעי תשלום', key: 'pay', width: 16 },
    { header: 'מי', key: 'who', width: 14 }, { header: 'מקור', key: 'src', width: 10 }, { header: 'הערות', key: 'note', width: 30 },
  ];
  wt.getRow(1).eachCell(c => {
    c.fill = fill(C.purple); c.font = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' }; c.border = box;
  });
  wt.getRow(1).height = 24;
  const SRC = { text: 'צ׳אט', voice: 'הקלטה', file: 'קובץ' };
  occ.forEach((o, i) => {
    const t = o.t, c = catOf(t.cat), income = t.cat === 'income';
    const notes = [t.inst > 1 ? `תשלום ${o.k + 1}/${t.inst} מתוך ${t.total} ₪` : '', t.note || ''].filter(Boolean).join(' · ');
    const row = wt.addRow({ date: new Date(Date.UTC(o.date.getFullYear(), o.date.getMonth(), o.date.getDate())), desc: t.desc,
      raw: t.source === 'file' ? `📄 ${t.raw || ''}` : (t.raw || ''), cat: `${c.e} ${c.n}`,
      amount: o.amount, type: income ? 'הכנסה' : o.amount < 0 ? 'זיכוי' : 'הוצאה',
      pay: t.pay ? `${PAY[t.pay].e} ${PAY[t.pay].n}` : '', who: whoName(t.who), src: SRC[t.source] || '', note: notes });
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font = { name: FONT, color: income ? { argb: argb(C.green) } : undefined, bold: income };
      cell.fill = fill(i % 2 ? '#FFFFFF' : C.soft); cell.border = box; cell.alignment = { vertical: 'middle' };
    });
    row.getCell('date').numFmt = 'dd/mm/yyyy';
    row.getCell('amount').numFmt = NIS;
    row.getCell('cat').fill = fill(tint(c.c, .22));
  });
  wt.autoFilter = { from: 'A1', to: 'J1' };

  const buf = await wb.xlsx.writeBuffer();
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const tag = kind === 'range' ? `${iso(start)}_${iso(new Date(end - 864e5))}` : kind === 'year' ? start.getFullYear() : kind === 'month' ? `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`
    : `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  return {
    blob: new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    name: `כסף-בכיף-סיכום-${KINDS[kind]}-${tag}.xlsx`,
  };
}
