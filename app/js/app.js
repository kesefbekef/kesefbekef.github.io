import { CATS, classify, isIncome, catOf, applyCustomCats, isBaseCat, CAT_COLORS, CAT_EMOJIS } from './categories.js';
import { parseMessage, stripVav, detectPay, PAY, takeTags, cleanTag } from './parse.js';
import * as db from './db.js';
import * as imp from './importer.js';
import * as xp from './exporter.js';
import * as sync from './sync.js';
import * as lock from './lock.js';
import * as help from './help.js';
import { demoData } from './demo-data.js';
import { fixedPayments, dueMonths, nextRuleDate } from './fixed.js';
import { NEWS } from './whats-new.js';
import { REVIEW } from './review.js';

// ---------- עזרים ----------
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Math.round(n).toLocaleString('he-IL') + '₪';
// 🎬 מספר "רץ" מהערך הקודם לחדש (כמעט שנייה). בלי אנימציות — מיד
const noAnim = () => document.documentElement.classList.contains('noanim');
function countUp(el, to, f = fmt) {
  if (!el) return;
  const from = el._v ?? 0; el._v = to; cancelAnimationFrame(el._raf);
  if (noAnim() || from === to || document.hidden) { el.textContent = f(to); return; }
  const t0 = performance.now(), D = 900;
  const step = now => { const k = Math.min(1, (now - t0) / D), e = 1 - Math.pow(1 - k, 3);
    el.textContent = f(from + (to - from) * e); if (k < 1) el._raf = requestAnimationFrame(step); };
  el._raf = requestAnimationFrame(step);
}
const pad = n => String(n).padStart(2, '0');
const ym = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const ymd = d => `${ym(d)}-${pad(d.getDate())}`;
const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); return ym(new Date(y, mo - 1 + n, 1)); };
const monthDiff = (a, b) => { const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1); };
const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const monthLabel = m => { const [y, mo] = m.split('-').map(Number); return `${MONTHS[mo - 1]} ${y}`; };
const timeOf = iso => new Date(iso).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
const thisMonth = () => ym(new Date());

const RECOVERY = /type=recovery/.test(location.hash);
// קישור מהמייל שכבר לא תקף (פג תוקף / נפתח כבר — לפעמים Gmail "בודק" קישורים מראש)
const LINK_ERR = /error_code=|error=access_denied/.test(location.hash) ? decodeURIComponent((location.hash.match(/error_code=([^&]+)/) || [])[1] || 'error') : '';
const S = { tx: [], budgets: {}, learned: {}, cats: {}, goals: {}, maaser: {}, pocket: {}, debts: {}, recurring: {}, people: [], me: null, month: thisMonth(), view: 'chat', catFilter: null, whoFilter: null, search: '' };

// ---------- בני הבית ----------
const FACES = ['🧔', '👩', '👦', '👧', '👴', '👵', '🧑', '👶'];
const personOf = id => S.people.find(p => p.id === id);
const whoLabel = id => { const p = personOf(id); return p ? `${esc(p.e)} ${esc(p.name)}` : ''; };
// שמות ואימוג'י של בני הבית מגיעים גם מטלפונים אחרים — מנקים תווים שיכולים להריץ קוד
const cleanPeople = list => (Array.isArray(list) ? list : []).map(p => ({ ...p, e: String(p.e ?? '').replace(/[<>&"'`]/g, ''), name: String(p.name ?? '').replace(/[<>&"'`]/g, '') }));
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "רחל: סופר 230" / "סופר 230 על השם של רחל" / "לרחל" → מי + הטקסט בלי השם
function detectWho(raw) {
  for (const p of [...S.people].sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp(`(^|\\s)(?:(?:על\\s+השם\\s+של|בשם\\s+של|על\\s+שם|בשביל|עבור|של)\\s+|[לש])?${reEsc(p.name)}\\s*[:,\\-]?(?=\\s|$)`);
    const m = raw.match(re);
    if (m) return { who: p.id, text: (raw.slice(0, m.index) + ' ' + raw.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() };
  }
  return { who: null, text: raw };
}

// ---------- חישובים ----------
function amountIn(t, m) {
  const tm = ym(new Date(t.date));
  if (t.inst > 1) { const d = monthDiff(tm, m); return d >= 0 && d < t.inst ? t.amount : 0; }
  return tm === m ? t.amount : 0;
}
const expenses = () => S.tx.filter(t => t.cat !== 'income');
const spentIn = (cat, m) => S.tx.filter(t => t.cat === cat).reduce((s, t) => s + amountIn(t, m), 0);
const incomeIn = m => spentIn('income', m);
const expenseIn = m => expenses().reduce((s, t) => s + amountIn(t, m), 0);
// 0 = בלי תקציב. במצב "🪄 אוטומטי" — מה שלא נקבע ידנית מתעדכן לפי ההוצאות בפועל (ממוצע 3 חודשים)
const budgetOf = cat => S.budgets[cat] ?? (S.budgets._mode === 'auto' ? recommend(cat) : null) ?? CATS[cat]?.budget ?? 0;
const totalBudget = () => Object.keys(CATS).reduce((s, c) => s + (budgetOf(c) || 0), 0);
const txInMonth = m => S.tx.filter(t => amountIn(t, m) > 0);
function daysLeft() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate(); }
function installmentNo(t, m) { return monthDiff(ym(new Date(t.date)), m) + 1; }

function streak() {
  const days = new Set(S.tx.map(t => ymd(new Date(t.created))));
  const d = new Date();
  if (!days.has(ymd(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days.has(ymd(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function recommend(cat) {
  const months = [];
  for (let i = 1; i <= 3; i++) { const m = addMonths(thisMonth(), -i); if (txInMonth(m).length) months.push(m); }
  if (!months.length) {
    const cur = spentIn(cat, thisMonth());
    return cur ? Math.ceil(cur * 1.1 / 50) * 50 : null;
  }
  const avg = months.reduce((s, m) => s + spentIn(cat, m), 0) / months.length;
  return Math.max(50, Math.ceil(avg / 50) * 50);
}

// ---------- הודעות קופצות וחגיגות ----------
let toastT;
function toast(text, warn = false) {
  const el = $('#toast');
  el.textContent = text; el.classList.toggle('warn', warn); el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2600);
}
function confetti() {
  const cols = ['#7C3AED', '#EC4899', '#F97316', '#22C55E', '#06B6D4', '#FACC15'];
  for (let i = 0; i < 70; i++) {
    const p = document.createElement('div'); p.className = 'conf';
    p.style.left = Math.random() * 100 + '%'; p.style.background = cols[i % cols.length];
    p.style.animationDuration = (1.6 + Math.random() * 1.6) + 's'; p.style.animationDelay = Math.random() * .3 + 's';
    $('#app').appendChild(p); setTimeout(() => p.remove(), 3600);
  }
}

// ---------- ↩️ ניווט: כפתור "חזור" של הטלפון חוזר בדיוק מסך אחד ----------
// כל צעד (מסך / חלון / חלון בתוך חלון) נרשם בהיסטוריה. "חזור" מבטל את הצעד האחרון בלבד.
const nav = []; let ignorePop = 0, queued = 0, curSheet = null, sheetReopen = null, backing = false;
function hPush(entry) { nav.push(entry); if (ignorePop) queued++; else history.pushState({ n: nav.length }, ''); }
function hDrop(n) {
  if (n <= 0) return;
  nav.length = Math.max(0, nav.length - n);
  if (queued >= n) { queued -= n; return; }
  n -= queued; queued = 0; ignorePop++; history.go(-n);
}
window.addEventListener('popstate', () => {
  if (ignorePop) { ignorePop--; if (!ignorePop) while (queued) { history.pushState({ n: nav.length - queued + 1 }, ''); queued--; } return; }
  const e = nav.pop(); e?.undo();
});
const sheetTitle = html => (html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] || '').replace(/<[^>]+>/g, '').trim();

// ---------- גיליון תחתון ----------
function openSheet(html, mount, fromBack = false) {
  fromBack = fromBack || backing;
  // חלונות של רשימות נפתחים מחדש ב"חזור" (כדי להראות מספרים עדכניים), השאר — כמו שהיו
  const open = $('#sheet').classList.contains('on'), title = sheetTitle(html), next = { html, mount, title, reopen: sheetReopen }; sheetReopen = null;
  if (!fromBack) {
    if (!open || !curSheet) hPush({ t: 'sheet', undo: () => closeSheet(true) });
    else if (curSheet.title !== title || !title) {
      // חוזרים לחלון שכבר פתוח מתחת? (כפתור "↩️ חזרה" בתוך החלון) — מורידים את מה שמעליו
      const i = nav.findIndex(e => e.t === 'sheet' && e.prev && e.prev.title && e.prev.title === title);
      if (i >= 0) hDrop(nav.length - i);
      else { const prev = curSheet; hPush({ t: 'sheet', prev, undo: () => { if (prev.reopen) { backing = true; try { prev.reopen(); } finally { backing = false; } } else openSheet(prev.html, prev.mount, true); } }); }
    } // אותו חלון בדיוק (רענון אחרי שמירה) — לא נרשם צעד חדש
  }
  curSheet = next;
  $('#sheet').innerHTML = '<div class="grip"></div>' + html;
  $('#sheet').scrollTop = 0;
  $('#overlay').classList.add('on'); $('#sheet').classList.add('on');
  mount?.($('#sheet'));
}
function closeSheet(fromPop) {
  $('#overlay').classList.remove('on'); $('#sheet').classList.remove('on');
  document.querySelector('.tour-card')?.classList.remove('hide'); // כרטיס הסיור חוזר
  document.body.classList.remove('noting', 'over-gate');
  if (fromPop !== true) { let k = 0; for (let i = nav.length - 1; i >= 0 && nav[i].t === 'sheet'; i--) k++; hDrop(k); }
  curSheet = null;
}
$('#overlay').onclick = closeSheet;
// המסגרת עצמה לעולם לא נגללת (פוקוס על שדה בחלון יכול להזיז אותה ולשבור את המסך)
$('#app').addEventListener('scroll', e => { e.target.scrollTop = 0; e.target.scrollLeft = 0; });
// משיכה כלפי מטה (כשהחלון גלול לראש) — החלון יורד ונסגר, חוזרים למסך הראשי
(() => {
  const sh = $('#sheet'); let y0 = null, dy = 0, drag = false;
  sh.addEventListener('touchstart', e => {
    y0 = sh.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
    dy = 0; drag = false;
  }, { passive: true });
  sh.addEventListener('touchmove', e => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (!drag && dy > 8 && sh.scrollTop <= 0) { drag = true; sh.style.transition = 'none'; }
    if (drag) { e.preventDefault(); sh.style.transform = `translateY(${Math.max(0, dy)}px)`; }
    else if (dy < -4) y0 = null;
  }, { passive: false });
  const end = () => {
    if (drag) { sh.style.transition = ''; if (dy > 90) closeSheet(); sh.style.transform = ''; }
    y0 = null; drag = false;
  };
  sh.addEventListener('touchend', end); sh.addEventListener('touchcancel', end);
  $('#overlay').addEventListener('touchmove', e => e.preventDefault(), { passive: false });
})();

function catGrid(selected, withIncome = true) {
  const ids = [...Object.keys(CATS), ...(withIncome ? ['income'] : [])];
  return `<div class="catgrid">${ids.map(id => { const c = catOf(id);
    return `<button class="catbtn ${id === selected ? 'sel' : ''}" data-cat="${id}"><div class="cat-ic" style="background:${c.g}">${c.e}</div>${c.n}</button>`; }).join('')}</div>`;
}

// ---------- צ'אט ----------
function botHTML(t) {
  const c = catOf(t.cat);
  let title, sub = '';
  if (t.cat === 'income') { title = `${esc(t.desc)} · +${fmt(t.amount)}`; sub = 'הכנסה נרשמה 🎉'; }
  else {
    title = `${esc(t.desc)} · ${fmt(t.inst > 1 ? t.total : t.amount)}`;
    sub = `${c.n} · `;
    if (t.inst > 1) sub += `${t.inst} תשלומים של ${fmt(t.amount)} · `;
    const m = ym(new Date(t.date)), b = budgetOf(t.cat), left = b - spentIn(t.cat, m);
    sub += !b ? `${fmt(spentIn(t.cat, m))} החודש` : left >= 0 ? `נשארו ${fmt(left)}` : `⚠️ חריגה של ${fmt(-left)}`;
  }
  const day = ymd(new Date(t.date)) !== ymd(new Date(t.created)) ? ` · ${new Date(t.date).toLocaleDateString('he-IL')}` : '';
  const pay = t.pay ? `<button data-act="pay" data-id="${t.id}">${PAY[t.pay].e} ${PAY[t.pay].n}</button>` : '';
  // שאלה קלה "איך שולם?" — רק על רשומות חדשות, אפשר לדלג
  const askPay = !t.pay && !t.paySkip && t.source !== 'file' && Date.now() - new Date(t.created) < 12 * 3600e3
    ? `<div class="paynow"><span>💳 איך שולם?</span>${['credit', 'cash', 'transfer', 'bit'].map(k => `<button data-act="setpay" data-pay="${k}" data-id="${t.id}">${PAY[k].e} ${PAY[k].n.split('/')[0]}</button>`).join('')}<button data-act="skippay" data-id="${t.id}" class="skip">דלג</button></div>` : '';
  return `<div class="cat-ic" style="background:${c.g}">${c.e}</div>
    <div><b>${t.rec ? '🔁 ' : ''}${title}</b><div class="sub">${sub}${day}${t.rec ? ' · קבוע' : ''}</div>${t.estimate ? `<div class="est"><span>💡 סכום משוער — כמה יצא החשבון?</span><input type="number" inputmode="decimal" value="${t.amount}" aria-label="הסכום האמיתי"><button data-act="estok" data-id="${t.id}">✅</button></div>` : ''}${t.tags?.length ? `<div class="tags">${t.tags.map(x => `<span class="tag">#${esc(x)}</span>`).join('')}</div>` : ''}
    ${askPay}
    <div class="acts">${t.who && personOf(t.who) ? `<button data-act="who" data-id="${t.id}">${whoLabel(t.who)}</button>` : ''}${pay}${t.cat === 'give' ? `<button data-act="mx" data-id="${t.id}">${t.extraGive ? '➕ בנוסף למעשר' : '🤲 מתוך המעשר'}</button>` : ''}<button data-act="fix" data-id="${t.id}">✏️ עריכה</button><button data-act="undo" data-id="${t.id}">🗑️ מחיקה</button></div></div>`;
}

function fileSummaryHTML(list, msg) {
  const exp = list.filter(t => t.cat !== 'income').reduce((s, t) => s + t.amount, 0);
  const inc = list.filter(t => t.cat === 'income').reduce((s, t) => s + t.amount, 0);
  const top = Object.entries(list.filter(t => t.cat !== 'income').reduce((a, t) => (a[t.cat] = (a[t.cat] || 0) + t.amount, a), {}))
    .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c]) => catOf(c).e).join(' ');
  return `<div class="cat-ic" style="background:var(--g2)">📊</div>
    <div><b>יובאו ${list.length} תנועות</b><div class="sub">📅 ${monthsSpan(list.map(t => t.date))}<br>${exp ? 'הוצאות ' + fmt(exp) : ''}${exp && inc ? ' · ' : ''}${inc ? 'הכנסות ' + fmt(inc) : ''} ${top}</div>
    <div class="acts"><button data-act="viewfile" data-msg="${msg}">👀 לצפייה</button><button data-act="undofile" data-msg="${msg}">↩️ ביטול ייבוא</button></div></div>`;
}

function dayLabel(d) {
  const today = ymd(new Date()), y = new Date(); y.setDate(y.getDate() - 1);
  const k = ymd(d);
  return k === today ? 'היום' : k === ymd(y) ? 'אתמול' : d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' });
}

// הרווח בתחתית הצ'אט = גובה שורת הכתיבה + התפריט התחתון (כולל הפס של האייפון)
function fitChatPadding() {
  const c = $('#composer'), n = document.querySelector('nav');
  if (!c || !n) return;
  document.documentElement.style.setProperty('--chat-pad', (c.offsetHeight + n.offsetHeight + 16) + 'px');
}
window.addEventListener('resize', fitChatPadding);
window.visualViewport?.addEventListener('resize', fitChatPadding);

function renderChat(newIds = []) {
  fitChatPadding();
  const since = Date.now() - 45 * 864e5;
  const list = S.tx.filter(t => new Date(t.created) >= since).sort((a, b) => a.created.localeCompare(b.created));
  let html = '', lastDay = '', lastMsg = '';
  if (!list.length) {
    html = `<div class="bot"><div class="cat-ic" style="background:var(--g1)">👋</div><div><b>היי! הכסף של הבית — סוף סוף בשליטה 💜</b>
      <div class="sub">🎯 בונים תקציב במסך "תקציב" (יש גם המלצה חכמה 🪄)<br>✍️ ורושמים הוצאות כמו בוואטסאפ, ואני מסדר לבד:<br>• "סופר 230"<br>• "טעינה לרכב 90 וקפה 18"<br>• "משכורת 12500"<br>• "ספה 6000 ב-12 תשלומים"<br>• "אתמול פיצה 85"<br>או לוחצים על 🎤 ומדברים<br><br>💡 ב-⚙️ אפשר להוסיף את בני הבית, ואז לכתוב "רחל: סופר 230"</div></div></div>`;
  }
  for (const t of list) {
    const d = new Date(t.created);
    if (ymd(d) !== lastDay) { lastDay = ymd(d); html += `<div class="day">${dayLabel(d)}</div>`; }
    const isNew = newIds.includes(t.id) ? ' new' : '';
    if (t.source === 'file') {
      // קובץ שיובא — בועה אחת מסכמת במקום עשרות בועות
      if (t.msg === lastMsg) continue;
      lastMsg = t.msg;
      html += `<div class="me${isNew}">📄 ${esc(t.raw)}<div class="time">${timeOf(t.created)}</div></div>`;
      html += `<div class="bot${isNew}">${fileSummaryHTML(S.tx.filter(x => x.msg === t.msg), t.msg)}</div>`;
      continue;
    }
    if (t.msg !== lastMsg) {
      lastMsg = t.msg;
      html += `<div class="me${isNew}">${t.source === 'voice' ? '🎤 ' : t.source === 'plus' ? '➕ ' : ''}${esc(t.raw)}<div class="time">${timeOf(t.created)}</div></div>`;
    }
    html += `<div class="bot${isNew}" id="b-${t.id}">${botHTML(t)}</div>`;
  }
  $('#chat').innerHTML = html;
  if (S.view === 'chat') requestAnimationFrame(() => $('#main').scrollTo({ top: $('#main').scrollHeight, behavior: newIds.length ? 'smooth' : 'auto' }));
}

const EXPORT_CMD = /^(תן לי |תוציא |תכין |אני רוצה )?(סיכום|דוח|דו"ח|דו״ח|אקסל|ייצוא|להוריד)/;

async function send(raw, source = 'text') {
  raw = raw.trim(); if (!raw) return;
  const rm = EXPORT_CMD.test(raw) && raw.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\s*(?:עד|-|–)\s*(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
  if (rm) {
    const y = v => v ? (v.length === 2 ? 2000 + +v : +v) : new Date().getFullYear();
    const from = new Date(y(rm[3]), rm[2] - 1, +rm[1], 12), to = new Date(y(rm[6] || rm[3]), rm[5] - 1, +rm[4], 12);
    openExportSheet('range', new Date(), from <= to ? { from, to } : { from: to, to: from });
    return;
  }
  if (EXPORT_CMD.test(raw) && !/\d/.test(raw)) {
    const kind = /יומי|היום|יום/.test(raw) ? 'day' : /שבוע/.test(raw) ? 'week' : /שנת|שנה/.test(raw) ? 'year' : 'month';
    openExportSheet(kind, /אתמול/.test(raw) ? new Date(Date.now() - 864e5) : /שעבר|קודם/.test(raw) ? xp.shiftAnchor(kind, new Date(), -1) : new Date());
    return;
  }
  if (/\sכל\s.*חודש/.test(raw) && await recurringCommand(raw)) { $('#inp').blur(); return; }
  if (/^(הלוויתי|לוויתי|לקחתי הלוואה|קיבלתי הלוואה|החזרתי ל)|\sהחזיר(ה)?\s/.test(raw) && await debtCommand(raw)) { $('#inp').blur(); return; }
  if (FEEDBACK_RE.test(raw)) { $('#inp').blur(); openFeedback(raw.replace(FEEDBACK_RE, '').trim(), raw); return; }
  if (help.isHelpRequest(raw)) { $('#inp').blur(); openHelp(raw, help.wantsGuide(raw) && !help.answer(raw).length); return; }
  const named = detectWho(raw);
  const tagged = takeTags(named.text);
  // 🤲 "תרומה 100 בנוסף למעשר" — תרומה שלא נספרת מהמעשר
  const EXTRA_RE = /\s*(בנוסף למעשר|לא מהמעשר|לא ממעשר|מחוץ למעשר)\s*/;
  const extraGive = EXTRA_RE.test(tagged.text); if (extraGive) tagged.text = tagged.text.replace(EXTRA_RE, ' ').trim();
  const items = parseMessage(tagged.text);
  const me = document.createElement('div');
  me.className = 'me new'; me.innerHTML = esc(raw);
  $('#chat').appendChild(me);
  const typing = document.createElement('div'); typing.className = 'typing'; typing.innerHTML = '<i></i><i></i><i></i>';
  $('#chat').appendChild(typing);
  $('#main').scrollTo({ top: $('#main').scrollHeight, behavior: 'smooth' });
  await new Promise(r => setTimeout(r, 550));

  if (!items.length) {
    typing.remove();
    const b = document.createElement('div'); b.className = 'bot new';
    b.innerHTML = `<div class="cat-ic" style="background:var(--card2)">🤔</div><div><b>לא מצאתי סכום</b><div class="sub">להוצאה כותבים למשל "סופר 230".<br>רצית לראות את ההוראות?</div>
      <div class="acts"><button data-help="guide">📖 כן, למדריך</button><button data-help="ask">❓ יש לי שאלה</button></div></div>`;
    b.querySelector('[data-help="guide"]').onclick = () => { b.remove(); me.remove(); openHelp('', true); };
    b.querySelector('[data-help="ask"]').onclick = () => { b.remove(); me.remove(); openHelp(raw); };
    $('#chat').appendChild(b);
    return;
  }

  const msg = db.newId(), now = new Date();
  const pay = detectPay(raw);
  const pending = items.map(it => {
    const income = items.length === 1 ? isIncome(raw) : isIncome(it.desc);
    let desc = it.desc, cat = income ? 'income' : classify(desc, S.learned);
    if (!income && stripVav(desc) !== desc) { const c2 = classify(stripVav(desc), S.learned); if (c2 !== 'other') { cat = c2; desc = stripVav(desc); } }
    const date = new Date(now); date.setDate(date.getDate() + it.dayOffset);
    const inst = !income && it.installments > 1 ? it.installments : 0;
    return { id: db.newId(), msg, raw, desc, cat, source, created: now.toISOString(), date: date.toISOString(),
      amount: inst ? Math.round(it.amount / inst * 100) / 100 : it.amount, total: it.amount, inst, pay: pay || (inst ? 'credit' : null),
      who: named.who || S.me || null, ...(tagged.tags.length ? { tags: tagged.tags } : {}) };
  }).map(t => t.cat === 'give' && extraGive ? { ...t, extraGive: true } : t);

  // ⚠️ כפילות: אותו סכום בערך + אותה קטגוריה או שם דומה, באותו חודש — שואלים לפני שרושמים
  const dups = pending.map(t => ({ t, d: findDup(t) })).filter(x => x.d);
  typing.remove();
  if (dups.length) {
    const { t, d } = dups[0];
    const by = d.who && personOf(d.who) ? ` ע"י ${(whoLabel(d.who))}` : '';
    const b = document.createElement('div'); b.className = 'bot new';
    b.innerHTML = `<div class="cat-ic" style="background:linear-gradient(135deg,#F59E0B,#F97316)">⚠️</div>
      <div><b>נראה שזה כבר נרשם</b><div class="sub">"${esc(d.desc)} · ${fmt(d.inst > 1 ? d.total : d.amount)}"${by} ב-${new Date(d.date).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })}${dups.length > 1 ? ` (ועוד ${dups.length - 1})` : ''}</div>
      <div class="acts" style="flex-wrap:wrap;gap:10px"><button data-dup="same">✋ זו אותה הוצאה — לא לרשום</button><button data-dup="add">➕ להכניס בכל זאת</button><button data-dup="show">👀 להראות לי</button></div></div>`;
    $('#chat').appendChild(b);
    $('#main').scrollTo({ top: $('#main').scrollHeight, behavior: 'smooth' });
    b.querySelector('[data-dup="add"]').onclick = () => { b.remove(); commitTx(pending); };
    b.querySelector('[data-dup="same"]').onclick = () => {
      me.style.opacity = '.45'; me.style.textDecoration = 'line-through';
      b.innerHTML = `<div class="cat-ic" style="background:var(--card2)">👌</div><div><b>בסדר, לא נרשם שוב</b></div>`;
    };
    b.querySelector('[data-dup="show"]').onclick = () => showTx(d.id);
    return;
  }
  await commitTx(pending);
}

function similarDesc(a, b) {
  const norm = x => x.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(w => w.length >= 2);
  const A = norm(a), B = norm(b);
  return A.some(w => B.includes(w)) || a.includes(b) || b.includes(a);
}
function findDup(t) {
  const amt = t.inst > 1 ? t.total : t.amount, inc = t.cat === 'income';
  return S.tx.filter(x => x.id !== t.id && (x.cat === 'income') === inc &&
      Math.abs((x.inst > 1 ? x.total : x.amount) - amt) <= Math.max(1, amt * 0.03) &&
      (ym(new Date(x.date)) === ym(new Date(t.date)) || Math.abs(new Date(x.date) - new Date(t.date)) <= 5 * 864e5) &&
      (x.cat === t.cat || similarDesc(x.desc, t.desc)))
    .sort((a, b) => Math.abs(new Date(a.date) - new Date(t.date)) - Math.abs(new Date(b.date) - new Date(t.date)))[0];
}

async function commitTx(pending) {
  const ids = [], before = {};
  for (const t of pending) {
    const m = ym(new Date(t.date));
    if (t.cat !== 'income' && !(t.cat in before)) before[t.cat] = spentIn(t.cat, m);
    S.tx.push(t); await db.putTx(t); ids.push(t.id);
  }
  renderAll(ids);
  // חגיגות והתראות
  const added = S.tx.filter(t => ids.includes(t.id));
  if (added.some(t => t.cat === 'income')) { confetti(); toast('💸 הכנסה חדשה! ' + fmt(added.filter(t => t.cat === 'income').reduce((s, t) => s + t.amount, 0))); }
  for (const cat of Object.keys(before)) {
    const b = budgetOf(cat), m = ym(new Date(added.find(t => t.cat === cat).date)), after = spentIn(cat, m);
    if (!b) continue;
    if (before[cat] <= b && after > b) toast(`🚨 עברת את תקציב ${catOf(cat).n}`, true);
    else if (before[cat] < b * .9 && after >= b * .9) toast(`🔔 הגעת ל-90% מתקציב ${catOf(cat).n} — נשארו ${fmt(b - after)}`, true);
  }
  for (const cat of new Set(added.map(t => t.cat))) $(`#st-${cat}`)?.classList.add('pop');
}

// קפיצה לשורה מסוימת ברשימת התנועות, עם הדגשה
function showTx(id) {
  const t = S.tx.find(x => x.id === id); if (!t) return;
  closeSheet();
  S.month = ym(new Date(t.date)); S.catFilter = null; S.whoFilter = null; S.search = ''; $('#search').value = '';
  go('tx');
  setTimeout(() => {
    const row = document.querySelector(`#txList [data-id="${id}"]`); if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
  }, 60);
}

$('#chat').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  if (b.dataset.act === 'viewfile') {
    const first = S.tx.find(x => x.msg === b.dataset.msg); if (!first) return;
    S.catFilter = null; S.month = ym(new Date(first.date)); go('tx'); return;
  }
  if (b.dataset.act === 'undofile') {
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'בטוח? לחץ שוב'; return; }
    undoImport(b.dataset.msg); return;
  }
  const t = S.tx.find(x => x.id === b.dataset.id); if (!t) return;
  if (b.dataset.act === 'undo') removeTx(t);
  else if (b.dataset.act === 'pay') openPaySheet(t);
  else if (b.dataset.act === 'setpay') { t.pay = b.dataset.pay; db.putTx(t).then(() => { const el = document.getElementById('b-' + t.id); if (el) el.innerHTML = botHTML(t); toast(`${PAY[t.pay].e} נשמר: ${PAY[t.pay].n}`); }); }
  else if (b.dataset.act === 'skippay') { t.paySkip = true; db.putTx(t).then(() => { const el = document.getElementById('b-' + t.id); if (el) el.innerHTML = botHTML(t); }); }
  else if (b.dataset.act === 'who') openWhoSheet(t);
  else if (b.dataset.act === 'mx') { if (t.extraGive) delete t.extraGive; else t.extraGive = true; db.putTx(t).then(() => { const el = document.getElementById('b-' + t.id); if (el) el.innerHTML = botHTML(t); toast(t.extraGive ? '➕ בנוסף למעשר — לא יורד ממה שחייבים' : '🤲 מתוך המעשר — יורד ממה שחייבים'); }); }
  else if (b.dataset.act === 'estok') {
    const v = num(b.parentElement.querySelector('input')?.value); if (!(v > 0)) return;
    t.amount = v; t.total = v; delete t.estimate; db.putTx(t).then(async () => {
      const r = t.rec && S.recurring?.[t.rec]; if (r) await saveRule(t.rec, { ...r, amount: v }); // בפעם הבאה ההערכה תהיה הסכום האחרון
      renderAll(); toast(`✅ ${t.desc}: ${fmt(v)}`); });
  }
  else openEditSheet(t);
});

async function removeTx(t) {
  S.tx = S.tx.filter(x => x.id !== t.id); await db.delTx(t.id);
  // 🔁 קבוע שנמחק — לא נרשום אותו שוב באותו חודש
  const rr = t.rec && S.recurring?.[t.rec], rm = ym(new Date(t.date));
  if (rr && !(rr.skip || []).includes(rm)) await saveRule(t.rec, { ...rr, skip: [...(rr.skip || []), rm].slice(-24) });
  renderAll();
  toastUndo(`🗑️ נמחק: ${t.desc}`, async () => { S.tx.push(t); await db.putTx(t); renderAll(); toast('↩️ הוחזר'); });
}
// הודעה עם כפתור "בטל" — 6 שניות להתחרט
const toastUndo = (text, undo) => toastAction(text, '↩️ בטל', undo);
function toastAction(text, label, fn) {
  const el = $('#toast');
  el.textContent = text + ' ';
  const b = document.createElement('button'); b.className = 'tundo'; b.textContent = label;
  b.onclick = () => { el.classList.remove('show'); fn(); };
  el.appendChild(b); el.classList.remove('warn'); el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 6000);
}

const payGrid = sel => `<div class="catgrid">${Object.entries(PAY).map(([id, p]) =>
  `<button class="catbtn ${id === sel ? 'sel' : ''}" data-pay="${id}"><div class="cat-ic" style="background:var(--card2)">${p.e}</div>${p.n}</button>`).join('')}</div>`;

// 🏷️ שדה תגית אירוע + הצעות מהתגיות שכבר בשימוש
const allTags = () => { const m = new Map(); for (const t of S.tx) for (const g of t.tags || []) m.set(g, (m.get(g) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]); };
function tagField(id, cur) {
  const sug = allTags().filter(g => !cur.includes(g)).slice(0, 6);
  return `<label class="field"><span>🏷️ אירוע (לא חובה) — למשל: בר_מצווה, פסח</span><input id="${id}" value="${cur.map(esc).join(' ')}" placeholder="#חתונה_של_דודי"></label>
    ${sug.length ? `<div class="chips" style="flex-wrap:wrap;margin:-6px 0 14px">${sug.map(g => `<button class="chip" data-tagsug="${esc(g)}" data-for="${id}">#${esc(g)}</button>`).join('')}</div>` : ''}`;
}
function readTags(sh, id) { return [...new Set((sh.querySelector('#' + id)?.value || '').split(/[\s,]+/).map(cleanTag).filter(Boolean))]; }
document.addEventListener('click', e => {
  const b = e.target.closest('[data-tagsug]'); if (!b) return;
  const inp = document.getElementById(b.dataset.for); if (!inp) return;
  const v = inp.value.trim(); if (!v.split(/\s+/).map(cleanTag).includes(b.dataset.tagsug)) inp.value = (v ? v + ' ' : '') + b.dataset.tagsug; b.remove();
});

const whoChips = sel => S.people.map(p => `<button class="chip ${p.id === sel ? 'on' : ''}" data-w="${p.id}">${esc(p.e)} ${esc(p.name)}</button>`).join('');

function openWhoSheet(t) {
  openSheet(`<h3>של מי ${t.cat === 'income' ? 'ההכנסה' : 'ההוצאה'}?</h3><div class="sub" style="margin:-6px 0 12px">"${esc(t.desc)}" · ${fmt(t.inst > 1 ? t.total : t.amount)}</div>
    <div class="chips" style="flex-wrap:wrap;margin-bottom:12px">${whoChips(t.who)}</div>
    <div class="sub">טיפ: אפשר לכתוב ישר בהודעה — "${esc(S.people[0]?.name || 'רחל')}: סופר 230"</div>`, sh => {
    sh.querySelectorAll('[data-w]').forEach(b => b.onclick = async () => {
      t.who = b.dataset.w; await db.putTx(t); closeSheet(); renderAll(); toast(`נשמר על ${personOf(t.who).e} ${personOf(t.who).name}`);
    });
  });
}

function openPaySheet(t) {
  openSheet(`<h3>איך שילמת?</h3><div class="sub" style="margin:-6px 0 12px">"${esc(t.desc)}" · ${fmt(t.inst > 1 ? t.total : t.amount)}</div>${payGrid(t.pay)}
    <div class="sub">טיפ: אפשר לכתוב ישר בהודעה — "סופר 230 במזומן"</div>`, sh => {
    sh.querySelectorAll('[data-pay]').forEach(btn => btn.onclick = async () => {
      t.pay = btn.dataset.pay; await db.putTx(t); closeSheet(); renderAll(); toast(`${PAY[t.pay].e} נשמר: ${PAY[t.pay].n}`);
    });
  });
}


// ---------- מסך ראשי: יתרה וסיפורים ----------
function renderHero() {
  const m = thisMonth(), inc = incomeIn(m), exp = expenseIn(m);
  const kid = !sync.isParent();
  $('#heroLabel').textContent = kid ? 'רשמת החודש' : inc ? 'נשאר לך החודש' : 'הוצאת החודש';
  countUp($('#left'), !kid && inc ? inc - exp : exp);
  const pct = Math.round(exp / totalBudget() * 100);
  $('#usedBar').style.width = Math.min(100, pct) + '%';
  $('#usedPct').textContent = `${pct}% מהתקציב נוצל`;
  $('#daysLeft').textContent = `עוד ${daysLeft()} ימים לסוף ${MONTHS[new Date().getMonth()]}`;
  const s = streak();
  $('#streak').textContent = s ? `🔥 ${s} ${s === 1 ? 'יום' : 'ימים'} ברצף` : '✨ בוא נתחיל';
}

function renderStories() {
  const m = thisMonth();
  $('#stories').innerHTML = Object.entries(CATS).map(([id, c]) => {
    const b = budgetOf(id), sp = spentIn(id, m), p = b ? Math.min(100, sp / b * 100) : sp ? 100 : 0, over = b && sp > b;
    return `<button class="story" id="st-${id}" data-cat="${id}"><div class="ring" style="background:conic-gradient(${over ? '#F43F5E' : c.c} ${p}%, rgba(255,255,255,.12) 0)"><span>${c.e}</span></div>${c.n.split(' ')[0]}</button>`;
  }).join('');
}
$('#stories').addEventListener('click', e => {
  const b = e.target.closest('[data-cat]'); if (!b) return;
  openCategory(b.dataset.cat, thisMonth());
});

// פירוט קטגוריה: כמה יצא, על מה, מתי ומי — לכל חודש
function openCategory(id, m = S.month) {
  const c = catOf(id), isInc = id === 'income';
  const list = txInMonth(m).filter(t => t.cat === id).sort((a, b) => b.date.localeCompare(a.date));
  const total = list.reduce((s, t) => s + amountIn(t, m), 0);
  const b = isInc ? 0 : budgetOf(id), p = b ? Math.min(100, total / b * 100) : 0, over = b && total > b;
  openSheet(`<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div class="cat-ic" style="background:${c.g};width:52px;height:52px;font-size:26px">${c.e}</div>
      <div style="flex:1;min-width:0"><h3 style="margin:0">${c.n}</h3><div class="sub">${list.length} ${isInc ? 'הכנסות' : 'הוצאות'}</div></div></div>
    <div class="monthnav" style="justify-content:space-between;margin-bottom:12px"><button data-cm="-1" aria-label="חודש קודם">›</button><span>${monthLabel(m)}</span><button data-cm="1" aria-label="חודש הבא">‹</button></div>
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><span class="sub">${isInc ? 'נכנס החודש' : 'יצא החודש'}</span>
        <b style="font-size:26px;direction:ltr" class="${over ? 'over' : ''}">${fmt(total)}${b ? ` <span class="sub" style="font-size:14px">/ ${fmt(b)}</span>` : ''}</b></div>
      ${b ? `<div class="pbar"><i style="width:${p}%;background:${over ? 'linear-gradient(90deg,#F43F5E,#FB7185)' : c.g}"></i></div>
      <div class="sub" style="margin-top:6px">${over ? `⚠️ חריגה של ${fmt(total - b)}` : `נשארו ${fmt(b - total)}`}</div>` : ''}
    </div>
    <div class="card" style="padding:4px 14px;margin-bottom:12px">${list.length ? list.map(t => {
      const extra = t.inst > 1 ? ` · תשלום ${installmentNo(t, m)}/${t.inst}` : '';
      const who = t.who && personOf(t.who) ? ' · ' + (whoLabel(t.who)) : '';
      return `<button class="tx" data-ct="${t.id}"><div class="nm"><div>${esc(t.desc)}</div><small>${new Date(t.date).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })}${extra}${who}${t.pay ? ' · ' + PAY[t.pay].e : ''}</small></div><div class="am ${isInc ? 'plus' : ''}">${fmt(amountIn(t, m))}</div></button>`;
    }).join('') : `<div class="empty"><span class="em">🌱</span>אין ${isInc ? 'הכנסות' : 'הוצאות'} בחודש הזה</div>`}</div>
    ${isInc ? '' : `<button class="btn grad full" id="cBudget" style="margin-bottom:8px">🎯 שינוי התקציב</button>`}
    <div class="sub" style="text-align:center">לחיצה על שורה — עריכה</div>`, sh => {
    sh.querySelectorAll('[data-cm]').forEach(x => x.onclick = () => openCategory(id, addMonths(m, Number(x.dataset.cm))));
    sh.querySelectorAll('[data-ct]').forEach(x => x.onclick = () => { const t = S.tx.find(y => y.id === x.dataset.ct); if (t) openEditSheet(t); });
    sh.querySelector('#cBudget')?.addEventListener('click', () => openBudgetEdit(id));
  });
}

// ---------- תקציב ----------
function renderBudget() {
  const m = S.month;
  countUp($('#incSum'), incomeIn(m));
  countUp($('#expSum'), expenseIn(m));
  const hint = !lsGet('kesef-cathint');
  const mode = S.budgets._mode || '';
  const rl = Object.values(S.recurring || {}).filter(r => !r.paused), rIn = rl.filter(r => r.cat === 'income').reduce((x, r) => x + r.amount, 0), rOut = rl.filter(r => r.cat !== 'income').reduce((x, r) => x + r.amount, 0);
  $('#budgetList').innerHTML = `<div class="bud-top"><button class="card newcat ${hint ? 'pulse' : ''}" id="catsBtn"><span class="plus">🏷️</span><span><b>קטגוריות</b><small>הוספה, שינוי שם, אייקון וצבע</small></span>${hint ? '<i class="hint">חדש ✨</i>' : ''}</button>
    <div class="bmode" role="group" aria-label="סוג התקציב"><button data-bmode="auto" class="${mode === 'auto' ? 'on' : ''}">🪄 אוטומטי</button><button data-bmode="manual" class="${mode === 'manual' ? 'on' : ''}">✍️ אני קובע</button></div></div>
    <button class="card rec-card" id="recCard"><span class="plus">🔁</span><span><b>הקבועים שלי${rl.length ? ` · ${rl.length}` : ''}</b><small>${rl.length ? `נכנס ${fmt(rIn)} · יוצא ${fmt(rOut)} — כל חודש, לבד` : 'שכירות, ועד בית, משכורת — פעם אחת, ונרשם לבד כל חודש'}</small></span></button>` + Object.entries(CATS).map(([id, c]) => {
    const s = spentIn(id, m), b = budgetOf(id), p = b ? Math.min(100, s / b * 100) : 0, o = b && s > b, left = b - s;
    // ✉️ מעטפה: כמה נשאר — בגדול. אדום כשנגמר / חרגנו
    const env = !b ? `<div class="env"><small>הוצאתם</small><b>${fmt(s)}</b></div>`
      : left > 0 ? `<div class="env ${p >= 90 ? 'warn' : ''}"><small>נשארו</small><b>${fmt(left)}</b></div>`
      : `<div class="env empty-env"><small>${left === 0 ? 'המעטפה ריקה' : 'חריגה'}</small><b>${left === 0 ? '0₪' : '-' + fmt(-left)}</b></div>`;
    return `<button class="card" data-cat="${id}"><div class="cat-row"><div class="cat-ic" style="background:${c.g}">${c.e}</div><div class="nm">${esc(c.n)} <span class="cedit2" data-ecat="${id}" role="button" aria-label="עריכת קטגוריה">✏️ עריכה</span><small class="sub" style="display:block">${b ? `${fmt(s)} מתוך ${fmt(b)}${S.budgets._mode === 'auto' && S.budgets[id] == null ? ' 🪄' : ''}` : 'בלי תקציב'}</small></div>${env}</div><div class="pbar"><i style="width:${p}%;background:${o || (b && left <= 0) ? 'linear-gradient(90deg,#F43F5E,#FB7185)' : c.g}"></i></div></button>`;
  }).join('');
}
$('#budgetList').addEventListener('click', e => {
  if (e.target.closest('#recCard')) { openRecurring(); return; }
  if (e.target.closest('#catsBtn')) { lsSet('kesef-cathint', '1'); openCatsSheet(); return; }
  const bm = e.target.closest('[data-bmode]'); if (bm) { setBudgetMode(bm.dataset.bmode); return; }
  const ec = e.target.closest('[data-ecat]'); if (ec) { lsSet('kesef-cathint', '1'); openCatEdit(ec.dataset.ecat, () => closeSheet()); return; }
  const b = e.target.closest('[data-cat]'); if (!b) return;
  openCategory(b.dataset.cat, S.month);
});
document.querySelector('#v-budget .duo').addEventListener('click', e => {
  const st = e.target.closest('.stat'); if (!st) return;
  if (st.querySelector('#incSum')) openCategory('income', S.month);
  else openExpenses(S.month);
});
// ---------- ✨ מה חדש ----------
// קופץ פעם אחת אחרי עדכון. 'kesef-news' = הגרסה האחרונה שראו בטלפון הזה. משתמש חדש — לא מקבל (יש לו את המדריך)
const NEWS_KEY = 'kesef-news';
const newsFor = items => items.filter(i => sync.isParent() || i.kids);
const NEWS_GO = {
  budget: () => go('budget'),
  bmode: () => { go('budget'); spot('.bmode'); },
  cats: () => { go('budget'); openCatsSheet(); },
  expenses: () => { go('budget'); openExpenses(); },
  maaser: () => { go('budget'); openMaaser(); },
  goals: () => { go('budget'); openGoals(); },
  debts: () => { go('budget'); openDebts(); },
  rec: () => { go('budget'); openRecurring(); },
  view: () => { openSettings(); setTimeout(() => $('#viewCard')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350); },
  news: () => openNews(true),
};
// מאיר רכיב במסך לכמה שניות
function spot(sel) {
  setTimeout(() => { const el = $(sel); if (!el) return; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.remove('spot'); void el.offsetWidth; el.classList.add('spot'); setTimeout(() => el.classList.remove('spot'), 2600); }, 350);
}
function maybeNews() {
  if (!NEWS.length || (db.DEMO && !UITEST)) return;
  const last = NEWS[0].v, seen = lsGet(NEWS_KEY);
  if (seen === last) return;
  if (!seen) {
    // אין סימון: משתמש ותיק (יש נתונים) — רואה רק את העדכון האחרון. חדש — לא מקבל כלום
    if (!S.tx.length) { lsSet(NEWS_KEY, last); return; }
  }
  const fresh = NEWS.filter(n => !seen ? n.v === last : n.v > seen);
  const items = newsFor(fresh.flatMap(n => n.items));
  if (!items.length) { lsSet(NEWS_KEY, last); return; }
  setTimeout(() => { if ($('#gate').classList.contains('on') || $('#sheet').classList.contains('on')) return; openNews(false, items); }, 900);
}
// newsBack = איפה עצרנו ברשימה — כדי לחזור אליה אחרי "👀 תראו לי"
let newsBack = null;
function openNews(all = false, items = null, restore = false) {
  lsSet(NEWS_KEY, NEWS[0]?.v || '');
  $('.news-fab')?.remove();
  const seen = newsBack?.seen || [];
  const row = (i, k) => `<div class="nw-row ${seen.includes(i.go) ? 'seen' : ''}" ${i.go ? `data-ng="${i.go}" role="button"` : ''} style="--d:${restore ? 0 : k * 90}ms"><span class="nw-e">${i.e}</span><span class="nw-t"><b>${esc(i.t)}</b><small>${esc(i.d)}</small></span>${i.go ? `<button class="nw-go" data-ng="${i.go}">${seen.includes(i.go) ? '✓ ' : ''}👀 תראו לי</button>` : ''}</div>`;
  const dLabel = v => new Date(v + 'T12:00:00').toLocaleDateString('he-IL', { day: 'numeric', month: 'long' });
  const body = all
    ? NEWS.map(n => ({ ...n, items: newsFor(n.items) })).filter(n => n.items.length).map((n, j) => `<div class="nw-day">${j === 0 ? '🆕 ' : ''}${dLabel(n.v)}</div>${n.items.map(row).join('')}`).join('')
    : (items.length > 6 ? items.slice(0, 6) : items).map(row).join('') + (items.length > 6 ? `<button class="chip" id="nwAll" style="margin-top:4px">ועוד ${items.length - 6} — לכל הרשימה</button>` : '');
  const first = (items || newsFor(NEWS[0].items)).find(i => i.go && i.go !== 'news' && !seen.includes(i.go)) || (items || []).find(i => i.go && i.go !== 'news');
  openSheet(`<div class="nw-head"><span class="nw-spark">✨</span><h3>מה חדש${all ? '' : ' באפליקציה'}</h3><div class="sub">${all ? 'כל העדכונים — החדש למעלה. "👀 תראו לי" — לשם, ו"✨ חזרה" מחזיר לכאן.' : 'עדכנו את האפליקציה. הנה מה שהשתנה 👇'}</div></div>
    <div class="nw-list">${body}</div>
    ${all ? '' : `<div class="row2 nw-btns">${first ? `<button class="btn grad" id="nwShow">👀 ${seen.length ? 'הבא' : 'תראו לי'}</button>` : ''}<button class="btn ghost" id="nwOk">הבנתי ✓</button></div>`}`, sh => {
    const goTo = key => {
      const f = NEWS_GO[key]; if (!f) return;
      newsBack = { all, items, scroll: $('#sheet').scrollTop, seen: [...new Set([...seen, key])] };
      closeSheet(); setTimeout(() => { f(); if (key !== 'news') newsFab(); }, 250);
    };
    sh.querySelectorAll('[data-ng]').forEach(b => b.onclick = e => { e.stopPropagation(); goTo(b.dataset.ng); });
    sh.querySelector('#nwShow')?.addEventListener('click', () => goTo(first.go));
    sh.querySelector('#nwOk')?.addEventListener('click', () => { newsBack = null; closeSheet(); });
    sh.querySelector('#nwAll')?.addEventListener('click', () => openNews(true));
    if (restore && newsBack) requestAnimationFrame(() => { $('#sheet').scrollTop = newsBack.scroll; });
  });
}
// ✨ כפתור צף: חזרה לרשימת "מה חדש" אחרי שניסו משהו. נשאר עד "הבנתי ✓" או ✕
function newsFab() {
  $('.news-fab')?.remove();
  if (!newsBack) return;
  const d = document.createElement('div'); d.className = 'news-fab';
  d.innerHTML = '<button class="nf-go">✨ חזרה למה חדש</button><button class="nf-x" aria-label="סגירה">✕</button>';
  d.querySelector('.nf-go').onclick = () => { const b = newsBack; if (b) openNews(b.all, b.items, true); };
  d.querySelector('.nf-x').onclick = () => { newsBack = null; d.remove(); };
  $('#app').appendChild(d);
}

// 🪄 / ✍️ — מעבר בין תקציב אוטומטי לידני בכל רגע. הסכומים הידניים נשמרים בצד (_saved) כדי לחזור אליהם
async function setBudgetMode(mode) {
  if (S.budgets._mode === mode) { toast(mode === 'auto' ? '🪄 התקציב כבר אוטומטי' : '✍️ כבר אתם קובעים — לשינוי סכום לוחצים על קטגוריה'); return; }
  const { _mode, _saved, ...cur } = S.budgets; void _mode;
  const own = Object.fromEntries(Object.entries(cur).filter(([, v]) => v != null));
  if (mode === 'auto') {
    S.budgets = { _mode: 'auto', ...(Object.keys(own).length ? { _saved: own } : {}) };
    await saveKV('budgets', S.budgets); renderAll(); confetti();
    toast(Object.keys(own).length ? '🪄 חזרנו לתקציב אוטומטי — הסכומים שקבעתם נשמרו בצד' : '🪄 התקציב אוטומטי — מתעדכן לבד לפי ההוצאות');
  } else if (_saved) {
    S.budgets = { _mode: 'manual', ..._saved, ...own };
    await saveKV('budgets', S.budgets); renderAll(); toast('✍️ חזרו הסכומים שקבעתם');
  } else openBudgetManual();
}
// 🔎 פירוט ההוצאות: לפי קטגוריה ולפי מי שהוציא
function openExpenses(m = S.month) {
  const list = txInMonth(m).filter(t => t.cat !== 'income'), total = list.reduce((s, t) => s + amountIn(t, m), 0);
  const byCat = {}, byWho = {};
  for (const t of list) { const v = amountIn(t, m); byCat[t.cat] = (byCat[t.cat] || 0) + v; const w = t.who && personOf(t.who) ? t.who : ''; byWho[w] = (byWho[w] || 0) + v; }
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]), who = Object.entries(byWho).sort((a, b) => b[1] - a[1]);
  const pct = v => total ? Math.round(v / total * 100) : 0;
  openSheet(`<h3>🔎 לאן הלך הכסף</h3>
    <div class="monthnav" style="justify-content:space-between;margin-bottom:12px"><button data-em="-1" aria-label="חודש קודם">›</button><span>${monthLabel(m)}</span><button data-em="1" aria-label="חודש הבא">‹</button></div>
    <div class="card" style="text-align:center;margin-bottom:12px"><small class="sub">יצא החודש</small><div class="big-num">${fmt(total)}</div><small class="sub">${list.length} הוצאות</small></div>
    ${cats.length ? `<b>🏷️ לפי קטגוריה</b><div class="card xb-list" style="padding:4px 12px;margin:6px 0 14px">${cats.map(([id, v], i) => { const c = catOf(id); return `<button class="xb" data-xc="${id}" style="--d:${i * 50}ms"><div class="cat-ic" style="background:${c.g}">${c.e}</div><div class="nm"><div class="xb-h"><span>${esc(c.n)}</span><b>${fmt(v)}</b></div><div class="pbar"><i style="width:${pct(v)}%;background:${c.g}"></i></div><small class="sub">${pct(v)}% מההוצאות</small></div></button>`; }).join('')}</div>
    <b>👪 לפי מי</b><div class="card xb-list" style="padding:4px 12px;margin-top:6px">${who.map(([w, v], i) => `<div class="xb" style="--d:${i * 50}ms"><div class="cat-ic" style="background:var(--g1)">${w ? esc(personOf(w).e) : '👥'}</div><div class="nm"><div class="xb-h"><span>${w ? esc(personOf(w).name) : 'בלי שם / כולם'}</span><b>${fmt(v)}</b></div><div class="pbar"><i style="width:${pct(v)}%;background:var(--g1)"></i></div><small class="sub">${pct(v)}%</small></div></div>`).join('')}</div>
    <div class="sub" style="text-align:center;margin-top:10px">לחיצה על קטגוריה — כל ההוצאות שבה</div>`
    : '<div class="empty"><span class="em">🌱</span>אין הוצאות בחודש הזה</div>'}`, sh => {
    sh.querySelectorAll('[data-em]').forEach(x => x.onclick = () => openExpenses(addMonths(m, Number(x.dataset.em))));
    sh.querySelectorAll('[data-xc]').forEach(x => x.onclick = () => openCategory(x.dataset.xc, m));
  });
}
function openBudgetEdit(id) {
  const c = CATS[id], r = recommend(id);
  openSheet(`<h3>${c.e} תקציב ל${c.n}</h3>
    <label class="field"><span>כמה מותר להוציא בחודש?</span><input id="bIn" type="number" inputmode="numeric" value="${budgetOf(id)}"></label>
    <div class="err" id="bErr"></div>
    ${r ? `<div class="card tip" style="margin-bottom:12px"><div class="em">🪄</div><p><b>המלצה: ${fmt(r)}</b><br>לפי ההוצאות שלך בפועל</p></div>` : ''}
    <div class="row2">${r ? `<button class="btn ghost" id="bReco">השתמש בהמלצה</button>` : ''}<button class="btn grad" id="bSave">שמירה</button></div>`, sh => {
    const save = async v => {
      if (!(v > 0)) { sh.querySelector('#bErr').textContent = 'צריך להזין סכום גדול מ-0'; return; }
      S.budgets[id] = Math.round(v); await db.setKV('budgets', S.budgets); closeSheet(); renderAll(); toast('🎯 התקציב עודכן');
    };
    sh.querySelector('#bIn').oninput = () => sh.querySelector('#bErr').textContent = '';
    sh.querySelector('#bSave').onclick = () => save(parseFloat(sh.querySelector('#bIn').value));
    sh.querySelector('#bReco')?.addEventListener('click', () => save(r));
  });
}
$('#recoBtn').onclick = () => {
  const rows = Object.entries(CATS).map(([id, c]) => [id, c, recommend(id)]).filter(x => x[2]);
  if (!rows.length) { toast('צריך קצת נתונים קודם — רשום הוצאות כמה ימים 🙂'); return; }
  openSheet(`<h3>🪄 המלצה לתקציב</h3><div class="sub" style="margin:-6px 0 12px">לפי ממוצע ההוצאות שלך בחודשים האחרונים, עם עיגול כלפי מעלה</div>
    <div class="card">${rows.map(([id, c, r]) => `<div class="tx" style="cursor:default"><div class="cat-ic" style="background:${c.g}">${c.e}</div><div class="nm"><div>${c.n}</div><small>עכשיו: ${fmt(budgetOf(id))}</small></div><div class="am">${fmt(r)}</div></div>`).join('')}</div>
    <button class="btn grad full" id="applyAll" style="margin-top:14px">החל את כל ההמלצות</button>`, sh => {
    sh.querySelector('#applyAll').onclick = async () => {
      for (const [id, , r] of rows) S.budgets[id] = r;
      await db.setKV('budgets', S.budgets); closeSheet(); renderAll(); toast('🎯 התקציב עודכן לפי ההמלצות'); confetti();
    };
  });
};

// ---------- תובנות ----------
function renderInsights() {
  const m = S.month, exp = expenseIn(m), inc = incomeIn(m);
  const parts = Object.entries(CATS).map(([id, c]) => ({ id, c, v: spentIn(id, m) })).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
  let acc = 0;
  $('#donut').style.background = exp ? `conic-gradient(${parts.map(p => { const a = acc; acc += p.v / exp * 100; return `${p.c.c} ${a}% ${acc}%`; }).join(',')})` : 'rgba(255,255,255,.08)';
  countUp($('#donutSum'), exp);
  $('#legend').innerHTML = parts.map(p => `<span><i style="background:${p.c.c}"></i>${p.c.n} ${Math.round(p.v / exp * 100)}%</span>`).join('');

  const tips = [];
  if (!exp && !inc) tips.push(['🌱', '<b>עוד אין נתונים לחודש הזה.</b> רשום כמה הוצאות בצ\'אט והתובנות יופיעו כאן.']);
  for (const p of parts) {
    const b = budgetOf(p.id); if (!b) continue;
    const pct = Math.round(p.v / b * 100);
    if (p.v > b) tips.push(['🚨', `<b>${p.c.n} עבר את התקציב ב-${pct - 100}%</b> (${fmt(p.v)} מתוך ${fmt(b)}).`]);
    else if (pct >= 80 && m === thisMonth()) tips.push(['⚠️', `<b>${p.c.n}: נוצלו ${pct}%</b> ונשארו ${daysLeft()} ימים לסוף החודש. כדאי להאט.`]);
  }
  if (inc) {
    const rate = (inc - exp) / inc;
    if (rate >= .1) tips.push(['🏆', `<b>חוסכים ${Math.round(rate * 100)}% מההכנסה</b> — מעולה! ${fmt(inc - exp)} נשארים בצד.`]);
    else if (rate < 0) tips.push(['📉', `<b>ההוצאות גבוהות מההכנסות ב-${fmt(exp - inc)}.</b> כדאי לבדוק איפה אפשר לקצץ.`]);
  }
  const prevExp = expenseIn(addMonths(m, -1));
  if (prevExp && exp) {
    const d = Math.round((exp - prevExp) / prevExp * 100);
    tips.push(d <= 0 ? ['👏', `<b>הוצאת ${Math.abs(d)}% פחות מהחודש הקודם</b> (${fmt(prevExp)} → ${fmt(exp)}).`]
                     : ['📊', `<b>הוצאת ${d}% יותר מהחודש הקודם</b> (${fmt(prevExp)} → ${fmt(exp)}).`]);
  }
  if (parts[0]) tips.push(['🥇', `<b>${parts[0].c.n}</b> היא ההוצאה הגדולה החודש — ${Math.round(parts[0].v / exp * 100)}% מכלל ההוצאות.`]);
  const subs = spentIn('subs', m);
  if (subs) tips.push(['📺', `<b>מנויים ותקשורת: ${fmt(subs)} בחודש</b> = ${fmt(subs * 12)} בשנה. שווה לבדוק שכולם באמת בשימוש.`]);
  const rest = spentIn('rest', m);
  if (rest > 150) tips.push(['🍕', `<b>צמצום של רבע מהמסעדות</b> יחסוך כ-${fmt(rest * .25 * 12)} בשנה.`]);
  const prevDescs = new Map(txInMonth(addMonths(m, -1)).filter(t => t.cat !== 'income' && !t.inst).map(t => [t.desc, t.amount]));
  const fixed = [...new Set(txInMonth(m).filter(t => t.cat !== 'income' && prevDescs.has(t.desc) && Math.abs(prevDescs.get(t.desc) - t.amount) <= t.amount * .1).map(t => t.desc))];
  if (fixed.length) tips.push(['🔁', `<b>הוצאות קבועות שזוהו:</b> ${fixed.slice(0, 5).map(esc).join(', ')}. אולי אפשר להוזיל אחת מהן?`]);
  if (S.people.length > 1) {
    const byWho = {};
    for (const t of txInMonth(m)) if (t.cat !== 'income') { const k = t.who || 'none'; byWho[k] = (byWho[k] || 0) + amountIn(t, m); }
    const rows = Object.entries(byWho).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    if (rows.length) tips.push(['👨‍👩‍👧', `<b>מי הוציא כמה:</b><br>${rows.map(([k, v]) => `${k === 'none' ? '❔ לא צוין' : (whoLabel(k))}: ${fmt(v)}`).join('<br>')}`]);
  }
  if (S.people.length > 1 && inc) {
    const incWho = {};
    for (const t of txInMonth(m)) if (t.cat === 'income') { const k = t.who || 'none'; incWho[k] = (incWho[k] || 0) + amountIn(t, m); }
    const rows = Object.entries(incWho).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    if (rows.length) tips.push(['💰', `<b>מי הכניס כמה:</b><br>${rows.map(([k, v]) => `${k === 'none' ? '❔ לא צוין' : (whoLabel(k))}: <span class="plus">${fmt(v)}</span> (${Math.round(v / inc * 100)}%)`).join('<br>')}`]);
  }
  const byPay = {};
  for (const t of txInMonth(m)) if (t.cat !== 'income') { const k = t.pay || 'none'; byPay[k] = (byPay[k] || 0) + amountIn(t, m); }
  const payParts = Object.entries(byPay).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (payParts.length) tips.push(['👛', `<b>איך שילמת החודש:</b><br>${payParts.map(([k, v]) => `${k === 'none' ? '❔ לא צוין' : PAY[k].e + ' ' + PAY[k].n}: ${fmt(v)}`).join('<br>')}`]);
  if (byPay.cash > 300) tips.push(['💵', `<b>${fmt(byPay.cash)} יצאו במזומן.</b> מזומן הכי קל "לאבד" — כדאי לרשום כל הוצאה במזומן מיד.`]);
  const inst = txInMonth(m).filter(t => t.inst > 1);
  if (inst.length) tips.push(['💳', `<b>${inst.length} תשלומים פעילים</b> בסך ${fmt(inst.reduce((s, t) => s + t.amount, 0))} החודש.`]);

  $('#tips').innerHTML = historyCard(m) + (m === thisMonth() ? fixedCard() : '') + hebCard() + tagsCard() + tips.map(([e, h]) => `<div class="card tip"><div class="em">${e}</div><p>${h}</p></div>`).join('');
}

// 📅 תשלומים קבועים ותשלומים שנגמרים — עם תזכורת בלחיצה ב"זמן בכיף"
const ZMAN_URL = 'https://zmanbekef.github.io/';
const zmanLink = (task, date) => `${ZMAN_URL}?task=${encodeURIComponent(task)}&date=${ymd(date)}&from=kesef`;
function fixedCard() {
  const rows = fixedPayments(S.tx, new Date(), S.recurring).map(f => f.kind === 'fixed'
    ? { e: catOf(f.cat).e, title: (f.rule ? '🔁 ' : '') + esc(f.desc), sub: `${f.rule && !f.variable ? '' : 'בערך '}${fmt(f.amount)} · הבא ב-${f.next.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })}`, href: zmanLink(`לשלם ${f.desc} (בערך ${Math.round(f.amount)}₪)`, f.remind) }
    : { e: '💳', title: esc(f.desc), sub: `התשלום האחרון (${f.inst}/${f.inst}) ב-${f.next.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })} · ${fmt(f.amount)} בחודש מתפנים`, href: zmanLink(`נגמרים התשלומים של ${f.desc} — ${Math.round(f.amount)}₪ בחודש מתפנים`, f.next) });
  if (!rows.length) return '';
  return `<div class="card"><b style="font-size:16px">📅 תשלומים קבועים</b><div class="sub" style="margin:2px 0 8px">מה עומד לרדת בקרוב — תזכורת ב"זמן בכיף" ⏰ או ביומן של הטלפון 📆</div>
    ${rows.slice(0, 8).map(r => `<div class="tx" style="cursor:default"><div class="cat-ic" style="background:var(--card2)">${r.e}</div><div class="nm"><div>${r.title}</div><small>${r.sub}</small></div>
      <a class="chip" href="${r.href}" target="_blank" rel="noopener" style="text-decoration:none;flex:none">📅 תזכורת</a></div>`).join('')}
    <button class="btn ghost full" data-calsub style="margin-top:10px">📆 להוסיף את כל התשלומים ליומן של הטלפון</button></div>`;
}
$('#tips').addEventListener('click', e => { if (e.target.closest('[data-calsub]')) openCalendarSub(); });
// 📆 מנוי ליומן (Google / אייפון): קישור אישי עם מפתח סודי — מתעדכן לבד
async function openCalendarSub() {
  if (db.DEMO) { toast('🎭 במצב הדגמה אין קישור ליומן — בטלפון האמיתי זה עובד', true); return; }
  openSheet(`<h3>📆 תשלומים קבועים ביומן</h3><div class="sub" style="margin:-6px 0 12px">⏳ מכין קישור אישי…</div>`);
  try {
    const url = await sync.calendarURL();
    const webcal = url.replace(/^https:/, 'webcal:'), g = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
    openSheet(`<h3>📆 תשלומים קבועים ביומן</h3><div class="sub" style="margin:-6px 0 12px">יומן אחד שמתעדכן לבד: כל תשלום קבוע (יום לפני), תשלומים שנגמרים, והחזרי הלוואות. פרטי — רק עם הקישור הזה.</div>
      <a class="btn grad full" href="${webcal}" style="display:block;text-align:center;text-decoration:none;margin-bottom:8px">🍏 אייפון / Mac — להוסיף ליומן</a>
      <a class="btn grad full" href="${g}" target="_blank" rel="noopener" style="display:block;text-align:center;text-decoration:none;margin-bottom:8px;background:linear-gradient(135deg,#3B82F6,#22C55E)">📅 Google יומן (גם אנדרואיד)</a>
      <button class="btn ghost full" id="calCopy">📋 העתקת הקישור</button>
      <div class="sub" style="margin-top:10px">💡 בגוגל: אחרי ההוספה היומן מופיע גם בטלפון האנדרואיד (אפליקציית Google Calendar). העדכון אצל גוגל לוקח עד כמה שעות.</div>`, sh => {
      sh.querySelector('#calCopy').onclick = async () => { try { await navigator.clipboard.writeText(url); toast('📋 הקישור הועתק'); } catch { toast(url); } };
    });
  } catch (e) { openSheet(`<h3>📆 יומן</h3><div class="err">${esc(e.message)}</div>`); }
}

// 🏷️ אירועים: כמה עלה כל אירוע (מכל הזמנים, בכל הקטגוריות)
function tagsCard() {
  const by = new Map();
  for (const t of S.tx) for (const g of t.tags || []) {
    const o = by.get(g) || { exp: 0, inc: 0, n: 0, cats: {} }; const v = t.inst > 1 ? t.total : t.amount;
    if (t.cat === 'income') o.inc += v; else { o.exp += v; o.cats[t.cat] = (o.cats[t.cat] || 0) + v; } o.n++; by.set(g, o);
  }
  if (!by.size) return '';
  const rows = [...by.entries()].sort((a, b) => b[1].exp - a[1].exp);
  return `<div class="card"><b style="font-size:16px">🏷️ אירועים</b><div class="sub" style="margin:2px 0 8px">כמה עלה כל אירוע — בכל הקטגוריות ביחד</div>
    ${rows.map(([g, o]) => `<button class="tx" data-tag="${esc(g)}"><div class="cat-ic" style="background:linear-gradient(135deg,#7C3AED,#EC4899)">🏷️</div>
      <div class="nm"><div>#${esc(g)}</div><small>${o.n} רשומות · ${Object.entries(o.cats).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => catOf(c).e).join(' ')}${o.inc ? ` · נכנס ${fmt(o.inc)}` : ''}</small></div>
      <div class="am">${fmt(o.exp)}</div></button>`).join('')}</div>`;
}
$('#tips').addEventListener('click', e => {
  const b = e.target.closest('[data-tag]'); if (!b) return;
  const g = b.dataset.tag, list = S.tx.filter(t => t.tags?.includes(g)).sort((a, b) => b.date.localeCompare(a.date));
  openSheet(`<h3>🏷️ #${esc(g)}</h3><div class="sub" style="margin:-6px 0 12px">${list.length} רשומות · סה״כ ${fmt(list.filter(t => t.cat !== 'income').reduce((s, t) => s + (t.inst > 1 ? t.total : t.amount), 0))}</div>
    <div class="card stg" style="padding:4px 12px">${list.map(t => { const c = catOf(t.cat);
      return `<button class="tx" data-ct="${t.id}"><div class="cat-ic" style="background:${c.g}">${c.e}</div><div class="nm"><div>${esc(t.desc)}</div><small>${c.n} · ${new Date(t.date).toLocaleDateString('he-IL')}</small></div><div class="am ${t.cat === 'income' ? 'plus' : ''}">${fmt(t.inst > 1 ? t.total : t.amount)}</div></button>`; }).join('')}</div>`, sh => {
    sh.querySelectorAll('[data-ct]').forEach(x => x.onclick = () => { const t = S.tx.find(y => y.id === x.dataset.ct); if (t) openEditSheet(t); });
  });
});

// תמונה לאורך זמן: עד 12 חודשים אחורה שיש בהם נתונים
function historyCard(m) {
  const months = [];
  for (let i = 11; i >= 0; i--) { const mm = addMonths(m, -i); if (txInMonth(mm).length) months.push(mm); }
  if (months.length < 2) return '';
  const rows = months.map(mm => ({ mm, inc: incomeIn(mm), exp: expenseIn(mm) }));
  const max = Math.max(...rows.map(r => Math.max(r.inc, r.exp)), 1);
  const avgExp = rows.reduce((s, r) => s + r.exp, 0) / rows.length, avgInc = rows.reduce((s, r) => s + r.inc, 0) / rows.length;
  const saved = rows.reduce((s, r) => s + r.inc - r.exp, 0);
  return `<div class="card">
    <b style="font-size:16px">📅 תמונה לאורך זמן · ${rows.length} חודשים</b>
    <div class="duo" style="padding:12px 0;grid-template-columns:1fr 1fr 1fr">
      <div class="stat" style="background:var(--card2);padding:10px"><small>הכנסה ממוצעת</small><div style="font-size:16px">${fmt(avgInc)}</div></div>
      <div class="stat" style="background:var(--card2);padding:10px"><small>הוצאה ממוצעת</small><div style="font-size:16px">${fmt(avgExp)}</div></div>
      <div class="stat" style="background:${saved >= 0 ? 'var(--g3)' : 'linear-gradient(135deg,#F43F5E,#F97316)'};padding:10px"><small>${saved >= 0 ? 'נחסך בסה״כ' : 'גירעון בסה״כ'}</small><div style="font-size:16px">${fmt(Math.abs(saved))}</div></div>
    </div>
    ${rows.map(r => `<button class="tx" data-goto="${r.mm}" style="padding:8px 0;display:block">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px"><b>${monthLabel(r.mm)}</b><span class="${r.inc - r.exp >= 0 ? 'plus' : 'over'}" style="direction:ltr">${r.inc - r.exp >= 0 ? '+' : ''}${fmt(r.inc - r.exp)}</span></div>
      <div style="height:7px;border-radius:6px;background:rgba(255,255,255,.06);margin-bottom:3px"><i style="display:block;height:100%;width:${r.inc / max * 100}%;border-radius:6px;background:linear-gradient(90deg,#22C55E,#14B8A6)"></i></div>
      <div style="height:7px;border-radius:6px;background:rgba(255,255,255,.06)"><i style="display:block;height:100%;width:${r.exp / max * 100}%;border-radius:6px;background:linear-gradient(90deg,#F43F5E,#F97316)"></i></div>
    </button>`).join('')}
    <div class="sub" style="margin-top:8px">🟩 הכנסות · 🟥 הוצאות · לחיצה על חודש פותחת אותו</div>
  </div>`;
}
$('#tips').addEventListener('click', e => { const b = e.target.closest('[data-goto]'); if (!b) return; S.month = b.dataset.goto; renderAll(); $('#main').scrollTo({ top: 0, behavior: 'smooth' }); });

// ---------- תנועות ----------
function renderTx() {
  const m = S.month, q = S.search.trim().toLowerCase();
  const used = [...new Set(txInMonth(m).map(t => t.cat))];
  $('#txFilter').innerHTML = `<button class="chip ${!S.catFilter ? 'on' : ''}" data-f="">הכל</button>` +
    used.map(id => `<button class="chip ${S.catFilter === id ? 'on' : ''}" data-f="${id}">${catOf(id).e} ${catOf(id).n}</button>`).join('');
  if (S.people.length > 1) $('#txFilter').innerHTML += S.people.map(p => `<button class="chip ${S.whoFilter === p.id ? 'on' : ''}" data-wf="${p.id}">${esc(p.e)} ${esc(p.name)}</button>`).join('');
  // 🔎 חיפוש לפי סכום: "230" (בערך ±1) או טווח "200-300"
  const qr = q.replace(/[₪,\s]/g, '').match(/^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/);
  const amtOk = t => { if (!qr) return false; const v = t.inst > 1 ? [t.amount, t.total] : [t.amount], a = +qr[1], b = qr[2] ? +qr[2] : null;
    return v.some(x => b !== null ? x >= Math.min(a, b) && x <= Math.max(a, b) : Math.abs(x - a) < 1); };
  const list = txInMonth(m).filter(t => (!S.catFilter || t.cat === S.catFilter) && (!S.whoFilter || t.who === S.whoFilter) && (!q || amtOk(t) || (!qr && (t.desc.toLowerCase().includes(q) || t.raw.toLowerCase().includes(q) || (t.tags || []).some(g => g.toLowerCase().includes(q.replace(/^#/, '')))))))
    .sort((a, b) => b.date.localeCompare(a.date));
  $('#txList').innerHTML = list.length ? list.map(t => {
    const c = catOf(t.cat), inc = t.cat === 'income';
    const extra = t.inst > 1 ? ` · תשלום ${installmentNo(t, m)}/${t.inst}` : '';
    return `<button class="tx" data-id="${t.id}"><div class="cat-ic" style="background:${c.g}">${c.e}</div><div class="nm"><div>${esc(t.desc)}</div><small>${c.n} · ${new Date(t.date).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })}${extra}${t.pay ? ' · ' + PAY[t.pay].e + ' ' + PAY[t.pay].n : ''}${t.who && personOf(t.who) ? ' · ' + (whoLabel(t.who)) : ''}${t.tags?.length ? ' · ' + t.tags.map(g => '#' + esc(g)).join(' ') : ''}${t.receipt ? ' · 🧾' : ''}${t.rec ? ' · 🔁' : ''}</small></div><div class="am ${inc ? 'plus' : ''}">${inc ? '+' : ''}${t.estimate ? '≈' : ''}${fmt(t.amount)}</div></button>`;
  }).join('') : `<div class="empty"><span class="em">🔍</span>אין תנועות ${S.catFilter || q ? 'שמתאימות לחיפוש' : 'בחודש הזה'}</div>`;
}
$('#txFilter').addEventListener('click', e => {
  const w = e.target.closest('[data-wf]');
  if (w) { S.whoFilter = S.whoFilter === w.dataset.wf ? null : w.dataset.wf; renderTx(); return; }
  const b = e.target.closest('[data-f]'); if (!b) return; S.catFilter = b.dataset.f || null; if (!b.dataset.f) S.whoFilter = null; renderTx();
});
$('#search').addEventListener('input', e => { S.search = e.target.value; renderTx(); });
$('#txList').addEventListener('click', e => {
  const b = e.target.closest('[data-id]'); if (!b) return;
  const t = S.tx.find(x => x.id === b.dataset.id); if (t) openEditSheet(t);
});

function openEditSheet(t) {
  let cat = t.cat, pay = t.pay || null, who = t.who || null, armed = false;
  openSheet(`<h3>✏️ עריכה</h3>
    ${t.raw && t.raw !== t.desc ? `<div class="sub" style="margin:-6px 0 12px">📝 נכתב במקור: "${esc(t.raw)}"</div>` : ''}
    <label class="field"><span>תיאור (מה זה היה)</span><input id="eDesc" value="${esc(t.desc)}"></label>
    <div class="row2">
      <label class="field"><span>${t.inst > 1 ? 'סכום כולל' : 'סכום'}</span><input id="eAmt" type="number" inputmode="decimal" value="${t.inst > 1 ? t.total : t.amount}"></label>
      <label class="field"><span>תאריך</span><input id="eDate" type="date" value="${ymd(new Date(t.date))}"></label>
    </div>
    ${t.inst > 1 ? `<div class="sub" style="margin:-4px 0 10px">${t.inst} תשלומים של ${fmt(t.amount)}</div>` : ''}
    <div class="err" id="eErr"></div>
    ${catGrid(cat)}
    <div class="sub" style="margin-bottom:8px">אמצעי תשלום</div>
    <div class="chips" id="ePay" style="flex-wrap:wrap;margin-bottom:14px">${Object.entries(PAY).map(([id, p]) => `<button class="chip ${id === pay ? 'on' : ''}" data-p="${id}">${p.e} ${p.n}</button>`).join('')}</div>
    ${S.people.length ? `<div class="sub" style="margin-bottom:8px">של מי?</div><div class="chips" id="eWho" style="flex-wrap:wrap;margin-bottom:14px">${whoChips(who)}</div>` : ''}
    ${tagField('eTag', t.tags || [])}
    ${t.cat !== 'income' && sync.isParent() ? '<button class="chip" id="eSplit" style="margin-bottom:10px">➗ לחלק את ההוצאה עם מישהו</button>' : ''}
    <div class="receipt" id="eRec">${t.receipt ? '<button class="chip" id="rShow">🧾 לראות את הקבלה</button> <button class="chip" id="rDel">🗑️ הסרה</button>' : '<button class="chip" id="rAdd">🧾 צילום קבלה</button>'}
      <input type="file" id="rFile" accept="image/*" capture="environment" hidden><input type="file" id="rGal" accept="image/*" hidden>${t.receipt ? '' : ' <button class="chip" id="rAddG">🖼️ מהגלריה</button>'}</div>
    ${t.cat === 'income' ? `<div class="chips" style="margin-bottom:14px"><button class="chip ${t.noMaaser ? 'on' : ''}" id="eNoM">🤲 בלי מעשר מההכנסה הזו</button></div>` : ''}
    <div id="eGive" class="give-seg" ${t.cat === 'give' ? '' : 'hidden'}><div class="sub" style="margin-bottom:6px">🤲 התרומה הזו —</div><div class="bmode"><button data-gx="0" class="${t.extraGive ? '' : 'on'}">🤲 מתוך המעשר</button><button data-gx="1" class="${t.extraGive ? 'on' : ''}">➕ בנוסף למעשר</button></div></div>
    <div class="row2"><button class="btn danger" id="eDel">🗑️ מחיקה</button><button class="btn grad" id="eSave">שמירה</button></div>`, sh => {
    sh.querySelectorAll('[data-cat]').forEach(btn => btn.onclick = () => {
      cat = btn.dataset.cat; sh.querySelectorAll('[data-cat]').forEach(x => x.classList.toggle('sel', x === btn));
      sh.querySelector('#eGive').hidden = cat !== 'give';
    });
    let gx = !!t.extraGive;
    sh.querySelectorAll('[data-gx]').forEach(b => b.onclick = () => { gx = b.dataset.gx === '1'; sh.querySelectorAll('[data-gx]').forEach(x => x.classList.toggle('on', x === b)); });
    sh.querySelectorAll('#eWho [data-w]').forEach(btn => btn.onclick = () => {
      who = btn.dataset.w; sh.querySelectorAll('#eWho [data-w]').forEach(x => x.classList.toggle('on', x === btn));
    });
    sh.querySelectorAll('[data-p]').forEach(btn => btn.onclick = () => {
      pay = btn.dataset.p; sh.querySelectorAll('[data-p]').forEach(x => x.classList.toggle('on', x === btn));
    });
    // 🧾 קבלה: מכווצים בטלפון לבערך 200KB, ושומרים בענן בתיקייה של המשפחה
    const recPick = async f => {
      if (!f) return;
      const box = sh.querySelector('#eRec'); box.innerHTML = '<span class="sub">⏳ מכווץ ושומר את הקבלה…</span>';
      try {
        const blob = await shrinkImage(f), path = await sync.uploadReceipt(t.id, blob);
        t.receipt = path; await db.putTx(t); toast('🧾 הקבלה נשמרה'); openEditSheet(t);
      } catch (e) { box.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
    };
    sh.querySelector('#rAdd')?.addEventListener('click', () => sh.querySelector('#rFile').click());
    sh.querySelector('#rAddG')?.addEventListener('click', () => sh.querySelector('#rGal').click());
    sh.querySelector('#rFile').onchange = e => recPick(e.target.files[0]);
    sh.querySelector('#rGal').onchange = e => recPick(e.target.files[0]);
    sh.querySelector('#rShow')?.addEventListener('click', async () => {
      try { const url = await sync.receiptURL(t.receipt); const ov = document.createElement('div'); ov.className = 'qr-zoom';
        ov.innerHTML = `<div class="qr-card" style="padding:10px"><img src="${url}" alt="קבלה" style="width:100%;max-height:70vh;object-fit:contain;border-radius:14px"><button class="btn grad full" style="margin-top:10px">סגירה</button></div>`;
        ov.onclick = ev => { if (ev.target === ov || ev.target.closest('button')) ov.remove(); }; document.body.appendChild(ov);
      } catch (e) { toast(e.message, true); }
    });
    sh.querySelector('#rDel')?.addEventListener('click', async () => { await sync.deleteReceipt(t.receipt); delete t.receipt; await db.putTx(t); toast('🗑️ הקבלה הוסרה'); openEditSheet(t); });
    sh.querySelector('#eSplit')?.addEventListener('click', () => openDebtNew({ kind: 'split', dir: 'lent', total: t.inst > 1 ? t.total : t.amount, note: t.desc }));
    let noM = !!t.noMaaser;
    sh.querySelector('#eNoM')?.addEventListener('click', e => { noM = !noM; e.currentTarget.classList.toggle('on', noM); });
    sh.querySelector('#eAmt').oninput = () => sh.querySelector('#eErr').textContent = '';
    sh.querySelector('#eSave').onclick = async () => {
      const v = parseFloat(sh.querySelector('#eAmt').value), d = sh.querySelector('#eDate').value;
      if (!(v > 0)) { sh.querySelector('#eErr').textContent = 'צריך להזין סכום גדול מ-0'; return; }
      if (!d) { sh.querySelector('#eErr').textContent = 'צריך לבחור תאריך'; return; }
      const desc = sh.querySelector('#eDesc').value.trim() || t.desc;
      if (cat !== t.cat) { const key = desc.toLowerCase(); if (key.length >= 2) { S.learned[key] = cat; await db.setKV('learned', S.learned); } }
      Object.assign(t, { desc, cat, pay, who, date: new Date(d + 'T12:00:00').toISOString() });
      const tg = readTags(sh, 'eTag'); if (tg.length) t.tags = tg; else delete t.tags;
      if (cat === 'income' && noM) t.noMaaser = true; else delete t.noMaaser;
      if (cat === 'give' && gx) t.extraGive = true; else delete t.extraGive;
      if (t.inst > 1) { t.total = v; t.amount = Math.round(v / t.inst * 100) / 100; } else { t.amount = v; t.total = v; }
      await db.putTx(t); closeSheet(); renderAll(); toast('✅ נשמר');
    };
    sh.querySelector('#eDel').onclick = async e => {
      if (!armed) { armed = true; e.target.textContent = 'בטוח? לחץ שוב'; return; }
      closeSheet(); await removeTx(t);
    };
  });
}

// ---------- ניווט וחודשים ----------
function renderMonthNav() {
  $$('[data-monthnav]').forEach(el => {
    el.innerHTML = `<button data-mn="-1" aria-label="חודש קודם">›</button><span>${monthLabel(S.month)}${hebOn() ? `<small class="hebm">${hebRange(S.month)}</small>` : ''}</span><button data-mn="1" aria-label="חודש הבא">‹</button>`;
  });
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-mn]'); if (!b) return;
  S.month = addMonths(S.month, Number(b.dataset.mn)); S.catFilter = null; renderAll();
});

function go(v, fromBack = false) {
  // ↩️ מעבר בין מסכים נרשם בהיסטוריה — "חזור" מחזיר למסך הקודם (ולא יוצא מהאפליקציה)
  if (!fromBack && v !== S.view && !$('#sheet').classList.contains('on')) {
    const top = nav[nav.length - 1];
    if (top?.t === 'view' && top.from === v) hDrop(1); // חזרה ידנית למסך הקודם = כמו "חזור"
    else { const from = S.view; hPush({ t: 'view', from, undo: () => go(from, true) }); }
  }
  S.view = v;
  $$('nav button[data-v]').forEach(x => x.classList.toggle('on', x.dataset.v === v));
  $$('.view').forEach(x => x.classList.toggle('on', x.id === 'v-' + v));
  $('#composer').style.display = v === 'chat' ? '' : 'none';
  if (v !== 'chat') { renderAll(); $('#main').scrollTo({ top: 0 }); }
  else { S.month = thisMonth(); renderChat(); }
}
$$('nav button[data-v]').forEach(b => b.onclick = () => { if (b.dataset.v === 'tx') S.catFilter = null; go(b.dataset.v); });

// ילד: רק מוסיף ורואה את מה שהוא רשם (ההגבלה האמיתית בשרת)
function applyRole() {
  const kid = !sync.isParent();
  document.body.classList.toggle('kid', kid);
  if (kid && (S.view === 'budget' || S.view === 'insights')) go('chat');
}

function renderAll(newIds) {
  applyRole();
  renderHero(); renderStories(); renderMonthNav(); renderBudget(); renderInsights(); renderTx(); renderQuick();
  if (S.view === 'chat') renderChat(newIds);
}

// ---------- כתיבה מהירה ----------
function renderQuick() {
  const count = {};
  for (const t of S.tx) count[t.desc] = (count[t.desc] || 0) + 1;
  const frequent = Object.entries(count).filter(([d]) => d !== 'הוצאה').sort((a, b) => b[1] - a[1]).slice(0, 6).map(([d]) => d);
  const defaults = ['סופר', 'טעינה לרכב', 'קפה', 'משכורת', 'חשמל', 'צדקה'];
  const words = [...new Set([...frequent, ...defaults])].slice(0, 8);
  // ❓ עזרה ראשונה בשורה — שלא תיעלם בסוף הגלילה
  $('#quick').innerHTML = '<button class="chip" data-helpchip="1">❓ עזרה</button>' + words.map(w => `<button class="chip" data-q="${esc(w)}">${catOf(isIncome(w) ? 'income' : classify(w, S.learned)).e} ${esc(w)}</button>`).join('');
}
$('#quick').addEventListener('click', e => {
  if (e.target.closest('[data-helpchip]')) { openHelp(); return; }
  const b = e.target.closest('[data-q]'); if (!b) return;
  const inp = $('#inp'); inp.value = b.dataset.q + ' '; inp.focus(); updateMic();
});

const inp = $('#inp');
function updateMic() { $('#mic').textContent = inp.value.trim() ? '➤' : '🎤'; }
inp.addEventListener('input', updateMic);
inp.addEventListener('keydown', e => { if (e.key === 'Enter') { send(inp.value); inp.value = ''; updateMic(); } });

// ---------- הודעה קולית ----------
// לחיצה קצרה = מקליט עד שלוחצים ⏹️ · החזקה = מדברים ומשחררים ונשלח
// בזמן החזקה: גרירה למעלה = נעילה (הקלטה ארוכה) · גרירה הצידה = ביטול
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = $('#mic');
const V = { on: false, mode: null, text: '', live: '', rec: null, t0: 0, timer: null, stopping: false, cancel: false, fatal: false, stopTap: false, x0: 0, y0: 0, downAt: 0 };
const MAX_REC = 3 * 60e3;

function voiceUI() {
  const bar = $('#recbar');
  document.body.classList.toggle('recording', V.on);
  bar.hidden = !V.on;
  mic.classList.toggle('rec', V.on);
  mic.classList.toggle('hold', V.on && V.mode === 'press');
  $('#recLock').hidden = !(V.on && V.mode === 'press');
  if (!V.on) { updateMic(); return; }
  mic.textContent = V.mode === 'press' ? '🎤' : '⏹️';
  mic.setAttribute('aria-label', V.mode === 'press' ? 'משחררים כדי לשלוח' : 'סיום ושליחה');
  showLive();
}
function showLive() {
  const t = (V.text + ' ' + V.live).trim();
  $('#recLive').textContent = t || (V.mode === 'press' ? '⬆️ למעלה לנעילה · ↔️ הצידה לביטול' : 'מקשיב… דבר עכשיו');
}
function tick() {
  const s = Math.floor((Date.now() - V.t0) / 1000);
  $('#recT').textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`;
  if (Date.now() - V.t0 > MAX_REC) finishVoice(true);
}
function listen() {
  const r = new SR(); V.rec = r;
  r.lang = 'he-IL'; r.interimResults = true; r.continuous = false;
  r.onresult = e => {
    let txt = ''; for (const x of e.results) txt += x[0].transcript;
    if (e.results[e.results.length - 1].isFinal) { V.text = (V.text + ' ' + txt).trim(); V.live = ''; } else V.live = txt;
    showLive();
  };
  r.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { V.fatal = true; toast('🎤 צריך לאשר גישה למיקרופון', true); }
    else if (e.error === 'network') { V.fatal = true; toast('🎤 כדי להקליט צריך חיבור לאינטרנט', true); }
  };
  // הדפדפן עוצר לבד אחרי שקט — ממשיכים להקשיב עד שהמשתמש עוצר
  r.onend = () => {
    if (V.rec !== r) return;
    V.text = (V.text + ' ' + V.live).trim(); V.live = '';
    if (V.on && !V.stopping && !V.fatal) { try { listen(); return; } catch {} }
    endVoice();
  };
  try { r.start(); } catch { V.fatal = true; V.rec = null; endVoice(); }
}
function startVoice() {
  if (!SR) { toast('🎤 הדפדפן הזה לא תומך בהקלטה. אפשר ללחוץ על המיקרופון במקלדת של הטלפון'); inp.focus(); return false; }
  Object.assign(V, { on: true, text: '', live: '', t0: Date.now(), stopping: false, cancel: false, fatal: false, stopTap: false });
  $('#recT').textContent = '0:00';
  V.timer = setInterval(tick, 250);
  navigator.vibrate?.(25);
  listen();
  return V.on;
}
function finishVoice(sendIt) {
  if (!V.on) return;
  V.stopping = true; V.cancel = !sendIt;
  const r = V.rec;
  if (!r) { endVoice(); return; }
  try { sendIt ? r.stop() : r.abort(); } catch { endVoice(); return; }
  setTimeout(() => { if (V.on && V.rec === r) endVoice(); }, 2500); // ליתר ביטחון
}
function endVoice() {
  if (!V.on) return;
  V.on = false; V.rec = null; clearInterval(V.timer);
  const t = V.cancel ? '' : (V.text + ' ' + V.live).trim();
  voiceUI();
  if (t) send(t, 'voice');
  else if (!V.cancel && !V.fatal) toast('🎤 לא שמעתי כלום, נסה שוב');
}

mic.addEventListener('pointerdown', e => {
  if (inp.value.trim()) return; // יש טקסט — הכפתור שולח (בלחיצה)
  e.preventDefault();
  if (V.on) { V.stopTap = true; return; }
  V.mode = 'press'; V.x0 = e.clientX; V.y0 = e.clientY; V.downAt = Date.now();
  if (!startVoice()) return;
  try { mic.setPointerCapture(e.pointerId); } catch {}
  voiceUI();
});
mic.addEventListener('pointermove', e => {
  if (!V.on || V.mode !== 'press') return;
  if (V.y0 - e.clientY > 60) { V.mode = 'locked'; navigator.vibrate?.(20); voiceUI(); }
  else if (Math.abs(e.clientX - V.x0) > 90) { finishVoice(false); toast('🗑️ ההקלטה בוטלה'); }
});
mic.addEventListener('pointerup', () => {
  if (V.stopTap) { V.stopTap = false; finishVoice(true); return; }
  if (!V.on || V.mode !== 'press') return;
  if (Date.now() - V.downAt < 400) { V.mode = 'tap'; voiceUI(); } // לחיצה קצרה — ממשיך להקליט עד ⏹️
  else finishVoice(true);                                         // החזקה — שחררו, שולחים
});
mic.addEventListener('pointercancel', () => { if (V.on && V.mode === 'press') { V.mode = 'tap'; voiceUI(); } });
mic.addEventListener('contextmenu', e => e.preventDefault());
mic.addEventListener('click', () => { if (!V.on && inp.value.trim()) { send(inp.value); inp.value = ''; updateMic(); } });
$('#recX').onclick = () => { finishVoice(false); toast('🗑️ ההקלטה בוטלה'); };

// ---------- העלאת קבצי אשראי ובנק ----------
const fpOf = (date, amount, desc) => `${ymd(date)}|${amount.toFixed(2)}|${desc}`;
const dayDist = (a, b) => Math.abs(new Date(a) - new Date(b)) / 864e5;

// מסמן כל שורה: חדשה / כבר יובאה / כבר נרשמה ידנית / חיוב אשראי מהבנק
function markDuplicates(items) {
  // הוצאה ידנית במזומן/ביט לא תופיע בפירוט אשראי — לא מתאימים אותה
  const payOk = (t, kind) => !t.pay || (kind !== 'bank' ? t.pay === 'credit' : t.pay !== 'cash');
  const fps = new Set(S.tx.map(t => t.fp).filter(Boolean));
  const used = new Set();
  for (const it of items) {
    it.fp = fpOf(it.date, it.amount, it.desc);
    if (fps.has(it.fp)) { it.status = 'dup-file'; continue; }
    fps.add(it.fp); // אותו קובץ שהועלה פעמיים באותה העלאה
    const manual = S.tx.find(t => t.source !== 'file' && !used.has(t.id) && payOk(t, it.kind) && (t.cat === 'income') === it.income &&
      Math.abs((t.inst > 1 ? t.amount : t.total ?? t.amount) - it.amount) <= 1 && dayDist(t.date, it.date) <= 3);
    if (manual) { used.add(manual.id); it.status = 'dup-manual'; it.match = manual.desc; continue; }
    it.status = it.ccCharge ? 'cc' : it.atm ? 'atm' : 'new';
  }
  for (const it of items) it.on = it.status === 'new';
}

const STATUS = {
  'dup-file': '🔁 כבר יובא בעבר',
  'cc': '💳 חיוב כרטיס אשראי — אם תעלה גם את פירוט הכרטיס זה ייספר פעמיים',
  'atm': '💵 משיכת מזומן — את ההוצאות עצמן רושמים כשמשלמים במזומן',
};

// 📎 — תפריט: קובץ מהבנק / צילום מסך מהגלריה / לצלם עכשיו
// (קלט נפרד לקבצים — אחרת אנדרואיד מציע רק מצלמה ותמונות)
const DOC_ACCEPT = '.xlsx,.xls,.csv,.txt,.pdf,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain';
function makePicker(accept, camera) {
  const i = document.createElement('input');
  i.type = 'file'; i.hidden = true; i.accept = accept; i.multiple = !camera;
  if (camera) i.setAttribute('capture', 'environment');
  i.onchange = () => { if (i.files.length) { const f = [...i.files]; closeSheet(); importFiles(f); } };
  document.body.appendChild(i);
  return i;
}
const PICK = { doc: makePicker(DOC_ACCEPT), img: makePicker('image/*'), cam: makePicker('image/*', true) };

function openAttachSheet() {
  openSheet(`<h3>📎 העלאת פירוט מהבנק או מהאשראי</h3>
    <div class="sub" style="margin:-6px 0 14px">מכל בנק וכל כרטיס אשראי · אפשר כמה קבצים יחד, גם חודשים אחורה</div>
    <button class="pick" data-pick="doc"><span class="pe" style="background:var(--g3)">📊</span><span><b>קובץ אקסל או PDF</b><small>שהורדת מהאתר או מהאפליקציה של הבנק / האשראי</small></span></button>
    <button class="pick" data-pick="img"><span class="pe" style="background:var(--g2)">🖼️</span><span><b>צילום מסך מהגלריה</b><small>צילום של רשימת התנועות באפליקציית הבנק</small></span></button>
    <button class="pick" data-pick="cam"><span class="pe" style="background:var(--g1)">📷</span><span><b>לצלם עכשיו</b><small>דף חיוב מודפס או קבלה</small></span></button>
    <div class="card" style="margin-top:6px"><b>🤔 מה קורה אחרי שבוחרים?</b>
      <div class="sub" style="margin-top:6px;line-height:1.9">1️⃣ האפליקציה קוראת את כל התנועות לבד<br>2️⃣ מוצגת רשימה לבדיקה — עם קטגוריה לכל שורה<br>3️⃣ מה שכבר נרשם מסומן 🔁 ולא ייכנס פעמיים<br>4️⃣ מתקנים אם צריך ולוחצים <b>"ייבוא"</b> ✅</div></div>
    <div class="dup-note">✋ מה שכבר רשמתם ידנית (בצ'אט או ב-➕) יזוהה ולא ייספר פעמיים</div>
    <div class="sub" style="margin-top:12px">💡 איפה מוצאים את הקובץ? באתר או באפליקציה של הבנק / חברת האשראי ← "פירוט חיובים" או "תנועות בחשבון" ← "ייצוא לאקסל" / "הורדה". הקובץ נשמר בתיקיית <b>"הורדות"</b>.</div>`, sh => {
    sh.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { const i = PICK[b.dataset.pick]; i.value = ''; i.click(); });
  });
}
$('#attach').onclick = openAttachSheet;

// ---------- ➕ הוספה בלי צ'אט: בוחרים קטגוריה וממלאים ----------
function openAddSheet() {
  const ids = ['income', ...Object.keys(CATS)];
  openSheet(`<h3>➕ מה מוסיפים?</h3>
    <div class="catgrid">${ids.map(id => { const c = catOf(id);
      return `<button class="catbtn${id === 'income' ? ' inc' : ''}" data-cat="${id}"><div class="cat-ic" style="background:${c.g}">${c.e}</div>${id === 'income' ? 'הכנסה' : c.n}</button>`; }).join('')}</div>
    <button class="btn ghost full" id="addFile">📎 או: העלאת פירוט מהבנק / אשראי</button>`, sh => {
    sh.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => openAddForm(b.dataset.cat));
    sh.querySelector('#addFile').onclick = openAttachSheet;
  });
}
const ADD_HINT = { income: 'משכורת', food: 'אושר עד', car: 'דלק / טעינה', rest: 'פיצה', home: 'חשמל', kids: 'חוג', health: 'קופת חולים', subs: 'נטפליקס', clothes: 'נעליים', fun: 'סרט', give: 'צדקה', other: 'מתנה' };
let addRecDefault = false; // נפתח מ"🔁 הקבועים שלי" — הטוגל דלוק מההתחלה
function openAddForm(cat) {
  const c = catOf(cat), inc = cat === 'income';
  let pay = null, who = S.me || null, rec = addRecDefault; addRecDefault = false;
  openSheet(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
      <div class="cat-ic" style="background:${c.g};width:44px;height:44px">${c.e}</div>
      <h3 style="margin:0;flex:1">${inc ? 'הכנסה חדשה' : c.n}</h3>
      <button class="chip" id="aBack">↩️ החלפה</button></div>
    <div class="row2">
      <label class="field"><span>סכום ₪</span><input id="aAmt" type="number" inputmode="decimal" placeholder="0"></label>
      <label class="field"><span>תאריך</span><input id="aDate" type="date" value="${ymd(new Date())}"></label>
    </div>
    <div class="rec-box ${rec ? 'on' : ''}" id="aRecBox"><button class="chip ${rec ? 'on' : ''}" id="aRec">🔁 קבוע כל חודש</button>
      <div class="rec-more"><div class="row2"><label class="field"><span>ביום בחודש</span><input id="aRecDay" type="number" inputmode="numeric" min="1" max="28" value="${Math.min(28, new Date().getDate())}"></label>
        <label class="field"><span>כמה חודשים?</span><input id="aRecN" type="number" inputmode="numeric" placeholder="♾️"></label></div>
        <div class="chips" id="aRecDur" style="flex-wrap:wrap;margin-bottom:10px"><button class="chip on" data-dur="0">♾️ ללא סוף</button><button class="chip" data-dur="3">3 חודשים</button><button class="chip" data-dur="6">חצי שנה</button><button class="chip" data-dur="12">שנה</button><button class="chip" data-dur="end">📅 עד תאריך</button></div>
        <label class="field" id="aRecEndF" style="display:none"><span>עד חודש</span><input id="aRecEnd" type="month"></label>
        <label class="chk"><input type="checkbox" id="aRecVar"> 💡 הסכום משתנה (כמו חשמל) — לשאול כל חודש כמה יצא</label></div></div>
    ${inc && S.people.length ? `<div class="who-box"><div class="who-q">👤 של מי ההכנסה?</div><div class="chips" id="aWho" style="flex-wrap:wrap">${whoChips(who)}</div></div>` : ''}
    <label class="field"><span>${inc ? 'מאיפה?' : 'על מה? / איפה?'} (לא חובה)</span><input id="aDesc" placeholder="למשל: ${ADD_HINT[cat] || ''}"></label>
    ${inc ? '' : `<label class="field"><span>מספר תשלומים (לא חובה)</span><input id="aInst" type="number" inputmode="numeric" placeholder="1"></label>`}
    <div class="err" id="aErr"></div>
    <div class="sub" style="margin-bottom:8px">${inc ? 'איך התקבל?' : 'איך שולם?'} (לא חובה)</div>
    <div class="chips" id="aPay" style="flex-wrap:wrap;margin-bottom:14px">${Object.entries(PAY).map(([id, p]) => `<button class="chip" data-p="${id}">${p.e} ${p.n}</button>`).join('')}</div>
    ${!inc && S.people.length ? `<div class="sub" style="margin-bottom:8px">של מי?</div><div class="chips" id="aWho" style="flex-wrap:wrap;margin-bottom:14px">${whoChips(who)}</div>` : ''}
    ${tagField('aTag', [])}
    <button class="btn grad full" id="aSave">✅ שמירה</button>`, sh => {
    sh.querySelector('#aBack').onclick = openAddSheet;
    sh.querySelectorAll('#aRecDur [data-dur]').forEach(b => b.onclick = () => {
      sh.querySelectorAll('#aRecDur [data-dur]').forEach(x => x.classList.toggle('on', x === b));
      const v = b.dataset.dur; sh.querySelector('#aRecEndF').style.display = v === 'end' ? '' : 'none';
      sh.querySelector('#aRecN').value = v === 'end' || v === '0' ? '' : v; if (v !== 'end') sh.querySelector('#aRecEnd').value = '';
    });
    sh.querySelector('#aRec').onclick = e => { rec = !rec; e.currentTarget.classList.toggle('on', rec); sh.querySelector('#aRecBox').classList.toggle('on', rec); };
    sh.querySelector('#aDate').onchange = e => { const d = new Date(e.target.value + 'T12:00:00'); if (!isNaN(d)) sh.querySelector('#aRecDay').value = Math.min(28, d.getDate()); };
    sh.querySelectorAll('#aPay [data-p]').forEach(b => b.onclick = () => {
      pay = pay === b.dataset.p ? null : b.dataset.p;
      sh.querySelectorAll('#aPay [data-p]').forEach(x => x.classList.toggle('on', x.dataset.p === pay));
    });
    sh.querySelectorAll('#aWho [data-w]').forEach(b => b.onclick = () => {
      who = b.dataset.w; sh.querySelectorAll('#aWho [data-w]').forEach(x => x.classList.toggle('on', x === b));
    });
    const amt = sh.querySelector('#aAmt'), err = sh.querySelector('#aErr');
    amt.oninput = () => err.textContent = '';
    setTimeout(() => amt.focus({ preventScroll: true }), 400);
    let force = false;
    sh.querySelector('#aSave').onclick = async () => {
      const total = parseFloat(amt.value), d = sh.querySelector('#aDate').value;
      if (!(total > 0)) { err.textContent = 'צריך להזין סכום גדול מ-0'; amt.focus(); return; }
      if (!d) { err.textContent = 'צריך לבחור תאריך'; return; }
      const desc = sh.querySelector('#aDesc').value.trim() || (inc ? 'הכנסה' : c.n);
      if (rec) { // 🔁 נשמר ככלל — והרישום עצמו נעשה לבד (גם החודש, אם היום כבר הגיע)
        const start = ym(new Date(d + 'T12:00:00')), day = Math.min(28, Math.max(1, Math.round(num(sh.querySelector('#aRecDay').value)) || 1));
        const end = recEnd(start, Math.round(num(sh.querySelector('#aRecN').value)), sh.querySelector('#aRecEnd').value);
        await saveRule('r_' + Math.random().toString(36).slice(2, 8), { desc: cleanName(desc), amount: total, cat, day, start, end, variable: sh.querySelector('#aRecVar').checked, who, pay });
        closeSheet(); const added = await postRecurring(); confetti();
        toast(`🔁 נשמר כקבוע: ${desc} · ${fmt(total)} כל ${day} לחודש${added.length ? '' : ' (יירשם ביום הזה)'}`); return;
      }
      const n = Math.round(parseFloat(sh.querySelector('#aInst')?.value) || 0), inst = !inc && n > 1 ? n : 0;
      const now = new Date();
      const t = { id: db.newId(), msg: db.newId(), raw: `${desc} ${total}${inst ? ` ב-${inst} תשלומים` : ''}`, desc, cat, source: 'plus',
        created: now.toISOString(), date: new Date(d + 'T12:00:00').toISOString(),
        amount: inst ? Math.round(total / inst * 100) / 100 : total, total, inst, pay: pay || (inst ? 'credit' : null), paySkip: !pay, who };
      const tg = readTags(sh, 'aTag'); if (tg.length) t.tags = tg;
      const dup = !force && findDup(t);
      if (dup) {
        force = true;
        err.innerHTML = `⚠️ נראה שזה כבר נרשם: "${esc(dup.desc)} · ${fmt(dup.inst > 1 ? dup.total : dup.amount)}" ב-${new Date(dup.date).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })}.<br>לוחצים שוב "שמירה" כדי לרשום בכל זאת.`;
        sh.querySelector('#aSave').textContent = '➕ לרשום בכל זאת';
        return;
      }
      // לומדים: אם כתבו שם חנות — בפעם הבאה בצ'אט היא תדע לאיזו קטגוריה
      const key = sh.querySelector('#aDesc').value.trim().toLowerCase();
      if (!inc && key.length >= 2 && classify(key, S.learned) !== cat) { S.learned[key] = cat; await db.setKV('learned', S.learned); }
      closeSheet();
      await commitTx([t]);
      toast(inc ? `💰 נרשמה הכנסה ${fmt(total)}` : `✅ נרשם: ${desc} · ${fmt(total)}`);
    };
  });
}
$('#plusBtn').onclick = openAddSheet;

// קורא קובץ אחד → { kind, items } או זורק שגיאה עם הודעה ידידותית
async function readOne(file, label) {
  if (imp.isImage(file.name) || file.type.startsWith('image/')) {
    let res;
    try { res = await imp.readImage(file, p => toast(`📸 ${label}קורא צילום מסך… ${p}%`), S.learned); }
    catch (err) { throw new Error(err.offline ? 'כדי לקרוא צילומי מסך צריך חיבור לאינטרנט בפעם הראשונה' : 'לא הצלחתי לקרוא את התמונה'); }
    if (!res.items.length) throw new Error('לא מצאתי סכומים בתמונה');
    return res;
  }
  if (!imp.isSupported(file.name)) throw new Error('אפשר להעלות אקסל, CSV, PDF או צילום מסך');
  let res;
  try { res = imp.extract(await imp.readSheets(file), S.learned); }
  catch (err) { console.error(err); throw new Error(err.scanned ? 'PDF סרוק בלי טקסט — נסה כצילום מסך' : 'לא הצלחתי לקרוא את הקובץ'); }
  if (!res.items.length) throw new Error('לא מצאתי תנועות בקובץ');
  return res;
}

async function importFiles(files) {
  const all = [], kinds = new Set(), errors = [], ok = [];
  for (const [i, f] of files.entries()) {
    const label = files.length > 1 ? `(${i + 1}/${files.length}) ` : '';
    toast(`📄 ${label}קורא את ${f.name}…`);
    try {
      const res = await readOne(f, label);
      for (const it of res.items) { it.kind = res.kind; it.file = f.name; }
      all.push(...res.items); kinds.add(res.kind); ok.push(f.name);
    } catch (e) { errors.push(`${f.name}: ${e.message}`); }
  }
  if (!all.length) { toast(errors[0] || 'לא נמצאו תנועות', true); return; }
  if (errors.length) setTimeout(() => toast(`⚠️ ${errors.length} קבצים לא נקראו: ${errors.join(' · ')}`, true), 400);
  markDuplicates(all);
  const kind = kinds.size === 1 ? [...kinds][0] : 'multi';
  openImportSheet(ok.length === 1 ? ok[0] : `${ok.length} קבצים`, { kind, items: all, files: ok });
}

function monthsSpan(dates) {
  if (!dates.length) return '';
  const ms = [...new Set(dates.map(d => ym(new Date(d))))].sort();
  return ms.length === 1 ? monthLabel(ms[0]) : `${monthLabel(ms[0]).split(' ')[0]}–${monthLabel(ms[ms.length - 1])} (${ms.length} חודשים)`;
}

function openImportSheet(name, { kind, items, files = [name] }) {
  let fileWho = S.me;
  const count = s => items.filter(i => i.status === s).length;
  const catOptions = sel => [...Object.keys(CATS), 'income'].map(id => `<option value="${id}" ${id === sel ? 'selected' : ''}>${catOf(id).e} ${catOf(id).n}</option>`).join('');
  const sorted = items.map((it, i) => ({ it, i })).sort((a, b) => b.it.date - a.it.date);
  openSheet(`<h3>📄 ${esc(name)}</h3>
    <div class="sub" style="margin:-6px 0 12px">${kind === 'multi' ? '📚 ' + files.map(esc).join(' · ') : kind === 'bank' ? '🏦 דף חשבון בנק' : kind === 'image' ? '📸 צילום מסך — כדאי לעבור על השורות, הזיהוי לא תמיד מדויק' : '💳 פירוט כרטיס אשראי'}<br>${items.length} תנועות · ${monthsSpan(items.map(i => i.date))}</div>
    <div class="duo" style="padding:0 0 12px;grid-template-columns:repeat(${count('dup-file') + count('dup-manual') + count('cc') + count('atm') ? 2 : 1},1fr)">
      <div class="stat" style="background:var(--g3)"><small>חדשות לייבוא</small><div id="impCount">${count('new')}</div></div>
      ${count('dup-file') + count('dup-manual') + count('cc') + count('atm') ? `<div class="stat" style="background:var(--card2)"><small>דילגתי (כפילויות)</small><div>${count('dup-file') + count('dup-manual') + count('cc') + count('atm')}</div></div>` : ''}
    </div>
    <div class="dup-note" style="margin-bottom:12px">✋ מה שכבר רשמתם ידנית יזוהה ולא ייספר פעמיים</div>
    ${S.people.length ? `<div class="sub" style="margin-bottom:6px">של מי ${kind === 'bank' ? 'החשבון' : kind === 'multi' ? 'הקבצים' : 'הכרטיס'}?</div><div class="chips" id="impWho" style="flex-wrap:wrap;margin-bottom:12px">${whoChips(fileWho)}</div>` : ''}
    ${count('dup-manual') ? `<div class="card tip" style="margin-bottom:10px"><div class="em">🧠</div><p><b>${count('dup-manual')} תנועות כבר רשמת בצ'אט</b> — סימנתי אותן כדי שלא ייספרו פעמיים.</p></div>` : ''}
    ${count('cc') ? `<div class="card tip" style="margin-bottom:10px"><div class="em">💳</div><p><b>${count('cc')} חיובי כרטיס אשראי</b> לא סומנו. את הפירוט שלהם עדיף להעלות מקובץ חברת האשראי.</p></div>` : ''}
    ${count('atm') ? `<div class="card tip" style="margin-bottom:10px"><div class="em">💵</div><p><b>${count('atm')} משיכות מזומן</b> לא סומנו — כדי שלא ייספרו פעמיים עם ההוצאות שתרשום במזומן.</p></div>` : ''}
    <div class="card" style="padding:4px 12px">${sorted.map(({ it, i }) => `
      <div class="tx imp-row" style="cursor:default;${it.on ? '' : 'opacity:.55'}" data-i="${i}">
        <input type="checkbox" ${it.on ? 'checked' : ''} style="width:20px;height:20px;accent-color:#EC4899;flex:none">
        <div class="nm">${it.kind === 'image' ? `<input class="imp-desc" value="${esc(it.desc)}" placeholder="✏️ מה זה היה? (שופרסל, דלק…)" style="width:100%;background:var(--card2);border:1px solid ${it.needsDesc ? '#EC4899' : 'var(--line)'};border-radius:10px;padding:6px 8px;outline:none">` : `<div>${esc(it.desc)}</div>`}
          <small>${it.date.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' })}${it.note ? ' · ' + esc(it.note) : ''}${files.length > 1 ? ' · 📄 ' + esc(it.file) : ''}</small>
          ${it.status !== 'new' ? `<small style="color:#F9A8D4">${it.status === 'dup-manual' ? '✋ כבר רשום: "' + esc(it.match) + '"' : STATUS[it.status]}</small>` : ''}
          <select class="imp-cat" style="margin-top:6px;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:4px 6px;max-width:100%">${catOptions(it.cat)}</select>
        </div>
        <div class="am ${it.income ? 'plus' : ''}">${it.income ? '+' : ''}${fmt(it.amount)}</div>
      </div>`).join('')}</div>
    <button class="btn grad full" id="impGo" style="margin-top:14px;position:sticky;bottom:0">${count('new') ? `ייבוא ${count('new')} תנועות` : 'אין תנועות חדשות — הכל כבר רשום 👌'}</button>`, sh => {
    const refresh = () => {
      const n = items.filter(i => i.on).length;
      sh.querySelector('#impCount').textContent = n;
      sh.querySelector('#impGo').textContent = n ? `ייבוא ${n} תנועות` : 'לא נבחרו תנועות';
    };
    sh.querySelectorAll('#impWho [data-w]').forEach(b => b.onclick = () => {
      fileWho = b.dataset.w; sh.querySelectorAll('#impWho [data-w]').forEach(x => x.classList.toggle('on', x === b));
    });
    sh.querySelectorAll('.imp-row').forEach(row => {
      const it = items[row.dataset.i];
      row.querySelector('input').onchange = e => { it.on = e.target.checked; row.style.opacity = it.on ? '' : '.55'; refresh(); };
      const di = row.querySelector('.imp-desc');
      if (di) {
        di.oninput = () => {
          it.desc = di.value.trim();
          if (!it.catChanged && !it.income) { it.cat = classify(it.desc, S.learned); row.querySelector('.imp-cat').value = it.cat; }
        };
      }
      const sel = row.querySelector('.imp-cat');
      sel.onchange = () => { it.cat = sel.value; it.income = sel.value === 'income'; it.catChanged = true; };
    });
    sh.querySelector('#impGo').onclick = async () => {
      const chosen = items.filter(i => i.on);
      for (const it of chosen) if (!it.desc) it.desc = 'הוצאה מצילום מסך';
      if (!chosen.length) { toast('סמן לפחות תנועה אחת', true); return; }
      const msg = db.newId(), now = new Date().toISOString(), ids = [];
      for (const it of chosen) {
        const t = { id: db.newId(), msg, raw: files.join(', '), desc: it.desc, cat: it.cat, source: 'file', created: now,
          date: it.date.toISOString(), amount: it.amount, total: it.amount, inst: 0, fp: it.fp, note: it.note || '',
          pay: it.kind === 'card' || it.ccCharge ? 'credit' : it.kind === 'image' ? detectPay(it.desc) : (detectPay(it.desc + ' ' + (it.note || '')) || 'transfer'),
          who: fileWho || null };
        S.tx.push(t); await db.putTx(t); ids.push(t.id);
        if (it.catChanged) S.learned[it.desc.toLowerCase()] = it.cat;
      }
      if (chosen.some(i => i.catChanged)) await db.setKV('learned', S.learned);
      closeSheet(); go('chat'); renderAll(ids); confetti();
      const had = count('dup-manual') + count('dup-file');
      toast(`✅ ${chosen.length} חדשות${had ? ` · ${had} כבר היו רשומות` : ''}`);
      const b = document.createElement('div'); b.className = 'bot new';
      b.innerHTML = `<div class="cat-ic" style="background:var(--g3)">📎</div><div><b>הייבוא הסתיים 🎉</b><div class="sub">✅ <b>${chosen.length}</b> תנועות חדשות נכנסו${had ? ` · 🔁 <b>${had}</b> כבר היו רשומות — לא נספרו פעמיים` : ''}${items.length - chosen.length - had > 0 ? ` · ⏭️ ${items.length - chosen.length - had} דילגת` : ''}</div></div>`;
      $('#chat').appendChild(b); setTimeout(() => $('#main').scrollTo({ top: $('#main').scrollHeight, behavior: 'smooth' }), 300);
    };
  });
}

async function undoImport(msg) {
  const list = S.tx.filter(t => t.msg === msg);
  for (const t of list) await db.delTx(t.id);
  S.tx = S.tx.filter(t => t.msg !== msg);
  renderAll(); toast(`↩️ בוטל ייבוא של ${list.length} תנועות`);
}

// גרירת קובץ לחלון (במחשב)
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) importFiles([...e.dataTransfer.files]); });

// ---------- הורדת סיכום לאקסל ----------
function openExportSheet(kind = 'month', anchor = new Date(), initRange = null) {
  let range = initRange || { from: new Date(new Date().getFullYear(), new Date().getMonth(), 1), to: new Date() };
  const canShare = file => navigator.canShare?.({ files: [file] }) && matchMedia('(pointer:coarse)').matches;
  const draw = () => {
    const st = xp.quickStats(S.tx, kind, kind === 'range' ? range : anchor);
    openSheet(`<h3>📊 סיכום לאקסל</h3>
      <div class="sub" style="margin:-6px 0 12px">קובץ צבעוני לקריאה, עם טבלת תנועות שאפשר גם להעלות ל-AI לניתוח</div>
      <div class="chips" style="margin-bottom:12px">${Object.entries(xp.KINDS).map(([k, n]) => `<button class="chip ${k === kind ? 'on' : ''}" data-k="${k}">${n}</button>`).join('')}</div>
      ${kind === 'range' ? `<div class="row2"><label class="field"><span>מתאריך</span><input type="date" id="rFrom" value="${ymd(range.from)}"></label><label class="field"><span>עד תאריך</span><input type="date" id="rTo" value="${ymd(range.to)}"></label></div><div class="err" id="rErr"></div>`
        : `<div class="monthnav" style="justify-content:space-between;margin-bottom:12px"><button data-sh="-1" aria-label="קודם">›</button><span>${st.label}</span><button data-sh="1" aria-label="הבא">‹</button></div>`}
      <div class="duo" style="padding:0 0 14px;grid-template-columns:1fr 1fr 1fr">
        <div class="stat" style="background:var(--g3)"><small>הכנסות</small><div style="font-size:17px">${fmt(st.inc)}</div></div>
        <div class="stat" style="background:linear-gradient(135deg,#F43F5E,#F97316)"><small>הוצאות</small><div style="font-size:17px">${fmt(st.exp)}</div></div>
        <div class="stat" style="background:var(--card2)"><small>תנועות</small><div style="font-size:17px">${st.count}</div></div>
      </div>
      <div class="row2"><button class="btn grad" id="xDown">⬇️ הורדה</button>${navigator.canShare ? '<button class="btn ghost" id="xShare">📤 שיתוף</button>' : ''}</div>
      <div class="sub" style="text-align:center;margin-top:10px">טיפ: אפשר גם לכתוב בצ'אט "סיכום שבועי" או "סיכום שנתי"</div>`, sh => {
      sh.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { kind = b.dataset.k; draw(); });
      sh.querySelectorAll('[data-sh]').forEach(b => b.onclick = () => { anchor = xp.shiftAnchor(kind, anchor, Number(b.dataset.sh)); draw(); });
      sh.querySelectorAll('#rFrom,#rTo').forEach(inp => inp.onchange = () => {
        const f = sh.querySelector('#rFrom').value, t = sh.querySelector('#rTo').value;
        if (!f || !t) { sh.querySelector('#rErr').textContent = 'צריך לבחור שני תאריכים'; return; }
        range = { from: new Date(f + 'T12:00:00'), to: new Date(t + 'T12:00:00') };
        if (range.from > range.to) range = { from: range.to, to: range.from };
        draw();
      });
      const make = async () => {
        toast('🎨 מכין קובץ צבעוני…');
        return xp.buildWorkbook({ tx: S.tx, budgets: S.budgets, people: S.people, kind, anchor: kind === 'range' ? range : anchor });
      };
      sh.querySelector('#xDown').onclick = async () => {
        try {
          const { blob, name } = await make();
          const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
          toast('✅ הקובץ ירד'); confetti();
        } catch (e) { console.error(e); toast('לא הצלחתי להכין את הקובץ', true); }
      };
      sh.querySelector('#xShare')?.addEventListener('click', async () => {
        try {
          const { blob, name } = await make();
          const file = new File([blob], name, { type: blob.type });
          if (!canShare(file) && !navigator.canShare?.({ files: [file] })) { toast('השיתוף לא נתמך כאן — השתמש בהורדה', true); return; }
          await navigator.share({ files: [file], title: name });
        } catch (e) { if (e.name !== 'AbortError') toast('השיתוף לא הצליח — נסה הורדה', true); }
      });
    });
  };
  draw();
}
$('#exportBtn').onclick = () => openExportSheet(S.view === 'chat' ? 'month' : 'month', S.view === 'chat' ? new Date() : new Date(S.month + '-01T12:00:00'));

// מכווץ תמונה (צילום קבלה) לבערך 200KB — רוחב עד 1280, JPEG
async function shrinkImage(file) {
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) throw new Error('לא הצלחתי לפתוח את התמונה');
  const k = Math.min(1, 1280 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  let q = .8, blob;
  for (let i = 0; i < 6; i++) { blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q)); if (blob.size <= 220 * 1024) break; q -= .12; }
  return blob;
}

// ========== שלב 2: 🐷 קופות חיסכון · 🤲 מעשר · 🧒 דמי כיס ==========
const num = v => Math.round((parseFloat(v) || 0) * 100) / 100;
const saveKV = async (k, v) => { S[k] = v; await db.setKV(k, v); };
const ringBg = (p, col) => `conic-gradient(${col} ${Math.min(100, p)}%, rgba(255,255,255,.12) 0)`;
const monthsUntil = m => { if (!m) return 0; const [y, mo] = m.split('-').map(Number), n = new Date(); return (y - n.getFullYear()) * 12 + (mo - 1 - n.getMonth()) + 1; };

// ---------- 🐷 קופות חיסכון ----------
// S.goals = { id: { n, e, target, date: 'YYYY-MM', dep: [{ d, a, w }] } }
const goalSaved = g => (g.dep || []).reduce((s, x) => s + x.a, 0);
function openGoals() {
  sheetReopen = () => openGoals();
  const list = Object.entries(S.goals || {});
  openSheet(`<h3>🐷 קופות חיסכון</h3><div class="sub" style="margin:-6px 0 12px">חוסכים למשהו? פותחים קופה עם יעד ותאריך — והאפליקציה אומרת כמה לשים בצד כל חודש.</div>
    ${list.length ? `<div class="stg" style="display:flex;flex-direction:column;gap:10px">${list.map(([id, g]) => {
      const saved = goalSaved(g), p = g.target ? saved / g.target * 100 : 0, left = Math.max(0, g.target - saved), mo = monthsUntil(g.date);
      const hint = left <= 0 ? '🎉 הגעתם ליעד!' : mo > 0 ? `כדאי לשים בצד <b>${fmt(left / mo)}</b> בחודש (עוד ${mo} חודשים)` : g.date ? '⏰ התאריך עבר — עוד ' + fmt(left) : `חסרים ${fmt(left)}`;
      return `<button class="card goal-card" data-goal="${id}"><div class="ring2" style="background:${ringBg(p, p >= 100 ? '#22C55E' : '#EC4899')}"><b>${esc(g.e || '🐷')}</b></div>
        <div class="nm"><div style="font-weight:700">${esc(g.n)}</div><small class="sub">${fmt(saved)} מתוך ${fmt(g.target)}${g.date ? ' · עד ' + monthLabel(g.date) : ''}</small><div class="sub" style="margin-top:2px">${hint}</div></div>
        <div style="font-weight:800;font-size:18px">${Math.round(p)}%</div></button>`; }).join('')}</div>`
      : `<div class="empty"><span class="em">🐷</span>עוד אין קופות. למשל: חתונה של הבן, פסח, רכב חדש</div>`}
    <button class="btn grad full" id="gNew" style="margin-top:12px">➕ קופה חדשה</button>`, sh => {
    sh.querySelector('#gNew').onclick = () => openGoalEdit(null);
    sh.querySelectorAll('[data-goal]').forEach(b => b.onclick = () => openGoal(b.dataset.goal));
  });
}
function openGoalEdit(id) {
  const g = id ? S.goals[id] : null; let e = g?.e || '🐷', armed = false;
  const EM = ['🐷', '💍', '🏠', '🚗', '✈️', '🕎', '🎓', '👶', '🎁', '💻', '🛋️', '⭐'];
  openSheet(`<h3>${g ? '✏️ עריכת קופה' : '➕ קופה חדשה'}</h3>
    <label class="field"><span>למה חוסכים?</span><input id="gN" maxlength="30" value="${g ? esc(g.n) : ''}" placeholder="למשל: חתונה של משה"></label>
    <div class="emo-grid" id="gE" style="margin-bottom:12px;grid-template-columns:repeat(6,1fr)">${EM.map(x => `<button class="${x === e ? 'on' : ''}" data-e="${x}">${x}</button>`).join('')}</div>
    <div class="row2"><label class="field"><span>יעד ₪</span><input id="gT" type="number" inputmode="decimal" value="${g?.target || ''}" placeholder="20000"></label>
    <label class="field"><span>עד מתי? (לא חובה)</span><input id="gD" type="month" value="${g?.date || ''}"></label></div>
    <div class="err" id="gErr"></div><button class="btn grad full" id="gSave">💾 שמור</button>
    ${g ? '<button class="btn ghost full" id="gDel" style="margin-top:10px;color:#FB7185">🗑️ מחיקת הקופה</button>' : ''}`, sh => {
    sh.querySelectorAll('#gE [data-e]').forEach(b => b.onclick = () => { e = b.dataset.e; sh.querySelectorAll('#gE button').forEach(x => x.classList.toggle('on', x === b)); });
    sh.querySelector('#gSave').onclick = async () => {
      const n = sh.querySelector('#gN').value.replace(/[<>&"'`]/g, '').trim(), t = num(sh.querySelector('#gT').value);
      if (!n) { sh.querySelector('#gErr').textContent = 'צריך לתת שם לקופה'; return; }
      if (!(t > 0)) { sh.querySelector('#gErr').textContent = 'צריך יעד גדול מ-0'; return; }
      const key = id || 'g_' + Math.random().toString(36).slice(2, 8);
      await saveKV('goals', { ...S.goals, [key]: { ...(g || { dep: [] }), n, e, target: t, date: sh.querySelector('#gD').value || '' } });
      toast(g ? '✅ נשמר' : `🐷 נפתחה קופה: ${n}`); openGoal(key);
    };
    sh.querySelector('#gDel')?.addEventListener('click', async ev => {
      if (!armed) { armed = true; ev.target.textContent = 'לחיצה שנייה לאישור המחיקה'; return; }
      const { [id]: _, ...rest } = S.goals; await saveKV('goals', rest); toast('🗑️ הקופה נמחקה'); openGoals();
    });
  });
}
function openGoal(id) {
  const g = S.goals[id]; if (!g) return openGoals();
  const saved = goalSaved(g), p = g.target ? saved / g.target * 100 : 0, left = Math.max(0, g.target - saved), mo = monthsUntil(g.date);
  openSheet(`<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div class="ring2" style="background:${ringBg(p, p >= 100 ? '#22C55E' : '#EC4899')}"><b>${esc(g.e || '🐷')}</b></div>
      <div style="flex:1;min-width:0"><h3 style="margin:0">${esc(g.n)}</h3><div class="sub">${g.date ? 'עד ' + monthLabel(g.date) : 'בלי תאריך'}</div></div>
      <button class="chip" id="gBack">↩️ חזרה</button></div>
    <div class="card" style="text-align:center;margin-bottom:12px"><small class="sub">נחסך עד עכשיו</small><div class="big-num" id="gSaved">${fmt(saved)}</div>
      <div class="pbar" style="margin:8px 0"><i style="width:${Math.min(100, p)}%;background:linear-gradient(90deg,#EC4899,#F97316)"></i></div>
      <div class="sub">${left <= 0 ? '🎉 הגעתם ליעד!' : `חסרים ${fmt(left)}${mo > 0 ? ` · כדאי <b>${fmt(left / mo)}</b> בחודש` : ''}`}</div></div>
    <div class="row2"><label class="field"><span>סכום ₪</span><input id="gA" type="number" inputmode="decimal" placeholder="500"></label>
      <div style="display:flex;gap:6px;align-items:flex-end;margin-bottom:12px"><button class="btn grad" id="gIn" style="flex:1">➕ הפקדה</button><button class="btn ghost" id="gOut" style="flex:1">➖ משיכה</button></div></div>
    ${(g.dep || []).length ? `<div class="card" style="padding:4px 12px">${[...g.dep].reverse().slice(0, 30).map(x => `<div class="mv"><span>${new Date(x.d).toLocaleDateString('he-IL')}${x.w && personOf(x.w) ? ' · ' + whoLabel(x.w) : ''}</span><b class="${x.a > 0 ? 'plus' : 'over'}" dir="ltr">${x.a > 0 ? '+' : ''}${fmt(x.a)}</b></div>`).join('')}</div>` : ''}
    <button class="btn ghost full" id="gEdit" style="margin-top:12px">✏️ עריכת הקופה</button>`, sh => {
    sh.querySelector('#gBack').onclick = openGoals;
    sh.querySelector('#gEdit').onclick = () => openGoalEdit(id);
    const move = async sign => {
      const a = num(sh.querySelector('#gA').value); if (!(a > 0)) { sh.querySelector('#gA').focus(); return; }
      const before = goalSaved(g), dep = [...(g.dep || []), { d: new Date().toISOString(), a: sign * a, w: S.me || null }];
      await saveKV('goals', { ...S.goals, [id]: { ...g, dep } });
      if (sign > 0 && before < g.target && before + a >= g.target) { confetti(); toast(`🎉 הגעתם ליעד של ${g.n}!`); } else toast(sign > 0 ? `🐷 הופקדו ${fmt(a)}` : `➖ נמשכו ${fmt(a)}`);
      openGoal(id);
    };
    sh.querySelector('#gIn').onclick = () => move(1);
    sh.querySelector('#gOut').onclick = () => move(-1);
  });
}

// ---------- 🤲 מעשר / חומש — גמיש לגמרי ----------
// S.maaser = { pct, since, incOff: { 'משכורת': false… }, deduct, deductCats: [], giveCounts, dist: [{ id, name, v, unit: 'nis'|'pct', done }] }
const incKind = t => (t.desc || 'הכנסה').trim().split(/\s+/).slice(0, 2).join(' ');
function maaserCalc() {
  const M = S.maaser || {}, pct = M.pct || 10, since = M.since || '', incOff = M.incOff || {}, dCats = M.deduct ? (M.deductCats || []) : [];
  const inRange = t => !since || ym(new Date(t.date)) >= since;
  let inc = 0, ded = 0, giveExp = 0, extra = 0; const kinds = {}, months = {};
  for (const t of S.tx) {
    if (!inRange(t)) continue;
    const m = ym(new Date(t.date)), v = t.inst > 1 ? t.total : t.amount;
    months[m] ??= { inc: 0, given: 0 };
    if (t.cat === 'income') {
      const k = incKind(t); kinds[k] ??= { v: 0, n: 0 }; kinds[k].v += v; kinds[k].n++;
      if (!t.noMaaser && incOff[k] !== false) { inc += v; months[m].inc += v; }
    } else {
      if (dCats.includes(t.cat)) ded += v;
      // תרומה נספרת כ"ניתן" — אלא אם סומנה "בנוסף למעשר". חלוקה שסומנה ✅ במסך המעשר (mdist) תמיד נספרת
      if (t.cat === 'give' && !t.extraGive && (t.mdist || M.giveCounts !== false)) { giveExp += v; months[m].given += v; }
      if (t.cat === 'give' && t.extraGive) extra += v;
    }
  }
  const base = Math.max(0, inc - ded), owed = base * pct / 100;
  const dist = (M.dist || []).map(d => ({ ...d, nis: d.unit === 'pct' ? owed * (d.v || 0) / 100 : (d.v || 0) }));
  const planned = dist.reduce((s, d) => s + d.nis, 0), doneSum = dist.filter(d => d.done && !d.tx).reduce((s, d) => s + d.nis, 0); // ישנים — מלפני שחלוקה נרשמה כהוצאה
  const given = giveExp + doneSum;
  return { pct, since, inc, ded, base, owed, given, giveExp, extra, left: owed - given, kinds, months, dist, planned, toPlan: owed - planned };
}
const saveMaaser = async patch => { await saveKV('maaser', { ...S.maaser, ...patch }); openMaaser(); };
function openMaaser() {
  sheetReopen = () => openMaaser();
  const r = maaserCalc(), M = S.maaser || {};
  const custom = ![10, 20].includes(r.pct);
  const kinds = Object.entries(r.kinds).sort((a, b) => b[1].v - a[1].v);
  openSheet(`<h3>🤲 מעשר</h3><div class="sub" style="margin:-6px 0 10px">${r.pct === 20 ? 'חומש 20%' : r.pct + '%'}</div>
    <div class="card" style="text-align:center;margin-bottom:12px">
      <small class="sub">${r.left > 0 ? 'נשאר לתת' : r.left < 0 ? 'נתתם יותר — יתרה לזכותכם' : 'הכל ניתן 👏'}</small>
      <div class="big-num" id="mLeft" style="color:${r.left > 0 ? '#FACC15' : '#4ADE80'}">${fmt(Math.abs(r.left))}</div>
      <div class="pbar" style="margin:8px 0"><i style="width:${r.owed ? Math.min(100, r.given / r.owed * 100) : 0}%;background:linear-gradient(90deg,#E879F9,#A855F7)"></i></div>
      <div class="sub">חייבים <b>${fmt(r.owed)}</b> (${r.pct}% מ-${fmt(r.base)}) · ניתן <b>${fmt(r.given)}</b></div></div>

    <div class="msec"><b>🎯 כמה אחוז?</b>
      <div class="chips" style="flex-wrap:wrap;margin-top:8px"><button class="chip ${r.pct === 10 ? 'on' : ''}" data-mp="10">מעשר 10%</button><button class="chip ${r.pct === 20 ? 'on' : ''}" data-mp="20">חומש 20%</button>
        <span class="chip ${custom ? 'on' : ''}" style="display:inline-flex;gap:4px;align-items:center">אחר <input id="mCustom" type="number" inputmode="decimal" value="${custom ? r.pct : ''}" placeholder="%" style="width:52px;background:transparent;border:none;border-bottom:1px solid var(--line);color:inherit;font-size:16px;text-align:center">%</span></div></div>

    <div class="msec"><b>💰 מאילו הכנסות?</b><div class="sub" style="margin:2px 0 8px">לוחצים כדי להכליל / להוציא סוג הכנסה. אפשר גם הכנסה בודדת: ✏️ עריכה ← "בלי מעשר".</div>
      ${kinds.length ? kinds.map(([k, v]) => { const on = (M.incOff || {})[k] !== false; return `<button class="mtog ${on ? 'on' : ''}" data-ik="${esc(k)}"><span>${on ? '✅' : '⬜'} ${esc(k)}</span><small>${fmt(v.v)} · ${v.n} פעמים</small></button>`; }).join('') : '<div class="sub">עוד אין הכנסות</div>'}</div>

    <div class="msec"><div style="display:flex;align-items:center;gap:8px"><b style="flex:1">➖ לנכות הוצאות?</b><button class="chip ${M.deduct ? 'on' : ''}" id="mDed">${M.deduct ? '✅ כן' : 'לא'}</button></div>
      ${M.deduct ? `<div class="sub" style="margin:6px 0">אילו הוצאות לנכות מההכנסה לפני החישוב? (נוכה: ${fmt(r.ded)})</div>
        <div class="chips" style="flex-wrap:wrap">${Object.entries(CATS).filter(([id]) => id !== 'give').map(([id, c]) => `<button class="chip ${(M.deductCats || []).includes(id) ? 'on' : ''}" data-dc="${id}">${c.e} ${esc(c.n)}</button>`).join('')}</div>` : ''}</div>

    <div class="msec"><b>🤲 חלוקה — למי נותנים?</b><div class="sub" style="margin:2px 0 8px">${r.toPlan > 0.5 ? `נשאר לחלק: <b style="color:#FACC15">${fmt(r.toPlan)}</b>` : r.toPlan < -0.5 ? `חילקתם יותר ב-${fmt(-r.toPlan)}` : '✅ הכל מחולק'}</div>
      ${r.dist.length ? `<div class="stg">${r.dist.map(d => `<div class="mdist"><button class="mdone ${d.done ? 'on' : ''}" data-dd="${d.id}">${d.done ? '✅' : '⏳'}</button>
        <div style="flex:1;min-width:0"><b>${esc(d.name)}</b><small class="sub" style="display:block">${d.unit === 'pct' ? `${d.v}% · ` : ''}${fmt(d.nis)} · ${d.done ? 'בוצע' : 'לא בוצע'}</small></div><button class="chip" data-dx="${d.id}" aria-label="מחיקה">🗑️</button></div>`).join('')}</div>` : ''}
      <div class="madd"><input id="dN" maxlength="30" placeholder="למי? ישיבה, משפחה, קופה"><input id="dV" type="number" inputmode="decimal" placeholder="סכום">
        <button class="chip on" id="dU" data-u="nis">₪</button><button class="btn grad" id="dAdd" style="padding:0 14px;height:42px">➕</button></div>
      <div class="sub" style="margin-top:6px">💡 תרומה בקטגוריה 💝 תרומות נספרת לבד כ"ניתן" (${fmt(r.giveExp)}). ✅ בחלוקה למעלה — נרשם גם כהוצאה.${r.extra ? ` ➕ בנוסף למעשר: ${fmt(r.extra)} (לא יורד ממה שחייבים).` : ''} לסמן תרומה כ"בנוסף": ✏️ עריכה, או בצ'אט "תרומה 100 בנוסף למעשר". <button class="chip ${M.giveCounts === false ? '' : 'on'}" id="mGive" style="margin-top:4px">${M.giveCounts === false ? 'לא לספור' : '✅ לספור'}</button></div></div>

    <label class="field" style="margin-top:12px"><span>לחשב החל מ (לא חובה)</span><input id="mSince" type="month" value="${r.since}"></label>`, sh => {
    sh.querySelectorAll('[data-mp]').forEach(b => b.onclick = () => saveMaaser({ pct: +b.dataset.mp }));
    sh.querySelector('#mCustom').onchange = e => { const v = num(e.target.value); if (v > 0 && v <= 100) saveMaaser({ pct: v }); };
    sh.querySelectorAll('[data-ik]').forEach(b => b.onclick = () => { const off = { ...(S.maaser?.incOff || {}) }; const k = b.dataset.ik; if (off[k] === false) delete off[k]; else off[k] = false; saveMaaser({ incOff: off }); });
    sh.querySelector('#mDed').onclick = () => saveMaaser({ deduct: !S.maaser?.deduct });
    sh.querySelectorAll('[data-dc]').forEach(b => b.onclick = () => { const l = new Set(S.maaser?.deductCats || []); l.has(b.dataset.dc) ? l.delete(b.dataset.dc) : l.add(b.dataset.dc); saveMaaser({ deductCats: [...l] }); });
    sh.querySelector('#mGive').onclick = () => saveMaaser({ giveCounts: S.maaser?.giveCounts === false });
    // ✅ בוצע = נרשמת הוצאה ב-💝 תרומות (כדי שתופיע במאזן). ביטול ✅ — ההוצאה נמחקת
    sh.querySelectorAll('[data-dd]').forEach(b => b.onclick = async () => {
      const d0 = r.dist.find(d => d.id === b.dataset.dd); if (!d0) return;
      const on = !d0.done; let txId = d0.tx || null;
      if (on && d0.nis > 0) {
        txId = 'mdist_' + d0.id; const now = new Date();
        const t = { id: txId, msg: txId, raw: `🤲 ${d0.name} ${Math.round(d0.nis)}`, desc: `🤲 ${d0.name}`, cat: 'give', source: 'maaser', mdist: d0.id,
          created: now.toISOString(), date: now.toISOString(), amount: Math.round(d0.nis), total: Math.round(d0.nis), inst: 0, pay: null, who: S.me || null };
        S.tx = S.tx.filter(x => x.id !== txId); S.tx.push(t); await db.putTx(t); confetti(); toast(`✅ ${d0.name} — נרשם כהוצאה ב-💝 תרומות`);
      } else if (!on && txId) { S.tx = S.tx.filter(x => x.id !== txId); await db.delTx(txId); txId = null; }
      const dist = (S.maaser?.dist || []).map(d => d.id === d0.id ? { ...d, done: on, ...(txId ? { tx: txId } : { tx: undefined }) } : d);
      renderAll(); saveMaaser({ dist });
    });
    sh.querySelectorAll('[data-dx]').forEach(b => b.onclick = () => saveMaaser({ dist: (S.maaser?.dist || []).filter(d => d.id !== b.dataset.dx) }));
    const u = sh.querySelector('#dU'); u.onclick = () => { u.dataset.u = u.dataset.u === 'nis' ? 'pct' : 'nis'; u.textContent = u.dataset.u === 'nis' ? '₪' : '%'; };
    sh.querySelector('#dAdd').onclick = () => {
      const name = cleanName(sh.querySelector('#dN').value), v = num(sh.querySelector('#dV').value);
      if (!name) return sh.querySelector('#dN').focus(); if (!(v > 0)) return sh.querySelector('#dV').focus();
      saveMaaser({ dist: [...(S.maaser?.dist || []), { id: 'm_' + Math.random().toString(36).slice(2, 7), name, v, unit: u.dataset.u, done: false }] });
    };
    sh.querySelector('#mSince').onchange = e => saveMaaser({ since: e.target.value || '' });
  });
}

// ---------- 🧒 קופת דמי כיס ----------
// S.pocket = { rate: { stars: 10, nis: 5 }, [personId]: { goal: { n, target } | null, mv: [{ id, d, a, note, src }] } }
const pocketOf = pid => S.pocket?.[pid] || { goal: null, mv: [] };
const pocketBal = pid => (pocketOf(pid).mv || []).reduce((s, x) => s + x.a, 0);
const kidsList = () => S.people;
function openPocket(only = null) {
  sheetReopen = () => openPocket(only);
  const kids = only ? S.people.filter(p => p.id === only) : kidsList();
  const rate = S.pocket?.rate || { stars: 10, nis: 5 };
  openSheet(`<h3>🧒 ${only ? 'הקופה שלי' : 'קופות דמי כיס'}</h3>
    ${!only ? `<div class="sub" style="margin:-6px 0 12px">לכל ילד קופה משלו: כמה יש לו, הפקדות, הוצאות ויעד. ⭐ כוכבים ממטלות הופכים לשקלים: <b>${rate.stars}⭐ = ${fmt(rate.nis)}</b></div>` : ''}
    ${kids.length ? `<div class="stg" style="display:flex;flex-direction:column;gap:10px">${kids.map(p => { const b = pocketBal(p.id), g = pocketOf(p.id).goal, pr = g?.target ? b / g.target * 100 : 0;
      return `<button class="card goal-card" data-kid="${p.id}"><div class="ring2" style="background:${ringBg(g ? pr : 0, '#F97316')}"><b>${esc(p.e)}</b></div>
        <div class="nm"><div style="font-weight:700">${esc(p.name)}</div><small class="sub">${g ? `🎯 ${esc(g.n)}: ${fmt(b)} מתוך ${fmt(g.target)}` : 'בלי יעד'}</small></div><div style="font-weight:800;font-size:20px">${fmt(b)}</div></button>`; }).join('')}</div>`
      : `<div class="empty"><span class="em">🧒</span>קודם מוסיפים את הילדים: ⚙️ ← המשפחה</div>`}
    ${!only ? `<div class="sub" style="margin:14px 0 6px">⭐ כמה שווים הכוכבים?</div>
      <div class="row2"><label class="field"><span>כוכבים</span><input id="rS" type="number" inputmode="numeric" value="${rate.stars}"></label><label class="field"><span>שווים ₪</span><input id="rN" type="number" inputmode="decimal" value="${rate.nis}"></label></div>
      <button class="btn ghost full" id="rSave">💾 שמירת שער הכוכבים</button>` : ''}`, sh => {
    sh.querySelectorAll('[data-kid]').forEach(b => b.onclick = () => openKid(b.dataset.kid, !!only));
    sh.querySelector('#rSave')?.addEventListener('click', async () => {
      const st = Math.round(num(sh.querySelector('#rS').value)), n = num(sh.querySelector('#rN').value);
      if (!(st > 0) || !(n > 0)) return;
      await saveKV('pocket', { ...S.pocket, rate: { stars: st, nis: n } }); toast(`⭐ ${st} כוכבים = ${fmt(n)}`); openPocket();
    });
  });
}
async function pocketMove(pid, a, note, src) {
  const box = pocketOf(pid), before = pocketBal(pid);
  await saveKV('pocket', { ...S.pocket, [pid]: { ...box, mv: [...(box.mv || []), { id: db.newId(), d: new Date().toISOString(), a, note: String(note || '').replace(/[<>&"'`]/g, '').slice(0, 40), src }] } });
  const g = box.goal; if (g?.target && before < g.target && before + a >= g.target) { confetti(); toast(`🎉 ${personOf(pid)?.name || ''} הגיע/ה ליעד: ${g.n}!`); }
}
function openKid(pid, readOnly = false) {
  const p = personOf(pid); if (!p) return openPocket();
  const box = pocketOf(pid), b = pocketBal(pid), g = box.goal, rate = S.pocket?.rate || { stars: 10, nis: 5 };
  const SRC = { dep: '💰', spend: '🛍️', stars: '⭐' };
  openSheet(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"><div class="cat-ic" style="background:linear-gradient(135deg,#F97316,#FACC15);width:48px;height:48px;font-size:24px">${esc(p.e)}</div>
      <h3 style="margin:0;flex:1">הקופה של ${esc(p.name)}</h3>${readOnly ? '' : '<button class="chip" id="kBack">↩️ חזרה</button>'}</div>
    <div class="card" style="text-align:center;margin-bottom:12px"><small class="sub">יש בקופה</small><div class="big-num" id="kBal">${fmt(b)}</div>
      ${g ? `<div class="pbar" style="margin:8px 0"><i style="width:${Math.min(100, b / g.target * 100)}%;background:linear-gradient(90deg,#F97316,#FACC15)"></i></div><div class="sub">🎯 ${esc(g.n)} · ${b >= g.target ? '🎉 יש מספיק!' : 'חסרים ' + fmt(g.target - b)}</div>` : ''}</div>
    ${readOnly ? '' : `<div class="row2"><label class="field"><span>סכום ₪</span><input id="kA" type="number" inputmode="decimal" placeholder="20"></label><label class="field"><span>על מה? (לא חובה)</span><input id="kNote" maxlength="40" placeholder="דמי כיס שבועיים"></label></div>
      <div class="row2" style="margin-bottom:10px"><button class="btn grad" id="kIn">➕ הפקדה</button><button class="btn ghost" id="kOut">🛍️ הוצאה</button></div>
      <div class="row2" style="margin-bottom:12px"><label class="field" style="margin:0"><span>⭐ כוכבים (${rate.stars}⭐ = ${fmt(rate.nis)})</span><input id="kS" type="number" inputmode="numeric" placeholder="20"></label><button class="btn ghost" id="kStars" style="align-self:flex-end">⭐ המרה לשקלים</button></div>`}
    ${(box.mv || []).length ? `<div class="card" style="padding:4px 12px">${[...box.mv].reverse().slice(0, 30).map(x => `<div class="mv"><span>${SRC[x.src] || ''} ${esc(x.note || '')} <small class="sub">${new Date(x.d).toLocaleDateString('he-IL')}</small></span><b class="${x.a > 0 ? 'plus' : 'over'}" dir="ltr">${x.a > 0 ? '+' : ''}${fmt(x.a)}</b></div>`).join('')}</div>` : '<div class="empty"><span class="em">🪙</span>הקופה עוד ריקה</div>'}
    ${readOnly ? '' : `<div class="sub" style="margin:14px 0 6px">🎯 יעד לחסוך (לא חובה)</div>
      <div class="row2"><label class="field"><span>למה?</span><input id="kGN" maxlength="30" value="${g ? esc(g.n) : ''}" placeholder="אופניים"></label><label class="field"><span>כמה ₪</span><input id="kGT" type="number" inputmode="decimal" value="${g?.target || ''}"></label></div>
      <button class="btn ghost full" id="kGoal">💾 שמירת היעד</button>`}`, sh => {
    sh.querySelector('#kBack')?.addEventListener('click', () => openPocket());
    if (readOnly) return;
    const amt = () => num(sh.querySelector('#kA').value), note = () => sh.querySelector('#kNote').value;
    sh.querySelector('#kIn').onclick = async () => { const a = amt(); if (!(a > 0)) return sh.querySelector('#kA').focus(); await pocketMove(pid, a, note() || 'הפקדה', 'dep'); toast(`💰 נוספו ${fmt(a)} לקופה של ${p.name}`); openKid(pid); };
    sh.querySelector('#kOut').onclick = async () => { const a = amt(); if (!(a > 0)) return sh.querySelector('#kA').focus(); await pocketMove(pid, -a, note() || 'הוצאה', 'spend'); toast(`🛍️ ירדו ${fmt(a)}`); openKid(pid); };
    sh.querySelector('#kStars').onclick = async () => {
      const st = Math.round(num(sh.querySelector('#kS').value)); if (!(st > 0)) return sh.querySelector('#kS').focus();
      const a = num(st / rate.stars * rate.nis); await pocketMove(pid, a, `${st}⭐ כוכבים`, 'stars'); confetti(); toast(`⭐ ${st} כוכבים = ${fmt(a)} לקופה!`); openKid(pid);
    };
    sh.querySelector('#kGoal').onclick = async () => {
      const n = sh.querySelector('#kGN').value.replace(/[<>&"'`]/g, '').trim(), t = num(sh.querySelector('#kGT').value);
      await saveKV('pocket', { ...S.pocket, [pid]: { ...pocketOf(pid), goal: n && t > 0 ? { n, target: t } : null } }); toast('🎯 היעד נשמר'); openKid(pid);
    };
  });
}
// 🔗 משימה ← הוצאה, מ"זמן בכיף": ?add=350&desc=חשמל — פותח ➕ עם הכל מוכן, המשתמש רק מאשר
function addLink() {
  const q = new URLSearchParams(location.search); if (!q.has('add')) return;
  const a = num(q.get('add')), desc = cleanName(q.get('desc') || '');
  history.replaceState(null, '', location.pathname);
  const cat = desc ? (isIncome(desc) ? 'income' : classify(desc, S.learned)) : 'other';
  openAddForm(cat);
  const sh = $('#sheet');
  if (a > 0) sh.querySelector('#aAmt').value = a;
  if (desc) sh.querySelector('#aDesc').value = desc;
  if (!(a > 0)) setTimeout(() => sh.querySelector('#aAmt')?.focus(), 450);
}
// ⭐ קישור מ"זמן בכיף": ?stars=20&kid=יעל — ההורה מאשר והכוכבים נכנסים לקופה
function starsLink() {
  const q = new URLSearchParams(location.search), st = Math.round(num(q.get('stars'))), kid = (q.get('kid') || '').trim();
  if (!(st > 0) || !kid || !sync.isParent()) return;
  history.replaceState(null, '', location.pathname);
  const p = S.people.find(x => x.name === kid) || S.people.find(x => x.name.includes(kid) || kid.includes(x.name));
  const rate = S.pocket?.rate || { stars: 10, nis: 5 }, a = num(st / rate.stars * rate.nis);
  openSheet(`<h3>⭐ המרת כוכבים</h3><div class="card" style="text-align:center;margin-bottom:12px"><div style="font-size:40px">⭐ ${st}</div><div class="big-num">${fmt(a)}</div><div class="sub">${rate.stars}⭐ = ${fmt(rate.nis)}</div></div>
    ${p ? `<button class="btn grad full" id="sOk">✅ להכניס לקופה של ${esc(p.e)} ${esc(p.name)}</button>` : `<div class="sub" style="margin-bottom:8px">לא מצאתי במשפחה את "${esc(kid)}". של מי הקופה?</div><div class="chips" style="flex-wrap:wrap">${S.people.map(x => `<button class="chip" data-sk="${x.id}">${esc(x.e)} ${esc(x.name)}</button>`).join('')}</div>`}`, sh => {
    const go2 = async pid => { await pocketMove(pid, a, `${st}⭐ כוכבים`, 'stars'); confetti(); toast(`⭐ ${fmt(a)} נכנסו לקופה!`); openKid(pid); };
    sh.querySelector('#sOk')?.addEventListener('click', () => go2(p.id));
    sh.querySelectorAll('[data-sk]').forEach(b => b.onclick = () => go2(b.dataset.sk));
  });
}
$('#goalsBtn').onclick = openGoals;
$('#maaserBtn').onclick = openMaaser;
$('#pocketBtn').onclick = () => openPocket();
$('#debtsBtn').onclick = () => openDebts();

// ========== שלב 3: ➗ מי חייב למי · 🕎 חודשים עבריים וחגים ==========

// ---------- ➗ מי חייב למי + גמ"חים ----------
// S.debts = { id: { name, dir: 'lent'|'borrowed', kind: 'loan'|'gemach'|'split', total, note, d, plan: { n, start } | null, pay: [{ d, a }] } }
const DKIND = { loan: ['🤝', 'הלוואה'], gemach: ['🏦', 'גמ"ח'], split: ['➗', 'חלוקת הוצאה'] };
const debtPaid = x => (x.pay || []).reduce((s, p) => s + p.a, 0);
const debtLeft = x => Math.max(0, num(x.total - debtPaid(x)));
const cleanName = s => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 30);
// כמה היה אמור להיות מוחזר עד היום לפי לוח התשלומים
function debtDue(x) {
  if (!x.plan?.n || !x.plan.start || debtLeft(x) <= 0) return null;
  const st = new Date(x.plan.start + 'T12:00:00'), now = new Date(), per = x.total / x.plan.n;
  const k = Math.min(x.plan.n, Math.max(0, (now.getFullYear() - st.getFullYear()) * 12 + now.getMonth() - st.getMonth() + (now.getDate() >= st.getDate() ? 1 : 0)));
  const next = new Date(st); next.setMonth(st.getMonth() + k);
  return { per, behind: Math.max(0, num(k * per - debtPaid(x))), next: k < x.plan.n ? next : null };
}
function openDebts() {
  sheetReopen = () => openDebts();
  const list = Object.entries(S.debts || {}).filter(([, x]) => debtLeft(x) > 0 || Date.now() - new Date(x.d) < 30 * 864e5);
  const owedToUs = list.filter(([, x]) => x.dir === 'lent').reduce((s, [, x]) => s + debtLeft(x), 0);
  const weOwe = list.filter(([, x]) => x.dir === 'borrowed').reduce((s, [, x]) => s + debtLeft(x), 0);
  openSheet(`<h3>➗ מי חייב למי</h3><div class="sub" style="margin:-6px 0 12px">הלוואות, גמ"חים וחלוקת הוצאות — רק שמות, בלי שהצד השני צריך את האפליקציה.</div>
    <div class="duo" style="padding:0 0 12px"><div class="stat" style="background:var(--g3)"><small>חייבים לנו</small><div>${fmt(owedToUs)}</div></div>
      <div class="stat" style="background:linear-gradient(135deg,#F43F5E,#F97316)"><small>אנחנו חייבים</small><div>${fmt(weOwe)}</div></div></div>
    ${list.length ? `<div class="card stg" style="padding:4px 12px">${list.sort((a, b) => debtLeft(b[1]) - debtLeft(a[1])).map(([id, x]) => { const [e, kn] = DKIND[x.kind] || DKIND.loan, left = debtLeft(x), due = debtDue(x);
      return `<button class="tx" data-debt="${id}"><div class="cat-ic" style="background:${x.dir === 'lent' ? 'var(--g3)' : 'linear-gradient(135deg,#F43F5E,#F97316)'}">${e}</div>
        <div class="nm"><div>${esc(x.name)} ${x.dir === 'lent' ? 'חייב/ת לנו' : '— אנחנו חייבים'}</div><small>${kn}${x.note ? ' · ' + esc(x.note) : ''}${due?.behind > 0 ? ' · <span class="over">⏰ באיחור ' + fmt(due.behind) + '</span>' : due?.next ? ' · הבא: ' + due.next.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' }) : ''}${left <= 0 ? ' · ✅ הוחזר' : ''}</small></div>
        <div class="am ${x.dir === 'lent' ? 'plus' : 'over'}">${fmt(left)}</div></button>`; }).join('')}</div>`
      : `<div class="empty"><span class="em">🤝</span>אין חובות פתוחים. אפשר גם לכתוב בצ'אט: "הלוויתי לדוד 500"</div>`}
    <button class="btn grad full" id="dNew" style="margin-top:12px">➕ הלוואה / גמ"ח / חלוקה חדשה</button>`, sh => {
    sh.querySelector('#dNew').onclick = () => openDebtNew();
    sh.querySelectorAll('[data-debt]').forEach(b => b.onclick = () => openDebt(b.dataset.debt));
  });
}
function openDebtNew(pre = {}) {
  let dir = pre.dir || 'lent', kind = pre.kind || 'loan';
  openSheet(`<h3>➕ חדש</h3>
    <div class="chips" id="dDir" style="margin-bottom:10px;flex-wrap:wrap"><button class="chip" data-dir="lent">💸 אנחנו נתנו / הלווינו</button><button class="chip" data-dir="borrowed">🙏 קיבלנו / לווינו</button></div>
    <div class="chips" id="dKind" style="margin-bottom:12px;flex-wrap:wrap">${Object.entries(DKIND).map(([k, [e, n]]) => `<button class="chip" data-kind="${k}">${e} ${n}</button>`).join('')}</div>
    <label class="field"><span>שם (רק שם — לא צריך שיהיה לו את האפליקציה)</span><input id="dName" maxlength="30" value="${esc(pre.name || '')}" placeholder="למשל: דוד, גמ&quot;ח יד ביד"></label>
    <div class="row2"><label class="field"><span id="dAmtL">סכום ₪</span><input id="dAmt" type="number" inputmode="decimal" value="${pre.total || ''}"></label>
      <label class="field" id="dPplF"><span>כמה אנשים (כולל אותנו)</span><input id="dPpl" type="number" inputmode="numeric" value="2"></label></div>
    <label class="field"><span>על מה? (לא חובה)</span><input id="dNote" maxlength="40" value="${esc(pre.note || '')}"></label>
    <div class="sub" style="margin-bottom:6px">📅 החזר בתשלומים? (לא חובה) — נזכיר כשמגיע תשלום</div>
    <div class="row2"><label class="field"><span>כמה תשלומים</span><input id="dN" type="number" inputmode="numeric" placeholder="10"></label><label class="field"><span>תשלום ראשון</span><input id="dStart" type="date" value="${ymd(new Date())}"></label></div>
    <div class="err" id="dErr"></div><button class="btn grad full" id="dSave">💾 שמור</button>`, sh => {
    const paint = () => {
      sh.querySelectorAll('[data-dir]').forEach(b => b.classList.toggle('on', b.dataset.dir === dir));
      sh.querySelectorAll('[data-kind]').forEach(b => b.classList.toggle('on', b.dataset.kind === kind));
      sh.querySelector('#dPplF').style.display = kind === 'split' ? '' : 'none';
      sh.querySelector('#dAmtL').textContent = kind === 'split' ? 'סכום ההוצאה כולה ₪' : 'סכום ₪';
    };
    sh.querySelectorAll('[data-dir]').forEach(b => b.onclick = () => { dir = b.dataset.dir; paint(); });
    sh.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { kind = b.dataset.kind; paint(); });
    paint();
    sh.querySelector('#dSave').onclick = async () => {
      const name = cleanName(sh.querySelector('#dName').value), amt = num(sh.querySelector('#dAmt').value), n = Math.round(num(sh.querySelector('#dN').value));
      if (!name) { sh.querySelector('#dErr').textContent = 'צריך שם'; return; }
      if (!(amt > 0)) { sh.querySelector('#dErr').textContent = 'צריך סכום גדול מ-0'; return; }
      const ppl = Math.max(2, Math.round(num(sh.querySelector('#dPpl').value)) || 2), total = kind === 'split' ? num(amt / ppl) : amt;
      const id = 'd_' + Math.random().toString(36).slice(2, 8);
      await saveKV('debts', { ...S.debts, [id]: { name, dir, kind, total, note: cleanName(sh.querySelector('#dNote').value), d: new Date().toISOString(), plan: n > 1 ? { n, start: sh.querySelector('#dStart').value || ymd(new Date()) } : null, pay: [] } });
      toast(dir === 'lent' ? `🤝 נרשם: ${name} חייב/ת לנו ${fmt(total)}` : `🙏 נרשם: אנחנו חייבים ל${name} ${fmt(total)}`); openDebt(id);
    };
  });
}
function openDebt(id) {
  const x = S.debts?.[id]; if (!x) return openDebts();
  const left = debtLeft(x), paid = debtPaid(x), due = debtDue(x), [e, kn] = DKIND[x.kind] || DKIND.loan; let armed = false;
  openSheet(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"><div class="cat-ic" style="background:${x.dir === 'lent' ? 'var(--g3)' : 'linear-gradient(135deg,#F43F5E,#F97316)'};width:48px;height:48px;font-size:24px">${e}</div>
      <div style="flex:1;min-width:0"><h3 style="margin:0">${esc(x.name)}</h3><div class="sub">${kn} · ${x.dir === 'lent' ? 'חייב/ת לנו' : 'אנחנו חייבים'}${x.note ? ' · ' + esc(x.note) : ''}</div></div><button class="chip" id="dBack">↩️ חזרה</button></div>
    <div class="card" style="text-align:center;margin-bottom:12px"><small class="sub">${left > 0 ? 'נשאר להחזיר' : '✅ הכל הוחזר'}</small><div class="big-num">${fmt(left)}</div>
      <div class="pbar" style="margin:8px 0"><i style="width:${x.total ? Math.min(100, paid / x.total * 100) : 0}%;background:linear-gradient(90deg,#22C55E,#14B8A6)"></i></div>
      <div class="sub">הוחזרו ${fmt(paid)} מתוך ${fmt(x.total)}${x.plan ? ` · ${x.plan.n} תשלומים של ${fmt(x.total / x.plan.n)}` : ''}${due?.behind > 0 ? ` · <span class="over">⏰ באיחור ${fmt(due.behind)}</span>` : due?.next ? ` · הבא ב-${due.next.toLocaleDateString('he-IL')}` : ''}</div></div>
    ${left > 0 ? `<div class="row2"><label class="field"><span>החזר ₪</span><input id="pA" type="number" inputmode="decimal" value="${due?.behind > 0 ? Math.round(due.behind) : x.plan ? Math.round(x.total / x.plan.n) : ''}"></label><button class="btn grad" id="pAdd" style="align-self:flex-end;margin-bottom:12px">✅ נרשם החזר</button></div>` : ''}
    ${(x.pay || []).length ? `<div class="card" style="padding:4px 12px">${[...x.pay].reverse().map(p => `<div class="mv"><span>${new Date(p.d).toLocaleDateString('he-IL')}</span><b class="plus">${fmt(p.a)}</b></div>`).join('')}</div>` : ''}
    <button class="btn ghost full" id="dDel" style="margin-top:12px;color:#FB7185">🗑️ מחיקה</button>`, sh => {
    sh.querySelector('#dBack').onclick = openDebts;
    sh.querySelector('#pAdd')?.addEventListener('click', async () => {
      const a = num(sh.querySelector('#pA').value); if (!(a > 0)) return sh.querySelector('#pA').focus();
      await saveKV('debts', { ...S.debts, [id]: { ...x, pay: [...(x.pay || []), { d: new Date().toISOString(), a: Math.min(a, left) }] } });
      if (a >= left) { confetti(); toast(`🎉 ${x.name} — הכל הוחזר!`); } else toast(`✅ נרשם החזר של ${fmt(a)}`);
      openDebt(id);
    });
    sh.querySelector('#dDel').onclick = async ev => {
      if (!armed) { armed = true; ev.target.textContent = 'לחיצה שנייה לאישור המחיקה'; return; }
      const { [id]: _, ...rest } = S.debts; await saveKV('debts', rest); toast('🗑️ נמחק'); openDebts();
    };
  });
}
// בצ'אט: "הלוויתי לדוד 500" · "לוויתי מדוד 500" · "דוד החזיר 200" · "החזרתי לדוד 200"
const DEBT_RE = [
  [/^הלוויתי\s+(?:את\s+)?ל?(\D+?)\s+(\d+(?:\.\d+)?)\s*(?:ש"?ח|₪|שקל(?:ים)?)?\s*(.*)$/, 'lent'],
  [/^(?:לוויתי|לקחתי הלוואה|קיבלתי הלוואה)\s+מ(\D+?)\s+(\d+(?:\.\d+)?)\s*(?:ש"?ח|₪|שקל(?:ים)?)?\s*(.*)$/, 'borrowed'],
  [/^(\D+?)\s+החזיר(?:ה)?\s+(?:לי\s+|לנו\s+)?(\d+(?:\.\d+)?)/, 'repaidUs'],
  [/^החזרתי\s+ל(\D+?)\s+(\d+(?:\.\d+)?)/, 'weRepaid'],
];
async function debtCommand(raw) {
  for (const [re, type] of DEBT_RE) {
    const m = raw.trim().match(re); if (!m) continue;
    if (!sync.isParent()) return false;
    const name = cleanName(m[1]), a = num(m[2]);
    if (!name || !(a > 0)) return false;
    let msg;
    if (type === 'lent' || type === 'borrowed') {
      const id = 'd_' + Math.random().toString(36).slice(2, 8);
      await saveKV('debts', { ...S.debts, [id]: { name, dir: type, kind: /גמ"?ח/.test(raw) ? 'gemach' : 'loan', total: a, note: cleanName(m[3]), d: new Date().toISOString(), plan: null, pay: [] } });
      msg = type === 'lent' ? `🤝 נרשם: <b>${esc(name)}</b> חייב/ת לכם ${fmt(a)}` : `🙏 נרשם: אתם חייבים ל<b>${esc(name)}</b> ${fmt(a)}`;
    } else {
      const dir = type === 'repaidUs' ? 'lent' : 'borrowed';
      const hit = Object.entries(S.debts || {}).filter(([, x]) => x.dir === dir && debtLeft(x) > 0 && (x.name === name || x.name.includes(name) || name.includes(x.name)));
      if (!hit.length) return false;
      const [id, x] = hit[0], pay = Math.min(a, debtLeft(x));
      await saveKV('debts', { ...S.debts, [id]: { ...x, pay: [...(x.pay || []), { d: new Date().toISOString(), a: pay }] } });
      const left = debtLeft(S.debts[id]);
      msg = `✅ נרשם החזר של ${fmt(pay)} — ${left > 0 ? `נשארו ${fmt(left)}` : '🎉 הכל הוחזר!'}`;
      if (!left) confetti();
    }
    const me = document.createElement('div'); me.className = 'me new'; me.innerHTML = esc(raw); $('#chat').appendChild(me);
    const b = document.createElement('div'); b.className = 'bot new';
    b.innerHTML = `<div class="cat-ic" style="background:var(--g3)">🤝</div><div><b>${msg}</b><div class="acts"><button data-opendebts>➗ מי חייב למי</button></div></div>`;
    b.querySelector('[data-opendebts]').onclick = openDebts;
    $('#chat').appendChild(b); $('#main').scrollTo({ top: $('#main').scrollHeight, behavior: 'smooth' });
    return true;
  }
  return false;
}
// 📅 תזכורת פעם ביום: תשלומים שהגיע זמנם
function debtReminder() {
  if (!sync.isParent() || lsGet('debtRemind') === ymd(new Date())) return;
  const due = Object.values(S.debts || {}).map(x => ({ x, d: debtDue(x) })).filter(o => o.d?.behind > 0);
  if (!due.length) return;
  lsSet('debtRemind', ymd(new Date()));
  const t = due.map(({ x, d }) => x.dir === 'lent' ? `${x.name} אמור/ה להחזיר ${fmt(d.behind)}` : `להחזיר ל${x.name} ${fmt(d.behind)}`).slice(0, 2).join(' · ');
  setTimeout(() => toastAction(`📅 ${t}`, '➗ לפתוח', openDebts), 1500);
}

// ---------- 🕎 חודשים עבריים וחגים ----------
const HEB_EN = new Intl.DateTimeFormat('en-u-ca-hebrew', { year: 'numeric', month: 'long', day: 'numeric' });
const HEB_HE = new Intl.DateTimeFormat('he-u-ca-hebrew', { month: 'long' });
function heb(d) { const o = {}; for (const p of HEB_EN.formatToParts(d)) o[p.type] = p.value; return { y: +o.year, m: o.month, day: +o.day }; }
const hebMonthName = d => HEB_HE.format(d);
// 5787 → תשפ״ז
function hebYear(y) {
  let n = y % 1000, s = '';
  const L = [[400, 'ת'], [300, 'ש'], [200, 'ר'], [100, 'ק'], [90, 'צ'], [80, 'פ'], [70, 'ע'], [60, 'ס'], [50, 'נ'], [40, 'מ'], [30, 'ל'], [20, 'כ'], [10, 'י'], [9, 'ט'], [8, 'ח'], [7, 'ז'], [6, 'ו'], [5, 'ה'], [4, 'ד'], [3, 'ג'], [2, 'ב'], [1, 'א']];
  for (const [v, ch] of L) while (n >= v) { if (n === 15) { s += 'טו'; n = 0; break; } if (n === 16) { s += 'טז'; n = 0; break; } s += ch; n -= v; }
  return s.length > 1 ? s.slice(0, -1) + '״' + s.slice(-1) : s + '׳';
}
// החג של תאריך מסוים (כולל ימי ההכנה) → { id, y }
const CHAGIM = { tishrei: ['🍎', 'חגי תשרי'], chanuka: ['🕎', 'חנוכה'], purim: ['🎭', 'פורים'], pesach: ['🍷', 'פסח'], shavuot: ['🌾', 'שבועות'] };
function chagOf(d) {
  const { y, m, day } = heb(d);
  if (m === 'Elul' && day >= 20) return { id: 'tishrei', y: y + 1 };
  if (m === 'Tishri' && day <= 23) return { id: 'tishrei', y };
  if ((m === 'Kislev' && day >= 20) || (m === 'Tevet' && day <= 3)) return { id: 'chanuka', y };
  if ((m === 'Adar' || m === 'Adar II') && day <= 15) return { id: 'purim', y };
  if (((m === 'Adar' || m === 'Adar II') && day >= 20) || (m === 'Nisan' && day <= 22)) return { id: 'pesach', y };
  if (m === 'Sivan' && day <= 7) return { id: 'shavuot', y };
  return null;
}
function hebCard() {
  const now = new Date(), from = new Date(now.getFullYear() - 2, now.getMonth(), 1);
  const occ = xp.collect(S.tx, from, new Date(now.getFullYear(), now.getMonth() + 1, 1)).filter(o => o.t.cat !== 'income');
  if (!occ.length) return '';
  const cy = heb(now).y, ch = {}, hm = {};
  for (const o of occ) {
    const c = chagOf(o.date); if (c) { const k = `${c.id}|${c.y}`; ch[k] ??= { v: 0, cats: {} }; ch[k].v += o.amount; ch[k].cats[o.t.cat] = (ch[k].cats[o.t.cat] || 0) + o.amount; }
    const h = heb(o.date), k2 = `${h.y}|${h.m}`; hm[k2] ??= { v: 0, name: hebMonthName(o.date), y: h.y, m: h.m }; hm[k2].v += o.amount;
  }
  // חגים: השנה מול שנה שעברה (רק חגים שהיו בהם הוצאות)
  const chRows = Object.keys(CHAGIM).map(id => {
    const ys = Object.keys(ch).filter(k => k.startsWith(id + '|')).map(k => +k.split('|')[1]).sort((a, b) => b - a);
    if (!ys.length) return '';
    const y = ys[0], cur = ch[`${id}|${y}`], prev = ch[`${id}|${y - 1}`], [e, n] = CHAGIM[id];
    const diff = prev ? Math.round((cur.v - prev.v) / prev.v * 100) : null;
    return `<div class="mv"><span>${e} ${n} ${hebYear(y)}<small class="sub" style="display:block">${Object.entries(cur.cats).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => catOf(c).e).join(' ')}${prev ? ` · ב${hebYear(y - 1)}: ${fmt(prev.v)}` : ''}</small></span>
      <b>${fmt(cur.v)}${diff !== null ? ` <small class="${diff > 0 ? 'over' : 'plus'}">${diff > 0 ? '▲' : '▼'}${Math.abs(diff)}%</small>` : ''}</b></div>`;
  }).join('');
  // חודשים עבריים: 6 האחרונים מול אותו חודש בשנה שעברה
  const mRows = Object.values(hm).sort((a, b) => b.y - a.y || 0).filter(r => r.y >= cy - 1);
  const seen = new Set(), last6 = [];
  for (let i = 0; i < 200 && last6.length < 6; i++) { const d = new Date(now); d.setDate(d.getDate() - i * 29); const h = heb(d), k = `${h.y}|${h.m}`; if (!seen.has(k)) { seen.add(k); if (hm[k]) last6.push(hm[k]); } }
  const mHtml = last6.map(r => { const p = hm[`${r.y - 1}|${r.m}`]; return `<div class="mv"><span>${r.name} ${hebYear(r.y)}${p ? `<small class="sub" style="display:block">בשנה שעברה: ${fmt(p.v)}</small>` : ''}</span><b>${fmt(r.v)}</b></div>`; }).join('');
  if (!chRows && !mHtml) return '';
  void mRows;
  return `<div class="card"><b style="font-size:16px">🕎 לפי הלוח העברי</b><div class="sub" style="margin:2px 0 8px">כמה עלה כל חג (כולל ימי ההכנה) — מול שנה שעברה</div>
    ${chRows || '<div class="sub">עוד אין הוצאות בחגים</div>'}
    ${mHtml ? `<div style="font-weight:700;margin:12px 0 2px">📅 חודשים עבריים</div>${mHtml}` : ''}</div>`;
}
// בכותרת החודש: גם החודש העברי (אפשר לכבות ב-⚙️ תצוגה)
const hebOn = () => lsGet('hebMonths') !== 'off';
function hebRange(m) {
  const [y, mo] = m.split('-').map(Number), a = hebMonthName(new Date(y, mo - 1, 1)), b = hebMonthName(new Date(y, mo, 0));
  return a === b ? a : `${a}–${b}`;
}

// ---------- 🎯 פתיחה: איך בונים את התקציב? (כשעוד אין תקציב במשפחה) ----------
function openBudgetSetup() {
  openSheet(`<div class="onb"><div class="onb-emo">🎯</div><h3 style="text-align:center">איך נבנה את התקציב?</h3>
    <div class="sub" style="text-align:center;margin:-4px 0 14px">תקציב = כמה מותר להוציא בחודש על כל דבר. אפשר לשנות בכל רגע.</div>
    <button class="onb-opt" id="obAuto"><span class="oe">🪄</span><span><b>תקציב אוטומטי</b><small>מתחילים מסכומים רגילים, והם מתעדכנים לבד לפי מה שאתם מוציאים בפועל. הכי קל.</small></span></button>
    <button class="onb-opt" id="obManual"><span class="oe">✍️</span><span><b>אני קובע לכל קטגוריה</b><small>עוברים על הקטגוריות ומחליטים סכום לכל אחת.</small></span></button>
    <button class="btn ghost full" id="obLater" style="margin-top:6px">אחר כך</button></div>`, sh => {
    sh.querySelector('#obAuto').onclick = async () => { const { _mode, ...rest } = S.budgets; void _mode; S.budgets = { ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null)), _mode: 'auto' };
      await db.setKV('budgets', S.budgets); renderAll(); toast('🪄 התקציב האוטומטי מוכן — מתעדכן לבד לפי ההוצאות'); go('budget'); openRecurringSetup(); };
    sh.querySelector('#obManual').onclick = () => openBudgetManual();
    sh.querySelector('#obLater').onclick = () => { lsSet('kesef-onb-later', ymd(new Date())); closeSheet(); };
  });
}
function openBudgetManual() {
  openSheet(`<h3>✍️ כמה מותר בחודש?</h3><div class="sub" style="margin:-6px 0 12px">כתבתי סכום מוצע (לפי ההוצאות שלכם, או סכום רגיל). משנים מה שרוצים — ריק = בלי תקציב.</div>
    <div class="card stg" style="padding:4px 12px">${Object.entries(CATS).map(([id, c]) => `<label class="tx" style="cursor:default"><div class="cat-ic" style="background:${c.g}">${c.e}</div><div class="nm">${esc(c.n)}</div>
      <input type="number" inputmode="numeric" data-bm="${id}" value="${S.budgets[id] ?? recommend(id) ?? c.budget ?? ''}" style="width:96px;height:40px;border-radius:12px;border:1px solid var(--line);background:var(--card2);padding:0 10px;font-size:16px;text-align:center"></label>`).join('')}</div>
    <button class="btn grad full" id="bmSave" style="margin-top:12px;position:sticky;bottom:0">💾 שמירת התקציב</button>`, sh => {
    sh.querySelector('#bmSave').onclick = async () => {
      const b = { _mode: 'manual' };
      sh.querySelectorAll('[data-bm]').forEach(i => { const v = Math.round(num(i.value)); b[i.dataset.bm] = v > 0 ? v : 0; });
      S.budgets = b; await db.setKV('budgets', b); renderAll(); toast('🎯 התקציב נשמר'); go('budget'); openRecurringSetup();
    };
  });
}
function maybeOnboard() {
  if (db.DEMO || $('#gate').classList.contains('on') || !sync.isParent() || Object.keys(S.budgets || {}).length || lsGet('kesef-onb-later') === ymd(new Date())) return;
  setTimeout(openBudgetSetup, 700);
}

// ========== 🔁 הכנסות והוצאות קבועות — נרשמות לבד כל חודש ==========
// S.recurring = { id: { desc, amount, cat, day, start 'YYYY-MM', end 'YYYY-MM'|'', paused, variable, who, pay, skip: ['YYYY-MM'] } }
// מספר רשומה קבוע לכל (כלל, חודש) → שני טלפונים לא ירשמו פעמיים
const REC_PRESETS = [
  ['🏠', 'שכירות', 'home', 4500, 1], ['🏦', 'משכנתא', 'home', 4000, 10], ['🏢', 'ועד בית', 'home', 250, 10], ['🏛️', 'ארנונה', 'home', 650, 1],
  ['💡', 'חשמל', 'home', 450, 15, true], ['💧', 'מים', 'home', 180, 15, true], ['👶', 'גן / מעון', 'kids', 1800, 1], ['⚽', 'חוגים', 'kids', 200, 1],
  ['🛡️', 'ביטוחים', 'ins', 350, 1], ['💝', 'תרומה קבועה', 'give', 100, 1], ['💼', 'משכורת', 'income', 12000, 1], ['👨‍👩‍👧', 'קצבת ילדים', 'income', 350, 20], ['🔑', 'שכירות שנכנסת', 'income', 4500, 1],
];
const recId = (rid, m) => `rec_${rid}_${m}`;
const monthsBetween = (a, b) => { const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1); };
const recEnd = (start, months, endM) => endM || (months > 0 ? addMonths(start, months - 1) : '');
async function saveRule(rid, rule) { await saveKV('recurring', { ...S.recurring, [rid]: rule }); }
async function postRecurring() {
  if (!sync.isParent()) return [];
  const now = new Date(), have = new Set(S.tx.map(t => t.id)), added = [];
  for (const [rid, r] of Object.entries(S.recurring || {})) {
    for (const m of dueMonths(r, now)) {
      const id = recId(rid, m); if (have.has(id) || (r.skip || []).includes(m)) continue;
      const day = Math.min(28, Math.max(1, r.day || 1)), [y, mo] = m.split('-').map(Number), inc = r.cat === 'income';
      const t = { id, msg: id, raw: `🔁 ${r.desc} ${r.amount}`, desc: r.desc, cat: r.cat, source: 'recurring', rec: rid,
        created: now.toISOString(), date: new Date(y, mo - 1, day, 12).toISOString(), amount: r.amount, total: r.amount, inst: 0,
        pay: r.pay || (inc ? 'transfer' : 'standing'), who: r.who || S.me || null, ...(r.variable ? { estimate: true } : {}) };
      S.tx.push(t); await db.putTx(t); added.push(t.id); have.add(id);
    }
  }
  if (added.length) { renderAll(added); toast(`🔁 נרשמו ${added.length} קבועים לחודש הזה`); }
  return added;
}
const ruleLine = r => `${r.variable ? '≈ ' : ''}${fmt(r.amount)} · כל ${r.day} לחודש${r.end ? ' · עד ' + monthLabel(r.end) : ''}${r.paused ? ' · ⏸️ מושהה' : ''}`;
function openRecurring() {
  sheetReopen = () => openRecurring();
  const list = Object.entries(S.recurring || {}), act = list.filter(([, r]) => !r.paused);
  const inSum = act.filter(([, r]) => r.cat === 'income').reduce((s, [, r]) => s + r.amount, 0), outSum = act.filter(([, r]) => r.cat !== 'income').reduce((s, [, r]) => s + r.amount, 0);
  openSheet(`<h3>🔁 הקבועים שלי</h3><div class="sub" style="margin:-6px 0 12px">נרשמים לבד כל חודש ביום שבחרתם. אפשר לערוך, להשהות או להפסיק.</div>
    <div class="duo" style="padding:0 0 12px"><div class="stat" style="background:var(--g3)"><small>נכנס כל חודש</small><div>${fmt(inSum)}</div></div><div class="stat" style="background:linear-gradient(135deg,#F43F5E,#F97316)"><small>יוצא כל חודש</small><div>${fmt(outSum)}</div></div></div>
    ${list.length ? `<div class="stg" style="display:flex;flex-direction:column;gap:8px">${list.sort((a, b) => (a[1].cat === 'income' ? 0 : 1) - (b[1].cat === 'income' ? 0 : 1) || a[1].day - b[1].day).map(([rid, r]) => { const c = catOf(r.cat), nx = nextRuleDate(r);
      const total = r.end ? Math.max(1, monthsBetween(r.start, r.end) + 1) : 0, left = r.end ? Math.max(0, monthsBetween(thisMonth(), r.end) + (nx ? 1 : 0)) : 0, ended = r.end && !nx;
      return `<div class="rec-row ${r.paused ? 'paused' : ''}" data-rule="${rid}"><div class="cat-ic" style="background:${c.g}">${c.e}</div>
        <div class="nm"><div>${esc(r.desc)} <b class="${r.cat === 'income' ? 'plus' : ''}">${r.cat === 'income' ? '+' : ''}${r.variable ? '≈' : ''}${fmt(r.amount)}</b></div>
          <small>כל ${r.day} לחודש${r.paused ? ' · ⏸️ מושהה' : ended ? ' · 🏁 הסתיים' : nx ? ` · הבא: ${nx.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })}` : ''}</small>
          <small class="rec-left">${ended ? '🏁 הסתיים' : r.end ? `נשארו ${left} ${left === 1 ? 'חודש' : 'חודשים'}` : '♾️ ללא סוף'}</small>
          ${r.end ? `<div class="rec-bar"><i style="width:${Math.min(100, (total - left) / total * 100)}%"></i></div>` : ''}</div>
        <div class="rec-acts"><button data-rp="${rid}" aria-label="${r.paused ? 'המשך' : 'השהיה'}">${r.paused ? '▶️' : '⏸️'}</button><button data-rs="${rid}" aria-label="הפסקה">⏹️</button></div></div>`; }).join('')}</div>`
      : `<div class="empty"><span class="em">🔁</span>עוד אין קבועים. שכירות, ועד בית, משכורת — מכניסים פעם אחת, והם נרשמים לבד כל חודש.</div>`}
    <div class="row2" style="margin-top:12px"><button class="btn grad" id="rqNew">➕ קבוע</button><button class="btn ghost" id="rqQuick">⚡ בחירה מהירה</button></div>
    <button class="btn ghost full" id="rqCal" style="margin-top:8px">📆 להוסיף ליומן של הטלפון (Google / אייפון)</button>
    <div class="sub" style="margin-top:10px">💡 גם בצ'אט: "ועד בית 250 כל חודש" או "שכירות 4200 כל 1 לחודש"</div>`, sh => {
    sh.querySelector('#rqCal').onclick = () => openCalendarSub();
    sh.querySelectorAll('[data-rule]').forEach(b => b.onclick = e => { if (!e.target.closest('.rec-acts')) openRuleEdit(b.dataset.rule); });
    sh.querySelectorAll('[data-rp]').forEach(b => b.onclick = async () => { const r = S.recurring[b.dataset.rp]; await saveRule(b.dataset.rp, { ...r, paused: !r.paused }); toast(r.paused ? '▶️ ממשיך לרשום כל חודש' : '⏸️ מושהה'); if (r.paused) await postRecurring(); openRecurring(); });
    sh.querySelectorAll('[data-rs]').forEach(b => b.onclick = async () => {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'בטוח?'; b.classList.add('armed'); return; }
      const { [b.dataset.rs]: _, ...rest } = S.recurring; await saveKV('recurring', rest); toast('🏁 הקבוע הופסק'); openRecurring();
    });
    sh.querySelector('#rqQuick').onclick = () => openRecurringSetup(openRecurring);
    sh.querySelector('#rqNew').onclick = () => { addRecDefault = true; openAddSheet(); };
  });
}
function openRuleEdit(rid) {
  const r = S.recurring?.[rid]; if (!r) return openRecurring();
  const c = catOf(r.cat); let armed = false;
  openSheet(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"><div class="cat-ic" style="background:${c.g};width:48px;height:48px;font-size:24px">${c.e}</div>
      <h3 style="margin:0;flex:1">🔁 ${esc(r.desc)}</h3><button class="chip" id="reBack">↩️ חזרה</button></div>
    <div class="row2"><label class="field"><span>סכום ₪</span><input id="reAmt" type="number" inputmode="decimal" value="${r.amount}"></label>
      <label class="field"><span>ביום בחודש (1-28)</span><input id="reDay" type="number" inputmode="numeric" min="1" max="28" value="${r.day}"></label></div>
    <label class="field"><span>עד חודש (ריק = בלי סוף)</span><input id="reEnd" type="month" value="${r.end || ''}"></label>
    <label class="chk"><input type="checkbox" id="reVar" ${r.variable ? 'checked' : ''}> 💡 הסכום משתנה (כמו חשמל) — לשאול כל חודש כמה יצא</label>
    <button class="btn grad full" id="reSave" style="margin-top:12px">💾 שמירה</button>
    <div class="row2" style="margin-top:10px"><button class="btn ghost" id="rePause">${r.paused ? '▶️ להמשיך' : '⏸️ להשהות'}</button><button class="btn ghost" id="reDel" style="color:#FB7185">🛑 להפסיק</button></div>
    <div class="sub" style="margin-top:8px">מה שכבר נרשם בחודשים הקודמים — נשאר.</div>`, sh => {
    sh.querySelector('#reBack').onclick = openRecurring;
    sh.querySelector('#reSave').onclick = async () => {
      const a = num(sh.querySelector('#reAmt').value), d = Math.round(num(sh.querySelector('#reDay').value));
      if (!(a > 0)) return sh.querySelector('#reAmt').focus();
      await saveRule(rid, { ...r, amount: a, day: Math.min(28, Math.max(1, d || r.day)), end: sh.querySelector('#reEnd').value || '', variable: sh.querySelector('#reVar').checked });
      toast('✅ נשמר'); await postRecurring(); openRecurring();
    };
    sh.querySelector('#rePause').onclick = async () => { await saveRule(rid, { ...r, paused: !r.paused }); toast(r.paused ? '▶️ ממשיך לרשום כל חודש' : '⏸️ מושהה — לא יירשם עד שתמשיכו'); if (r.paused) await postRecurring(); openRecurring(); };
    sh.querySelector('#reDel').onclick = async ev => {
      if (!armed) { armed = true; ev.target.textContent = 'בטוח? לחיצה שנייה'; return; }
      const { [rid]: _, ...rest } = S.recurring; await saveKV('recurring', rest); toast('🛑 הקבוע הופסק'); openRecurring();
    };
  });
}
// ⚡ בחירה מהירה (גם בסוף מסך הפתיחה): לוחצים על מה שיש לכם ומקלידים סכום
function openRecurringSetup(after = null) {
  const exist = new Set(Object.values(S.recurring || {}).map(r => r.desc));
  openSheet(`<div class="onb-emo">🔁</div><h3 style="text-align:center">מה הקבועים שלכם?</h3>
    <div class="sub" style="text-align:center;margin:-4px 0 12px">לוחצים על מה שיש לכם ← סכום ← וזהו. כל חודש זה יירשם לבד.</div>
    <div class="rq-chips">${REC_PRESETS.map(([e, n, cat], i) => `<button class="chip ${exist.has(n) ? 'done' : ''}" data-rq="${i}" ${exist.has(n) ? 'disabled' : ''}>${e} ${n}${cat === 'income' ? ' 💰' : ''}${exist.has(n) ? ' ✓' : ''}</button>`).join('')}</div>
    <div id="rqRows"></div>
    <button class="btn grad full" id="rqSave" style="margin-top:12px">✅ סיום</button>
    <button class="btn ghost full" id="rqSkip" style="margin-top:8px">אחר כך</button>`, sh => {
    const rows = sh.querySelector('#rqRows');
    sh.querySelectorAll('[data-rq]').forEach(b => b.onclick = () => {
      const i = +b.dataset.rq, [e, n, , amt, day, variable] = REC_PRESETS[i];
      if (b.classList.toggle('on')) {
        rows.insertAdjacentHTML('beforeend', `<div class="rq-row" data-row="${i}"><span class="rq-n">${e} ${n}</span>
          <input type="number" inputmode="decimal" placeholder="${amt}" aria-label="סכום"><span class="sub">₪ · ב-</span><input type="number" inputmode="numeric" value="${day}" min="1" max="28" class="rq-day" aria-label="יום בחודש">${variable ? '<span class="sub">≈</span>' : ''}</div>`);
        rows.lastElementChild.querySelector('input').focus();
      } else rows.querySelector(`[data-row="${i}"]`)?.remove();
      const n2 = rows.children.length; sh.querySelector('#rqSave').textContent = n2 ? `✅ שמירה (${n2})` : '✅ סיום';
    });
    sh.querySelector('#rqSkip').onclick = () => after ? after() : closeSheet();
    sh.querySelector('#rqSave').onclick = async () => {
      const next = { ...S.recurring }, m = thisMonth(); let n = 0;
      for (const row of rows.children) {
        const [, name, cat, , , variable] = REC_PRESETS[+row.dataset.row], ins = row.querySelectorAll('input');
        const a = num(ins[0].value || ins[0].placeholder), d = Math.min(28, Math.max(1, Math.round(num(ins[1].value)) || 1));
        if (!(a > 0)) continue;
        next['r_' + Math.random().toString(36).slice(2, 8)] = { desc: name, amount: a, cat, day: d, start: m, end: '', variable: !!variable, who: S.me || null };
        n++;
      }
      if (n) { await saveKV('recurring', next); await postRecurring(); confetti(); toast(`🔁 ${n} קבועים נשמרו — יירשמו לבד כל חודש`); }
      after ? after() : closeSheet();
    };
  });
}
// בצ'אט: "ועד בית 250 כל חודש" · "שכירות 4200 כל 1 לחודש" · "משכורת 12000 כל ה-10 לחודש"
const REC_RE = /^(.+?)\s+(\d+(?:\.\d+)?)\s*(?:₪|ש"?ח|שקל(?:ים)?)?\s+כל\s+(?:ה-?)?(?:(\d{1,2})\s*)?(?:ב|ל)?חודש/;
async function recurringCommand(raw) {
  const m = raw.trim().match(REC_RE); if (!m || !sync.isParent()) return false;
  const named = detectWho(m[1]), desc = cleanName(named.text) || 'קבוע', a = num(m[2]);
  if (!(a > 0)) return false;
  const day = Math.min(28, Math.max(1, m[3] ? +m[3] : new Date().getDate()));
  const cat = isIncome(desc) ? 'income' : classify(desc, S.learned), rid = 'r_' + Math.random().toString(36).slice(2, 8);
  const variable = /חשמל|מים|גז/.test(desc);
  await saveRule(rid, { desc, amount: a, cat, day, start: thisMonth(), end: '', variable, who: named.who || S.me || null });
  await postRecurring(); // קודם רושמים (זה מרענן את הצ'אט) — ואז מוסיפים את האישור
  const me = document.createElement('div'); me.className = 'me new'; me.innerHTML = esc(raw); $('#chat').appendChild(me);
  const b = document.createElement('div'); b.className = 'bot new'; const c = catOf(cat);
  b.innerHTML = `<div class="cat-ic" style="background:${c.g}">🔁</div><div><b>נשמר כקבוע: ${esc(desc)} · ${fmt(a)}</b><div class="sub">${c.e} ${esc(c.n)} · יירשם לבד כל ${day} לחודש${variable ? ' · 💡 נשאל כל חודש כמה יצא' : ''}</div>
    <div class="acts"><button data-openrec>🔁 הקבועים שלי</button></div></div>`;
  b.querySelector('[data-openrec]').onclick = openRecurring;
  $('#chat').appendChild(b);
  $('#main').scrollTo({ top: $('#main').scrollHeight, behavior: 'smooth' });
  return true;
}

// ========== 🎭 מצב הדגמה · 🧭 סיור מודרך · 💬 הערות ==========
// מצב הדגמה = מאגר נפרד (db.DEMO), בלי סנכרון, בלי התראות ובלי כתיבה לשרת. יציאה מחזירה את הנתונים האמיתיים כמו שהם.
function enterDemo() { lsSet('kesef-demo', '1'); location.href = location.pathname; }
function exitDemo() { try { localStorage.removeItem('kesef-demo'); } catch { /* */ } location.href = location.pathname; }
async function demoStart() {
  if (!(await db.allTx()).length) {
    const { tx, kv } = demoData();
    for (const t of tx) await db.putTx(t, true);
    for (const [k, v] of Object.entries(kv)) await db.setKV(k, v, true);
  }
  await reloadFromDb(); await postRecurring();
  $('#gate').classList.remove('on'); openStartView();
  document.body.classList.add('demo');
  const bar = document.createElement('div'); bar.className = 'demo-bar';
  bar.innerHTML = `<span>🎭 מצב הדגמה — הנתונים לא אמיתיים</span><button id="dbReview" class="rv-btn" hidden></button><button id="dbTour">🧭 סיור</button><button id="dbExit">יציאה ✕</button>`;
  $('#app').prepend(bar);
  bar.querySelector('#dbTour').onclick = () => tourStart(0);
  bar.querySelector('#dbReview').onclick = () => reviewStart();
  reviewBadge();
  bar.querySelector('#dbExit').onclick = exitDemo;
  notesFab();
  if (!lsGet('kesef-tour-seen')) setTimeout(() => toastAction('🧭 רוצה סיור מודרך בכל התכונות?', '▶️ להתחיל', () => tourStart(0)), 900);
}
// אתחול מחדש של נתוני ההדגמה
async function demoReset() {
  await db.clearAll(); location.reload();
}

// ---------- 🧭 הסיור: כל התכונות, צעד אחר צעד ----------
// ⚠️ כלל קבוע: כל תכונה חדשה מוסיפה כאן צעד. v = מסך, sel = מה להאיר (או פונקציה), open = פותח חלון לפני ההארה
const cardWith = txt => () => [...document.querySelectorAll('#tips .card')].find(c => c.innerText.includes(txt));
const TOUR = [
  { v: 'chat', sel: '#inp', t: '💬 רושמים הוצאה כמו הודעה', d: 'כותבים "אושר עד 500" ושולחים — הקטגוריה נבחרת לבד. אפשר כמה ביחד, תאריך ("אתמול"), ושם ("רחל: …").' },
  { v: 'chat', sel: '#mic', t: '🎤 מדברים במקום להקליד', d: 'לחיצה קצרה — הקלטה עד ⏹️. החזקה — כמו בוואטסאפ: למעלה נועל, הצידה מבטל.' },
  { v: 'chat', sel: '#attach', t: '📎 פירוט מהבנק / אשראי', d: 'אקסל, PDF או צילום מסך. ✋ מה שכבר רשמתם ידנית יזוהה ולא ייספר פעמיים — ובסוף: "12 חדשות · 3 כבר היו רשומות".' },
  { v: 'chat', sel: '#plusBtn', t: '➕ הוספה בלי צ\'אט', d: 'בוחרים קטגוריה (או 💰 הכנסה), סכום — ושמירה. אפשר גם תגית אירוע.' },
  { v: 'chat', sel: '.hero', t: '💜 כמה נשאר החודש', d: 'המספר "רץ" לערך החדש, והפס מראה כמה מהתקציב נוצל.' },
  { v: 'chat', sel: '#stories', t: '⭕ הטבעות של הקטגוריות', d: 'כל טבעת מתמלאת לפי התקציב, ונהיית אדומה כשחורגים. לחיצה — פירוט.' },
  { v: 'chat', sel: () => [...document.querySelectorAll('#chat .bot .acts')].pop(), t: '✏️ עריכה, מחיקה, של מי', d: 'בכל בועה: לשנות הכל, למחוק (עם ↩️ ביטול), ולבחור על שם מי.' },
  { v: 'chat', sel: () => [...document.querySelectorAll('#chat .tag')].pop() || $('#inp'), t: '🏷️ תגיות אירוע', d: 'מוסיפים #בר_מצווה להודעה — ורואים בתובנות כמה עלה כל אירוע.' },
  { v: 'budget', sel: '#sheet', open: () => openBudgetSetup(), t: '🎯 פתיחה: איך בונים תקציב?', d: 'בפעם הראשונה בוחרים: 🪄 אוטומטי (מתעדכן לבד לפי ההוצאות) או ✍️ אני קובע לכל קטגוריה. אפשר לשנות אחר כך.' },
  { v: 'budget', sel: '#sheet', open: () => openRecurringSetup(), t: '🔁 מה הקבועים שלכם?', d: 'בסוף מסך הפתיחה: לוחצים על שכירות, ועד בית, משכורת… מקלידים סכום — וזה נרשם לבד כל חודש.' },
  { v: 'budget', sel: '#sheet', open: () => openRecurring(), t: '🔁 הקבועים שלי', d: 'כל ההכנסות וההוצאות הקבועות: לערוך, ⏸️ להשהות או להפסיק. חשמל עם "סכום משתנה" — שואלים כל חודש כמה יצא. גם בצ\'אט: "ועד בית 250 כל חודש".' },
  { v: 'chat', sel: '#settingsBtn', t: '✨ מה חדש', d: 'אחרי כל עדכון קופץ חלון קצר עם מה שהשתנה, ו"👀 תראו לי" לוקח לשם. כל ההיסטוריה: ⚙️ ← "✨ מה חדש".' },
  { v: 'budget', sel: '#sheet', open: () => openMaaser(), t: '💝 תרומה: מתוך המעשר או בנוסף', d: 'כל תרומה היא הוצאה במאזן. בבועה בצ\'אט או ב-✏️ עריכה בוחרים "🤲 מתוך המעשר" או "➕ בנוסף למעשר". ✅ בחלוקה כאן — נרשם לבד כהוצאה.' },
  { v: 'budget', sel: '#catsBtn', t: '🏷️ קטגוריות', d: 'כפתור גדול בראש מסך התקציב: מוסיפים קטגוריה משלכם (🐶 הכלב, 🎓 לימודים) או משנים שם, אייקון וצבע. וליד כל קטגוריה יש ✏️ עריכה.' },
  { v: 'budget', sel: '.bmode', t: '🪄 אוטומטי או ✍️ אני קובע', d: 'בכל רגע אפשר לעבור: אוטומטי = הסכומים מתעדכנים לבד לפי ההוצאות. אני קובע = אתם מחליטים. הסכומים שקבעתם נשמרים בצד ואפשר לחזור אליהם.' },
  { v: 'budget', sel: '#v-budget .duo', t: '🎯 הכנסות מול הוצאות', d: 'כמה נכנס וכמה יצא בחודש. לחיצה על ההוצאות 🔎 — לאן הלך הכסף: לפי קטגוריה ולפי מי. לחיצה על ההכנסות — מי הכניס.' },
  { v: 'budget', sel: '#budgetList .card', t: '✉️ מעטפות', d: 'בגדול: כמה נשאר בכל קטגוריה. ירוק, צהוב ב-90%, אדום כשנגמר.' },
  { v: 'budget', sel: '#recoBtn', t: '🪄 המלצה לתקציב', d: 'מחשבת כמה כדאי להגדיר לכל קטגוריה לפי מה שהוצאתם בפועל.' },
  { v: 'budget', sel: '#sheet', open: () => openGoals(), t: '🐷 קופות חיסכון', d: 'יעד, תאריך — ואומרת כמה לשים בצד כל חודש. מגיעים ליעד? קונפטי.' },
  { v: 'budget', sel: '#sheet', open: () => openMaaser(), t: '🤲 מעשר / חומש', d: '10%, חומש 20% או אחוז אחר. בוחרים מאילו הכנסות, אם לנכות הוצאות, ומחלקים למקבלים (₪ או %) עם ✅ בוצע / ⏳ לא בוצע.' },
  { v: 'budget', sel: '#sheet', open: () => openKid('p_kid1'), t: '🧒 קופת דמי כיס', d: 'לכל ילד קופה ויעד. ⭐ כוכבים ממטלות ב"זמן בכיף" הופכים לשקלים.' },
  { v: 'budget', sel: '#sheet', open: () => openDebts(), t: '➗ מי חייב למי + גמ"חים', d: 'הלוואות, גמ"ח וחלוקת הוצאות — עם החזר בתשלומים ותזכורת. גם בצ\'אט: "הלוויתי לדוד 500".' },
  { v: 'insights', sel: '#donut', t: '🍩 לאן הלך הכסף', d: 'חלוקה לפי קטגוריות. הסכום באמצע "רץ" כשנכנסים.' },
  { v: 'insights', sel: cardWith('תשלומים קבועים'), t: '📅 תשלומים קבועים', d: 'מה יורד כל חודש ומתי נגמרים תשלומים — תזכורת ב"זמן בכיף", או 📆 כל התשלומים ביומן של הטלפון (Google / אייפון), מתעדכן לבד.' },
  { v: 'insights', sel: cardWith('הלוח העברי'), t: '🕎 לפי הלוח העברי', d: 'כמה עלה כל חג (כולל ההכנות) מול שנה שעברה, וכל חודש עברי.' },
  { v: 'insights', sel: cardWith('אירועים'), t: '🏷️ אירועים', d: 'כל התגיות: כמה עלה כל אירוע מכל הקטגוריות ביחד. לחיצה — כל הרשומות.' },
  { v: 'insights', sel: cardWith('מי הכניס'), t: '💰 מי הכניס כמה', d: 'הכנסות לפי בני הבית — גם באקסל ובמייל החודשי.' },
  { v: 'insights', sel: cardWith('תמונה לאורך זמן'), t: '📈 תמונה לאורך זמן', d: 'עד 12 חודשים: הכנסה מול הוצאה, וכמה נחסך בסך הכל.' },
  { v: 'tx', sel: '#search', t: '🔎 חיפוש', d: 'לפי שם, #תגית — או סכום: "230", או טווח "200-300". מתחת — סינון לפי קטגוריה ובן משפחה.' },
  { v: 'tx', sel: '#sheet', open: () => { const t = S.tx.find(x => x.tags?.length) || S.tx[0]; if (t) openEditSheet(t); }, t: '✏️ עריכת רשומה', d: 'בתוך העריכה: 🏷️ אירוע, 🧾 צילום קבלה, ➗ לחלק עם מישהו, ו"בלי מעשר" להכנסות.' },
  { v: 'chat', sel: '#exportBtn', t: '📊 סיכום לאקסל', d: 'יומי, שבועי, חודשי, שנתי או בין תאריכים — קובץ צבעוני. ב-1 לחודש הוא מגיע גם במייל.' },
  { v: 'chat', sel: '#viewCard', open: () => openSettings(), t: '🎨 תצוגה', d: 'גודל כתב (רגיל/גדול/ענק), אנימציות פועל/כבוי, חודש עברי ליד הלועזי, ו📱 המסך שנפתח ראשון (צ\'אט / תקציב / תנועות / תובנות).' },
  { v: 'chat', sel: '#pushCard', open: () => openSettings(), t: '🔔 התראה לפני חריגה', d: 'ההורים מקבלים התראה בטלפון כשקטגוריה מגיעה ל-90% או עוברת 100%. לא בשבת.' },
  { v: 'chat', sel: '#toCats', open: () => openSettings(), t: '🏷️ קטגוריות משלכם', d: 'מוסיפים קטגוריה עם שם, אייקון וצבע, או משנים שם לקיימת. מגיע לכל המשפחה.' },
  { v: 'chat', sel: '#lockCard', open: () => openSettings(), t: '🔒 נעילה', d: 'טביעת אצבע, Face ID או קוד — לכל טלפון בנפרד.' },
  { v: 'chat', sel: null, t: '👨‍👩‍👧 המשפחה, QR והזמנות', d: 'ב-⚙️ (כשמחוברים): קוד להורה וקוד לילד, ריבועי QR לסריקה, הזמנה בוואטסאפ, ותפקיד הורה/ילד. (במצב הדגמה הכרטיס מוסתר.)' },
  { v: 'chat', sel: '#toFeedback', open: () => openSettings(), t: '💌 משוב', d: 'משוב, רעיון או תקלה — ישר אליך במייל. גם בצ\'אט: "משוב: …".' },
  { v: 'chat', sel: () => $('#quick [data-helpchip]'), t: '❓ עזרה בצ\'אט', d: 'שואלים "איך מוסיפים קטגוריה?" — ומקבלים תשובה מיד.' },
  { v: 'chat', sel: '.notes-fab', t: '💬 ההערות שלך', d: 'בכל מסך: לוחצים, כותבים מה לתקן — וכשמסיימים שולחים את כל ההערות ביחד.' },
  { v: 'chat', sel: null, t: '🎉 סיימנו!', d: 'זה כל מה שכסף בכיף יודע לעשות. שלח את ההערות שלך ב-💬, ואפשר לצאת ממצב הדגמה למעלה.', end: true },
];
let tourI = -1, STEPS = TOUR;
function tourStart(i = 0) { STEPS = TOUR; lsSet('kesef-tour-seen', '1'); document.body.classList.add('touring'); notesFab(); tourGo(i); }
function tourStop() { tourI = -1; document.body.classList.remove('touring'); $('.tour-ring')?.remove(); $('.tour-card')?.remove(); closeSheet(); notesFab(); }
async function tourGo(i) {
  if (i < 0 || i >= STEPS.length) { const rv = STEPS !== TOUR; tourStop(); if (rv && i >= STEPS.length) reviewSummary(); return; }
  tourI = i; const s = STEPS[i];
  if ($('#sheet').classList.contains('on') && !s.open) closeSheet();
  if (s.v && S.view !== s.v) go(s.v, true);
  if (s.open) s.open();
  await new Promise(r => setTimeout(r, s.open ? 450 : 200));
  let el = typeof s.sel === 'function' ? s.sel() : s.sel ? document.querySelector(s.sel) : null;
  if (el && !el.getClientRects().length) el = null;
  // גוללים פעמיים: תוכן החלון נטען קצת אחרי שהוא נפתח ויכול להזיז את היעד
  if (el && el.id !== 'sheet') { el.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, s.open ? 300 : 60)); el.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 60)); }
  if (tourI !== i) return; // בינתיים עברו לשלב אחר
  let ring = $('.tour-ring'); if (!ring) { ring = document.createElement('div'); ring.className = 'tour-ring'; document.body.appendChild(ring); }
  let low = false;
  if (el) {
    const r = el.getBoundingClientRect(), pad = 6;
    Object.assign(ring.style, { display: 'block', top: `${r.top - pad}px`, left: `${r.left - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    low = r.top + r.height / 2 > innerHeight / 2;
  } else ring.style.display = 'none';
  let card = $('.tour-card'); if (!card) { card = document.createElement('div'); card.className = 'tour-card'; document.body.appendChild(card); }
  card.classList.toggle('top', low); card.classList.toggle('mid', !el);
  if (s.review) { reviewCard(card, s, i); notesFab(); return; }
  card.classList.remove('rv');
  card.innerHTML = `<div class="tbar"><i style="width:${(i + 1) / TOUR.length * 100}%"></i></div>
    <div class="sub">שלב ${i + 1} מתוך ${TOUR.length}</div><b>${s.t}</b><p>${s.d}</p>
    <div class="tbtns"><button id="tPrev" ${i ? '' : 'disabled'}>→ הקודם</button><button class="go" id="tNext">${s.end ? '✅ סיום' : 'הבא ←'}</button><button id="tList" aria-label="כל השלבים">☰</button><button id="tX" aria-label="סגירה">✕</button></div>
    <div class="tlist" hidden>${TOUR.map((x, k) => `<button data-ti="${k}" class="${k === i ? 'on' : ''}">${k + 1}. ${x.t}</button>`).join('')}</div>`;
  card.querySelector('#tPrev').onclick = () => tourGo(i - 1);
  card.querySelector('#tNext').onclick = () => s.end ? tourStop() : tourGo(i + 1);
  card.querySelector('#tX').onclick = tourStop;
  card.querySelector('#tList').onclick = () => { const l = card.querySelector('.tlist'); l.hidden = !l.hidden; if (!l.hidden) l.querySelector('.on')?.scrollIntoView({ block: 'center' }); };
  card.querySelectorAll('[data-ti]').forEach(b => b.onclick = () => tourGo(+b.dataset.ti));
  if (s.end) confetti();
  notesFab();
}
// סיבוב מסך וכו' — מסדרים את הסיור מחדש. אבל לא כשהמקלדת נפתחת (גם היא "משנה גודל"):
// אחרת חלון ההערות נסגר באמצע הלחיצה, והלחיצה נוחתת על כפתור שמתחתיו (למשל 🗑️ מחיקה)
addEventListener('resize', () => {
  if (tourI < 0 || document.body.classList.contains('noting') || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  tourGo(tourI);
});

// ---------- 🔁 סיור תיקונים: עובר רק על המסכים שבהם נכתבו הערות, ומראה מה השתנה ----------
// kesef-review = { [id]: 'ok' | 'seen' | 'note' } — מה כבר נסקר בטלפון הזה. kesef-review-sent = ids שהאישור שלהם כבר נשלח
const RV_KEY = 'kesef-review', RV_SENT = 'kesef-review-sent';
const rvGet = k => { try { return JSON.parse(lsGet(k) || (k === RV_SENT ? '[]' : '{}')); } catch { return k === RV_SENT ? [] : {}; } };
const RV_ST = { fixed: ['✅', 'תוקן'], answered: ['💬', 'נענה'], todo: ['⏳', 'עוד לא'] };
const REVIEW_AT = {
  chat: { v: 'chat', sel: '#inp' },
  attach: { v: 'chat', sel: '#attach' },
  excel: { v: 'chat', sel: '#exportBtn' },
  bmode: { v: 'budget', sel: '.bmode' },
  catsBtn: { v: 'budget', sel: '#catsBtn' },
  recCard: { v: 'budget', sel: '#recCard' },
  insCard: { v: 'budget', sel: '#budgetList [data-cat="ins"]' },
  expenses: { v: 'budget', sel: '#sheet', open: () => openExpenses() },
  maaser: { v: 'budget', sel: '#sheet', open: () => openMaaser() },
  maaserInc: { v: 'budget', sel: '#sheet', open: () => { openMaaser(); setTimeout(() => $('#sheet [data-ik]')?.scrollIntoView({ block: 'center' }), 350); } },
  debts: { v: 'budget', sel: '#sheet', open: () => openDebts() },
  recQuick: { v: 'budget', sel: '#sheet', open: () => openRecurringSetup() },
  onboard: { v: 'budget', sel: '#sheet', open: () => openBudgetSetup() },
  giveEdit: { v: 'chat', sel: '#sheet', open: () => { const t = [...S.tx].reverse().find(x => x.cat === 'give'); if (t) { openEditSheet(t); setTimeout(() => $('#eGive')?.scrollIntoView({ block: 'center' }), 350); } } },
  fixedCard: { v: 'insights', sel: cardWith('תשלומים קבועים') },
  search: { v: 'tx', sel: '#search' },
  view: { v: 'chat', sel: '#sheet', open: () => { openSettings(); setTimeout(() => $('#viewCard')?.scrollIntoView({ block: 'center' }), 350); } },
};
const rvPending = () => { const done = rvGet(RV_KEY); return REVIEW.filter(r => r.st !== 'todo' && !done[r.id]); };
function reviewBadge() {
  const b = $('#dbReview'); if (!b) return;
  const n = rvPending().length; b.hidden = !n; b.textContent = `🔁 תיקונים ${n}`;
}
function reviewStart() {
  if (!REVIEW.length) return;
  const done = rvGet(RV_KEY), order = [...REVIEW.filter(r => r.st !== 'todo'), ...REVIEW.filter(r => r.st === 'todo')];
  STEPS = order.map(r => ({ ...(REVIEW_AT[r.at] || REVIEW_AT.chat), t: r.where, review: r }));
  const first = Math.max(0, STEPS.findIndex(x => x.review.st !== 'todo' && !done[x.review.id]));
  document.body.classList.add('touring'); notesFab(); tourGo(first);
}
function reviewMark(id, v) { const d = rvGet(RV_KEY); d[id] = v; lsSet(RV_KEY, JSON.stringify(d)); reviewBadge(); }
function reviewCard(card, s, i) {
  const r = s.review, [se, sl] = RV_ST[r.st] || RV_ST.fixed, mine = rvGet(RV_KEY)[r.id], n = STEPS.length;
  const dd = new Date(r.date + 'T12:00:00').toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
  card.classList.add('rv');
  card.innerHTML = `<div class="tbar"><i style="width:${(i + 1) / n * 100}%"></i></div>
    <div class="sub">🔁 סיור תיקונים · ${i + 1} מתוך ${n} · הערה מ-${dd}${mine ? ` · ${mine === 'ok' ? '✅ אישרת' : mine === 'note' ? '💬 הוספת הערה' : '👍 ראית'}` : ''}</div>
    <div class="rv-h"><span class="rv-st ${r.st}">${se} ${sl}</span><b>${esc(r.where)}</b></div>
    <div class="rv-note" title="לחיצה — לקרוא הכל"><small>📝 ההערה שלך</small>${esc(r.note)}</div>
    <div class="rv-did ${r.st}"><small>${r.st === 'todo' ? '⏳ מה מתוכנן' : r.st === 'answered' ? '💬 התשובה' : '✨ מה שינינו'}</small>${esc(r.did)}</div>
    ${r.before ? '<button class="chip" id="rBefore">👀 איך זה היה לפני</button>' : ''}
    <div class="tbtns rv-btns"><button id="tPrev" ${i ? '' : 'disabled'} aria-label="הקודם">→</button><button class="ok" id="rOk">${r.st === 'todo' ? '👍 ראיתי' : '✅ מאשר'}</button><button id="rMore">💬 עוד הערה</button><button class="go" id="tNext">${i === n - 1 ? 'סיום' : 'הבא ←'}</button><button id="tX" aria-label="סגירה">✕</button></div>`;
  card.querySelector('.rv-note').onclick = e => e.currentTarget.classList.toggle('open');
  card.querySelector('#tPrev').onclick = () => tourGo(i - 1);
  card.querySelector('#tNext').onclick = () => tourGo(i + 1);
  card.querySelector('#tX').onclick = tourStop;
  card.querySelector('#rOk').onclick = () => { reviewMark(r.id, r.st === 'todo' ? 'seen' : 'ok'); if (r.st !== 'todo') confetti(); tourGo(i + 1); };
  card.querySelector('#rMore').onclick = () => { reviewMark(r.id, 'note'); openNotes(); };
  card.querySelector('#rBefore')?.addEventListener('click', () => {
    const ov = document.createElement('div'); ov.className = 'qr-zoom';
    ov.innerHTML = `<div class="qr-card" style="padding:10px"><div class="sub" style="margin-bottom:6px">👀 לפני התיקון</div><img src="${esc(r.before)}" alt="לפני" style="width:100%;max-height:70vh;object-fit:contain;border-radius:14px"><button class="btn grad full" style="margin-top:10px">סגירה</button></div>`;
    ov.onclick = ev => { if (ev.target === ov || ev.target.closest('button')) ov.remove(); }; document.body.appendChild(ov);
  });
}
function reviewSummary() {
  const done = rvGet(RV_KEY), sent = rvGet(RV_SENT);
  const ok = REVIEW.filter(r => done[r.id] === 'ok'), more = REVIEW.filter(r => done[r.id] === 'note'), todo = REVIEW.filter(r => r.st === 'todo');
  const left = rvPending(), fresh = [...ok, ...more].filter(r => !sent.includes(r.id)), notes = getNotes().length;
  openSheet(`<div class="nw-head"><span class="nw-spark">🔁</span><h3>סיור התיקונים הסתיים</h3></div>
    <div class="rv-sum"><div><b>${ok.length}</b><span>✅ אישרת</span></div><div><b>${more.length}</b><span>💬 עם הערה</span></div><div><b>${left.length}</b><span>⏭️ דילגת</span></div><div><b>${todo.length}</b><span>⏳ בעבודה</span></div></div>
    ${notes ? `<button class="btn grad full" id="rvNotes" style="margin-bottom:10px">📤 יש ${notes} הערות חדשות — לשליחה</button>` : ''}
    ${fresh.length ? `<button class="btn grad full" id="rvSend" style="margin-bottom:10px">✅ שליחת האישורים (${fresh.length})</button>` : '<div class="sub" style="text-align:center;margin-bottom:10px">כל האישורים כבר נשלחו 👍</div>'}
    <button class="btn ghost full" id="rvAgain">🔁 לעבור שוב</button><div class="err" id="rvErr"></div>`, sh => {
    sh.querySelector('#rvNotes')?.addEventListener('click', () => openNotes());
    sh.querySelector('#rvAgain').onclick = () => { closeSheet(); setTimeout(reviewStart, 250); };
    sh.querySelector('#rvSend')?.addEventListener('click', async e => {
      e.target.disabled = true; e.target.textContent = 'שולח…';
      const line = r => `${done[r.id] === 'ok' ? '✅ אושר' : '💬 אושר עם הערה נוספת'} · ${r.id} · ${r.where}\n   ההערה: ${r.note.slice(0, 120)}${r.note.length > 120 ? '…' : ''}`;
      const okSent = await sendFeedback({ kind: 'approval', message: fresh.map(line).join('\n\n'), subject: `✅ אישור תיקונים — כסף בכיף (${fresh.length})`, tag: 'אישור תיקונים' });
      if (okSent) { lsSet(RV_SENT, JSON.stringify([...new Set([...sent, ...fresh.map(r => r.id)])])); confetti(); toast('✅ האישורים נשלחו — תודה!'); reviewSummary(); return; }
      e.target.disabled = false; e.target.textContent = `✅ שליחת האישורים (${fresh.length})`;
      sh.querySelector('#rvErr').textContent = 'לא הצלחתי לשלוח (אין אינטרנט?). אפשר לנסות שוב.';
    });
  });
}

// ---------- 💬 הערות לתיקון (במצב הדגמה ובזמן הסיור) ----------
const VIEW_NAMES = { chat: 'צ\'אט', budget: 'תקציב', insights: 'תובנות', tx: 'תנועות' };
const getNotes = () => { try { return JSON.parse(lsGet('kesef-demoNotes') || '[]'); } catch { return []; } };
const setNotes = l => lsSet('kesef-demoNotes', JSON.stringify(l));
function notesFab() {
  const show = db.DEMO || tourI >= 0;
  let b = $('.notes-fab');
  if (!show) { b?.remove(); return; }
  if (!b) { b = document.createElement('button'); b.className = 'notes-fab'; b.setAttribute('aria-label', 'הערות לתיקון'); b.onclick = openNotes; $('#app').appendChild(b); }
  const n = getNotes().length;
  b.innerHTML = `💬${n ? `<i>${n}</i>` : ''}`;
}
function noteContext() {
  const sheet = $('#sheet').classList.contains('on') ? $('#sheet h3')?.innerText : '';
  return `📍 מסך: ${VIEW_NAMES[S.view] || S.view}${sheet ? ' · חלון: ' + sheet : ''}${tourI >= 0 ? (STEPS[tourI]?.review ? ` · 🔁 סיור תיקונים: ${STEPS[tourI].t}` : ` · שלב ${tourI + 1}: ${STEPS[tourI].t}`) : ''}`;
}
const notesText = l => l.map((x, k) => `${k + 1}. ${x.ctx}\n${x.text}`).join('\n\n');
function openNotes() {
  const ctx = noteContext(), list = getNotes();
  $('.tour-card')?.classList.add('hide'); document.body.classList.add('noting');
  openSheet(`<h3>💬 הערות לתיקון</h3><div class="sub" style="margin:-6px 0 10px">${esc(ctx)}</div>
    <textarea id="nT" rows="3" placeholder="מה לתקן / לשפר כאן?" style="width:100%;border-radius:14px;border:1px solid var(--line);background:var(--card2);padding:10px 12px;font:inherit;font-size:16px;color:inherit;resize:vertical"></textarea>
    <button class="btn grad full" id="nAdd" style="margin:8px 0 12px">➕ שמירת הערה</button>
    ${list.length ? `<div class="card" style="padding:4px 12px;margin-bottom:12px">${list.map((x, k) => `<div class="mv" style="align-items:flex-start;gap:8px"><span style="min-width:0;overflow-wrap:anywhere"><small class="sub">${esc(x.ctx)}</small><br>${esc(x.text)}</span><button class="chip" data-nd="${k}" aria-label="מחיקה">🗑️</button></div>`).join('')}</div>
      <div class="row2"><button class="btn grad" id="nSend">📤 שלח את כל ההערות (${list.length})</button><button class="btn ghost" id="nCopy">📋 העתק</button></div>` : '<div class="empty"><span class="em">📝</span>עוד אין הערות. כל הערה נשמרת כאן עד שתשלח את כולן ביחד.</div>'}
    <div class="err" id="nErr"></div>`, sh => {
    sh.querySelector('#nAdd').onclick = () => {
      const text = sh.querySelector('#nT').value.trim(); if (!text) return sh.querySelector('#nT').focus();
      setNotes([...getNotes(), { ctx, text, at: new Date().toISOString() }]); notesFab(); toast('📝 ההערה נשמרה'); openNotes();
    };
    sh.querySelectorAll('[data-nd]').forEach(b => b.onclick = () => { const l = getNotes(); l.splice(+b.dataset.nd, 1); setNotes(l); notesFab(); openNotes(); });
    sh.querySelector('#nCopy')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(notesText(getNotes())); toast('📋 ההערות הועתקו'); } catch { toast('לא הצלחתי להעתיק', true); } });
    sh.querySelector('#nSend')?.addEventListener('click', async e => {
      e.target.disabled = true; e.target.textContent = 'שולח…';
      const l = getNotes(), ok = await sendFeedback({ kind: 'idea', message: notesText(l), subject: `📝 הערות מצב הדגמה — כסף בכיף (${l.length})`, tag: 'הערות מצב הדגמה' });
      if (ok) { setNotes([]); notesFab(); closeSheet(); confetti(); toast('📤 כל ההערות נשלחו — תודה!'); return; }
      e.target.disabled = false; e.target.textContent = `📤 שלח את כל ההערות (${l.length})`;
      sh.querySelector('#nErr').textContent = 'לא הצלחתי לשלוח (אין אינטרנט?). אפשר ללחוץ 📋 העתק ולהדביק.';
    });
  });
}

// ---------- 🏷️ קטגוריות אישיות (מסונכרן לכל המשפחה) ----------
async function saveCats() { await db.setKV('cats', S.cats); applyCustomCats(S.cats); renderAll(); }
function openCatsSheet() {
  sheetReopen = () => openCatsSheet();
  openSheet(`<h3>🏷️ קטגוריות</h3><div class="sub" style="margin:-6px 0 12px">אפשר להוסיף קטגוריה משלכם או לשנות שם, אייקון וצבע. השינוי מגיע לכל המשפחה 👨‍👩‍👧</div>
    <div class="card" style="padding:4px 12px">${Object.entries(CATS).map(([id, c]) => `<button class="tx cat-li" data-ec="${id}">
      <div class="cat-ic" style="background:${c.g}">${c.e}</div><div class="nm"><div>${c.n}</div>${c.custom ? '<small>✨ שלנו</small>' : ''}</div>
      <i class="cdot" style="background:${c.c}"></i><span class="cedit">✏️</span></button>`).join('')}</div>
    <button class="btn grad full" id="catNew" style="margin-top:12px">➕ קטגוריה חדשה</button>`, sh => {
    sh.querySelectorAll('[data-ec]').forEach(b => b.onclick = () => openCatEdit(b.dataset.ec));
    sh.querySelector('#catNew').onclick = () => openCatEdit(null);
  });
}
function openCatEdit(id, back = openCatsSheet) {
  const c = id ? CATS[id] : null, isNew = !c;
  let e = c?.e || CAT_EMOJIS[0], col = c?.c || CAT_COLORS[(Object.keys(S.cats).length) % CAT_COLORS.length], armed = false;
  const emojis = [...new Set([...(c && !CAT_EMOJIS.includes(c.e) ? [c.e] : []), ...CAT_EMOJIS])].slice(0, 24);
  openSheet(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
      <div class="cat-ic" id="cPrev" style="background:${col};width:48px;height:48px;font-size:24px">${e}</div>
      <h3 style="margin:0;flex:1">${isNew ? '➕ קטגוריה חדשה' : '✏️ עריכת קטגוריה'}</h3>
      <button class="chip" id="cBack">↩️ חזרה</button></div>
    <label class="field"><span>שם</span><input id="cName" maxlength="24" value="${c ? c.n : ''}" placeholder="למשל: הכלב, חוגים, שבתות"></label>
    <div class="sub" style="margin-bottom:8px">אייקון</div>
    <div class="emo-grid" id="cEmo">${emojis.map(x => `<button class="${x === e ? 'on' : ''}" data-e="${x}">${x}</button>`).join('')}</div>
    <div class="sub" style="margin:12px 0 8px">צבע</div>
    <div class="col-row" id="cCol">${CAT_COLORS.map(x => `<button class="${x === col ? 'on' : ''}" data-c="${x}" style="background:${x}" aria-label="צבע"></button>`).join('')}</div>
    ${isNew ? `<label class="field" style="margin-top:12px"><span>תקציב חודשי ₪ (לא חובה)</span><input id="cBud" type="number" inputmode="numeric" placeholder="בלי תקציב"></label>` : ''}
    <div class="err" id="cErr"></div>
    <button class="btn grad full" id="cSave" style="margin-top:12px">💾 שמור</button>
    ${c?.custom ? '<button class="btn ghost full" id="cDel" style="margin-top:10px;color:#FB7185">🗑️ מחיקת הקטגוריה</button>' : ''}
    ${c && !c.custom ? '<div class="sub" style="margin-top:10px;text-align:center">קטגוריה מוכנה — אפשר לשנות לה שם, אייקון וצבע, אבל לא למחוק</div>' : ''}`, sh => {
    const prev = sh.querySelector('#cPrev');
    sh.querySelector('#cBack').onclick = () => back();
    sh.querySelectorAll('#cEmo [data-e]').forEach(b => b.onclick = () => { e = b.dataset.e; prev.textContent = e; sh.querySelectorAll('#cEmo button').forEach(x => x.classList.toggle('on', x === b)); });
    sh.querySelectorAll('#cCol [data-c]').forEach(b => b.onclick = () => { col = b.dataset.c; prev.style.background = col; sh.querySelectorAll('#cCol button').forEach(x => x.classList.toggle('on', x === b)); });
    sh.querySelector('#cSave').onclick = async () => {
      const n = sh.querySelector('#cName').value.replace(/[<>&"'`\\]/g, '').trim();
      if (!n) { sh.querySelector('#cErr').textContent = 'צריך לתת שם לקטגוריה'; return; }
      if (Object.entries(CATS).some(([k, x]) => k !== id && x.n === n)) { sh.querySelector('#cErr').textContent = 'כבר יש קטגוריה בשם הזה'; return; }
      const key = id || 'c_' + Math.random().toString(36).slice(2, 8);
      S.cats = { ...S.cats, [key]: { n, e, c: col, ...(isBaseCat(key) ? {} : { custom: true }) } };
      const bud = Math.round(parseFloat(sh.querySelector('#cBud')?.value) || 0);
      if (isNew && bud > 0) { S.budgets[key] = bud; await db.setKV('budgets', S.budgets); }
      await saveCats();
      toast(isNew ? `🎉 נוספה הקטגוריה ${e} ${n}` : `✅ נשמר: ${e} ${n}`);
      lsSet('kesef-cathint', '1'); back();
    };
    sh.querySelector('#cDel')?.addEventListener('click', async ev => {
      const used = S.tx.filter(t => t.cat === id);
      if (!armed) { armed = true; ev.target.textContent = used.length ? `לחיצה שנייה למחיקה — ${used.length} רשומות יעברו ל"שונות"` : 'לחיצה שנייה לאישור המחיקה'; return; }
      for (const t of used) { t.cat = 'other'; await db.putTx(t); }
      const { [id]: _, ...rest } = S.cats; S.cats = rest;
      if (id in S.budgets) { delete S.budgets[id]; await db.setKV('budgets', S.budgets); }
      if (Object.values(S.learned).includes(id)) { for (const k of Object.keys(S.learned)) if (S.learned[k] === id) delete S.learned[k]; await db.setKV('learned', S.learned); }
      await saveCats(); S.tx = await db.allTx(); renderAll();
      toast('🗑️ הקטגוריה נמחקה'); back();
    });
  });
}

// ---------- 🔔 התראה לטלפון כשמתקרבים לסוף התקציב (הורים) ----------
async function drawPushCard(el) {
  if (!el) return;
  if (!syncUser && !UITEST && !db.DEMO) { el.style.display = 'none'; return; }
  const st = UITEST || db.DEMO ? 'off' : await sync.pushState();
  el.innerHTML = `<b style="font-size:16px">🔔 התראה כשמתקרבים לסוף התקציב</b>
    <div class="sub" style="margin:4px 0 10px">כשמישהו במשפחה רושם הוצאה והקטגוריה מגיעה ל-<b>90%</b> או עוברת את <b>100%</b> — תקפוץ התראה בטלפון. (לא בשבת — נשלח במוצ"ש)</div>
    ${st === 'unsupported' ? `<div class="sub">📲 כדי לקבל התראות צריך קודם להתקין את האפליקציה על המסך${/iphone|ipad/i.test(navigator.userAgent) ? ' (באייפון: שיתוף ⬆️ ← "הוסף למסך הבית")' : ''}.</div>`
      : st === 'denied' ? `<div class="sub">🚫 ההתראות חסומות. פותחים את הגדרות הטלפון ← האפליקציה ← התראות ← מאשרים.</div>`
      : `<div class="chips"><button class="chip ${st === 'on' ? 'on' : ''}" data-push="on">🔔 פועל</button><button class="chip ${st === 'on' ? '' : 'on'}" data-push="off">🔕 כבוי</button></div>`}
    <div class="err" id="pushErr"></div>`;
  el.querySelectorAll('[data-push]').forEach(b => b.onclick = async () => {
    try {
      if (UITEST || db.DEMO) { toast('🎭 במצב הדגמה ההתראות לא נשלחות'); return; }
      if (b.dataset.push === 'on') { await sync.enablePush(); toast('🔔 ההתראות פועלות'); } else { await sync.disablePush(); toast('🔕 ההתראות כבויות'); }
      drawPushCard(el);
    } catch (e) { el.querySelector('#pushErr').textContent = e.message; }
  });
}

// ---------- 🔠 גודל כתב + 🎬 אנימציות (נשמר בכל טלפון בנפרד) ----------
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* */ } };
// 📱 המסך שנפתח ראשון (בכל טלפון בנפרד). ילד — רק צ'אט או תנועות
const START_VIEWS = [['chat', "💬 צ'אט"], ['budget', '🎯 תקציב'], ['tx', '📋 תנועות'], ['insights', '💡 תובנות']];
const startView = () => { const v = lsGet('kesef-start'); return START_VIEWS.some(x => x[0] === v) ? v : 'chat'; };
function openStartView() {
  if (new URLSearchParams(location.search).has('v')) return; // נפתח מהתראה — היא קובעת לאן
  let v = startView(); if (!sync.isParent() && (v === 'budget' || v === 'insights')) v = 'chat';
  if (v !== S.view) go(v, true); // המסך הראשון — לא נרשם ב"חזור"
}
const FONT_SIZES = [['1', 'רגיל'], ['1.12', 'גדול'], ['1.25', 'ענק']];
function drawViewCard(el) {
  const fs = lsGet('fontScale') || '1', anim = !noAnim();
  el.innerHTML = `<b style="font-size:16px">🎨 תצוגה</b>
    <div class="sub" style="margin:8px 0 6px">🔠 גודל כתב</div>
    <div class="chips" style="flex-wrap:wrap">${FONT_SIZES.map(([v, n], i) => `<button class="chip ${v === fs ? 'on' : ''}" data-fs="${v}" style="font-size:${14 + i * 2}px">א ${n}</button>`).join('')}</div>
    <div class="sub" style="margin:12px 0 6px">🎬 אנימציות</div>
    <div class="chips"><button class="chip ${anim ? 'on' : ''}" data-an="on">✨ פועל</button><button class="chip ${anim ? '' : 'on'}" data-an="off">⏸️ כבוי</button></div>
    <div class="sub" style="margin:12px 0 6px">📅 חודש עברי ליד החודש הלועזי</div>
    <div class="chips"><button class="chip ${hebOn() ? 'on' : ''}" data-hm="on">✅ להראות</button><button class="chip ${hebOn() ? '' : 'on'}" data-hm="off">🚫 בלי</button></div>
    <div class="sub" style="margin:12px 0 6px">📱 המסך שנפתח ראשון</div>
    <div class="chips" style="flex-wrap:wrap">${START_VIEWS.filter(([v]) => sync.isParent() || v === 'chat' || v === 'tx').map(([v, n]) => `<button class="chip ${startView() === v ? 'on' : ''}" data-sv="${v}">${n}</button>`).join('')}</div>`;
  el.querySelectorAll('[data-fs]').forEach(b => b.onclick = () => {
    lsSet('fontScale', b.dataset.fs); document.documentElement.style.zoom = b.dataset.fs === '1' ? '' : b.dataset.fs;
    drawViewCard(el); toast('🔠 גודל הכתב עודכן');
  });
  el.querySelectorAll('[data-sv]').forEach(b => b.onclick = () => { lsSet('kesef-start', b.dataset.sv); drawViewCard(el); toast(`📱 מעכשיו האפליקציה תיפתח ב${START_VIEWS.find(x => x[0] === b.dataset.sv)[1].replace(/^\S+ /, '')}`); });
  el.querySelectorAll('[data-hm]').forEach(b => b.onclick = () => { lsSet('hebMonths', b.dataset.hm); renderMonthNav(); drawViewCard(el); });
  el.querySelectorAll('[data-an]').forEach(b => b.onclick = () => {
    lsSet('anim', b.dataset.an); document.documentElement.classList.toggle('noanim', b.dataset.an === 'off');
    drawViewCard(el); toast(b.dataset.an === 'on' ? '✨ האנימציות פועלות' : '⏸️ האנימציות כבויות');
  });
}

// ---------- הגדרות וגיבוי ----------
$('#helpBtn').onclick = () => openHelp();
$('#settingsBtn').onclick = () => openSettings();
function openSettings() {
  sheetReopen = () => openSettings(); openSheet(`<h3>⚙️ הגדרות</h3>
  <div class="card" id="meCard" style="margin-bottom:12px"></div>
  <div class="card" id="syncCard" style="margin-bottom:12px"></div>
  <div class="card" id="lockCard" style="margin-bottom:12px"></div>
  <div class="card parent-only" id="pushCard" style="margin-bottom:12px"></div>
  <div class="card" id="viewCard" style="margin-bottom:12px"></div>
  ${db.DEMO ? `<div class="card" style="margin-bottom:12px;border-color:#F59E0B"><b style="font-size:16px">🎭 מצב הדגמה</b><div class="sub" style="margin:4px 0 10px">הנתונים כאן מדומים ונשמרים בנפרד. הנתונים האמיתיים שלכם לא נגעים.</div>
    <button class="btn grad full" id="demoTour" style="margin-bottom:8px">🧭 סיור מודרך בכל התכונות</button>
    <div class="row2"><button class="btn ghost" id="demoReset">🔄 נתונים מחדש</button><button class="btn ghost" id="demoExit">🚪 יציאה</button></div></div>`
    : '<button class="btn ghost full" id="toDemo" hidden style="margin-bottom:10px">🎭 מצב הדגמה (נתונים מדומים) + סיור</button>'}
  <a class="btn grad full" id="toAdmin" href="admin/" hidden style="margin-bottom:10px;display:block;text-align:center;text-decoration:none">📊 לוח בקרה — רק לך</a>
  <button class="btn ghost full" id="toHelp" style="margin-bottom:10px">❓ עזרה ואיך משתמשים</button>
  <button class="btn ghost full" id="toShare" style="margin-bottom:10px">📤 שתף את האפליקציה עם חבר</button>
  <button class="btn ghost full news-btn" id="toNews" style="margin-bottom:10px">✨ מה חדש</button>
  <button class="btn ghost full" id="toFeedback" style="margin-bottom:10px">💌 שליחת משוב / הצעה / תקלה</button>
  ${isStandalone() ? '' : '<button class="btn ghost full" id="toInstall" style="margin-bottom:10px">📲 התקנה על המסך (כמו אפליקציה)</button>'}
  <button class="btn grad full kid-only" id="toMyBox" style="margin-bottom:10px">🐷 הקופה שלי</button>
  <button class="btn ghost full parent-only" id="toRec" style="margin-bottom:10px">🔁 הכנסות והוצאות קבועות</button>
  <button class="btn ghost full parent-only" id="toCats" style="margin-bottom:10px">🏷️ קטגוריות — להוסיף / לשנות שם</button>
  <button class="btn grad full parent-only" id="toExcel" style="margin-bottom:10px">📊 הורדת סיכום לאקסל</button>
  <div class="row2" style="margin-bottom:10px"><button class="btn ghost" id="exp">⬇️ גיבוי</button><button class="btn ghost" id="imp">⬆️ שחזור מגיבוי</button></div>
  <input type="file" id="impFile" accept="application/json,.json" hidden>
  <div class="sub" style="text-align:center;margin-top:8px">${S.tx.length} רשומות · ${Object.keys(S.learned).length} מילים שלמדתי</div>`, sh => {
  drawMe(sh.querySelector('#meCard'));
  drawSync(sh.querySelector('#syncCard'));
  drawLockCard(sh.querySelector('#lockCard'));
  drawViewCard(sh.querySelector('#viewCard'));
  drawPushCard(sh.querySelector('#pushCard'));
  sync.isAdmin().then(ok => { const a = sh.querySelector('#toAdmin'); if (ok && a) a.hidden = false; const d = sh.querySelector('#toDemo'); if ((ok || UITEST) && d) d.hidden = false; });
  sh.querySelector('#toDemo')?.addEventListener('click', enterDemo);
  sh.querySelector('#demoTour')?.addEventListener('click', () => { closeSheet(); tourStart(0); });
  sh.querySelector('#demoReset')?.addEventListener('click', demoReset);
  sh.querySelector('#demoExit')?.addEventListener('click', exitDemo);
  sh.querySelector('#toExcel').onclick = () => openExportSheet();
  sh.querySelector('#toCats').onclick = () => openCatsSheet();
  sh.querySelector('#toNews').onclick = () => openNews(true);
  sh.querySelector('#toRec').onclick = () => openRecurring();
  sh.querySelector('#toMyBox').onclick = () => S.me ? openKid(S.me, true) : toast('קודם בוחרים "אני ___" במשפחה', true);
  sh.querySelector('#toHelp').onclick = () => openHelp();
  sh.querySelector('#toShare').onclick = () => openHelp('איך משתפים את האפליקציה עם חבר');
  sh.querySelector('#toFeedback').onclick = () => openFeedback();
  sh.querySelector('#toInstall')?.addEventListener('click', openInstallSheet);
  sh.querySelector('#exp').onclick = async () => {
    const blob = new Blob([JSON.stringify(await db.exportAll(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `kesef-backup-${ymd(new Date())}.json`; a.click();
    toast('⬇️ קובץ הגיבוי ירד');
  };
  sh.querySelector('#imp').onclick = () => sh.querySelector('#impFile').click();
  sh.querySelector('#impFile').onchange = async e => {
    try { await db.importAll(JSON.parse(await e.target.files[0].text())); await load(); closeSheet(); toast('✅ הגיבוי שוחזר'); }
    catch (err) { toast('הקובץ לא נראה כמו גיבוי של האפליקציה', true); }
  };
}); }

// ---------- משוב: נשלח אוטומטית במייל למוישי + נשמר בענן ----------
const FEEDBACK_TO = 'mvindish@gmail.com';
const FEEDBACK_KEY = 'afe845b5ff6d0c2cd899d08390663e7c'; // הכינוי של FormSubmit — כדי שהמייל לא יופיע בקוד
const FEEDBACK_RE = /^(משוב|פידבק|הערה|הערות|הצעה|הצעת שיפור|רעיון|יש לי רעיון|יש לי הערה|יש לי הצעה|באג|תקלה|בעיה|דיווח|feedback)(?=[\s:,-]|$)[\s:,-]*/i;
const KINDS = { idea: '💡 רעיון', bug: '🐞 משהו לא עובד', love: '❤️ מחמאה', other: '💬 אחר', approval: '✅ אישור תיקונים' };

// שליחת משוב: גם לטבלה בענן וגם למייל (FormSubmit). מחזיר true אם לפחות אחד הצליח
async function sendFeedback({ kind = 'other', message, contact = '', device = '', subject = '', tag = '' }) {
  const cloud = sync.saveFeedback({ app: 'kesef-bekef', kind, message: tag ? `[${tag}]\n${message}` : message, contact, device }).catch(() => false);
  let mailed = false;
  try {
    const r = await fetch(`https://formsubmit.co/ajax/${FEEDBACK_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ _subject: subject || `💌 משוב חדש — כסף בכיף (${KINDS[kind]})`, _template: 'table', _captcha: 'false',
        'סוג': tag || KINDS[kind], 'משוב': message, 'פרטים לחזרה': contact || '—', 'משפחה': sync.household()?.name || (db.DEMO ? '🎭 מצב הדגמה' : '—'), 'מכשיר': device || '—' }),
    });
    mailed = r.ok;
  } catch { mailed = false; }
  return mailed || !!(await cloud);
}
function openFeedback(text = '', hint = text) {
  let kind = /באג|תקלה|בעיה|לא עובד/.test(hint) ? 'bug' : /רעיון|הצעה|שיפור/.test(hint) ? 'idea' : /תודה|מעולה|אוהב|כל הכבוד|מדהים/.test(hint) ? 'love' : 'other';
  const me = personOf(S.me);
  openSheet(`<h3>💌 שליחת משוב</h3>
    <div class="sub" style="margin:-6px 0 12px">כל הערה, רעיון או תקלה מגיעים ישירות למוישי — ועוזרים לשפר את האפליקציה 🙏</div>
    <div class="chips" style="flex-wrap:wrap;margin-bottom:12px">${Object.entries(KINDS).map(([k, n]) => `<button class="chip ${k === kind ? 'on' : ''}" data-fk="${k}">${n}</button>`).join('')}</div>
    <textarea id="fMsg" rows="5" placeholder="מה תרצו לספר? למשל: היה נחמד אם…" style="width:100%;border-radius:16px;border:1px solid var(--line);background:var(--card2);padding:12px 14px;outline:none;resize:vertical;margin-bottom:10px">${esc(text)}</textarea>
    <label class="field"><span>איך לחזור אליך (לא חובה)</span><input id="fContact" value="${esc([me?.name, syncUser?.email].filter(Boolean).join(' · '))}" placeholder="שם / טלפון / מייל"></label>
    <label style="display:flex;gap:8px;align-items:center;margin-bottom:12px" class="sub"><input type="checkbox" id="fDev" checked style="width:18px;height:18px;accent-color:#EC4899"> לצרף פרטי מכשיר (עוזר לתקן תקלות)</label>
    <div class="err" id="fErr"></div>
    <button class="btn grad full" id="fSend">📨 שליחה</button>`, sh => {
    sh.querySelectorAll('[data-fk]').forEach(b => b.onclick = () => { kind = b.dataset.fk; sh.querySelectorAll('[data-fk]').forEach(x => x.classList.toggle('on', x === b)); });
    sh.querySelector('#fMsg').oninput = () => sh.querySelector('#fErr').textContent = '';
    sh.querySelector('#fSend').onclick = async e => {
      const message = sh.querySelector('#fMsg').value.trim();
      if (message.length < 2) { sh.querySelector('#fErr').textContent = 'צריך לכתוב משהו 🙂'; return; }
      const contact = sh.querySelector('#fContact').value.trim();
      const device = sh.querySelector('#fDev').checked
        ? `${navigator.userAgent.match(/iPhone|iPad|Android[^;)]*|Mac|Windows/)?.[0] || 'מכשיר'} · ${screen.width}×${screen.height} · ${isStandalone() ? 'מותקנת' : 'דפדפן'} · ${sync.isParent() ? 'הורה' : 'ילד'}`
        : '';
      e.target.disabled = true; e.target.textContent = 'שולח…';
      if (await sendFeedback({ kind, message, contact, device })) { closeSheet(); confetti(); toast('💌 תודה! המשוב נשלח'); return; }
      e.target.disabled = false; e.target.textContent = '📨 שליחה';
      sh.querySelector('#fErr').innerHTML = `לא הצלחתי לשלוח (אין אינטרנט?). אפשר <a href="mailto:${FEEDBACK_TO}?subject=${encodeURIComponent('משוב — כסף בכיף')}&body=${encodeURIComponent(message)}" style="color:#F9A8D4">לשלוח במייל רגיל</a>`;
    };
  });
}

// ---------- שיתוף האפליקציה עם חבר (משפחה חדשה, בלי קוד) ----------
async function shareApp() {
  try {
    if (navigator.share) { await navigator.share({ title: 'כסף בכיף', text: help.SHARE_TEXT.replace(help.SHARE_URL, '').trim(), url: help.SHARE_URL }); return; }
    await navigator.clipboard.writeText(help.SHARE_TEXT); toast('🔗 הקישור הועתק — אפשר להדביק לחבר');
  } catch (e) { if (e.name !== 'AbortError') toast('🔗 ' + help.SHARE_URL); }
}

// ---------- עזרה: שאלות ותשובות בחלון נפרד (לא נשמר בצ'אט) ----------
function openHelp(question = '', showGuide = false) {
  const kid = !sync.isParent();
  const topics = help.TOPICS.filter(t => !kid || !['roles', 'export', 'budget', 'insights', 'add'].includes(t.id));
  openSheet(`<h3>❓ עזרה</h3>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <input id="hQ" placeholder="שאל אותי, למשל: איך מוסיפים את אשתי?" style="flex:1;min-width:0;height:46px;border-radius:16px;border:1px solid var(--line);background:var(--card2);padding:0 14px;outline:none;font-size:16px" enterkeyhint="send">
      <button class="btn grad" id="hAsk" style="height:46px">שאל</button></div>
    <div id="hAns" style="display:flex;flex-direction:column;gap:10px;margin-bottom:12px"></div>
    <div id="hGuide"></div>
    <div class="row2" style="margin-bottom:12px"><button class="btn ghost" id="hOpenGuide">📖 המדריך המלא</button><button class="btn ghost news-btn" id="hNews">✨ מה חדש</button></div>
    <div class="sub" style="margin-bottom:6px">שאלות נפוצות:</div>
    <div class="chips" style="flex-wrap:wrap;margin-bottom:12px">${topics.map(t => `<button class="chip" data-topic="${t.id}">${t.t}</button>`).join('')}</div>
    <div class="sub" style="text-align:center">עדיין תקוע? מוישי וינדיש · <a href="tel:0542964361" style="color:#F9A8D4">054-2964361</a> · <a href="mailto:mvindish@gmail.com" style="color:#F9A8D4">mvindish@gmail.com</a></div>`, sh => {
    const box = sh.querySelector('#hAns');
    const bubble = (cls, html) => {
      const d = document.createElement('div'); d.className = cls + ' new'; d.innerHTML = html; d.style.maxWidth = '100%'; box.appendChild(d);
      d.querySelector('[data-share-app]')?.addEventListener('click', shareApp);
      d.querySelector('[data-feedback-app]')?.addEventListener('click', () => openFeedback());
      return d;
    };
    const showGuideFrame = () => {
      sh.querySelector('#hGuide').innerHTML = `<iframe src="guide/" title="המדריך" style="width:100%;height:65vh;border:0;border-radius:18px;margin-bottom:12px;background:#FBF8FF"></iframe>`;
      sh.querySelector('#hOpenGuide').style.display = 'none';
      sh.querySelector('#hGuide').scrollIntoView({ behavior: 'smooth' });
    };
    const ask = q => {
      q = q.trim(); if (!q) return;
      bubble('me', esc(q));
      const found = help.answer(q).filter(t => topics.includes(t));
      if (found.length) found.forEach(t => bubble('bot', `<div><b>${t.t}</b><div style="margin-top:6px;line-height:1.6">${t.a}</div></div>`));
      else {
        const b = bubble('bot', `<div><b>🤔 לא בטוח שהבנתי</b><div class="sub" style="margin-top:4px">רצית לראות את ההוראות? או לבחור נושא למטה 👇</div>
          <div class="acts"><button data-g="1">📖 כן, פתח את המדריך</button></div></div>`);
        b.querySelector('[data-g]').onclick = showGuideFrame;
      }
      sh.querySelector('#hQ').value = '';
    };
    sh.querySelector('#hAsk').onclick = () => ask(sh.querySelector('#hQ').value);
    sh.querySelector('#hQ').addEventListener('keydown', e => { if (e.key === 'Enter') ask(e.target.value); });
    sh.querySelector('#hOpenGuide').onclick = showGuideFrame;
    sh.querySelector('#hNews').onclick = () => openNews(true);
    sh.querySelectorAll('[data-topic]').forEach(c => c.onclick = () => {
      const t = help.TOPICS.find(x => x.id === c.dataset.topic);
      bubble('me', esc(t.t.replace(/^\S+\s/, '')));
      bubble('bot', `<div><b>${t.t}</b><div style="margin-top:6px;line-height:1.6">${t.a}</div></div>`);
      box.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    if (showGuide) showGuideFrame();
    else if (question) ask(question);
  });
}

// ---------- התקנה על המסך (כמו אפליקציה רגילה) ----------
let installEvt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; drawInstallBanner(); });
window.addEventListener('appinstalled', () => { installEvt = null; drawInstallBanner(); toast('🎉 האפליקציה הותקנה על המסך'); confetti(); });

function openInstallSheet() {
  if (installEvt) { installEvt.prompt(); installEvt.userChoice.finally(() => { installEvt = null; drawInstallBanner(); }); return; }
  openSheet(`<h3>📲 התקנה על המסך</h3>
    <div class="sub" style="margin:-6px 0 14px">ככה "כסף בכיף" יופיע עם אייקון במסך הבית, כמו וואטסאפ — ייפתח במסך מלא ויעבוד גם בלי אינטרנט</div>
    ${isIOS() ? `<div class="card tip" style="margin-bottom:10px"><div class="em">🍏</div><p><b>באייפון (בדפדפן Safari):</b><br>1. לוחצים על כפתור השיתוף <b>⬆️</b> בתחתית המסך<br>2. גוללים ובוחרים <b>"הוסף למסך הבית"</b><br>3. לוחצים <b>"הוסף"</b> — וזהו!</p></div>`
      : `<div class="card tip" style="margin-bottom:10px"><div class="em">🤖</div><p><b>באנדרואיד (בדפדפן Chrome):</b><br>1. לוחצים על <b>⋮</b> (שלוש הנקודות) למעלה<br>2. גוללים קצת למטה ובוחרים <b>"התקנת אפליקציה"</b> (או "הוספה למסך הבית")<br>3. לוחצים <b>"התקנה"</b> — וזהו!</p></div>
         <div class="card tip"><div class="em">💻</div><p><b>במחשב (Chrome / Edge):</b> לוחצים על סמל ההתקנה בשורת הכתובת, או ⋮ ← "התקנה".</p></div>`}`);
}
function drawInstallBanner() {
  const el = $('#installBanner');
  let hidden = false; try { hidden = localStorage.getItem('kesef-install-hide') === '1'; } catch {}
  if (isStandalone() || hidden || !location.protocol.startsWith('https')) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="card tip" style="margin:0 16px 14px;align-items:center">
    <div class="em">📲</div><p style="flex:1"><b>להתקין כאפליקציה?</b><br>אייקון במסך הבית, כמו וואטסאפ</p>
    <button class="btn grad" id="instGo" style="height:40px">התקנה</button><button class="chip" id="instX" aria-label="סגירה">✕</button></div>`;
  $('#instGo').onclick = openInstallSheet;
  $('#instX').onclick = () => { try { localStorage.setItem('kesef-install-hide', '1'); } catch {} drawInstallBanner(); };
}
drawInstallBanner();

// ---------- נעילה ----------
let pinBuf = '', fails = 0, lockedUntil = 0, hiddenAt = 0;
function showLock() {
  const st = lock.settings(); if (!st) return;
  pinBuf = ''; drawDots(); $('#lockErr').textContent = '';
  $('#lockBio').hidden = !st.cred;
  $('#lockBio').textContent = isIOS() ? '👆 לחיצה כאן — ונפתח עם Face ID' : '👆 פתיחה בטביעת אצבע';
  $('#lock').classList.add('on');
  // אנדרואיד: טביעת אצבע קופצת לבד. אייפון: אפל מחייבת לחיצה אחת — בלי חלון מבלבל
  if (st.cred && !isIOS()) tryBio(true);
}
// לחיצה בכל מקום במסך הנעילה (חוץ מהמקלדת) = Face ID / טביעת אצבע
$('#lock').addEventListener('click', e => {
  if (e.target.closest('#lockPad') || e.target.closest('#lockBio') || e.target.closest('#lockForgot') || e.target.closest('#lockForgotBox')) return;
  if (lock.settings()?.cred) tryBio(false);
});
function unlockNow() { $('#lock').classList.remove('on'); fails = 0; }
async function tryBio(auto) {
  try { if (await lock.bioUnlock()) unlockNow(); }
  catch (e) { if (!auto && e.name !== 'NotAllowedError') $('#lockErr').textContent = 'הזיהוי לא הצליח — אפשר להקליד קוד'; }
}
function drawDots() { $$('#lockDots i').forEach((d, i) => d.classList.toggle('f', i < pinBuf.length)); }
$('#lockPad').innerHTML = ['1','2','3','4','5','6','7','8','9','','0','⌫'].map(k => k ? `<button data-k="${k}" aria-label="${k === '⌫' ? 'מחיקה' : k}">${k}</button>` : '<span></span>').join('');
$('#lockPad').addEventListener('click', async e => {
  const b = e.target.closest('[data-k]'); if (!b) return;
  if (Date.now() < lockedUntil) { $('#lockErr').textContent = `יותר מדי ניסיונות. נסה שוב בעוד ${Math.ceil((lockedUntil - Date.now()) / 1000)} שניות`; return; }
  const k = b.dataset.k;
  pinBuf = k === '⌫' ? pinBuf.slice(0, -1) : (pinBuf + k).slice(0, 4);
  drawDots(); $('#lockErr').textContent = '';
  if (pinBuf.length === 4) {
    if (await lock.pinOk(pinBuf)) { unlockNow(); return; }
    fails++; pinBuf = ''; drawDots();
    $('#lockDots').classList.remove('shake'); void $('#lockDots').offsetWidth; $('#lockDots').classList.add('shake');
    if (fails >= 5) { lockedUntil = Date.now() + 30000; fails = 0; $('#lockErr').textContent = 'יותר מדי ניסיונות. המתן 30 שניות'; }
    else $('#lockErr').textContent = 'קוד שגוי';
  }
});
$('#lockBio').onclick = () => tryBio(false);
// 🔢 שכחתי את הקוד — פותחים עם הסיסמה של החשבון, והנעילה מתבטלת (אפשר להגדיר קוד חדש באזור האישי)
$('#lockForgot').onclick = () => {
  const box = $('#lockForgotBox');
  box.hidden = !box.hidden; $('#lockPad').hidden = !box.hidden;
  if (!box.hidden) { box.querySelector('input').value = ''; box.querySelector('input').focus(); }
};
$('#lockPwGo').onclick = async () => {
  const b = $('#lockPwGo'), pw = $('#lockPw').value;
  if (!pw) return;
  if (!navigator.onLine) { $('#lockErr').textContent = 'צריך אינטרנט כדי לבדוק את הסיסמה'; return; }
  b.disabled = true;
  try {
    await sync.checkPassword(pw);
    lock.disable(); unlockNow();
    $('#lockForgotBox').hidden = true; $('#lockPad').hidden = false;
    toast('🔓 הנעילה בוטלה. אפשר להגדיר קוד חדש ב"אזור אישי"');
  } catch (x) { $('#lockErr').textContent = x.message; }
  b.disabled = false;
};
document.addEventListener('visibilitychange', () => {
  const st = lock.settings(); if (!st) return;
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt >= (st.minutes ?? 5) * 60000) showLock();
});
showLock();

function drawLockCard(el) {
  const st = lock.settings();
  if (!st) {
    el.innerHTML = `<b>🔒 נעילת האפליקציה</b><div class="sub" style="margin:4px 0 10px">כדי שלא כל מי שמחזיק את הטלפון יראה את הנתונים</div>
      <button class="btn ghost full" id="lkOn">הפעלת נעילה</button>`;
    el.querySelector('#lkOn').onclick = async () => {
      const bio = await lock.bioSupported();
      el.innerHTML = `<b>🔒 בחירת קוד (4 ספרות)</b>
        <input id="lk1" type="password" inputmode="numeric" maxlength="4" placeholder="קוד" style="${inputStyle};text-align:center;letter-spacing:8px">
        <input id="lk2" type="password" inputmode="numeric" maxlength="4" placeholder="שוב את אותו קוד" style="${inputStyle};text-align:center;letter-spacing:8px">
        ${bio ? `<label style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><input type="checkbox" id="lkBio" checked style="width:20px;height:20px;accent-color:#EC4899"> גם טביעת אצבע / Face ID</label>` : '<div class="sub" style="margin-bottom:8px">טביעת אצבע תהיה זמינה אחרי שהאפליקציה תעלה לאינטרנט</div>'}
        <div class="err" id="lkErr"></div>
        <button class="btn grad full" id="lkSave">הפעלה</button>`;
      el.querySelectorAll('input').forEach(i => i.oninput = () => el.querySelector('#lkErr').textContent = '');
      el.querySelector('#lkSave').onclick = async () => {
        const a = el.querySelector('#lk1').value, b = el.querySelector('#lk2').value;
        if (!/^\d{4}$/.test(a)) { el.querySelector('#lkErr').textContent = 'הקוד צריך להיות 4 ספרות'; return; }
        if (a !== b) { el.querySelector('#lkErr').textContent = 'הקודים לא זהים'; return; }
        try { await lock.enable(a, !!el.querySelector('#lkBio')?.checked, 5); drawLockCard(el); toast('🔒 הנעילה הופעלה — תינעל אחרי 5 דקות שהאפליקציה סגורה'); }
        catch (e) {
          if (e.name === 'NotAllowedError') { await lock.enable(a, false, 5); drawLockCard(el); toast('🔒 הנעילה הופעלה עם קוד בלבד'); }
          else el.querySelector('#lkErr').textContent = 'לא הצלחתי להפעיל טביעת אצבע. נסה בלי';
        }
      };
    };
    return;
  }
  el.innerHTML = `<b>🔒 הנעילה פעילה</b> <span class="sub">· ${st.cred ? '👆 טביעת אצבע/Face ID + קוד' : 'קוד בלבד'}</span>
    <div class="sub" style="margin:8px 0 6px">לנעול כשחוזרים לאפליקציה אחרי:</div>
    <div class="chips" style="margin-bottom:10px">${[[0, 'מיד'], [1, 'דקה'], [5, '5 דקות'], [30, 'חצי שעה']].map(([m, n]) => `<button class="chip ${st.minutes === m ? 'on' : ''}" data-min="${m}">${n}</button>`).join('')}</div>
    <input id="lkOff" type="password" inputmode="numeric" maxlength="4" placeholder="כדי לכבות — הקלד את הקוד" style="${inputStyle};text-align:center">
    <div class="err" id="lkErr"></div>
    <button class="btn danger full" id="lkOffBtn">כיבוי הנעילה</button>`;
  el.querySelectorAll('[data-min]').forEach(b => b.onclick = () => { lock.setMinutes(+b.dataset.min); drawLockCard(el); });
  el.querySelector('#lkOffBtn').onclick = async () => {
    if (!(await lock.pinOk(el.querySelector('#lkOff').value))) { el.querySelector('#lkErr').textContent = 'קוד שגוי'; return; }
    lock.disable(); drawLockCard(el); toast('הנעילה כובתה');
  };
}

// ---------- אזור אישי (כמו הפרופיל בוואטסאפ) ----------
const MORE_FACES = ['🧔', '👨', '👩', '👱‍♀️', '👦', '👧', '🧒', '👶', '👴', '👵', '🧑', '👩‍🦰', '🧕', '👨‍🦱', '🙂', '😎', '🦁', '🐻', '🦄', '⭐', '💜', '🌸'];
function drawMe(el) {
  if (!syncUser && !UITEST) { el.style.display = 'none'; return; }
  const hh = UITEST ? FAKE_HH : sync.household();
  const parent = sync.isParent();
  let p = personOf(S.me);
  const savePeople = async () => { await db.setKV('people', S.people); renderAll(); drawMe(el); };
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px">
      <button id="meFace" aria-label="שינוי אייקון" style="width:76px;height:76px;flex:none;border-radius:50%;border:3px solid transparent;background:linear-gradient(var(--bg),var(--bg)) padding-box,conic-gradient(#FEDA75,#FA7E1E,#D62976,#962FBF,#4F5BD5,#FEDA75) border-box;font-size:40px;cursor:pointer">${p?.e || '🙂'}</button>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:6px"><b style="font-size:21px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p?.name || 'בלי שם')}</b><button class="chip" data-me-edit="name" aria-label="שינוי שם">✏️</button></div>
        <div class="sub" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">✉️ ${esc(syncUser?.email || '')}</div>
        <div class="sub">📞 ${p?.phone ? esc(p.phone) : 'לא הוזן'} <button class="chip" data-me-edit="phone" style="padding:2px 8px" aria-label="עריכת טלפון">✏️</button></div>
      </div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;padding:10px 12px;border-radius:14px;background:var(--card2)">
      <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">👨‍👩‍👧 <b>${esc(hh?.name || 'בלי משפחה')}</b> · ${parent ? '👨‍👩 הורה' : '🧒 ילד'}</span>
      ${parent && hh ? '<button class="chip" data-me-edit="family">✏️ שינוי שם</button>' : ''}
    </div>
    ${parent && hh ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;padding:10px 12px;border-radius:14px;background:var(--card2)">
      <span style="min-width:0">📧 סיכום חודשי למייל<div class="sub" style="font-size:12px">ב-1 לכל חודש: סיכום + קובץ אקסל</div></span>
      <button class="chip" id="meMail">…</button></div>` : ''}
    <div id="meEdit"></div>
    <div class="row2" style="margin-top:10px"><button class="btn ghost" data-me-edit="password">🔑 שינוי סיסמה</button><button class="btn ghost" data-me-edit="switch">🔄 משפחה אחרת</button></div>
    <button class="btn danger full" id="meOut" style="margin-top:10px">🚪 יציאה מהחשבון</button>`;
  const mailBtn = el.querySelector('#meMail');
  if (mailBtn) {
    const show = on => { mailBtn.textContent = on ? '✅ פעיל' : '⏸️ כבוי'; mailBtn.classList.toggle('on', on); mailBtn.dataset.on = on ? '1' : ''; };
    (UITEST ? Promise.resolve(true) : sync.getMonthlyEmail()).then(show, () => show(true));
    mailBtn.onclick = async () => {
      const on = !mailBtn.dataset.on;
      try { if (!UITEST) await sync.setMonthlyEmail(on); show(on); toast(on ? '📧 הסיכום החודשי יגיע למייל ב-1 לחודש' : '⏸️ הסיכום החודשי במייל כובה'); }
      catch (e) { toast(e.message, true); }
    };
  }
  const box = el.querySelector('#meEdit');
  const form = (html, onSave) => {
    box.innerHTML = `<div style="margin-top:12px;padding:12px;border-radius:16px;border:1px solid var(--line);background:var(--card)">${html}
      <div class="err" id="meErr"></div><div class="row2"><button class="btn ghost" id="meCancel">ביטול</button><button class="btn grad" id="meSave">שמירה</button></div></div>`;
    box.querySelector('#meCancel').onclick = () => { box.innerHTML = ''; };
    box.querySelectorAll('input').forEach(i => i.oninput = () => box.querySelector('#meErr').textContent = '');
    box.querySelector('#meSave').onclick = async () => {
      try { await onSave(); } catch (x) { box.querySelector('#meErr').textContent = x.message; }
    };
    box.querySelector('input')?.focus();
  };
  el.querySelector('#meFace').onclick = () => {
    box.innerHTML = `<div style="margin-top:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(46px,1fr));gap:8px">${MORE_FACES.map(f => `<button class="chip" data-face="${f}" style="font-size:24px;padding:6px;max-width:none">${f}</button>`).join('')}</div>`;
    box.querySelectorAll('[data-face]').forEach(b => b.onclick = async () => { if (!p) return; p.e = b.dataset.face; await savePeople(); toast('✨ האייקון עודכן'); });
  };
  el.querySelectorAll('[data-me-edit]').forEach(b => b.onclick = () => {
    const k = b.dataset.meEdit;
    if (k === 'name') form(`<label class="field"><span>השם שלי</span><input id="meIn" value="${esc(p?.name || '')}"></label>`, async () => {
      const v = box.querySelector('#meIn').value.trim();
      if (!v) throw new Error('צריך לכתוב שם');
      if (S.people.some(x => x.name === v && x !== p)) throw new Error('השם הזה כבר קיים במשפחה');
      p.name = v; await savePeople(); toast('✅ השם עודכן');
    });
    if (k === 'phone') form(`<label class="field"><span>הטלפון שלי (לא חובה)</span><input id="meIn" type="tel" inputmode="tel" value="${esc(p?.phone || '')}" placeholder="050-0000000"></label>`, async () => {
      p.phone = box.querySelector('#meIn').value.trim(); await savePeople(); toast('✅ נשמר');
    });
    if (k === 'family') form(`<label class="field"><span>שם המשפחה</span><input id="meIn" value="${esc(hh?.name || '')}" maxlength="60"></label>`, async () => {
      const v = box.querySelector('#meIn').value.trim();
      if (!v) throw new Error('צריך לכתוב שם');
      if (!UITEST) await sync.renameHousehold(v);
      drawMe(el); drawSync(document.querySelector('#syncCard')); toast('✅ שם המשפחה עודכן');
    });
    if (k === 'password') form(`<label class="field"><span>סיסמה חדשה (לפחות 6 תווים)</span><input id="meIn" type="password" autocomplete="new-password"></label>
      <label class="field"><span>שוב את אותה סיסמה</span><input id="meIn2" type="password" autocomplete="new-password"></label>`, async () => {
      const a = box.querySelector('#meIn').value, c = box.querySelector('#meIn2').value;
      if (a.length < 6) throw new Error('לפחות 6 תווים');
      if (a !== c) throw new Error('הסיסמאות לא זהות');
      if (!UITEST) await sync.changePassword(a);
      box.innerHTML = ''; toast('🔑 הסיסמה עודכנה');
    });
    if (k === 'switch') {
      form(`<div class="sub" style="margin-bottom:10px;line-height:1.6">עוברים למשפחה אחרת עם קוד — או יוצאים ופותחים משפחה חדשה.<br>⚠️ הנתונים של "${esc(hh?.name || '')}" יימחקו מהטלפון הזה${parent ? ' (ואם אין בה אף אחד אחר — יימחקו לגמרי)' : ''}.</div>
        <label class="field"><span>קוד המשפחה החדשה (ריק = לפתוח משפחה חדשה)</span><input id="meIn" maxlength="6" style="text-transform:uppercase;letter-spacing:3px;text-align:center"></label>`, async () => {
        const code = box.querySelector('#meIn').value.trim();
        if (code && code.length < 6) throw new Error('הקוד הוא 6 תווים');
        const btn = box.querySelector('#meSave');
        if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'בטוח? לחץ שוב'; return; }
        if (UITEST) { toast('(בדיקה) היה עובר משפחה'); return; }
        await sync.leaveHousehold();
        S.tx = []; S.people = []; S.me = null; S.budgets = {}; S.learned = {};
        let joinErr = '';
        if (code) { try { await sync.joinHousehold(code); await sync.connected(); } catch (x) { joinErr = x.message; } }
        await reloadFromDb(); closeSheet(); showGate();
        if (joinErr) { toast(`יצאת מהמשפחה, אבל ההצטרפות לא הצליחה: ${joinErr}. אפשר לנסות שוב כאן`, true); return; }
        toast(code ? '🎉 עברת למשפחה החדשה' : 'יצאת מהמשפחה — עכשיו פותחים משפחה חדשה');
      });
      box.querySelector('#meSave').textContent = 'מעבר';
    }
  });
  el.querySelector('#meOut').onclick = async e => {
    if (!e.target.dataset.armed) { e.target.dataset.armed = '1'; e.target.textContent = 'בטוח? לחץ שוב לצאת'; return; }
    if (UITEST) return;
    await sync.signOut(); syncUser = null; closeSheet(); showGate();
  };
}

// ---------- סנכרון בין הטלפונים ----------
let removedFrom = null; // 🔐 שם המשפחה שממנה הוסרת (להודעה במסך הפתיחה)
let syncUser = null, joinCode = new URLSearchParams(location.search).get('join') || '', joinName = new URLSearchParams(location.search).get('name') || '';
const inputStyle = 'width:100%;height:44px;border-radius:14px;border:1px solid var(--line);background:var(--card2);padding:0 12px;outline:none;margin-bottom:8px;font-size:16px';

// מצב בדיקת עיצוב — רק במחשב הפיתוח (localhost), לעולם לא באתר האמיתי
const UITEST = location.hostname === 'localhost' && new URLSearchParams(location.search).has('uitest');
const FAKE_HH = { id: 'x', name: 'משפחת בדיקה ארוכה מאוד', role: 'parent', invite_code: '8929FF', child_code: 'BC0DC2' };

// ---------- QR להצטרפות ----------
let qrLib = null;
const loadQR = () => qrLib ??= new Promise((res, rej) => {
  const s = document.createElement('script'); s.src = 'vendor/qrcode.js';
  s.onload = () => res(window.qrcode); s.onerror = () => { qrLib = null; rej(new Error('qr')); }; document.head.appendChild(s);
});
const joinLink = code => `${location.origin}${location.pathname}guide/?join=${encodeURIComponent(code)}`;
async function qrSVG(code) {
  const qr = (await loadQR())(0, 'M'); qr.addData(joinLink(code)); qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
async function drawQRs(el) {
  for (const box of el.querySelectorAll('[data-qr]')) { try { box.innerHTML = await qrSVG(box.dataset.qr); } catch { box.remove(); } }
  el.querySelectorAll('[data-zoom]').forEach(b => b.onclick = async () => {
    const ov = document.createElement('div'); ov.className = 'qr-zoom';
    ov.innerHTML = `<div class="qr-card"><b>${b.dataset.zt}</b><div class="qr big">${await qrSVG(b.dataset.zoom)}</div>
      <div class="qr-code">${esc(b.dataset.zoom)}</div><div class="sub" style="color:#555">פותחים את המצלמה בטלפון השני ומכוונים לריבוע 📷</div>
      <button class="btn grad full" style="margin-top:12px">סגירה</button></div>`;
    ov.onclick = e => { if (e.target === ov || e.target.closest('button')) ov.remove(); };
    document.body.appendChild(ov);
  });
}

async function drawSync(el) {
  if (db.DEMO) { el.style.display = 'none'; return; }
  const hh = UITEST ? FAKE_HH : sync.household();
  if (UITEST && !syncUser) syncUser = { id: 'u1', email: 'a.very.long.email.address@example.com' };
  if (!sync.enabled() && !UITEST) {
    el.innerHTML = `<b>☁️ סנכרון בין הטלפונים</b><div class="sub" style="margin-top:4px">עוד לא הוגדר. כרגע הנתונים שמורים רק במכשיר הזה — כדאי לגבות מדי פעם.</div>`;
    return;
  }
  if (!syncUser) {
    el.innerHTML = `<b>☁️ סנכרון בין הטלפונים</b><div class="sub" style="margin:4px 0 10px">נכנסים פעם אחת עם מייל וסיסמה — וכל בני הבית רואים את אותם נתונים</div>
      <input id="sEmail" type="email" autocomplete="email" placeholder="מייל" style="${inputStyle}">
      <input id="sPass" type="password" autocomplete="current-password" placeholder="סיסמה (לפחות 6 תווים)" style="${inputStyle}">
      <div class="err" id="sErr"></div>
      <div class="row2"><button class="btn grad" id="sIn">כניסה</button><button class="btn ghost" id="sUp">הרשמה חדשה</button></div>
      <button class="linkbtn" id="sForgot">🔑 שכחתי סיסמה</button>`;
    el.querySelector('#sForgot').onclick = e => forgotPassword(el.querySelector('#sEmail'), el.querySelector('#sErr'), e.target);
    const go2 = async fn => {
      const e = el.querySelector('#sEmail').value.trim(), p = el.querySelector('#sPass').value;
      if (!/^\S+@\S+\.\S+$/.test(e)) { el.querySelector('#sErr').textContent = 'צריך מייל תקין'; return; }
      if (p.length < 6) { el.querySelector('#sErr').textContent = 'הסיסמה צריכה להיות לפחות 6 תווים'; return; }
      try { await fn(e, p); syncUser = await sync.user(); try { await sync.loadHousehold(); } catch {} if (sync.household()) { await sync.connected(); await reloadFromDb(); } drawSync(el); toast('✅ מחובר'); }
      catch (err) { el.querySelector('#sErr').textContent = err.message; }
    };
    el.querySelector('#sIn').onclick = () => go2(sync.signIn);
    el.querySelector('#sUp').onclick = () => go2(sync.signUp);
    el.querySelectorAll('input').forEach(i => i.oninput = () => el.querySelector('#sErr').textContent = '');
    return;
  }
  if (!hh) {
    el.innerHTML = `<b>☁️ ${esc(syncUser.email)}</b><div class="sub" style="margin:4px 0 10px">עכשיו פותחים משפחה, או מצטרפים לקיימת עם קוד</div>
      <input id="hName" placeholder="שם המשפחה, למשל: משפחת כהן" style="${inputStyle}">
      <button class="btn grad full" id="hNew" style="margin-bottom:12px">👨‍👩‍👧 פתיחת משפחה חדשה</button>
      <input id="hCode" placeholder="קוד הצטרפות (6 תווים)" value="${esc(joinCode)}" style="${inputStyle};text-transform:uppercase;letter-spacing:3px;text-align:center">
      <button class="btn ghost full" id="hJoin">🔑 הצטרפות עם קוד</button>
      <div class="err" id="hErr" style="margin-top:8px"></div>
      <button class="chip" id="sOut" style="margin-top:6px">יציאה</button>`;
    const run = async fn => { try { await fn(); await sync.connected(); await reloadFromDb(); drawSync(el); confetti(); toast('🎉 מחוברים למשפחה!'); } catch (e) { el.querySelector('#hErr').textContent = e.message; } };
    el.querySelector('#hNew').onclick = () => run(() => sync.createHousehold(el.querySelector('#hName').value.trim()));
    el.querySelector('#hJoin').onclick = () => { const c = el.querySelector('#hCode').value.trim(); if (c.length < 6) { el.querySelector('#hErr').textContent = 'הקוד הוא 6 תווים'; return; } run(() => sync.joinHousehold(c)); };
    el.querySelector('#sOut').onclick = async () => { await sync.signOut(); syncUser = null; drawSync(el); };
    return;
  }
  if (hh.role === 'child') {
    el.innerHTML = `<b>☁️ ${esc(hh.name)}</b> <span class="sub" id="syncState">· מסונכרן ✓</span>
      <div class="sub" style="margin-top:4px">🧒 חשבון ילד — אפשר להוסיף הוצאות והכנסות ולראות את מה שרשמת</div>`;
    return;
  }
  const inviteHref = (role, name) => {
    const code = role === 'parent' ? hh.invite_code : hh.child_code;
    const link = `${location.origin}${location.pathname}guide/?join=${code}${name ? '&name=' + encodeURIComponent(name) : ''}`;
    const msg = `${name ? `היי ${name}! ` : ''}הצטרפו לתקציב המשפחתי שלנו ב"כסף בכיף" 💰\nהכל בקישור אחד — התקנה, הצטרפות והסבר:\n${link}\n\nקוד ${role === 'parent' ? 'הורה' : 'ילד'} (למקרה שצריך): ${code}`;
    return `https://wa.me/?text=${encodeURIComponent(msg)}`;
  };
  const row = (inner, actions) => `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:8px 10px;margin-bottom:6px">
    <span style="flex:1;min-width:120px">${inner}</span>${actions}</div>`;
  el.innerHTML = `<b style="font-size:16px">👨‍👩‍👧 ${esc(hh.name)}</b> <span class="sub" id="syncState">· מסונכרן ✓</span>
    <div class="sub" style="margin:4px 0 12px">${esc(syncUser.email)} · אתה הורה — רואה הכל ומנהל את המשפחה</div>
    <div class="sub" style="margin-bottom:6px">🔑 קודי הצטרפות — סורקים את הריבוע במצלמה של הטלפון, או מקריאים / מעתיקים:</div>
    <div class="row2" style="margin-bottom:14px">
      <div style="text-align:center;background:linear-gradient(160deg,rgba(124,58,237,.35),rgba(168,85,247,.2));border:1px solid rgba(196,181,253,.4);border-radius:18px;padding:12px 6px;min-width:0;overflow:hidden">
        <div class="sub" style="color:#E9D5FF">👨‍👩 קוד להורה</div>
        <div style="font-size:clamp(20px,6vw,28px);font-weight:800;letter-spacing:2px;direction:ltr;margin:4px 0 8px;white-space:nowrap">${hh.invite_code}</div>
        <div class="qr" data-qr="${hh.invite_code}"></div>
        <button class="chip" data-copy="${hh.invite_code}">📋 העתקה</button> <button class="chip" data-zoom="${hh.invite_code}" data-zt="👨‍👩 קוד להורה">🔍 להגדיל</button></div>
      <div style="text-align:center;background:linear-gradient(160deg,rgba(249,115,22,.35),rgba(251,146,60,.2));border:1px solid rgba(253,186,116,.4);border-radius:18px;padding:12px 6px;min-width:0;overflow:hidden">
        <div class="sub" style="color:#FFEDD5">🧒 קוד לילד</div>
        <div style="font-size:clamp(20px,6vw,28px);font-weight:800;letter-spacing:2px;direction:ltr;margin:4px 0 8px;white-space:nowrap">${hh.child_code || '—'}</div>
        ${hh.child_code ? `<div class="qr" data-qr="${hh.child_code}"></div>
        <button class="chip" data-copy="${hh.child_code}">📋 העתקה</button> <button class="chip" data-zoom="${hh.child_code}" data-zt="🧒 קוד לילד">🔍 להגדיל</button>` : ''}</div>
    </div>
    <div class="regen"><button class="chip" id="regenCodes">🔄 להחליף קודים</button>
      <span class="sub">מישהו לא רצוי קיבל קוד או קישור? מחליפים — והקודים, הקישורים וה-QR הישנים מפסיקים לעבוד מיד. מי שכבר במשפחה נשאר.</span></div>
    <div class="sub" style="margin-bottom:6px">👨‍👩‍👧 מי במשפחה:</div>
    <div id="famList" class="sub">טוען…</div>
    <div class="err" id="memErr"></div>
    <div style="display:flex;gap:8px;margin-top:4px"><button class="round attach" id="pplFace" style="width:44px;height:44px" aria-label="בחירת אייקון">${FACES[1]}</button>
      <input id="pplName" placeholder="הוספת בן משפחה, למשל: יעל" style="flex:1;min-width:0;height:44px;border-radius:14px;border:1px solid var(--line);background:var(--card2);padding:0 12px;outline:none;font-size:16px">
      <button class="btn grad" id="pplAdd" style="height:44px">הוספה</button></div>
    <div class="sub" style="margin-top:10px;line-height:1.6">📱 מחובר — יש לו טלפון משלו (הורה רואה הכל, ילד רק מוסיף)<br>✏️ רק שם — רושמים בשבילו, למשל "יעל: גלידה 15"</div>
`;

  drawQRs(el);
  el.querySelector('#regenCodes')?.addEventListener('click', async e => {
    const b = e.currentTarget;
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = '⚠️ בטוח? לחץ שוב'; b.classList.add('armed'); return; }
    if (UITEST) { toast('(בדיקה) הקודים היו מתחלפים'); return; }
    b.disabled = true; b.textContent = '⏳ מחליף…';
    try { await sync.regenerateCodes(); toast('🔐 הוחלפו קודים — הישנים כבר לא עובדים'); confetti(); drawSync(el); }
    catch (x) { b.disabled = false; b.textContent = '🔄 להחליף קודים'; toast(x.message, true); }
  });
  el.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = '✅ הועתק'; } catch { b.textContent = b.dataset.copy; }
  });
  let face = 1;
  const err = m => { el.querySelector('#memErr').textContent = m; };
  const drawFamily = async () => {
    const box = el.querySelector('#famList'); if (!box) return;
    let members = [], offline = false;
    try { members = UITEST ? [{ user_id: 'u1', role: 'parent' }, { user_id: 'u2', role: 'child' }, { user_id: 'u3', role: 'parent' }] : await sync.listMembers(); } catch { offline = true; }
    const html = S.people.map(p => {
      const m = members.find(x => x.user_id === p.uid), me = p.uid === syncUser.id;
      if (m) return row(`📱 ${esc(p.e)} <b>${esc(p.name)}</b>${me ? ' (אני)' : ''}`,
        `<button class="chip ${m.role === 'parent' ? 'on' : ''}" data-role="${m.user_id}" data-to="${m.role === 'parent' ? 'child' : 'parent'}">${m.role === 'parent' ? '👨‍👩 הורה' : '🧒 ילד'}</button>${me ? '' : `<button class="chip" data-rm="${m.user_id}" aria-label="הסרה מהמשפחה">✕</button>`}`);
      return row(`✏️ ${esc(p.e)} <b>${esc(p.name)}</b> <span class="sub">· רק שם</span>`,
        `<span data-invbox="${p.id}"><button class="chip" data-inv="${p.id}">📱 הזמנה</button></span><button class="chip" data-del="${p.id}" aria-label="מחיקת השם">✕</button>`);
    }).join('') + members.filter(m => !S.people.some(p => p.uid === m.user_id)).map(m =>
      row(`📱 👤 <span class="sub">נרשם, עוד לא בחר שם</span>`,
        `<button class="chip ${m.role === 'parent' ? 'on' : ''}" data-role="${m.user_id}" data-to="${m.role === 'parent' ? 'child' : 'parent'}">${m.role === 'parent' ? '👨‍👩 הורה' : '🧒 ילד'}</button><button class="chip" data-rm="${m.user_id}" aria-label="הסרה מהמשפחה">✕</button>`)).join('');
    box.innerHTML = (html || '<div class="sub">עוד אין אף אחד</div>') + (offline ? '<div class="sub">⚠️ אין חיבור — מוצג חלקית</div>' : '');
    box.querySelectorAll('[data-role]').forEach(b => b.onclick = async () => {
      try { await sync.setRole(b.dataset.role, b.dataset.to); toast(b.dataset.to === 'parent' ? 'עכשיו הורה 👨‍👩' : 'עכשיו ילד 🧒'); drawFamily(); } catch (x) { err(x.message); }
    });
    box.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'להסיר?'; return; }
      try {
        await sync.removeMember(b.dataset.rm);
        // גם השם שלו יורד מהרשימה (השרת כבר מחק — כאן מעדכנים מיד גם בטלפון)
        if (S.people.some(p => p.uid === b.dataset.rm)) { S.people = S.people.filter(p => p.uid !== b.dataset.rm); await db.setKV('people', S.people); renderAll(); }
        toast('הוסר מהמשפחה — הוא כבר לא רואה את הנתונים'); drawFamily();
      } catch (x) { err(x.message); }
    });
    box.querySelectorAll('[data-inv]').forEach(b => b.onclick = () => {
      const p = personOf(b.dataset.inv);
      box.querySelector(`[data-invbox="${p.id}"]`).innerHTML = `<span class="sub">להזמין כ:</span>
        <a class="chip" href="${inviteHref('parent', p.name)}" target="_blank" rel="noopener" style="text-decoration:none">👨‍👩 הורה <b style="direction:ltr;letter-spacing:2px">${hh.invite_code}</b></a>
        <a class="chip" href="${inviteHref('child', p.name)}" target="_blank" rel="noopener" style="text-decoration:none">🧒 ילד <b style="direction:ltr;letter-spacing:2px">${hh.child_code || ''}</b></a>
        <span class="sub" style="width:100%">לחיצה שולחת בוואטסאפ · יושבים ליד? פשוט מקריאים את הקוד</span>`;
    });
    box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'למחוק?'; return; }
      S.people = S.people.filter(p => p.id !== b.dataset.del); await db.setKV('people', S.people); renderAll(); drawFamily();
    });
  };
  drawFamily();
  el.querySelector('#pplFace').onclick = e => { face = (face + 1) % FACES.length; e.target.textContent = FACES[face]; };
  el.querySelector('#pplName').oninput = () => err('');
  el.querySelector('#pplAdd').onclick = async () => {
    const name = el.querySelector('#pplName').value.trim();
    if (!name) return err('צריך לכתוב שם');
    if (S.people.some(p => p.name === name)) return err('השם הזה כבר קיים');
    const p = { id: db.newId(), name, e: FACES[face] };
    S.people.push(p); await db.setKV('people', S.people);
    el.querySelector('#pplName').value = ''; renderAll(); drawFamily();
    toast(`👋 ${p.e} ${name} נוסף/ה — אפשר לרשום על שמו/ה, או ללחוץ "📱 הזמנה"`);
  };
}

async function reloadFromDb() {
  S.tx = await db.allTx();
  S.cats = await db.getKV('cats', {}); applyCustomCats(S.cats);
  S.goals = await db.getKV('goals', {}); S.maaser = await db.getKV('maaser', {}); S.pocket = await db.getKV('pocket', {}); S.debts = await db.getKV('debts', {}); S.recurring = await db.getKV('recurring', {});
  S.budgets = await db.getKV('budgets', {});
  S.learned = await db.getKV('learned', {});
  S.people = cleanPeople(await db.getKV('people', []));
  renderAll();
}

// ---------- הפעלה ----------
async function load() {
  S.tx = await db.allTx();
  S.cats = await db.getKV('cats', {}); applyCustomCats(S.cats);
  S.goals = await db.getKV('goals', {}); S.maaser = await db.getKV('maaser', {}); S.pocket = await db.getKV('pocket', {});
  S.budgets = await db.getKV('budgets', {});
  S.learned = await db.getKV('learned', {});
  S.people = cleanPeople(await db.getKV('people', []));
  S.me = await db.getKV('me', null);
  renderAll();
}
load().then(async () => {
  if (db.DEMO) { await demoStart(); if (UITEST) maybeNews(); return; } // 🎭 בלי סנכרון, בלי שרת
  const r = await sync.start({
    onRemoteChange: () => reloadFromDb(),
    onStatus: st => { const el = document.querySelector('#syncState'); if (el) el.textContent = st === 'ok' ? '· מסונכרן ✓' : '· ממתין לרשת…'; },
  });
  syncUser = r.user;
  if (r.removed) { // 🔐 הוסרת מהמשפחה — העותק בטלפון נמחק, ומתחילים מההתחלה כמו משתמש חדש (רק החשבון נשאר)
    S.me = null; S.month = thisMonth(); S.catFilter = null; S.whoFilter = null;
    for (const k of ['kesef-onb-later', 'kesef-cathint', 'debtRemind', 'kesef-tour-seen']) { try { localStorage.removeItem(k); } catch { /* */ } }
    await reloadFromDb();
    removedFrom = typeof r.removed === 'string' ? r.removed : ' ';
  }
  await reloadFromDb();
  await showGate();
  if (!$('#gate').classList.contains('on')) openStartView();
  if (RECOVERY && syncUser) newPasswordSheet();
  else if (LINK_ERR) linkErrorSheet();
  if (r.deleted) toast('👋 החשבון הזה כבר לא קיים — אפשר להירשם מחדש', true);
  if (new URLSearchParams(location.search).get('v') === 'budget') go('budget'); // לחיצה על התראת תקציב
  await postRecurring();
  starsLink(); addLink(); if (!$('#sheet').classList.contains('on')) maybeOnboard();
  debtReminder(); maybeNews();
});

// 🔑 הקישור מהמייל לא עבד (פג תוקף / כבר נפתח) — מסבירים ומאפשרים לשלוח שוב
function linkErrorSheet() {
  history.replaceState(null, '', location.pathname + location.search);
  document.body.classList.add('over-gate');
  openSheet(`<div class="onb-emo">⏰</div><h3 style="text-align:center">הקישור מהמייל כבר לא תקף</h3>
    <div class="sub" style="text-align:center;margin:-4px 0 14px">קישור לאיפוס סיסמה עובד <b>פעם אחת בלבד</b> ולזמן קצר. לפעמים תיבת המייל "בודקת" אותו לפני שלוחצים.<br>שולחים מייל חדש ולוחצים על הקישור <b>מיד</b>:</div>
    <input id="leMail" type="email" autocomplete="email" placeholder="המייל שאיתו נרשמת" style="${inputStyle}">
    <div class="err" id="leErr"></div><button class="btn grad full" id="leSend">📧 לשלוח קישור חדש</button>`, sh => {
    sh.querySelector('#leSend').onclick = async e => {
      const m = sh.querySelector('#leMail').value.trim(); if (!/.+@.+\..+/.test(m)) { sh.querySelector('#leErr').textContent = 'צריך מייל תקין'; return; }
      e.target.disabled = true;
      try { await sync.resetPassword(m); e.target.textContent = '📧 נשלח! פתחו את המייל ולחצו על הקישור'; }
      catch (x) { e.target.disabled = false; sh.querySelector('#leErr').textContent = x.message; }
    };
  });
}
// 🔑 אחרי לחיצה על הקישור במייל "שכחתי סיסמה"
function newPasswordSheet() {
  document.body.classList.add('over-gate'); // מעל מסך הכניסה / הנעילה — אחרת לא רואים את החלון
  openSheet(`<h3>🔑 סיסמה חדשה</h3><div class="sub" style="margin:-6px 0 12px">בחר סיסמה חדשה לחשבון ${esc(syncUser.email || '')}</div>
    <input id="npPass" type="password" autocomplete="new-password" placeholder="סיסמה חדשה (לפחות 6 תווים)" style="${inputStyle}">
    <div class="err" id="npErr"></div><button class="btn grad full" id="npSave">שמירה</button>`, sh => {
    sh.querySelector('#npSave').onclick = async () => {
      const pw = sh.querySelector('#npPass').value;
      if (pw.length < 6) { sh.querySelector('#npErr').textContent = 'הסיסמה צריכה להיות לפחות 6 תווים'; return; }
      try { await sync.changePassword(pw); document.body.classList.remove('over-gate'); closeSheet(); toast('✅ הסיסמה הוחלפה — אפשר להיכנס איתה'); showGate(); }
      catch (x) { sh.querySelector('#npErr').textContent = x.message; }
    };
  });
  history.replaceState(null, '', location.pathname + location.search);
}
// כפתור "שכחתי סיסמה" — משתמש במייל שכבר הוקלד
async function forgotPassword(emailInput, errEl, btn) {
  const e = emailInput.value.trim();
  if (!/^\S+@\S+\.\S+$/.test(e)) { errEl.textContent = 'קודם כתוב את המייל שלך למעלה'; emailInput.focus(); return; }
  btn.disabled = true;
  try { await sync.resetPassword(e); errEl.textContent = ''; toast('📧 שלחנו לך מייל — לחץ על הקישור שבו ובחר סיסמה חדשה'); btn.textContent = '📧 נשלח! בדוק את המייל'; }
  catch (x) { errEl.textContent = x.message; btn.disabled = false; }
}

// ---------- מסך פתיחה: נרשמים לפני שמתחילים ----------
async function gateStep() {
  if (!sync.enabled()) return null;
  if (!syncUser) return 'auth';
  if (!sync.household()) return 'family';
  const mine = S.people.find(p => p.uid === syncUser.id);
  if (!mine) return 'name';
  if (S.me !== mine.id) { S.me = mine.id; await db.setKV('me', S.me); }
  return null;
}

async function showGate() {
  const step = await gateStep();
  const g = $('#gate');
  if (!step) { const was = g.classList.contains('on'); g.classList.remove('on'); renderAll(); if (was) maybeOnboard(); return; }
  g.classList.add('on');
  const body = $('#gateBody');
  const err = msg => { body.querySelector('.err').textContent = msg; };
  const busy = (btn, on) => { btn.disabled = on; btn.style.opacity = on ? .6 : 1; };

  if (step === 'auth') {
    body.innerHTML = `<h2>ברוכים הבאים ✨</h2>
      <p class="sub" style="margin-bottom:16px">${joinCode ? '👋 הוזמנת למשפחה! קודם נרשמים — ' : ''}נרשמים פעם אחת, וכל בני הבית רואים את אותם נתונים מכל טלפון</p>
      <input id="gEmail" type="email" autocomplete="email" placeholder="מייל" style="${inputStyle}">
      <input id="gPass" type="password" autocomplete="new-password" placeholder="סיסמה (לפחות 6 תווים)" style="${inputStyle}">
      <div class="err"></div>
      <button class="btn grad full" id="gUp" style="margin-bottom:8px">הרשמה</button>
      <button class="btn ghost full" id="gIn">כבר נרשמתי — כניסה</button>
      <button class="linkbtn" id="gForgot">🔑 שכחתי סיסמה</button>
      <a href="guide/" target="_blank" rel="noopener" class="sub" style="display:block;text-align:center;margin-top:14px;color:#F9A8D4">❓ צריך עזרה? למדריך</a>`;
    const go2 = async (fn, btn) => {
      const e = body.querySelector('#gEmail').value.trim(), p = body.querySelector('#gPass').value;
      if (!/^\S+@\S+\.\S+$/.test(e)) return err('צריך מייל תקין');
      if (p.length < 6) return err('הסיסמה צריכה להיות לפחות 6 תווים');
      busy(btn, true);
      try {
        await fn(e, p); syncUser = await sync.user();
        try { await sync.loadHousehold(); } catch {}
        if (sync.household()) { await sync.connected(); await reloadFromDb(); }
        showGate();
      } catch (x) { err(x.message); busy(btn, false); }
    };
    body.querySelector('#gUp').onclick = e => go2(sync.signUp, e.target);
    body.querySelector('#gIn').onclick = e => go2(sync.signIn, e.target);
    body.querySelector('#gForgot').onclick = e => forgotPassword(body.querySelector('#gEmail'), body.querySelector('.err'), e.target);
    body.querySelectorAll('input').forEach(i => i.oninput = () => err(''));
    return;
  }

  if (step === 'family') {
    body.innerHTML = `${removedFrom ? `<div class="removed-note">👋 <b>הוסרת מהמשפחה${removedFrom.trim() ? ` "${esc(removedFrom)}"` : ''}</b><br>הורה במשפחה הסיר אותך, והנתונים שלה נמחקו מהטלפון הזה. אפשר לפתוח משפחה חדשה, או להצטרף שוב עם קוד חדש.</div>` : ''}<h2>👨‍👩‍👧 המשפחה</h2>
      <p class="sub" style="margin-bottom:16px">מי שמתחיל — פותח משפחה ושולח קוד לבני הבית. מי שקיבל קוד — מצטרף</p>
      ${joinCode ? '' : `<input id="gName" placeholder="שם המשפחה, למשל: משפחת כהן" style="${inputStyle}">
      <button class="btn grad full" id="gNew" style="margin-bottom:18px">פתיחת משפחה חדשה</button>`}
      <input id="gCode" placeholder="קוד הצטרפות (6 תווים)" value="${esc(joinCode)}" style="${inputStyle};text-transform:uppercase;letter-spacing:3px;text-align:center">
      <button class="btn ${joinCode ? 'grad' : 'ghost'} full" id="gJoin">🔑 הצטרפות עם קוד</button>
      <div class="err" style="margin-top:8px"></div>
      <button class="chip" id="gOut" style="margin-top:10px">יציאה מהחשבון</button>`;
    const run = async (fn, btn) => {
      busy(btn, true);
      try { await fn(); await sync.connected(); await reloadFromDb(); confetti(); showGate(); }
      catch (x) { err(x.message); busy(btn, false); }
    };
    body.querySelector('#gNew')?.addEventListener('click', e => run(() => sync.createHousehold(body.querySelector('#gName').value.trim()), e.target));
    body.querySelector('#gJoin').onclick = e => {
      const c = body.querySelector('#gCode').value.trim();
      if (c.length < 6) return err('הקוד הוא 6 תווים');
      run(() => sync.joinHousehold(c), e.target);
    };
    body.querySelector('#gOut').onclick = async () => { await sync.signOut(); syncUser = null; showGate(); };
    return;
  }

  // step === 'name'
  const free = S.people.filter(p => !p.uid).sort((a, b) => (b.name === joinName) - (a.name === joinName));
  let face = 0;
  body.innerHTML = `<h2>🙋 איך קוראים לך?</h2>
    <p class="sub" style="margin-bottom:16px">כל מה שתרשום יופיע אוטומטית על השם שלך</p>
    ${free.length ? `<div class="sub" style="margin-bottom:6px">אולי זה אתה?</div><div class="chips" style="flex-wrap:wrap;margin-bottom:14px">${free.map(p => `<button class="chip ${p.name === joinName ? 'on' : ''}" data-claim="${p.id}">אני ${esc(p.e)} ${esc(p.name)}</button>`).join('')}</div>` : ''}
    <div style="display:flex;gap:8px"><button class="round attach" id="gFace" style="width:48px;height:48px" aria-label="בחירת אייקון">${FACES[0]}</button>
      <input id="gMe" placeholder="השם שלי" style="${inputStyle};margin:0;flex:1"></div>
    <div class="err" style="margin-top:8px"></div>
    <button class="btn grad full" id="gSave" style="margin-top:10px">יאללה, מתחילים! 🚀</button>`;
  const finish = async () => { await db.setKV('people', S.people); await db.setKV('me', S.me); confetti(); showGate(); toast('🎉 ברוך הבא!'); };
  body.querySelectorAll('[data-claim]').forEach(b => b.onclick = async () => {
    const p = S.people.find(x => x.id === b.dataset.claim); p.uid = syncUser.id; S.me = p.id; await finish();
  });
  body.querySelector('#gFace').onclick = e => { face = (face + 1) % FACES.length; e.target.textContent = FACES[face]; };
  body.querySelector('#gMe').oninput = () => err('');
  body.querySelector('#gSave').onclick = async () => {
    const name = body.querySelector('#gMe').value.trim();
    if (!name) return err('צריך לכתוב שם');
    if (S.people.some(p => p.name === name)) return err('השם הזה כבר קיים — אם זה אתה, לחץ עליו למעלה');
    const p = { id: db.newId(), name, e: FACES[face], uid: syncUser.id };
    S.people.push(p); S.me = p.id; await finish();
  };
}

// ---------- עדכונים אוטומטיים ----------
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) toastAction('✨ יש גרסה חדשה', '🔄 לרענן', () => location.reload()); });
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').then(reg => {
  // בודקים אם יש גרסה חדשה בכל פעם שחוזרים לאפליקציה
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
}).catch(() => {});
// מבקשים מהטלפון לא למחוק את הנתונים שבמכשיר (בעיקר באייפון)
navigator.storage?.persist?.().catch(() => {});
