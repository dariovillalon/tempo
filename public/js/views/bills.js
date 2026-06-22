// bills.js — Cuentas por pagar. Cargás lo que pagás (puntual o regular),
// marcás "pagado" cada período y al siguiente se resetea solo.

import { state, mutate } from '../state.js';
import { uid, escapeHtml } from '../utils.js';

const FREQS = [['mensual', 'Mensual'], ['bimestral', 'Bimestral'], ['anual', 'Anual'], ['puntual', 'Puntual']];
const FREQ_LBL = Object.fromEntries(FREQS);
const expandedBills = new Set(); // ids de cuentas expandidas (por defecto colapsadas)
let billView = 'actual';         // 'actual' (por pagar) | 'historial'

const MESES = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fmtPeriod = (pk) => {
  if (pk === 'once') return 'Pagos puntuales';
  if (/^\d{4}$/.test(pk)) return `Año ${pk}`;
  const [y, m] = pk.split('-');
  return `${MESES[+m] || m} ${y}`;
};
// Historial de pagos: agrupa por período (mes/año) qué cuentas se marcaron pagadas.
function historyView() {
  const map = {};
  for (const b of state.bills) for (const pk of (b.paidMonths || [])) (map[pk] ||= []).push({ name: b.name, amount: parseFloat(b.amount) || 0 });
  const keys = Object.keys(map).sort().reverse();
  if (!keys.length) return '<div class="card"><div class="muted text-xs">Todavía no marcaste ninguna cuenta como pagada. Cuando marques "Pagado", queda registrado acá por mes.</div></div>';
  return keys.map(pk => {
    const items = map[pk]; const total = items.reduce((s, i) => s + i.amount, 0);
    return `<div class="card"><div class="card-title">${fmtPeriod(pk)} <span class="muted text-xs">· ${items.length} pago(s)${total > 0 ? ` · ~$${total.toLocaleString('es-AR')}` : ''}</span></div>
      ${items.map(i => `<div class="hist-row"><span>✅ ${escapeHtml(i.name || '(sin nombre)')}</span>${i.amount > 0 ? `<span class="muted">$${i.amount.toLocaleString('es-AR')}</span>` : ''}</div>`).join('')}
    </div>`;
  }).join('');
}

const periodKey = (freq) => {
  const now = new Date();
  if (freq === 'anual') return String(now.getFullYear());
  if (freq === 'puntual') return 'once';
  return now.toISOString().slice(0, 7); // mensual / bimestral -> YYYY-MM
};
const isPaid = (b) => (b.paidMonths || []).includes(periodKey(b.frequency || 'mensual'));

const addBill = (data) => mutate(s => { s.bills.push({ id: uid(), name: data.name || '', amount: data.amount || '', frequency: data.frequency || 'mensual', dueDay: data.dueDay || '', payMethod: data.payMethod || '', url: data.url || '', notes: '', paidMonths: [] }); });
const patchBill = (id, patch) => mutate(s => { const b = s.bills.find(x => x.id === id); if (b) Object.assign(b, patch); });
const delBill = (id) => mutate(s => { s.bills = s.bills.filter(x => x.id !== id); });
const togglePaid = (id) => mutate(s => {
  const b = s.bills.find(x => x.id === id); if (!b) return;
  b.paidMonths = b.paidMonths || [];
  const pk = periodKey(b.frequency || 'mensual');
  b.paidMonths = b.paidMonths.includes(pk) ? b.paidMonths.filter(x => x !== pk) : [...b.paidMonths, pk];
});

export const renderBills = (root) => {
  const bills = [...state.bills];
  const pend = bills.filter(b => !isPaid(b)).sort((a, b) => (+a.dueDay || 99) - (+b.dueDay || 99));
  const paid = bills.filter(b => isPaid(b));
  const sumPend = pend.reduce((s, b) => s + (parseFloat(b.amount) || 0), 0);

  const billCard = (b) => {
    const paidNow = isPaid(b);
    const open = expandedBills.has(b.id);
    const meta = [FREQ_LBL[b.frequency || 'mensual'], b.dueDay ? `vence ${b.dueDay}` : '', b.payMethod].filter(Boolean).join(' · ');
    return `<div class="bill ${paidNow ? 'is-paid' : ''} ${open ? 'is-open' : ''}">
      <div class="bill-top">
        <button class="bill-toggle" data-btoggle="${b.id}" title="${open ? 'Contraer' : 'Expandir'}">${open ? '▾' : '▸'}</button>
        <input type="checkbox" data-bpaid="${b.id}" ${paidNow ? 'checked' : ''} title="Pagado">
        <input type="text" class="input bill-name" data-bid="${b.id}" data-f="name" value="${escapeHtml(b.name || '')}" placeholder="Nombre (ej: Visa BBVA)">
        ${!open && meta ? `<span class="bill-meta muted">${escapeHtml(meta)}</span>` : ''}
        <input type="number" class="input bill-amount" data-bid="${b.id}" data-f="amount" value="${escapeHtml(String(b.amount || ''))}" placeholder="$ monto">
        <button class="btn btn-ghost btn-sm" data-bdelete="${b.id}" title="Eliminar">✕</button>
      </div>
      ${open ? `
      <div class="bill-row2">
        <select class="select" data-bid="${b.id}" data-f="frequency">${FREQS.map(([v, l]) => `<option value="${v}" ${(b.frequency || 'mensual') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input type="number" min="1" max="31" class="input bill-due" data-bid="${b.id}" data-f="dueDay" value="${escapeHtml(String(b.dueDay || ''))}" placeholder="vence día" title="Día de vencimiento">
        <input type="text" class="input bill-method" data-bid="${b.id}" data-f="payMethod" value="${escapeHtml(b.payMethod || '')}" placeholder="Cómo pago (Ppay, débito…)">
      </div>
      <input type="text" class="input bill-url" data-bid="${b.id}" data-f="url" value="${escapeHtml(b.url || '')}" placeholder="Link de pago (opcional)">
      ${b.url ? `<a href="${escapeHtml(b.url)}" target="_blank" rel="noopener" class="bill-link">↗ Abrir link de pago</a>` : ''}
      <textarea class="textarea bill-notes" data-bid="${b.id}" data-f="notes" rows="1" placeholder="Notas (nº de cliente, observaciones…)">${escapeHtml(b.notes || '')}</textarea>` : ''}
    </div>`;
  };

  const tabs = `<div class="fit-day-tabs bills-tabs">
      <button class="fit-day-tab ${billView === 'actual' ? 'active' : ''}" data-billview="actual">Por pagar</button>
      <button class="fit-day-tab ${billView === 'historial' ? 'active' : ''}" data-billview="historial">Historial</button>
    </div>`;
  const wireTabs = () => Array.from(root.querySelectorAll('[data-billview]')).forEach(b => b.addEventListener('click', () => { billView = b.dataset.billview; renderBills(root); }));

  if (billView === 'historial') {
    root.innerHTML = tabs + historyView();
    wireTabs();
    return;
  }

  root.innerHTML = tabs + `
    <div class="card">
      <div class="card-title">Cuentas por pagar</div>
      <div class="muted text-xs">Pendientes este período: <b>${pend.length}</b>${sumPend > 0 ? ` · ~$${sumPend.toLocaleString('es-AR')}` : ''}</div>
      <div class="row gap-6" style="flex-wrap:wrap;align-items:center;margin-top:12px">
        <input type="text" class="input" id="bill-new-name" placeholder="Nombre (ej: Gas, Visa…)" style="flex:1;min-width:150px">
        <input type="number" class="input" id="bill-new-amount" placeholder="$ monto" style="width:110px">
        <select class="select" id="bill-new-freq" style="width:120px">${FREQS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <input type="number" min="1" max="31" class="input" id="bill-new-due" placeholder="día" style="width:72px">
        <button class="btn btn-primary" id="bill-add">+ Agregar</button>
      </div>
    </div>
    ${pend.length ? `<div class="fit-section-h" style="border:none;padding-top:0">Pendientes</div>${pend.map(billCard).join('')}` : ''}
    ${paid.length ? `<div class="fit-section-h">Pagadas este período</div>${paid.map(billCard).join('')}` : ''}
    ${!bills.length ? `<div class="card"><div class="muted text-xs">Sin cuentas todavía. Agregá la primera arriba. Marcás "Pagado" cada mes y al siguiente se resetea solo.</div></div>` : ''}
  `;

  const $ = (s) => root.querySelector(s); const all = (s) => Array.from(root.querySelectorAll(s));
  wireTabs();
  $('#bill-add')?.addEventListener('click', () => { const name = $('#bill-new-name').value.trim(); if (!name) return; addBill({ name, amount: $('#bill-new-amount').value, frequency: $('#bill-new-freq').value, dueDay: $('#bill-new-due').value }); });
  all('[data-btoggle]').forEach(b => b.addEventListener('click', () => { const id = b.dataset.btoggle; if (expandedBills.has(id)) expandedBills.delete(id); else expandedBills.add(id); renderBills(root); }));
  all('[data-bpaid]').forEach(c => c.addEventListener('change', () => togglePaid(c.dataset.bpaid)));
  all('[data-bdelete]').forEach(b => b.addEventListener('click', () => delBill(b.dataset.bdelete)));
  all('[data-bid][data-f]').forEach(el => el.addEventListener('change', () => patchBill(el.dataset.bid, { [el.dataset.f]: el.value })));
};
