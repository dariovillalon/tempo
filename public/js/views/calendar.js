// calendar.js — Planificador del día: reuniones + bloques de trabajo (manual),
// con notas/comentarios y pomodoro directo desde los bloques de trabajo.
// (Reemplaza la grilla semanal + overlay de Google Calendar, que no se usaba.)

import { state, addBlock, updateBlock, deleteBlock } from '../state.js';
import { todayKey, addDays, dayName, monthName, escapeHtml, minsBetween, minsToHrs } from '../utils.js';
import { startPomodoroForBlock } from './pomodoro.js';
import { router } from '../router.js';

let dayAnchor = null;
const expandedBlocks = new Set(); // bloques expandidos (por defecto colapsados)

// Compatibilidad: la agenda ya no usa calendarios externos (Google), pero settings.js
// todavía importa esto. Lo dejamos como no-op para no romper nada.
export const invalidateCalendarCache = () => {};

export const renderCalendar = (root) => {
  if (!dayAnchor) dayAnchor = new Date();
  const k = todayKey(dayAnchor);
  const isToday = k === todayKey(new Date());
  const blocks = state.blocks
    .filter(b => b.date === k)
    .sort((a, b) => (a.start || '99:99') < (b.start || '99:99') ? -1 : 1);
  const totalMins = blocks.reduce((s, b) => s + (b.start && b.end ? Math.max(0, minsBetween(b.start, b.end)) : 0), 0);
  const dateLabel = `${dayName(dayAnchor)}, ${dayAnchor.getDate()} ${monthName(dayAnchor)}`;

  const blockRow = (b) => {
    const kind = b.kind || 'work';
    const open = expandedBlocks.has(b.id);
    const kindEmoji = kind === 'meeting' ? '📅' : '💼';
    if (!open) {
      return `<div class="day-block kind-${kind}">
        <div class="day-block-line">
          <button class="bill-toggle" data-dtoggle="${b.id}" title="Expandir">▸</button>
          <span class="db-time-lbl">${escapeHtml(b.start || '--:--')}–${escapeHtml(b.end || '--:--')}</span>
          <span class="db-line-title">${kindEmoji} ${escapeHtml(b.title || '(sin título)')}</span>
          ${b.notes ? '<span class="db-note-dot" title="Tiene notas">📝</span>' : ''}
          ${kind === 'work' ? `<button class="btn btn-secondary btn-sm" data-pomo="${b.id}" title="Lanzar pomodoro">▶</button>` : ''}
          <button class="btn btn-ghost btn-sm" data-bdel="${b.id}" title="Eliminar">✕</button>
        </div>
      </div>`;
    }
    return `<div class="day-block kind-${kind} is-open">
      <div class="day-block-top">
        <button class="bill-toggle" data-dtoggle="${b.id}" title="Contraer">▾</button>
        <input type="time" class="input db-f" data-bid="${b.id}" data-f="start" value="${b.start || ''}">
        <span class="db-dash">–</span>
        <input type="time" class="input db-f" data-bid="${b.id}" data-f="end" value="${b.end || ''}">
        <select class="select db-kind" data-bid="${b.id}">
          <option value="work" ${kind === 'work' ? 'selected' : ''}>💼 Trabajo</option>
          <option value="meeting" ${kind === 'meeting' ? 'selected' : ''}>📅 Reunión</option>
        </select>
        ${kind === 'work' ? `<button class="btn btn-secondary btn-sm" data-pomo="${b.id}" title="Lanzar pomodoro para este bloque">▶ Pomodoro</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-bdel="${b.id}" title="Eliminar">✕</button>
      </div>
      <input type="text" class="input db-title" data-bid="${b.id}" value="${escapeHtml(b.title || '')}" placeholder="Título…">
      <textarea class="textarea db-notes" data-bid="${b.id}" rows="2" placeholder="Notas / comentarios…">${escapeHtml(b.notes || '')}</textarea>
    </div>`;
  };

  root.innerHTML = `
    <div class="cal-toolbar">
      <button class="nav-btn-cal" id="day-prev" title="Día anterior">‹</button>
      <button class="btn btn-sm btn-secondary" id="day-today">Hoy</button>
      <button class="nav-btn-cal" id="day-next" title="Día siguiente">›</button>
      <div class="cal-title">${escapeHtml(dateLabel)}${isToday ? ' · hoy' : ''}</div>
      <div class="cal-total muted text-xs">${blocks.length} bloque(s) · ${minsToHrs(totalMins)}</div>
    </div>

    <div class="card day-add">
      <div class="row gap-6" style="flex-wrap:wrap;align-items:center">
        <input type="time" class="input" id="db-new-start" style="width:108px" title="Inicio">
        <span class="db-dash">–</span>
        <input type="time" class="input" id="db-new-end" style="width:108px" title="Fin">
        <select class="select" id="db-new-kind" style="width:140px">
          <option value="work">💼 Trabajo</option>
          <option value="meeting">📅 Reunión</option>
        </select>
        <input type="text" class="input" id="db-new-title" placeholder="Reunión o bloque de trabajo…" style="flex:1;min-width:180px">
        <button class="btn btn-primary" id="db-add">+ Agregar</button>
      </div>
    </div>

    <div class="day-list">
      ${blocks.length ? blocks.map(blockRow).join('') : '<div class="card"><div class="muted text-xs">No tenés nada cargado para este día. Agregá tu primera reunión o bloque arriba ☝️</div></div>'}
    </div>`;

  const $ = (s) => root.querySelector(s);
  const all = (s) => Array.from(root.querySelectorAll(s));

  $('#day-prev')?.addEventListener('click', () => { dayAnchor = addDays(dayAnchor, -1); renderCalendar(root); });
  $('#day-next')?.addEventListener('click', () => { dayAnchor = addDays(dayAnchor, 1); renderCalendar(root); });
  $('#day-today')?.addEventListener('click', () => { dayAnchor = new Date(); renderCalendar(root); });

  $('#db-add')?.addEventListener('click', () => {
    const title = $('#db-new-title').value.trim();
    const start = $('#db-new-start').value;
    const end = $('#db-new-end').value;
    const kind = $('#db-new-kind').value;
    if (!title && !start) return;
    addBlock({ title, date: k, start, end, kind });
    renderCalendar(root);
  });

  all('[data-dtoggle]').forEach(b => b.addEventListener('click', () => { const id = b.dataset.dtoggle; if (expandedBlocks.has(id)) expandedBlocks.delete(id); else expandedBlocks.add(id); renderCalendar(root); }));
  all('.db-f').forEach(i => i.addEventListener('change', () => updateBlock(i.dataset.bid, { [i.dataset.f]: i.value })));
  all('.db-kind').forEach(s => s.addEventListener('change', () => { updateBlock(s.dataset.bid, { kind: s.value }); renderCalendar(root); }));
  all('.db-title').forEach(i => i.addEventListener('change', () => updateBlock(i.dataset.bid, { title: i.value })));
  all('.db-notes').forEach(t => t.addEventListener('change', () => updateBlock(t.dataset.bid, { notes: t.value })));
  all('[data-bdel]').forEach(b => b.addEventListener('click', () => { deleteBlock(b.dataset.bdel); renderCalendar(root); }));
  all('[data-pomo]').forEach(b => b.addEventListener('click', () => {
    const blk = state.blocks.find(x => x.id === b.dataset.pomo);
    if (blk) { startPomodoroForBlock(blk.title || 'Bloque de trabajo', blk.projectId); router.go('pomodoro'); }
  }));
};
