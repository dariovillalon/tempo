// promos.js — Promociones y cupones. Registrás promos que te interesan,
// si ya las usaste (y con qué tarjeta) y hasta cuándo son válidas.

import { state, mutate } from '../state.js';
import { uid, escapeHtml, todayKey } from '../utils.js';

const expandedPromos = new Set(); // promos expandidas (por defecto colapsadas)
const monthNow = () => new Date().toISOString().slice(0, 7);
const usedThisMonth = (p) => (p.usedDates || []).some(d => (d || '').startsWith(monthNow()));
const isExpired = (p) => p.validUntil && p.validUntil < todayKey();

const addPromo = (data) => mutate(s => { s.promos.push({ id: uid(), name: data.name || '', source: data.source || '', card: data.card || '', benefit: data.benefit || '', cadence: data.cadence || '', validUntil: data.validUntil || '', usedDates: [], notes: '', url: '' }); });
const patchPromo = (id, patch) => mutate(s => { const p = s.promos.find(x => x.id === id); if (p) Object.assign(p, patch); });
const delPromo = (id) => mutate(s => { s.promos = s.promos.filter(x => x.id !== id); });
const useToday = (id) => mutate(s => { const p = s.promos.find(x => x.id === id); if (!p) return; p.usedDates = p.usedDates || []; p.usedDates.push(todayKey()); });
const undoUse = (id) => mutate(s => { const p = s.promos.find(x => x.id === id); if (!p || !(p.usedDates || []).length) return; p.usedDates.pop(); });

export const renderPromos = (root) => {
  const promos = [...state.promos];
  const active = promos.filter(p => !isExpired(p));
  const porUsar = active.filter(p => !usedThisMonth(p));
  const usados = active.filter(p => usedThisMonth(p));
  const vencidas = promos.filter(p => isExpired(p));

  const promoCard = (p) => {
    const used = usedThisMonth(p), exp = isExpired(p);
    const last = (p.usedDates || []).slice(-1)[0];
    const open = expandedPromos.has(p.id);
    if (!open) {
      return `<div class="promo ${used ? 'is-used' : ''} ${exp ? 'is-exp' : ''}">
        <div class="day-block-line">
          <button class="bill-toggle" data-ptoggle="${p.id}" title="Expandir">▸</button>
          ${exp ? '<span class="muted text-xs">(vencida)</span>' : `<button class="btn ${used ? 'btn-ghost' : 'btn-secondary'} btn-sm" data-pgo="${p.id}">${used ? '✓ Usada' : 'Usar hoy'}</button>`}
          <span class="db-line-title">${escapeHtml(p.name || '(sin nombre)')}</span>
          ${p.benefit ? `<span class="promo-badge">${escapeHtml(p.benefit)}</span>` : ''}
          ${p.card ? `<span class="muted text-xs">${escapeHtml(p.card)}</span>` : ''}
          <button class="btn btn-ghost btn-sm" data-pdelete="${p.id}" title="Eliminar">✕</button>
        </div>
      </div>`;
    }
    return `<div class="promo is-open ${used ? 'is-used' : ''} ${exp ? 'is-exp' : ''}">
      <div class="promo-top">
        <button class="bill-toggle" data-ptoggle="${p.id}" title="Contraer">▾</button>
        ${exp ? '' : `<button class="btn ${used ? 'btn-ghost' : 'btn-secondary'} btn-sm" data-pgo="${p.id}">${used ? '✓ Usada' : 'Usar hoy'}</button>`}
        <input type="text" class="input promo-name" data-pid="${p.id}" data-f="name" value="${escapeHtml(p.name || '')}" placeholder="Promo (ej: 20% en super)">
        ${p.benefit ? `<span class="promo-badge">${escapeHtml(p.benefit)}</span>` : ''}
        <button class="btn btn-ghost btn-sm" data-pdelete="${p.id}" title="Eliminar">✕</button>
      </div>
      <div class="promo-row2">
        <input type="text" class="input" data-pid="${p.id}" data-f="source" value="${escapeHtml(p.source || '')}" placeholder="Banco / fuente">
        <input type="text" class="input" data-pid="${p.id}" data-f="card" value="${escapeHtml(p.card || '')}" placeholder="Con qué tarjeta">
        <input type="text" class="input" data-pid="${p.id}" data-f="benefit" value="${escapeHtml(p.benefit || '')}" placeholder="Beneficio (20%, 2x1…)">
      </div>
      <div class="promo-row2">
        <label class="muted text-xs promo-valid">Válida hasta <input type="date" class="input" data-pid="${p.id}" data-f="validUntil" value="${escapeHtml(p.validUntil || '')}"></label>
        <input type="text" class="input" data-pid="${p.id}" data-f="cadence" value="${escapeHtml(p.cadence || '')}" placeholder="Frecuencia (1/mes…)">
      </div>
      ${last ? `<div class="muted text-xs">Último uso: ${escapeHtml(last)}${used ? ` · <a data-pundo="${p.id}" class="promo-undo">deshacer</a>` : ''}</div>` : ''}
      ${exp ? `<div class="muted text-xs" style="color:var(--red)">Venció el ${escapeHtml(p.validUntil)}</div>` : ''}
      <textarea class="textarea" data-pid="${p.id}" data-f="notes" rows="1" placeholder="Notas (condiciones, tope de reintegro…)">${escapeHtml(p.notes || '')}</textarea>
    </div>`;
  };

  root.innerHTML = `
    <div class="card">
      <div class="card-title">Promociones y cupones</div>
      <div class="muted text-xs">Por usar este mes: <b>${porUsar.length}</b></div>
      <div class="row gap-6" style="flex-wrap:wrap;align-items:center;margin-top:12px">
        <input type="text" class="input" id="promo-new-name" placeholder="Promo (ej: 20% en super)" style="flex:1;min-width:150px">
        <input type="text" class="input" id="promo-new-source" placeholder="Banco" style="width:110px">
        <input type="text" class="input" id="promo-new-card" placeholder="Tarjeta" style="width:110px">
        <input type="date" class="input" id="promo-new-valid" style="width:150px" title="Válida hasta">
        <button class="btn btn-primary" id="promo-add">+ Agregar</button>
      </div>
    </div>
    ${porUsar.length ? `<div class="fit-section-h" style="border:none;padding-top:0">Por usar</div>${porUsar.map(promoCard).join('')}` : ''}
    ${usados.length ? `<div class="fit-section-h">Usadas este mes</div>${usados.map(promoCard).join('')}` : ''}
    ${vencidas.length ? `<div class="fit-section-h">Vencidas</div>${vencidas.map(promoCard).join('')}` : ''}
    ${!promos.length ? `<div class="card"><div class="muted text-xs">Sin promos todavía. Cargá la primera arriba (ej: el 20% del banco en el súper, 1 vez por mes por tarjeta).</div></div>` : ''}
  `;

  const $ = (s) => root.querySelector(s); const all = (s) => Array.from(root.querySelectorAll(s));
  $('#promo-add')?.addEventListener('click', () => { const name = $('#promo-new-name').value.trim(); if (!name) return; addPromo({ name, source: $('#promo-new-source').value, card: $('#promo-new-card').value, validUntil: $('#promo-new-valid').value }); });
  all('[data-ptoggle]').forEach(b => b.addEventListener('click', () => { const id = b.dataset.ptoggle; if (expandedPromos.has(id)) expandedPromos.delete(id); else expandedPromos.add(id); renderPromos(root); }));
  all('[data-pgo]').forEach(b => b.addEventListener('click', () => { const p = state.promos.find(x => x.id === b.dataset.pgo); if (p && usedThisMonth(p)) undoUse(b.dataset.pgo); else useToday(b.dataset.pgo); }));
  all('[data-pundo]').forEach(a => a.addEventListener('click', () => undoUse(a.dataset.pundo)));
  all('[data-pdelete]').forEach(b => b.addEventListener('click', () => delPromo(b.dataset.pdelete)));
  all('[data-pid][data-f]').forEach(el => el.addEventListener('change', () => patchPromo(el.dataset.pid, { [el.dataset.f]: el.value })));
};
