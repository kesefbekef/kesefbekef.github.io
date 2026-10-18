import { CATS, classify, isIncome, catOf } from './categories.js';
import { parseMessage, stripVav, detectPay, PAY } from './parse.js';
import * as db from './db.js';
import * as imp from './importer.js';
import * as xp from './exporter.js';
import * as sync from './sync.js';
import * as lock from './lock.js';
import * as help from './help.js';

// ---------- עזרים ----------
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Math.round(n).toLocaleString('he-IL') + '₪';
const pad = n => String(n).padStart(2, '0');
const ym = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const ymd = d => `${ym(d)}-${pad(d.getDate())}`;
const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); return ym(new Date(y, mo - 1 + n, 1)); };
const monthDiff = (a, b) => { const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1); };
const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const monthLabel = m => { const [y, mo] = m.split('-').map(Number); return `${MONTHS[mo - 1]} ${y}`; };
const timeOf = iso => new Date(iso).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
const thisMonth = () => ym(new Date());

const S = { tx: [], budgets: {}, learned: {}, people: [], me: null, month: thisMonth(), view: 'chat', catFilter: null, whoFilter: null, search: '' };

// ---------- בני הבית ----------
const FACES = ['🧔', '👩', '👦', '👧', '👴', '👵', '🧑', '👶'];
const personOf = id => S.people.find(p => p.id === id);
const whoLabel = id => { const p = personOf(id); return p ? `${p.e} ${p.name}` : ''; };
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
const budgetOf = cat => S.budgets[cat] ?? CATS[cat].budget;
const totalBudget = () => Object.keys(CATS).reduce((s, c) => s + budgetOf(c), 0);
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

// ---------- גיליון תחתון ----------
function openSheet(html, mount) {
  $('#sheet').innerHTML = '<div class="grip"></div>' + html;
  $('#overlay').classList.add('on'); $('#sheet').classList.add('on');
  mount?.($('#sheet'));
}
function closeSheet() { $('#overlay').classList.remove('on'); $('#sheet').classList.remove('on'); }
$('#overlay').onclick = closeSheet;

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
    const m = ym(new Date(t.date)), left = budgetOf(t.cat) - spentIn(t.cat, m);
    sub += left >= 0 ? `נשארו ${fmt(left)}` : `⚠️ חריגה של ${fmt(-left)}`;
  }
  const day = ymd(new Date(t.date)) !== ymd(new Date(t.created)) ? ` · ${new Date(t.date).toLocaleDateString('he-IL')}` : '';
  const pay = t.pay ? `<button data-act="pay" data-id="${t.id}">${PAY[t.pay].e} ${PAY[t.pay].n}</button>` : '';
  // שאלה קלה "איך שולם?" — רק על רשומות חדשות, אפשר לדלג
  const askPay = !t.pay && !t.paySkip && t.source !== 'file' && Date.now() - new Date(t.created) < 12 * 3600e3
    ? `<div class="paynow"><span>💳 איך שולם?</span>${['credit', 'cash', 'transfer', 'bit'].map(k => `<button data-act="setpay" data-pay="${k}" data-id="${t.id}">${PAY[k].e} ${PAY[k].n.split('/')[0]}</button>`).join('')}<button data-act="skippay" data-id="${t.id}" class="skip">דלג</button></div>` : '';
  return `<div class="cat-ic" style="background:${c.g}">${c.e}</div>
    <div><b>${title}</b><div class="sub">${sub}${day}</div>
    ${askPay}
    <div class="acts">${t.who && personOf(t.who) ? `<button data-act="who" data-id="${t.id}">${whoLabel(t.who)}</button>` : ''}${pay}<button data-act="fix" data-id="${t.id}">✏️ עריכה</button><button data-act="undo" data-id="${t.id}">↩️ ביטול</button></div></div>`;
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
      html += `<div class="me${isNew}">${t.source === 'voice' ? '🎤 ' : ''}${esc(t.raw)}<div class="time">${timeOf(t.created)}</div></div>`;
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
  if (FEEDBACK_RE.test(raw)) { $('#inp').blur(); openFeedback(raw.replace(FEEDBACK_RE, '').trim(), raw); return; }
  if (help.isHelpRequest(raw)) { $('#inp').blur(); openHelp(raw, help.wantsGuide(raw) && !help.answer(raw).length); return; }
  const named = detectWho(raw);
  const items = parseMessage(named.text);
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
      who: named.who || S.me || null };
  });

  // ⚠️ כפילות: אותו סכום בערך + אותה קטגוריה או שם דומה, באותו חודש — שואלים לפני שרושמים
  const dups = pending.map(t => ({ t, d: findDup(t) })).filter(x => x.d);
  typing.remove();
  if (dups.length) {
    const { t, d } = dups[0];
    const by = d.who && personOf(d.who) ? ` ע"י ${esc(whoLabel(d.who))}` : '';
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
    if (before[cat] <= b && after > b) toast(`🚨 עברת את תקציב ${CATS[cat].n}`, true);
    else if (before[cat] < b * .8 && after >= b * .8) toast(`⚠️ הגעת ל-80% מתקציב ${CATS[cat].n}`, true);
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
  else openEditSheet(t);
});

async function removeTx(t) {
  S.tx = S.tx.filter(x => x.id !== t.id); await db.delTx(t.id);
  renderAll(); toast('נמחק ↩️');
}

const payGrid = sel => `<div class="catgrid">${Object.entries(PAY).map(([id, p]) =>
  `<button class="catbtn ${id === sel ? 'sel' : ''}" data-pay="${id}"><div class="cat-ic" style="background:var(--card2)">${p.e}</div>${p.n}</button>`).join('')}</div>`;

const whoChips = sel => S.people.map(p => `<button class="chip ${p.id === sel ? 'on' : ''}" data-w="${p.id}">${p.e} ${esc(p.name)}</button>`).join('');

function openWhoSheet(t) {
  openSheet(`<h3>של מי ההוצאה?</h3><div class="sub" style="margin:-6px 0 12px">"${esc(t.desc)}" · ${fmt(t.inst > 1 ? t.total : t.amount)}</div>
    <div class="chips" style="flex-wrap:wrap;margin-bottom:12px">${whoChips(t.who)}</div>
    <div class="sub">טיפ: אפשר לכתוב ישר בהודעה — "${esc(S.people[0]?.name || 'רחל')}: סופר 230"</div>`, sh => {
    sh.querySelectorAll('[data-w]').forEach(b => b.onclick = async () => {
      t.who = b.dataset.w; await db.putTx(t); closeSheet(); renderAll(); toast(`נשמר על ${whoLabel(t.who)}`);
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
  $('#left').textContent = !kid && inc ? fmt(inc - exp) : fmt(exp);
  const pct = Math.round(exp / totalBudget() * 100);
  $('#usedBar').style.width = Math.min(100, pct) + '%';
  $('#usedPct').textContent = `${pct}% מהתקציב נוצל`;
  $('#daysLeft').textContent = `עוד ${daysLeft()} ימים לסוף ${MONTHS[new Date().getMonth()]}`;
  const s = streak();
  $('#streak').textContent = s ? `🔥 ${s} ${s === 1 ? 'יום' : 'ימים'} ברצף` : '✨ בוא נתחיל';
  $('#bellDot').hidden = !Object.keys(CATS).some(c => spentIn(c, m) > budgetOf(c));
}

function renderStories() {
  const m = thisMonth();
  $('#stories').innerHTML = Object.entries(CATS).map(([id, c]) => {
    const p = Math.min(100, spentIn(id, m) / budgetOf(id) * 100), over = spentIn(id, m) > budgetOf(id);
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
      const who = t.who && personOf(t.who) ? ' · ' + esc(whoLabel(t.who)) : '';
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
  $('#incSum').textContent = fmt(incomeIn(m));
  $('#expSum').textContent = fmt(expenseIn(m));
  $('#budgetList').innerHTML = Object.entries(CATS).map(([id, c]) => {
    const s = spentIn(id, m), b = budgetOf(id), p = Math.min(100, s / b * 100), o = s > b;
    return `<button class="card" data-cat="${id}"><div class="cat-row"><div class="cat-ic" style="background:${c.g}">${c.e}</div><div class="nm">${c.n}</div><div class="am ${o ? 'over' : ''}">${fmt(s)} / ${fmt(b)}</div></div><div class="pbar"><i style="width:${p}%;background:${o ? 'linear-gradient(90deg,#F43F5E,#FB7185)' : c.g}"></i></div></button>`;
  }).join('');
}
$('#budgetList').addEventListener('click', e => {
  const b = e.target.closest('[data-cat]'); if (!b) return;
  openCategory(b.dataset.cat, S.month);
});
document.querySelector('#v-budget .duo').addEventListener('click', e => {
  const st = e.target.closest('.stat'); if (!st) return;
  if (st.querySelector('#incSum')) openCategory('income', S.month);
});
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
  $('#donutSum').textContent = fmt(exp);
  $('#legend').innerHTML = parts.map(p => `<span><i style="background:${p.c.c}"></i>${p.c.n} ${Math.round(p.v / exp * 100)}%</span>`).join('');

  const tips = [];
  if (!exp && !inc) tips.push(['🌱', '<b>עוד אין נתונים לחודש הזה.</b> רשום כמה הוצאות בצ\'אט והתובנות יופיעו כאן.']);
  for (const p of parts) {
    const b = budgetOf(p.id), pct = Math.round(p.v / b * 100);
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
    if (rows.length) tips.push(['👨‍👩‍👧', `<b>מי הוציא כמה:</b><br>${rows.map(([k, v]) => `${k === 'none' ? '❔ לא צוין' : esc(whoLabel(k))}: ${fmt(v)}`).join('<br>')}`]);
  }
  const byPay = {};
  for (const t of txInMonth(m)) if (t.cat !== 'income') { const k = t.pay || 'none'; byPay[k] = (byPay[k] || 0) + amountIn(t, m); }
  const payParts = Object.entries(byPay).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (payParts.length) tips.push(['👛', `<b>איך שילמת החודש:</b><br>${payParts.map(([k, v]) => `${k === 'none' ? '❔ לא צוין' : PAY[k].e + ' ' + PAY[k].n}: ${fmt(v)}`).join('<br>')}`]);
  if (byPay.cash > 300) tips.push(['💵', `<b>${fmt(byPay.cash)} יצאו במזומן.</b> מזומן הכי קל "לאבד" — כדאי לרשום כל הוצאה במזומן מיד.`]);
  const inst = txInMonth(m).filter(t => t.inst > 1);
  if (inst.length) tips.push(['💳', `<b>${inst.length} תשלומים פעילים</b> בסך ${fmt(inst.reduce((s, t) => s + t.amount, 0))} החודש.`]);

  $('#tips').innerHTML = historyCard(m) + tips.map(([e, h]) => `<div class="card tip"><div class="em">${e}</div><p>${h}</p></div>`).join('');
}

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
  if (S.people.length > 1) $('#txFilter').innerHTML += S.people.map(p => `<button class="chip ${S.whoFilter === p.id ? 'on' : ''}" data-wf="${p.id}">${p.e} ${esc(p.name)}</button>`).join('');
  const list = txInMonth(m).filter(t => (!S.catFilter || t.cat === S.catFilter) && (!S.whoFilter || t.who === S.whoFilter) && (!q || t.desc.toLowerCase().includes(q) || t.raw.toLowerCase().includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date));
  $('#txList').innerHTML = list.length ? list.map(t => {
    const c = catOf(t.cat), inc = t.cat === 'income';
    const extra = t.inst > 1 ? ` · תשלום ${installmentNo(t, m)}/${t.inst}` : '';
    return `<button class="tx" data-id="${t.id}"><div class="cat-ic" style="background:${c.g}">${c.e}</div><div class="nm"><div>${esc(t.desc)}</div><small>${c.n} · ${new Date(t.date).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })}${extra}${t.pay ? ' · ' + PAY[t.pay].e + ' ' + PAY[t.pay].n : ''}${t.who && personOf(t.who) ? ' · ' + esc(whoLabel(t.who)) : ''}</small></div><div class="am ${inc ? 'plus' : ''}">${inc ? '+' : ''}${fmt(t.amount)}</div></button>`;
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
    <div class="row2"><button class="btn danger" id="eDel">🗑️ מחיקה</button><button class="btn grad" id="eSave">שמירה</button></div>`, sh => {
    sh.querySelectorAll('[data-cat]').forEach(btn => btn.onclick = () => {
      cat = btn.dataset.cat; sh.querySelectorAll('[data-cat]').forEach(x => x.classList.toggle('sel', x === btn));
    });
    sh.querySelectorAll('#eWho [data-w]').forEach(btn => btn.onclick = () => {
      who = btn.dataset.w; sh.querySelectorAll('#eWho [data-w]').forEach(x => x.classList.toggle('on', x === btn));
    });
    sh.querySelectorAll('[data-p]').forEach(btn => btn.onclick = () => {
      pay = btn.dataset.p; sh.querySelectorAll('[data-p]').forEach(x => x.classList.toggle('on', x === btn));
    });
    sh.querySelector('#eAmt').oninput = () => sh.querySelector('#eErr').textContent = '';
    sh.querySelector('#eSave').onclick = async () => {
      const v = parseFloat(sh.querySelector('#eAmt').value), d = sh.querySelector('#eDate').value;
      if (!(v > 0)) { sh.querySelector('#eErr').textContent = 'צריך להזין סכום גדול מ-0'; return; }
      if (!d) { sh.querySelector('#eErr').textContent = 'צריך לבחור תאריך'; return; }
      const desc = sh.querySelector('#eDesc').value.trim() || t.desc;
      if (cat !== t.cat) { const key = desc.toLowerCase(); if (key.length >= 2) { S.learned[key] = cat; await db.setKV('learned', S.learned); } }
      Object.assign(t, { desc, cat, pay, who, date: new Date(d + 'T12:00:00').toISOString() });
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
    el.innerHTML = `<button data-mn="-1" aria-label="חודש קודם">›</button><span>${monthLabel(S.month)}</span><button data-mn="1" aria-label="חודש הבא">‹</button>`;
  });
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-mn]'); if (!b) return;
  S.month = addMonths(S.month, Number(b.dataset.mn)); S.catFilter = null; renderAll();
});

function go(v) {
  S.view = v;
  $$('nav button').forEach(x => x.classList.toggle('on', x.dataset.v === v));
  $$('.view').forEach(x => x.classList.toggle('on', x.id === 'v-' + v));
  $('#composer').style.display = v === 'chat' ? '' : 'none';
  if (v !== 'chat') { renderAll(); $('#main').scrollTo({ top: 0 }); }
  else { S.month = thisMonth(); renderChat(); }
}
$$('nav button').forEach(b => b.onclick = () => { if (b.dataset.v === 'tx') S.catFilter = null; go(b.dataset.v); });
$('#bell').onclick = () => { S.month = thisMonth(); go('insights'); };

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
  $('#quick').innerHTML = words.map(w => `<button class="chip" data-q="${esc(w)}">${catOf(isIncome(w) ? 'income' : classify(w, S.learned)).e} ${esc(w)}</button>`).join('') + '<button class="chip" data-helpchip="1">❓ עזרה</button>';
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
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
$('#mic').onclick = () => {
  if (inp.value.trim()) { send(inp.value); inp.value = ''; updateMic(); return; }
  if (rec) { rec.stop(); return; }
  if (!SR) { toast('🎤 הדפדפן הזה לא תומך בהקלטה. אפשר ללחוץ על המיקרופון במקלדת של הטלפון'); inp.focus(); return; }
  rec = new SR(); rec.lang = 'he-IL'; rec.interimResults = true; rec.continuous = false;
  let finalText = '';
  $('#mic').classList.add('rec'); inp.placeholder = '🎤 מקשיב… דבר עכשיו';
  rec.onresult = e => {
    let txt = ''; for (const r of e.results) txt += r[0].transcript;
    inp.value = txt; if (e.results[e.results.length - 1].isFinal) finalText = txt;
  };
  rec.onerror = e => { if (e.error === 'not-allowed') toast('🎤 צריך לאשר גישה למיקרופון', true); else if (e.error !== 'no-speech' && e.error !== 'aborted') toast('🎤 לא הצלחתי לשמוע, נסה שוב', true); };
  rec.onend = () => {
    $('#mic').classList.remove('rec'); inp.placeholder = 'מה הוצאת? למשל: סופר 230'; rec = null;
    const t = (finalText || inp.value).trim();
    inp.value = ''; updateMic();
    if (t) send(t, 'voice');
  };
  rec.start();
};

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

const fileInp = document.createElement('input');
fileInp.type = 'file'; fileInp.hidden = true; fileInp.multiple = true;
fileInp.accept = '.xlsx,.xls,.csv,.txt,.pdf,image/*,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';
document.body.appendChild(fileInp);
$('#attach').onclick = () => { fileInp.value = ''; fileInp.click(); };
fileInp.onchange = () => { if (fileInp.files.length) importFiles([...fileInp.files]); };

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
      toast(`✅ יובאו ${chosen.length} תנועות`);
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

// ---------- הגדרות וגיבוי ----------
$('#settingsBtn').onclick = () => openSettings();
function openSettings() { openSheet(`<h3>⚙️ הגדרות</h3>
  <div class="card" id="meCard" style="margin-bottom:12px"></div>
  <div class="card" id="syncCard" style="margin-bottom:12px"></div>
  <div class="card" id="lockCard" style="margin-bottom:12px"></div>
  <button class="btn ghost full" id="toHelp" style="margin-bottom:10px">❓ עזרה ואיך משתמשים</button>
  <button class="btn ghost full" id="toShare" style="margin-bottom:10px">📤 שתף את האפליקציה עם חבר</button>
  <button class="btn ghost full" id="toFeedback" style="margin-bottom:10px">💌 שליחת משוב / הצעה / תקלה</button>
  ${isStandalone() ? '' : '<button class="btn ghost full" id="toInstall" style="margin-bottom:10px">📲 התקנה על המסך (כמו אפליקציה)</button>'}
  <button class="btn grad full parent-only" id="toExcel" style="margin-bottom:10px">📊 הורדת סיכום לאקסל</button>
  <div class="row2" style="margin-bottom:10px"><button class="btn ghost" id="exp">⬇️ גיבוי</button><button class="btn ghost" id="imp">⬆️ שחזור מגיבוי</button></div>
  <input type="file" id="impFile" accept="application/json,.json" hidden>
  <div class="sub" style="text-align:center;margin-top:8px">${S.tx.length} רשומות · ${Object.keys(S.learned).length} מילים שלמדתי</div>`, sh => {
  drawMe(sh.querySelector('#meCard'));
  drawSync(sh.querySelector('#syncCard'));
  drawLockCard(sh.querySelector('#lockCard'));
  sh.querySelector('#toExcel').onclick = () => openExportSheet();
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
const KINDS = { idea: '💡 רעיון', bug: '🐞 משהו לא עובד', love: '❤️ מחמאה', other: '💬 אחר' };

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
      const cloud = sync.saveFeedback({ app: 'kesef-bekef', kind, message, contact, device }).catch(() => false);
      let mailed = false;
      try {
        const r = await fetch(`https://formsubmit.co/ajax/${FEEDBACK_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ _subject: `💌 משוב חדש — כסף בכיף (${KINDS[kind]})`, _template: 'table', _captcha: 'false',
            'סוג': KINDS[kind], 'משוב': message, 'פרטים לחזרה': contact || '—', 'משפחה': sync.household()?.name || '—', 'מכשיר': device || '—' }),
        });
        mailed = r.ok;
      } catch { mailed = false; }
      const saved = await cloud;
      if (mailed || saved) { closeSheet(); confetti(); toast('💌 תודה! המשוב נשלח'); return; }
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
    <button class="btn ghost full" id="hOpenGuide" style="margin-bottom:12px">📖 המדריך המלא (עם תמונות)</button>
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
      : `<div class="card tip" style="margin-bottom:10px"><div class="em">🤖</div><p><b>באנדרואיד (בדפדפן Chrome):</b><br>1. לוחצים על <b>⋮</b> (שלוש נקודות) למעלה<br>2. בוחרים <b>"התקנת אפליקציה"</b> או <b>"הוספה למסך הבית"</b><br>3. מאשרים — וזהו!</p></div>
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
  if (e.target.closest('#lockPad') || e.target.closest('#lockBio')) return;
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
    <div id="meEdit"></div>
    <div class="row2" style="margin-top:10px"><button class="btn ghost" data-me-edit="password">🔑 שינוי סיסמה</button><button class="btn ghost" data-me-edit="switch">🔄 משפחה אחרת</button></div>
    <button class="btn danger full" id="meOut" style="margin-top:10px">🚪 יציאה מהחשבון</button>`;
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
let syncUser = null, joinCode = new URLSearchParams(location.search).get('join') || '', joinName = new URLSearchParams(location.search).get('name') || '';
const inputStyle = 'width:100%;height:44px;border-radius:14px;border:1px solid var(--line);background:var(--card2);padding:0 12px;outline:none;margin-bottom:8px;font-size:16px';

// מצב בדיקת עיצוב — רק במחשב הפיתוח (localhost), לעולם לא באתר האמיתי
const UITEST = location.hostname === 'localhost' && new URLSearchParams(location.search).has('uitest');
const FAKE_HH = { id: 'x', name: 'משפחת בדיקה ארוכה מאוד', role: 'parent', invite_code: '8929FF', child_code: 'BC0DC2' };

async function drawSync(el) {
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
      <div class="row2"><button class="btn grad" id="sIn">כניסה</button><button class="btn ghost" id="sUp">הרשמה חדשה</button></div>`;
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
    <div class="sub" style="margin-bottom:6px">🔑 קודי הצטרפות — אפשר להקריא או להעתיק:</div>
    <div class="row2" style="margin-bottom:14px">
      <div style="text-align:center;background:linear-gradient(160deg,rgba(124,58,237,.35),rgba(168,85,247,.2));border:1px solid rgba(196,181,253,.4);border-radius:18px;padding:12px 6px;min-width:0;overflow:hidden">
        <div class="sub" style="color:#E9D5FF">👨‍👩 קוד להורה</div>
        <div style="font-size:clamp(20px,6vw,28px);font-weight:800;letter-spacing:2px;direction:ltr;margin:4px 0 8px;white-space:nowrap">${hh.invite_code}</div>
        <button class="chip" data-copy="${hh.invite_code}">📋 העתקה</button></div>
      <div style="text-align:center;background:linear-gradient(160deg,rgba(249,115,22,.35),rgba(251,146,60,.2));border:1px solid rgba(253,186,116,.4);border-radius:18px;padding:12px 6px;min-width:0;overflow:hidden">
        <div class="sub" style="color:#FFEDD5">🧒 קוד לילד</div>
        <div style="font-size:clamp(20px,6vw,28px);font-weight:800;letter-spacing:2px;direction:ltr;margin:4px 0 8px;white-space:nowrap">${hh.child_code || '—'}</div>
        ${hh.child_code ? `<button class="chip" data-copy="${hh.child_code}">📋 העתקה</button>` : ''}</div>
    </div>
    <div class="sub" style="margin-bottom:6px">👨‍👩‍👧 מי במשפחה:</div>
    <div id="famList" class="sub">טוען…</div>
    <div class="err" id="memErr"></div>
    <div style="display:flex;gap:8px;margin-top:4px"><button class="round attach" id="pplFace" style="width:44px;height:44px" aria-label="בחירת אייקון">${FACES[1]}</button>
      <input id="pplName" placeholder="הוספת בן משפחה, למשל: יעל" style="flex:1;min-width:0;height:44px;border-radius:14px;border:1px solid var(--line);background:var(--card2);padding:0 12px;outline:none;font-size:16px">
      <button class="btn grad" id="pplAdd" style="height:44px">הוספה</button></div>
    <div class="sub" style="margin-top:10px;line-height:1.6">📱 מחובר — יש לו טלפון משלו (הורה רואה הכל, ילד רק מוסיף)<br>✏️ רק שם — רושמים בשבילו, למשל "יעל: גלידה 15"</div>
`;

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
      if (m) return row(`📱 ${p.e} <b>${esc(p.name)}</b>${me ? ' (אני)' : ''}`,
        `<button class="chip ${m.role === 'parent' ? 'on' : ''}" data-role="${m.user_id}" data-to="${m.role === 'parent' ? 'child' : 'parent'}">${m.role === 'parent' ? '👨‍👩 הורה' : '🧒 ילד'}</button>${me ? '' : `<button class="chip" data-rm="${m.user_id}" aria-label="הסרה מהמשפחה">✕</button>`}`);
      return row(`✏️ ${p.e} <b>${esc(p.name)}</b> <span class="sub">· רק שם</span>`,
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
      try { await sync.removeMember(b.dataset.rm); toast('הוסר מהמשפחה'); drawFamily(); } catch (x) { err(x.message); }
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
  S.budgets = await db.getKV('budgets', {});
  S.learned = await db.getKV('learned', {});
  S.people = await db.getKV('people', []);
  renderAll();
}

// ---------- הפעלה ----------
async function load() {
  S.tx = await db.allTx();
  S.budgets = await db.getKV('budgets', {});
  S.learned = await db.getKV('learned', {});
  S.people = await db.getKV('people', []);
  S.me = await db.getKV('me', null);
  renderAll();
}
load().then(async () => {
  const r = await sync.start({
    onRemoteChange: () => reloadFromDb(),
    onStatus: st => { const el = document.querySelector('#syncState'); if (el) el.textContent = st === 'ok' ? '· מסונכרן ✓' : '· ממתין לרשת…'; },
  });
  syncUser = r.user;
  await reloadFromDb();
  showGate();
});

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
  if (!step) { g.classList.remove('on'); renderAll(); return; }
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
    body.querySelectorAll('input').forEach(i => i.oninput = () => err(''));
    return;
  }

  if (step === 'family') {
    body.innerHTML = `<h2>👨‍👩‍👧 המשפחה</h2>
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
    ${free.length ? `<div class="sub" style="margin-bottom:6px">אולי זה אתה?</div><div class="chips" style="flex-wrap:wrap;margin-bottom:14px">${free.map(p => `<button class="chip ${p.name === joinName ? 'on' : ''}" data-claim="${p.id}">אני ${p.e} ${esc(p.name)}</button>`).join('')}</div>` : ''}
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
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) toast('✨ האפליקציה עודכנה לגרסה חדשה'); });
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
