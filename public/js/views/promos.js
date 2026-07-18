// promos.js — Promociones y cupones. Registrás promos que te interesan,
// si ya las usaste (y con qué tarjeta) y hasta cuándo son válidas.

import { state, mutate } from '../state.js';
import { uid, escapeHtml, todayKey } from '../utils.js';

const expandedPromos = new Set(); // promos expandidas (por defecto colapsadas)
const monthNow = () => todayKey().slice(0, 7); // mes local, no UTC
const usedThisMonth = (p) => (p.usedDates || []).some(d => (d || '').startsWith(monthNow()));
const isExpired = (p) => p.validUntil && p.validUntil < todayKey();

// Días de la semana estructurados (números JS: 0=domingo … 6=sábado).
// `days` es la fuente de verdad; `cadence` queda como etiqueta humana libre.
const DAY_SHORT = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
const DAY_FULL = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// Parser legacy: deriva días desde el texto libre de cadencia ('Lun · Mié · Vie',
// 'Martes y viernes', 'Sábados', 'todos los días'…). Devuelve null si no se
// reconoce ningún día (cadencias tipo '1/mes' → null = "se muestra siempre").
export const parseCadenceDays = (text) => {
  if (!text || !String(text).trim()) return null;
  const norm = String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/\b(todos|todas|diario|diaria|siempre)\b/.test(norm)) return [0, 1, 2, 3, 4, 5, 6];
  const TOKENS = {
    dom: 0, domingo: 0, domingos: 0,
    lun: 1, lunes: 1,
    mar: 2, martes: 2,
    mie: 3, miercoles: 3,
    jue: 4, jueves: 4,
    vie: 5, viernes: 5,
    sab: 6, sabado: 6, sabados: 6,
  };
  const days = new Set();
  // Rangos primero ("Lun–Jue", "lunes a viernes", "Vie-Dom"): expandir el tramo
  // completo, con wrap pasando el domingo (Vie–Dom → 5,6,0).
  const DAY_RE = '(dom(?:ingos?)?|lun(?:es)?|mar(?:tes)?|mie(?:rcoles)?|jue(?:ves)?|vie(?:rnes)?|sab(?:ados?)?)';
  const rangeRe = new RegExp(`\\b${DAY_RE}\\s*(?:[\\u2013\\u2014-]|a|al|hasta)\\s*${DAY_RE}\\b`, 'g');
  let rest = norm;
  for (const m of norm.matchAll(rangeRe)) {
    const from = TOKENS[m[1]], to = TOKENS[m[2]];
    if (from === undefined || to === undefined) continue;
    for (let d = from; ; d = (d + 1) % 7) { days.add(d); if (d === to) break; }
    rest = rest.replace(m[0], ' ');
  }
  // Días sueltos. hasOwn: `in` matchearía claves del prototipo ("constructor").
  for (const tok of rest.split(/[^a-z]+/)) if (Object.hasOwn(TOKENS, tok)) days.add(TOKENS[tok]);
  return days.size ? [...days].sort((a, b) => a - b) : null;
};

// Días efectivos de una promo: `days` explícito si existe; si no, se derivan
// de la cadencia. null = sin info parseable (tratar como "siempre").
const effectiveDays = (p) => (Array.isArray(p.days) ? p.days : parseCadenceDays(p.cadence || ''));

// Promos activas que aplican a un día de semana (0=domingo … 6=sábado).
// - days: [] explícito → no se muestra nunca.
// - days undefined Y cadencia no parseable → se muestra siempre (que nada desaparezca solo).
// - Respeta validUntil cuando está seteado.
export const promosForDay = (promos, weekday) => (promos || []).filter(p => {
  if (!p || isExpired(p)) return false;
  const days = effectiveDays(p);
  if (days == null) return true;
  return days.includes(weekday);
});

const addPromo = (data) => mutate(s => {
  const p = { id: uid(), name: data.name || '', source: data.source || '', card: data.card || '', benefit: data.benefit || '', cadence: data.cadence || '', validUntil: data.validUntil || '', usedDates: [], notes: '', url: '' };
  if (Array.isArray(data.days)) p.days = data.days.slice();
  s.promos.push(p);
});
const patchPromo = (id, patch) => mutate(s => {
  const p = s.promos.find(x => x.id === id); if (!p) return;
  Object.assign(p, patch);
  // Backfill perezoso: si todavía no tiene days, derivarlos de la cadencia y persistirlos.
  if (!Array.isArray(p.days)) { const d = parseCadenceDays(p.cadence || ''); if (d) p.days = d; }
});
const togglePromoDay = (id, day) => mutate(s => {
  const p = s.promos.find(x => x.id === id); if (!p) return;
  const base = Array.isArray(p.days) ? p.days.slice() : (parseCadenceDays(p.cadence || '') || []);
  p.days = base.includes(day) ? base.filter(x => x !== day) : [...base, day].sort((a, b) => a - b);
});
const delPromo = (id) => mutate(s => { s.promos = s.promos.filter(x => x.id !== id); });
const useToday = (id) => mutate(s => { const p = s.promos.find(x => x.id === id); if (!p) return; p.usedDates = p.usedDates || []; p.usedDates.push(todayKey()); });
const undoUse = (id) => mutate(s => { const p = s.promos.find(x => x.id === id); if (!p || !(p.usedDates || []).length) return; p.usedDates.pop(); });

// Agrupar una lista de promos por banco (source), bancos y promos ordenados
// alfabéticamente. Devuelve [[banco, promos]] listo para render.
const groupByBank = (list) => {
  const map = new Map();
  const sorted = [...list].sort((a, b) => {
    const ba = (a.source || 'Sin banco').toLowerCase(), bb = (b.source || 'Sin banco').toLowerCase();
    return ba === bb ? (a.name || '').localeCompare(b.name || '') : ba.localeCompare(bb);
  });
  for (const p of sorted) {
    const k = p.source || 'Sin banco';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(p);
  }
  return [...map.entries()];
};

export const renderPromos = (root) => {
  const promos = [...state.promos];
  const active = promos.filter(p => !isExpired(p));
  // oneUse = promo mensual de un solo uso: se marca con el check y el estado
  // se renueva solo al cambiar el mes (usedThisMonth mira el mes corriente).
  const mensuales = active.filter(p => p.oneUse);
  const recurrentes = active.filter(p => !p.oneUse);
  const porUsar = mensuales.filter(p => !usedThisMonth(p));
  const vencidas = promos.filter(p => isExpired(p));

  const promoCard = (p) => {
    const used = usedThisMonth(p), exp = isExpired(p);
    const last = (p.usedDates || []).slice(-1)[0];
    const open = expandedPromos.has(p.id);
    // Control de uso: las mensuales de un solo uso llevan check (marcable/desmarcable);
    // las recurrentes conservan el botón "Usar hoy" que solo registra el uso.
    const useCtl = exp ? '<span class="muted text-xs">(vencida)</span>'
      : p.oneUse
        ? `<label class="promo-usecheck" title="${used ? 'Usada este mes (destildá para deshacer)' : 'Marcá cuando la uses; se renueva al mes siguiente'}" style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" data-pcheck="${p.id}" ${used ? 'checked' : ''}><span class="muted text-xs">${used ? 'usada' : 'sin usar'}</span></label>`
        : `<button class="btn ${used ? 'btn-ghost' : 'btn-secondary'} btn-sm" data-pgo="${p.id}">${used ? '✓ Usada' : 'Usar hoy'}</button>`;
    if (!open) {
      return `<div class="promo ${used ? 'is-used' : ''} ${exp ? 'is-exp' : ''}">
        <div class="day-block-line">
          <button class="bill-toggle" data-ptoggle="${p.id}" title="Expandir">▸</button>
          ${useCtl}
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
        ${exp ? '' : useCtl}
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
        <label class="muted text-xs" style="display:flex;align-items:center;gap:4px;cursor:pointer" title="Mensual de un solo uso: aparece con check y se renueva cada mes"><input type="checkbox" data-poneuse="${p.id}" ${p.oneUse ? 'checked' : ''}> 1 uso/mes</label>
      </div>
      ${(() => {
        const eff = effectiveDays(p) || [];
        return `<div class="promo-days" style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin:2px 0" title="Días en que aplica la promo (sin días marcados y sin cadencia reconocible = se muestra siempre)">
          <span class="muted text-xs" style="margin-right:2px">Días</span>
          ${DAY_SHORT.map((lbl, d) => `<button class="fit-day-tab ${eff.includes(d) ? 'active' : ''}" data-pday="${d}" data-pdayof="${p.id}" title="${DAY_FULL[d]}">${lbl}</button>`).join('')}
        </div>`;
      })()}
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
    ${mensuales.length ? `<div class="fit-section-h" style="border:none;padding-top:0">Mensuales · 1 uso por mes</div>${groupByBank(mensuales).map(([bank, list]) =>
      `<div class="muted text-xs" style="margin:8px 0 4px;font-weight:600">${escapeHtml(bank)}</div>${list.map(promoCard).join('')}`).join('')}` : ''}
    ${recurrentes.length ? `<div class="fit-section-h">Recurrentes</div>${groupByBank(recurrentes).map(([bank, list]) =>
      `<div class="muted text-xs" style="margin:8px 0 4px;font-weight:600">${escapeHtml(bank)}</div>${list.map(promoCard).join('')}`).join('')}` : ''}
    ${vencidas.length ? `<div class="fit-section-h">Vencidas</div>${vencidas.map(promoCard).join('')}` : ''}
    ${!promos.length ? `<div class="card"><div class="muted text-xs">Sin promos todavía. Cargá la primera arriba (ej: el 20% del banco en el súper, 1 vez por mes por tarjeta).</div></div>` : ''}
  `;

  const $ = (s) => root.querySelector(s); const all = (s) => Array.from(root.querySelectorAll(s));
  $('#promo-add')?.addEventListener('click', () => { const name = $('#promo-new-name').value.trim(); if (!name) return; addPromo({ name, source: $('#promo-new-source').value, card: $('#promo-new-card').value, validUntil: $('#promo-new-valid').value }); });
  all('[data-ptoggle]').forEach(b => b.addEventListener('click', () => { const id = b.dataset.ptoggle; if (expandedPromos.has(id)) expandedPromos.delete(id); else expandedPromos.add(id); renderPromos(root); }));
  all('[data-pgo]').forEach(b => b.addEventListener('click', () => { const p = state.promos.find(x => x.id === b.dataset.pgo); if (p && usedThisMonth(p)) undoUse(b.dataset.pgo); else useToday(b.dataset.pgo); }));
  all('[data-pcheck]').forEach(c => c.addEventListener('change', () => { if (c.checked) useToday(c.dataset.pcheck); else undoUse(c.dataset.pcheck); }));
  all('[data-poneuse]').forEach(c => c.addEventListener('change', () => patchPromo(c.dataset.poneuse, { oneUse: c.checked })));
  all('[data-pundo]').forEach(a => a.addEventListener('click', () => undoUse(a.dataset.pundo)));
  all('[data-pday]').forEach(b => b.addEventListener('click', () => togglePromoDay(b.dataset.pdayof, +b.dataset.pday)));
  all('[data-pdelete]').forEach(b => b.addEventListener('click', () => delPromo(b.dataset.pdelete)));
  all('[data-pid][data-f]').forEach(el => el.addEventListener('change', () => patchPromo(el.dataset.pid, { [el.dataset.f]: el.value })));
};
