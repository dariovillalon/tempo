// utils.js — small helpers used throughout the app

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};

export const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

// ----- Date helpers -----
export const pad = n => String(n).padStart(2, '0');

export const todayKey = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const fromKey = key => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const startOfWeek = (d = new Date()) => {
  const x = new Date(d);
  const day = x.getDay(); // 0 Sun .. 6 Sat
  const diff = day === 0 ? -6 : 1 - day; // Monday-start
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
};

export const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

export const fmtTime = (mins) => {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${pad(h)}:${pad(m)}`;
};

export const minsToHrs = (mins) => {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (!h) return `${m}m`;
  if (!m) return `${h}h`;
  return `${h}h ${m}m`;
};

export const minsBetween = (start, end) => {
  if (!start || !end || !start.includes(':') || !end.includes(':')) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if ([sh, sm, eh, em].some(n => !Number.isFinite(n))) return 0;
  return (eh * 60 + em) - (sh * 60 + sm);
};

export const minsFromHHMM = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const dayName = (d, short = false) => {
  const names = short
    ? ['dom','lun','mar','mié','jue','vie','sáb']
    : ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  return names[d.getDay()];
};

export const monthName = (d, short = false) => {
  const names = short
    ? ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic']
    : ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  return names[d.getMonth()];
};

export const fmtDate = (d, opts = {}) => {
  const { weekday = false, year = false, short = false } = opts;
  const dn = d.getDate();
  const mn = monthName(d, short);
  const wd = weekday ? `${dayName(d, short)}, ` : '';
  const yr = year ? `, ${d.getFullYear()}` : '';
  return `${wd}${dn} de ${mn}${yr}`;
};

export const relTime = (ts) => {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'recién';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const dy = Math.floor(h / 24);
  if (dy < 7) return `${dy}d`;
  const w = Math.floor(dy / 7);
  if (w < 4) return `${w}sem`;
  return `${Math.floor(dy / 30)}mes`;
};

export const debounce = (fn, ms = 200) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Base path for vault file fetch (relative)
export const joinPath = (a, b) => {
  if (!a) return b;
  if (a.endsWith('/')) return a + b;
  return a + '/' + b;
};
