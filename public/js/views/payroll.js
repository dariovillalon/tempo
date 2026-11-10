// payroll.js — Empleado: el sueldo como cuenta corriente en dólares.
// Cada mes: deuda al inicio + sueldo − adelantos − gastos = saldo a pagar; lo
// que no se paga al cierre pasa como deuda al mes siguiente. Saldo > 0 = le
// debés a la persona; < 0 = te debe. Cada monto en pesos guarda el dólar blue
// promedio (DolarHoy) del día en que se cargó y se convierte siempre con ese.

import { state, mutate } from '../state.js';
import { api } from '../api.js';
import { uid, escapeHtml, todayKey } from '../utils.js';
import { toast } from '../components/toast.js';
import { createPdf, fitText } from '../pdf.js';

const MESES = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const LISTS = [['advances', 'Adelantos recibidos', 'Plata que le diste durante el mes. Se descuenta del sueldo.'],
  ['expenses', 'Gastos del mes', 'Gastos suyos que pagaste vos. Se descuentan del sueldo.']];
const BLUE_TTL_MS = 10 * 60 * 1000;

let activeId = null;    // persona elegida (por pestaña)
let viewMonth = null;   // 'YYYY-MM' que se está mirando
let showPerson = false; // panel "Datos de la persona" abierto
let creating = false;   // formulario de persona nueva abierto
let blueCache = null;   // { quote, at }
const lastCur = {};     // última moneda usada al agregar, por lista

// ----- Números y fechas -----
const r2 = (n) => Math.round(n * 100) / 100;
// Acepta "700.000", "700000", "1.234,50" y "500.5"
const parseAmount = (raw) => {
  let s = String(raw ?? '').trim().replace(/[^\d.,]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  return Number(s);
};
const fmtNum = (n, minDec = 2) => (Number(n) || 0).toLocaleString('es-AR', { minimumFractionDigits: minDec, maximumFractionDigits: 2 });
const fmtUsd = (n) => `USD ${fmtNum(Math.abs(n))}`;
const fmtOrig = (m) => (m.cur === 'USD' ? `USD ${fmtNum(m.amount)}` : `ARS ${fmtNum(m.amount, 0)}`);
const fmtInput = (n) => (n > 0 ? fmtNum(n, 0) : '');
const fmtDay = (k) => (k ? k.split('-').reverse().join('/') : '');
const monthLabel = (k) => { const [y, m] = k.split('-'); return `${MESES[+m]} ${y}`; };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const shiftMonth = (k, d) => {
  const [y, m] = k.split('-').map(Number);
  const dt = new Date(y, m - 1 + d, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
};

// USD de un monto; NaN si está en pesos y le falta la cotización.
const toUsd = (m) => {
  const a = Number(m?.amount) || 0;
  if (!a) return 0;
  if (m.cur === 'USD') return r2(a);
  return m.rate > 0 ? r2(a / m.rate) : NaN;
};
const isMissing = (m) => Number.isNaN(toUsd(m));
const sumUsd = (list) => r2((list || []).reduce((s, i) => s + (toUsd(i) || 0), 0));

// ----- Cuenta corriente -----
const employer = () => state.settings?.userName || 'Dario';
const favorTxt = (n, p) => (Math.abs(n) < 0.005 ? 'sin deuda' : n > 0 ? `a favor de ${p.name || 'la persona'}` : `a favor de ${employer()}`);
const openingUsd = (p) => (p.opening?.favor === 'vos' ? -1 : 1) * (toUsd(p.opening) || 0);

// Recorre los meses abiertos en orden: el cierre de cada uno es el inicio del siguiente.
const ledger = (p) => {
  let bal = openingUsd(p);
  let missingBefore = isMissing(p.opening) ? 1 : 0;
  const months = {};
  for (const k of Object.keys(p.months || {}).sort()) {
    const m = p.months[k];
    const sueldo = toUsd(m.salary) || 0;
    const adelantos = sumUsd(m.advances);
    const gastos = sumUsd(m.expenses);
    const pagado = toUsd(m.paid) || 0;
    const saldo = r2(bal + sueldo - adelantos - gastos);
    const cierre = r2(saldo - pagado);
    const missing = [m.salary, ...(m.advances || []), ...(m.expenses || []), m.paid].filter(isMissing).length;
    months[k] = { inicio: bal, sueldo, adelantos, gastos, saldo, pagado, cierre, missing, missingBefore };
    missingBefore += missing;
    bal = cierre;
  }
  return months;
};
// Inicio de un mes sin abrir: el cierre del último mes abierto anterior.
const startOf = (p, key, L) => {
  const prev = Object.keys(L).filter((k) => k < key).sort().pop();
  return prev ? L[prev].cierre : openingUsd(p);
};

// ----- Dólar blue -----
const getBlueRate = async ({ quiet = false } = {}) => {
  if (blueCache && Date.now() - blueCache.at < BLUE_TTL_MS) return blueCache.quote.promedio;
  try {
    const { quote } = await api.getDolarBlue();
    blueCache = { quote, at: Date.now() };
    return quote.promedio;
  } catch (e) {
    console.warn('[payroll] dólar blue', e);
    if (!quiet) toast('No pude leer el dólar blue. Cargá la cotización a mano en ese monto.', 'error');
    return null;
  }
};

// ----- Mutaciones -----
const findPerson = (s, pid) => s.payroll.people.find((x) => x.id === pid);
const newMonth = (amount, cur, rate) => ({ salary: { amount, cur, rate }, advances: [], expenses: [], paid: { amount: 0, cur, rate: null }, paidDate: '' });

const addPerson = async (d) => {
  const needRate = (d.debtCur === 'ARS' && d.debt > 0) || (d.salaryCur === 'ARS' && d.salary > 0);
  const rate = needRate ? await getBlueRate() : null;
  const id = uid();
  const key = todayKey().slice(0, 7);
  mutate((s) => {
    s.payroll.people.push({
      id, name: d.name,
      salary: { amount: d.salary, cur: d.salaryCur },
      opening: { amount: d.debt, cur: d.debtCur, rate: d.debtCur === 'ARS' ? rate : null, favor: d.favor },
      months: { [key]: newMonth(d.salary, d.salaryCur, d.salaryCur === 'ARS' ? rate : null) },
    });
  });
  activeId = id; viewMonth = key; creating = false;
};

const delPerson = (pid) => {
  const idx = state.payroll.people.findIndex((x) => x.id === pid);
  if (idx < 0) return;
  const removed = state.payroll.people[idx];
  activeId = null;
  mutate((s) => { s.payroll.people = s.payroll.people.filter((x) => x.id !== pid); });
  toast(`Eliminé a ${removed.name || 'la persona'}`, '', {
    actionLabel: 'Deshacer', duration: 6000,
    onAction: () => mutate((s) => { if (!findPerson(s, pid)) s.payroll.people.splice(Math.min(idx, s.payroll.people.length), 0, removed); }),
  });
};

const openMonth = async (pid, key) => {
  const p = findPerson(state, pid);
  if (!p) return;
  const amount = Number(p.salary?.amount) || 0;
  const cur = p.salary?.cur || 'ARS';
  const rate = cur === 'ARS' && amount > 0 ? await getBlueRate() : null;
  mutate((s) => { const pp = findPerson(s, pid); if (pp && !pp.months[key]) pp.months[key] = newMonth(amount, cur, rate); });
};

const delMonth = (pid, key) => {
  const removed = findPerson(state, pid)?.months?.[key];
  if (!removed) return;
  mutate((s) => { delete findPerson(s, pid).months[key]; });
  toast(`Borré ${monthLabel(key)}`, '', {
    actionLabel: 'Deshacer', duration: 6000,
    onAction: () => mutate((s) => { const pp = findPerson(s, pid); if (pp && !pp.months[key]) pp.months[key] = removed; }),
  });
};

const addItem = async (pid, key, list, item) => {
  const rate = item.cur === 'ARS' ? await getBlueRate() : null;
  mutate((s) => { const m = findPerson(s, pid)?.months?.[key]; if (m) (m[list] ||= []).push({ id: uid(), ...item, rate }); });
};

const delItem = (pid, key, list, iid) => {
  const arr = findPerson(state, pid)?.months?.[key]?.[list] || [];
  const idx = arr.findIndex((i) => i.id === iid);
  if (idx < 0) return;
  const removed = arr[idx];
  const pick = (s) => findPerson(s, pid)?.months?.[key]?.[list];
  mutate((s) => { const a = pick(s); if (a) a.splice(a.findIndex((i) => i.id === iid), 1); });
  toast(`Eliminé "${removed.desc || fmtOrig(removed)}"`, '', {
    actionLabel: 'Deshacer', duration: 6000,
    onAction: () => mutate((s) => { const a = pick(s); if (a && !a.some((i) => i.id === iid)) a.splice(Math.min(idx, a.length), 0, removed); }),
  });
};

// Monto editable: 'opening' y 'base' son de la persona; 'salary', 'paid' y las
// listas, del mes. 'base' es el sueldo que se copia al abrir cada mes (sin cotización).
const moneyTarget = (s, pid, key, scope, iid) => {
  const p = findPerson(s, pid);
  if (!p) return null;
  if (scope === 'opening') return (p.opening ||= { amount: 0, cur: 'USD', rate: null, favor: 'persona' });
  if (scope === 'base') return (p.salary ||= { amount: 0, cur: 'ARS' });
  const m = p.months?.[key];
  if (!m) return null;
  if (scope === 'salary' || scope === 'paid') return (m[scope] ||= { amount: 0, cur: 'ARS', rate: null });
  return (m[scope] || []).find((i) => i.id === iid) || null;
};

const editMoney = async (root, ds, raw) => {
  const { scope, iid, f } = ds;
  const pid = activeId; const key = viewMonth;
  let v = raw;
  if (f === 'amount' || f === 'rate') {
    v = String(raw).trim() === '' ? 0 : parseAmount(raw);
    if (!(v >= 0)) { toast('Monto inválido. Ejemplos: 150000, 150.000 o 1.234,50', 'error'); renderPayroll(root); return; }
    if (f === 'rate' && v === 0) v = null;
  }
  const t0 = moneyTarget(state, pid, key, scope, iid);
  if (!t0) return;
  // Un monto que queda en pesos sin cotización toma el blue de hoy.
  const cur = f === 'cur' ? v : t0.cur;
  const amount = f === 'amount' ? v : t0.amount;
  const rate = scope !== 'base' && f !== 'rate' && cur === 'ARS' && amount > 0 && !(t0.rate > 0) ? await getBlueRate() : null;
  mutate((s) => {
    const t = moneyTarget(s, pid, key, scope, iid);
    if (!t) return;
    t[f] = v;
    if (rate) t.rate = rate;
  });
};

// ----- Render -----
const curSelect = (attrs, cur) => `<select class="select pay-cur" ${attrs}>${['ARS', 'USD'].map((c) => `<option value="${c}" ${cur === c ? 'selected' : ''}>${c}</option>`).join('')}</select>`;

// Monto + moneda + cotización (si es en pesos) + equivalente en USD.
const moneyFields = (m, attrs, { showUsd = true, showRate = true } = {}) => {
  const usd = toUsd(m);
  const rateInput = showRate && m.cur === 'ARS'
    ? `<input type="text" inputmode="decimal" class="input pay-rate ${isMissing(m) ? 'is-missing' : ''}" ${attrs} data-f="rate" value="${m.rate > 0 ? fmtNum(m.rate, 0) : ''}" placeholder="cotiz." title="Dólar blue promedio usado para este monto">`
    : '';
  return `<input type="text" inputmode="decimal" class="input pay-amt" ${attrs} data-f="amount" value="${fmtInput(m.amount)}" placeholder="Monto">
    ${curSelect(`${attrs} data-f="cur"`, m.cur)}${rateInput}
    ${showUsd ? `<span class="pay-usd">${Number.isNaN(usd) ? 'falta cotiz.' : fmtUsd(usd)}</span>` : ''}`;
};

const personForm = () => `
  <div class="card">
    <div class="card-title">${state.payroll.people.length ? 'Persona nueva' : 'Empleado'}</div>
    <div class="muted text-xs" style="margin:4px 0 10px">El sueldo se lleva como cuenta corriente en dólares: lo que no pagás al cierre de un mes pasa como deuda al siguiente. Los montos en pesos se convierten con el dólar blue promedio de DolarHoy del día en que los cargás.</div>
    <div class="pay-form">
      <label>Nombre<input type="text" class="input" id="pn-name" placeholder="Nombre y apellido"></label>
      <label>Sueldo mensual<span class="pay-line"><input type="text" inputmode="decimal" class="input pay-amt" id="pn-salary" placeholder="Monto">${curSelect('id="pn-salary-cur"', 'ARS')}</span></label>
      <label>Deuda actual<span class="pay-line"><input type="text" inputmode="decimal" class="input pay-amt" id="pn-debt" placeholder="0">${curSelect('id="pn-debt-cur"', 'USD')}
        <select class="select" id="pn-favor"><option value="persona">le debés vos</option><option value="vos">te debe a vos</option></select></span></label>
    </div>
    <div class="row gap-6" style="margin-top:12px">
      <button class="btn btn-primary" id="pn-create">Crear</button>
      ${state.payroll.people.length ? '<button class="btn btn-ghost" id="pn-cancel">Cancelar</button>' : ''}
    </div>
  </div>`;

const personPanel = (p) => `
  <div class="card">
    <div class="card-title">Datos de ${escapeHtml(p.name || 'la persona')}</div>
    <div class="pay-form" style="margin-top:10px">
      <label>Nombre<input type="text" class="input" data-pname value="${escapeHtml(p.name || '')}"></label>
      <label>Sueldo mensual <span class="muted text-xs">(se copia al abrir cada mes)</span><span class="pay-line">${moneyFields({ cur: 'ARS', ...p.salary }, 'data-scope="base"', { showUsd: false, showRate: false })}</span></label>
      <label>Deuda inicial <span class="muted text-xs">(saldo antes del primer mes cargado)</span><span class="pay-line">${moneyFields({ cur: 'USD', ...p.opening }, 'data-scope="opening"')}
        <select class="select" data-pfavor><option value="persona" ${p.opening?.favor !== 'vos' ? 'selected' : ''}>le debés vos</option><option value="vos" ${p.opening?.favor === 'vos' ? 'selected' : ''}>te debe a vos</option></select></span></label>
    </div>
    <button class="btn btn-ghost btn-sm" id="pay-del-person" style="margin-top:10px">Eliminar persona</button>
  </div>`;

const itemRow = (list, i) => {
  const attrs = `data-scope="${list}" data-iid="${i.id}"`;
  return `<div class="pay-item">
    <input type="date" class="input pay-date" data-li="${list}" data-iid="${i.id}" data-f="date" value="${escapeHtml(i.date || '')}">
    <input type="text" class="input pay-desc" data-li="${list}" data-iid="${i.id}" data-f="desc" value="${escapeHtml(i.desc || '')}" placeholder="Concepto">
    <button class="btn btn-ghost btn-sm pay-del" data-del="${list}" data-iid="${i.id}" title="Eliminar">✕</button>
    <span class="pay-line">${moneyFields(i, attrs)}</span>
  </div>`;
};

const listCard = (p, key, m, [list, title, hint]) => {
  const items = [...(m[list] || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const defDate = key === todayKey().slice(0, 7) ? todayKey() : `${key}-01`;
  const cur = lastCur[list] || p.salary?.cur || 'ARS';
  return `<div class="card">
    <div class="card-title">${title} <span class="muted text-xs">· ${items.length} · ${fmtUsd(sumUsd(items))}</span></div>
    <div class="muted text-xs" style="margin:2px 0 8px">${hint}</div>
    ${items.map((i) => itemRow(list, i)).join('')}
    <div class="pay-item pay-add" data-addfor="${list}">
      <input type="date" class="input pay-date" data-new="date" value="${defDate}">
      <input type="text" class="input pay-desc" data-new="desc" placeholder="Concepto">
      <span class="pay-line"><input type="text" inputmode="decimal" class="input pay-amt" data-new="amount" placeholder="Monto">${curSelect('data-new="cur"', cur)}
        <button class="btn btn-primary btn-sm" data-add="${list}">+ Agregar</button></span>
    </div>
  </div>`;
};

const sumRow = (label, value, note = '', cls = '') =>
  `<div class="pay-sum-row ${cls}"><span>${label}${note ? `<span class="pay-note">${escapeHtml(note)}</span>` : ''}</span><b>${value}</b></div>`;

const summaryCard = (p, key, c) => {
  const next = monthLabel(shiftMonth(key, 1));
  const warn = c.missing || c.missingBefore
    ? `<div class="pay-warn">${c.missing ? `Faltan ${c.missing} cotización(es) en este mes` : 'Faltan cotizaciones en meses anteriores o en la deuda inicial'}: esos montos en pesos no entran en el total. Cargalas en el campo "cotiz.".</div>`
    : '';
  return `<div class="card pay-summary">
    <div class="card-title">Resumen de ${monthLabel(key)}</div>
    ${warn}
    ${sumRow('Deuda al inicio', fmtUsd(c.inicio), favorTxt(c.inicio, p))}
    ${sumRow('+ Sueldo', fmtUsd(c.sueldo))}
    ${sumRow('− Adelantos recibidos', fmtUsd(c.adelantos))}
    ${sumRow('− Gastos del mes', fmtUsd(c.gastos))}
    ${sumRow('Saldo a pagar', fmtUsd(c.saldo), favorTxt(c.saldo, p), 'is-total')}
    ${sumRow('− Pagado al cierre', fmtUsd(c.pagado))}
    ${sumRow('Deuda al cierre', fmtUsd(c.cierre), `${favorTxt(c.cierre, p)} · pasa a ${next}`, 'is-total')}
    <div class="row gap-6" style="margin-top:12px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-primary" id="pay-pdf">Generar resumen (PDF)</button>
      <span class="muted text-xs" id="pay-blue">${blueCache ? blueBadge(blueCache.quote) : ''}</span>
    </div>
  </div>`;
};
const blueBadge = (q) => `Blue hoy: $${fmtNum(q.compra, 0)} / $${fmtNum(q.venta, 0)} · promedio $${fmtNum(q.promedio, 0)} (${escapeHtml(q.source)})`;

export const renderPayroll = (root) => {
  const people = state.payroll?.people || [];
  if (!people.some((x) => x.id === activeId)) activeId = people[0]?.id || null;
  viewMonth ||= todayKey().slice(0, 7);
  const p = people.find((x) => x.id === activeId);

  if (!p || creating) {
    root.innerHTML = personForm();
    wireCreate(root);
    return;
  }

  const key = viewMonth;
  const isCurrent = key === todayKey().slice(0, 7);
  const m = p.months?.[key];
  const L = ledger(p);

  const head = `<div class="card"><div class="row" style="justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      ${people.length > 1
        ? `<select class="select" id="pay-person" style="width:auto">${people.map((x) => `<option value="${x.id}" ${x.id === p.id ? 'selected' : ''}>${escapeHtml(x.name || '(sin nombre)')}</option>`).join('')}</select>`
        : `<b>${escapeHtml(p.name || '(sin nombre)')}</b>`}
      <span class="row gap-6">
        <button class="btn btn-ghost btn-sm" id="pay-toggle-person">${showPerson ? 'Ocultar datos' : 'Datos'}</button>
        <button class="btn btn-ghost btn-sm" id="pay-new-person">+ Persona</button>
      </span>
    </div>
    <div class="row" style="justify-content:space-between;align-items:center;gap:10px;flex-wrap:nowrap;margin-top:10px">
      <button class="btn btn-ghost btn-sm" id="pay-prev" title="Mes anterior">◀</button>
      <b class="pay-month">${cap(monthLabel(key))}</b>
      <button class="btn btn-ghost btn-sm" id="pay-next" title="Mes siguiente">▶</button>
      ${isCurrent ? '' : '<button class="btn btn-secondary btn-sm" id="pay-today">Este mes</button>'}
    </div></div>`;

  let body;
  if (!m) {
    const start = startOf(p, key, L);
    body = `<div class="card">
      <div class="muted text-xs">${cap(monthLabel(key))} todavía no está abierto.</div>
      <div style="margin:8px 0">Arranca con <b>${fmtUsd(start)}</b> ${escapeHtml(favorTxt(start, p))} y un sueldo de <b>${fmtOrig({ amount: Number(p.salary?.amount) || 0, cur: p.salary?.cur || 'ARS' })}</b>.</div>
      <button class="btn btn-primary" id="pay-open">Abrir ${monthLabel(key)}</button>
    </div>`;
  } else {
    const c = L[key];
    body = summaryCard(p, key, c) + `
      <div class="card">
        <div class="card-title">Sueldo de ${monthLabel(key)}</div>
        <div class="pay-line" style="margin-top:8px">${moneyFields(m.salary || { amount: 0, cur: 'ARS' }, 'data-scope="salary"')}</div>
      </div>
      ${LISTS.map((l) => listCard(p, key, m, l)).join('')}
      <div class="card">
        <div class="card-title">Pagado al cierre</div>
        <div class="muted text-xs" style="margin:2px 0 8px">Lo que le pagaste al cerrar el mes. La diferencia con el saldo pasa como deuda a ${monthLabel(shiftMonth(key, 1))}.</div>
        <div class="pay-line"><input type="date" class="input pay-date" data-mf="paidDate" value="${escapeHtml(m.paidDate || '')}">${moneyFields(m.paid || { amount: 0, cur: 'ARS' }, 'data-scope="paid"')}</div>
      </div>
      <button class="btn btn-ghost btn-sm" id="pay-del-month">Borrar ${monthLabel(key)}</button>`;
  }

  root.innerHTML = head + (showPerson ? personPanel(p) : '') + body;
  wireView(root, p, key);
};

// ----- Eventos -----
const wireCreate = (root) => {
  const $ = (s) => root.querySelector(s);
  $('#pn-cancel')?.addEventListener('click', () => { creating = false; renderPayroll(root); });
  $('#pn-create').addEventListener('click', async () => {
    const name = $('#pn-name').value.trim();
    const salary = parseAmount($('#pn-salary').value);
    const debtRaw = $('#pn-debt').value.trim();
    const debt = debtRaw ? parseAmount(debtRaw) : 0;
    if (!name) { toast('Poné el nombre', 'error'); return; }
    if (!(salary > 0)) { toast('Cargá el sueldo mensual', 'error'); return; }
    if (!(debt >= 0)) { toast('La deuda tiene que ser un número (o vacía)', 'error'); return; }
    $('#pn-create').disabled = true;
    await addPerson({ name, salary, salaryCur: $('#pn-salary-cur').value, debt, debtCur: $('#pn-debt-cur').value, favor: $('#pn-favor').value });
    renderPayroll(root);
  });
};

const wireView = (root, p, key) => {
  const $ = (s) => root.querySelector(s);
  const all = (s) => Array.from(root.querySelectorAll(s));
  const go = (k) => { viewMonth = k; renderPayroll(root); };

  $('#pay-person')?.addEventListener('change', (e) => { activeId = e.target.value; renderPayroll(root); });
  $('#pay-toggle-person').addEventListener('click', () => { showPerson = !showPerson; renderPayroll(root); });
  $('#pay-new-person').addEventListener('click', () => { creating = true; renderPayroll(root); });
  $('#pay-prev').addEventListener('click', () => go(shiftMonth(key, -1)));
  $('#pay-next').addEventListener('click', () => go(shiftMonth(key, 1)));
  $('#pay-today')?.addEventListener('click', () => go(todayKey().slice(0, 7)));
  $('#pay-open')?.addEventListener('click', (e) => { e.target.disabled = true; openMonth(p.id, key); });
  $('#pay-del-month')?.addEventListener('click', () => delMonth(p.id, key));
  $('#pay-del-person')?.addEventListener('click', () => delPerson(p.id));
  $('#pay-pdf')?.addEventListener('click', () => generateSummary(p, key));

  $('[data-pname]')?.addEventListener('change', (e) => mutate((s) => { const pp = findPerson(s, p.id); if (pp) pp.name = e.target.value.trim(); }));
  $('[data-pfavor]')?.addEventListener('change', (e) => mutate((s) => { const pp = findPerson(s, p.id); if (pp) (pp.opening ||= { amount: 0, cur: 'USD', rate: null }).favor = e.target.value; }));
  $('[data-mf="paidDate"]')?.addEventListener('change', (e) => mutate((s) => { const mm = findPerson(s, p.id)?.months?.[key]; if (mm) mm.paidDate = e.target.value; }));

  all('[data-scope][data-f]').forEach((el) => el.addEventListener('change', () => editMoney(root, el.dataset, el.value)));
  all('[data-li][data-f]').forEach((el) => el.addEventListener('change', () => mutate((s) => {
    const it = (findPerson(s, p.id)?.months?.[key]?.[el.dataset.li] || []).find((i) => i.id === el.dataset.iid);
    if (it) it[el.dataset.f] = el.dataset.f === 'desc' ? el.value.trim() : el.value;
  })));
  all('[data-del]').forEach((b) => b.addEventListener('click', () => delItem(p.id, key, b.dataset.del, b.dataset.iid)));
  all('[data-add]').forEach((b) => b.addEventListener('click', async () => {
    const list = b.dataset.add;
    const box = root.querySelector(`[data-addfor="${list}"]`);
    const val = (n) => box.querySelector(`[data-new="${n}"]`).value;
    const amount = parseAmount(val('amount'));
    if (!(amount > 0)) { toast('Cargá el monto', 'error'); return; }
    lastCur[list] = val('cur');
    b.disabled = true;
    await addItem(p.id, key, list, { date: val('date'), desc: val('desc').trim(), amount, cur: val('cur') });
  }));
  // Enter en el monto de una fila nueva = Agregar
  all('[data-addfor] [data-new="amount"]').forEach((inp) => inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') inp.closest('[data-addfor]').querySelector('[data-add]').click();
  }));

  // Cotización de hoy, informativa (sin toast si falla: se avisa recién al cargar un monto en pesos)
  if (!blueCache) getBlueRate({ quiet: true }).then(() => { const el = root.querySelector('#pay-blue'); if (el && blueCache) el.innerHTML = blueBadge(blueCache.quote); });
};

// ----- Resumen en PDF -----
const generateSummary = (p, key) => {
  const c = ledger(p)[key];
  if (c.missing || c.missingBefore) { toast('Faltan cotizaciones: cargalas antes de generar el resumen', 'error'); return; }
  const title = `Resumen ${p.name || ''} ${monthLabel(key)}`.replace(/\s+/g, ' ').trim();
  const bytes = buildSummaryPdf(p, key, c, title);
  shareOrDownload(bytes, `${title.replace(/[\\/:*?"<>|]/g, '')}.pdf`, title);
};

const buildSummaryPdf = (p, key, c, title) => {
  const m = p.months[key];
  const doc = createPdf({ title });
  const X0 = 50; const X1 = doc.width - 50;
  const GRAY = [0.42, 0.42, 0.42]; const SOFT = [0.94, 0.95, 0.97];
  let y = 64;
  const ensure = (h) => { if (y + h > doc.height - 50) { doc.addPage(); y = 56; } };

  doc.text(X0, y, 'Resumen de sueldo', { size: 18, bold: true }); y += 22;
  doc.text(X0, y, `${p.name || ''} · ${cap(monthLabel(key))}`, { size: 12 }); y += 16;
  doc.text(X0, y, `Generado el ${fmtDay(todayKey())}. Todos los totales en dólares (USD).`, { size: 9, color: GRAY }); y += 26;

  const row = (label, value, note = '', strong = false) => {
    if (strong) doc.rect(X0, y - 14, X1 - X0, 21, { fill: SOFT });
    doc.text(X0 + 8, y, label, { size: 10.5, bold: strong });
    if (note) doc.text(X1 - 110, y, fitText(note, 190, 9), { size: 9, color: GRAY, align: 'right' });
    doc.text(X1 - 8, y, value, { size: 10.5, bold: strong, align: 'right' });
    y += 22;
  };
  row('Deuda al inicio del mes', fmtUsd(c.inicio), favorTxt(c.inicio, p));
  row('+ Sueldo', fmtUsd(c.sueldo));
  row('- Adelantos recibidos', fmtUsd(c.adelantos));
  row('- Gastos del mes', fmtUsd(c.gastos));
  row('Saldo a pagar', fmtUsd(c.saldo), favorTxt(c.saldo, p), true);
  row('- Pagado al cierre', fmtUsd(c.pagado));
  row('Deuda al cierre', fmtUsd(c.cierre), `${favorTxt(c.cierre, p)}, pasa a ${monthLabel(shiftMonth(key, 1))}`, true);
  y += 10;

  const COL = { fecha: X0, concepto: X0 + 62, monto: X1 - 160, cotiz: X1 - 80, usd: X1 };
  const header = () => {
    const o = { size: 8.5, bold: true, color: GRAY };
    doc.text(COL.fecha, y, 'Fecha', o);
    doc.text(COL.concepto, y, 'Concepto', o);
    doc.text(COL.monto, y, 'Monto', { ...o, align: 'right' });
    doc.text(COL.cotiz, y, 'Cotización', { ...o, align: 'right' });
    doc.text(COL.usd, y, 'USD', { ...o, align: 'right' });
    y += 5; doc.line(X0, y, X1, y); y += 13;
  };
  const section = (name, items, total) => {
    ensure(60);
    doc.text(X0, y, name, { size: 12, bold: true }); y += 16;
    if (!items.length) { doc.text(X0, y, 'Sin movimientos.', { size: 9.5, color: GRAY }); y += 22; return; }
    header();
    for (const i of items) {
      if (y + 16 > doc.height - 50) { doc.addPage(); y = 56; header(); }
      const o = { size: 9.5 };
      doc.text(COL.fecha, y, fmtDay(i.date), o);
      doc.text(COL.concepto, y, fitText(i.desc || '-', COL.monto - 70 - COL.concepto, 9.5), o);
      doc.text(COL.monto, y, fmtOrig(i), { ...o, align: 'right' });
      doc.text(COL.cotiz, y, i.cur === 'ARS' ? `$ ${fmtNum(i.rate, 0)}` : '-', { ...o, align: 'right' });
      doc.text(COL.usd, y, fmtNum(toUsd(i)), { ...o, align: 'right' });
      y += 16;
    }
    doc.line(X0, y - 10, X1, y - 10);
    doc.text(COL.cotiz, y + 2, 'Total', { size: 9.5, bold: true, align: 'right' });
    doc.text(COL.usd, y + 2, fmtUsd(total), { size: 9.5, bold: true, align: 'right' });
    y += 28;
  };
  const byDate = (list) => [...(m[list] || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  section('Sueldo', m.salary?.amount > 0 ? [{ ...m.salary, date: '', desc: `Sueldo de ${monthLabel(key)}` }] : [], c.sueldo);
  section('Adelantos recibidos', byDate('advances'), c.adelantos);
  section('Gastos del mes', byDate('expenses'), c.gastos);
  section('Pagado al cierre', m.paid?.amount > 0 ? [{ ...m.paid, date: m.paidDate || '', desc: 'Pago al cierre del mes' }] : [], c.pagado);

  ensure(30);
  doc.text(X0, y, 'Los montos en pesos se pasan a dólares con el dólar blue promedio ((compra + venta) / 2)', { size: 8.5, color: GRAY }); y += 12;
  doc.text(X0, y, 'de DolarHoy del día en que se cargó cada uno.', { size: 8.5, color: GRAY });
  return doc.output();
};

// En el celular abre el menú de compartir (WhatsApp, mail…); en la compu, descarga.
const shareOrDownload = async (bytes, fname, title) => {
  const file = new File([bytes], fname, { type: 'application/pdf' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return; }
    catch (e) { if (e.name === 'AbortError') return; console.warn('[payroll] compartir falló, descargo', e); }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: fname });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
