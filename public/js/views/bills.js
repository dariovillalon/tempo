// bills.js — Cuentas por pagar. Cargás lo que pagás (puntual o regular),
// marcás "pagado" cada período y al siguiente se resetea solo.

import { state, mutate } from '../state.js';
import { uid, escapeHtml, todayKey, sanitizeUrl } from '../utils.js';
import { toast } from '../components/toast.js';

const FREQS = [['mensual', 'Mensual'], ['bimestral', 'Bimestral'], ['anual', 'Anual'], ['puntual', 'Puntual']];
const FREQ_LBL = Object.fromEntries(FREQS);
const expandedBills = new Set(); // ids de cuentas expandidas (por defecto colapsadas)
let billView = 'actual';         // 'actual' (por pagar) | 'historial'

const MESES = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fmtPeriod = (pk) => {
  if (pk === 'once') return 'Pagos puntuales';
  if (/^\d{4}$/.test(pk)) return `Año ${pk}`;
  const bi = pk.match(/^(\d{4})-B(\d{2})$/); // bimestral: YYYY-B01, YYYY-B03…
  if (bi) return `${MESES[+bi[2]]}–${MESES[+bi[2] + 1]} ${bi[1]}`;
  const [y, m] = pk.split('-');
  return `${MESES[+m] || m} ${y}`;
};
// Historial de pagos: agrupa por período (mes/año) qué cuentas se marcaron pagadas.
function historyView() {
  const map = {};
  for (const b of state.bills) for (const pk of (b.paidMonths || [])) (map[pk] ||= []).push({ name: b.name, amount: parseFloat(b.amount) || 0 });
  // Orden cronológico real: 'YYYY-Bnn' se compara por su mes de apertura
  // (lexicográficamente la 'B' quedaría después de cualquier mes del año).
  const norm = (k) => k.replace(/-B(\d{2})$/, '-$1');
  const keys = Object.keys(map).sort((a, b) => norm(a).localeCompare(norm(b))).reverse();
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
  if (freq === 'bimestral') {
    // Período real de 2 meses (ene–feb, mar–abr…), clave por el mes impar que lo abre.
    const bi = Math.floor(now.getMonth() / 2) * 2 + 1;
    return `${now.getFullYear()}-B${String(bi).padStart(2, '0')}`;
  }
  return todayKey().slice(0, 7); // mensual -> YYYY-MM (fecha local, no UTC)
};
// Claves legacy de un bimestral: antes del formato YYYY-Bnn se guardaba el mes
// suelto YYYY-MM; un pago marcado en cualquiera de los 2 meses del bimestre
// actual sigue contando como pagado (migración suave, sin tocar datos).
const legacyBimestralKeys = () => {
  const now = new Date();
  const open = Math.floor(now.getMonth() / 2) * 2 + 1; // mes impar que abre el bimestre
  return [open, open + 1].map(m => `${now.getFullYear()}-${String(m).padStart(2, '0')}`);
};
const paidKeysFor = (b) => {
  const freq = b.frequency || 'mensual';
  const keys = [periodKey(freq)];
  if (freq === 'bimestral') keys.push(...legacyBimestralKeys());
  return keys;
};
const isPaid = (b) => {
  const paid = b.paidMonths || [];
  return paidKeysFor(b).some(k => paid.includes(k));
};

// Vencimientos del período: para cada cuenta IMPAGA con día de vencimiento,
// cuántos días faltan para que venza este período. `days` >= 0: vence en N días
// (0 = hoy); `days` < 0: el vencimiento de este período ya pasó y sigue impaga
// (vencida). El rollover al mes siguiente solo aplica a cuentas ya pagadas
// (que acá se excluyen): una impaga con el día pasado se reporta vencida, no
// "vence el mes que viene". dueDay se recorta al último día del mes actual
// (ej: "vence 31" en junio → 30). Ordenado de más urgente a menos.
export const dueInfo = (bills = state.bills) => {
  const now = new Date();
  const today = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return (bills || [])
    // Solo mensuales: dueDay como "día del mes actual" no está definido para
    // anual/bimestral/puntual (avisarían "vencida" 11 meses al año).
    .filter(b => b && (b.frequency || 'mensual') === 'mensual' && parseInt(b.dueDay, 10) >= 1 && !isPaid(b))
    .map(b => {
      const due = Math.min(daysInMonth, parseInt(b.dueDay, 10));
      const days = due - today;
      return { bill: b, name: b.name || '', dueDay: due, days, overdue: days < 0 };
    })
    .sort((a, b) => a.days - b.days);
};

const addBill = (data) => mutate(s => { s.bills.push({ id: uid(), name: data.name || '', amount: data.amount || '', frequency: data.frequency || 'mensual', dueDay: data.dueDay || '', payMethod: data.payMethod || '', ref: data.ref || '', autoDebit: !!data.autoDebit, url: data.url || '', notes: '', paidMonths: [] }); });
const patchBill = (id, patch) => mutate(s => { const b = s.bills.find(x => x.id === id); if (b) Object.assign(b, patch); });
// El ✕ queda a un toque en el celular: borrar avisa con "Deshacer" en vez de confirmar.
const delBill = (id) => {
  const idx = state.bills.findIndex(x => x.id === id);
  if (idx < 0) return;
  const removed = state.bills[idx];
  mutate(s => { s.bills = s.bills.filter(x => x.id !== id); });
  toast(`Eliminé "${removed.name || 'la cuenta'}"`, '', {
    actionLabel: 'Deshacer', duration: 6000,
    onAction: () => mutate(s => { if (!s.bills.some(x => x.id === id)) s.bills.splice(Math.min(idx, s.bills.length), 0, removed); }),
  });
};
// Vencimiento para la fila colapsada (solo mensuales impagas con día cargado).
const dueLabel = (b) => {
  const info = dueInfo([b])[0];
  if (!info) return '';
  const { days, dueDay } = info;
  const [txt, cls] = days < 0 ? [`vencida (día ${dueDay})`, 'is-late']
    : days === 0 ? ['vence hoy', 'is-late']
    : days <= 5 ? [`vence en ${days} d`, 'is-soon']
    : [`día ${dueDay}`, ''];
  return `<span class="bill-meta bill-due-meta ${cls}">${txt}</span>`;
};
const togglePaid = (id) => mutate(s => {
  const b = s.bills.find(x => x.id === id); if (!b) return;
  b.paidMonths = b.paidMonths || [];
  // Desmarcar tiene que sacar también las claves legacy del período (si no,
  // un bimestral marcado con el formato viejo quedaría "pagado" para siempre).
  const keys = paidKeysFor(b);
  b.paidMonths = keys.some(k => b.paidMonths.includes(k))
    ? b.paidMonths.filter(x => !keys.includes(x))
    : [...b.paidMonths, periodKey(b.frequency || 'mensual')];
});

export const renderBills = (root) => {
  const bills = [...state.bills];
  const pend = bills.filter(b => !isPaid(b)).sort((a, b) => (+a.dueDay || 99) - (+b.dueDay || 99));
  const paid = bills.filter(b => isPaid(b));

  const billCard = (b) => {
    const paidNow = isPaid(b);
    const safeUrl = sanitizeUrl(b.url); // solo http/https; si no, se muestra como texto plano
    const open = expandedBills.has(b.id);
    // Referencia = el nro/código que hay que pegar en la página de pago. Va
    // visible aun colapsada, con copiar de un click (para eso existe el campo).
    const refChip = b.ref ? `<button class="btn btn-ghost btn-sm bill-ref-chip" data-bcopy="${escapeHtml(b.ref)}" title="Copiar referencia">${escapeHtml(b.ref)} ⧉</button>` : '';
    // Columna DA fija (mismo ancho en todas las filas): ✓ si está adherida a
    // débito automático, vacía si no.
    const daCol = `<span class="bill-da-col" title="${b.autoDebit ? 'Adherida a débito automático' : 'Sin débito automático'}">${b.autoDebit ? '✓' : ''}</span>`;
    return `<div class="bill ${paidNow ? 'is-paid' : ''} ${open ? 'is-open' : ''}">
      <div class="bill-top">
        <button class="bill-toggle" data-btoggle="${b.id}" title="${open ? 'Contraer' : 'Expandir'}">${open ? '▾' : '▸'}</button>
        <input type="checkbox" data-bpaid="${b.id}" ${paidNow ? 'checked' : ''} title="Pagado">
        <input type="text" class="input bill-name" data-bid="${b.id}" data-f="name" value="${escapeHtml(b.name || '')}" placeholder="Nombre (ej: Visa BBVA)">
        <span class="bill-ref-cell">${open ? '' : dueLabel(b)}${refChip}</span>
        <span class="bill-link-cell">${!open && safeUrl ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener" class="bill-link" title="Abrir link de pago">↗</a>` : ''}</span>
        ${daCol}
        <button class="btn btn-ghost btn-sm bill-del" data-bdelete="${b.id}" title="Eliminar">✕</button>
      </div>
      ${open ? `
      <div class="bill-row2">
        <select class="select" data-bid="${b.id}" data-f="frequency">${FREQS.map(([v, l]) => `<option value="${v}" ${(b.frequency || 'mensual') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input type="number" min="1" max="31" class="input bill-due" data-bid="${b.id}" data-f="dueDay" value="${escapeHtml(String(b.dueDay || ''))}" placeholder="vence día" title="Día de vencimiento">
        <input type="text" class="input bill-method" data-bid="${b.id}" data-f="payMethod" value="${escapeHtml(b.payMethod || '')}" placeholder="Cómo pago (Ppay, débito…)">
      </div>
      <div class="bill-row2">
        <input type="text" class="input" data-bid="${b.id}" data-f="ref" value="${escapeHtml(b.ref || '')}" placeholder="Referencia / nº para la página (ej: x00010192)">
        <label class="muted text-xs" style="display:flex;align-items:center;gap:6px;white-space:nowrap"><input type="checkbox" data-bda="${b.id}" ${b.autoDebit ? 'checked' : ''}> Débito automático</label>
      </div>
      <input type="text" class="input bill-url" data-bid="${b.id}" data-f="url" value="${escapeHtml(b.url || '')}" placeholder="Link de pago (opcional)">
      ${b.url ? (safeUrl ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener" class="bill-link">↗ Abrir link de pago</a>` : `<span class="bill-link muted" title="Link inválido — solo http/https">${escapeHtml(b.url)}</span>`) : ''}
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
      <div class="muted text-xs">Pendientes este período: <b>${pend.length}</b></div>
      <div class="row gap-6" style="flex-wrap:wrap;align-items:center;margin-top:12px">
        <input type="text" class="input" id="bill-new-name" placeholder="Nombre (ej: Gas, Visa…)" style="flex:1;min-width:150px">
        <select class="select" id="bill-new-freq" style="width:120px">${FREQS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <input type="number" min="1" max="31" class="input" id="bill-new-due" placeholder="día" style="width:72px">
        <button class="btn btn-primary" id="bill-add">+ Agregar</button>
      </div>
    </div>
    ${pend.length ? `<div class="fit-section-h bill-section-h" style="border:none;padding-top:0">Pendientes <span class="bill-da-h" title="Débito automático">DA</span></div>${pend.map(billCard).join('')}` : ''}
    ${paid.length ? `<div class="fit-section-h bill-section-h">Pagadas este período <span class="bill-da-h" title="Débito automático">DA</span></div>${paid.map(billCard).join('')}` : ''}
    ${!bills.length ? `<div class="card"><div class="muted text-xs">Sin cuentas todavía. Agregá la primera arriba. Marcás "Pagado" cada mes y al siguiente se resetea solo.</div></div>` : ''}
  `;

  const $ = (s) => root.querySelector(s); const all = (s) => Array.from(root.querySelectorAll(s));
  wireTabs();
  $('#bill-add')?.addEventListener('click', () => { const name = $('#bill-new-name').value.trim(); if (!name) return; addBill({ name, frequency: $('#bill-new-freq').value, dueDay: $('#bill-new-due').value }); });
  all('[data-btoggle]').forEach(b => b.addEventListener('click', () => { const id = b.dataset.btoggle; if (expandedBills.has(id)) expandedBills.delete(id); else expandedBills.add(id); renderBills(root); }));
  all('[data-bpaid]').forEach(c => c.addEventListener('change', () => togglePaid(c.dataset.bpaid)));
  all('[data-bdelete]').forEach(b => b.addEventListener('click', () => delBill(b.dataset.bdelete)));
  all('[data-bda]').forEach(c => c.addEventListener('change', () => patchBill(c.dataset.bda, { autoDebit: c.checked })));
  all('[data-bcopy]').forEach(b => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.bcopy); toast('Referencia copiada'); }
    catch { toast('No se pudo copiar — copiala a mano', 'error'); }
  }));
  all('[data-bid][data-f]').forEach(el => el.addEventListener('change', () => {
    // Se guarda igual (puede ser un link a medio pegar), pero avisamos; el render nunca linkea URLs inválidas.
    if (el.dataset.f === 'url' && el.value.trim() && !sanitizeUrl(el.value)) toast('El link de pago debe empezar con http:// o https://', 'error');
    patchBill(el.dataset.bid, { [el.dataset.f]: el.value });
  }));
};
