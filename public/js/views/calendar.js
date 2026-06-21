// calendar.js — week view with drag-to-create blocks + Google Calendar overlay

import { state, findProject } from '../state.js';
import { api } from '../api.js';
import {
  todayKey, fromKey, startOfWeek, addDays, dayName, monthName,
  pad, fmtTime, minsToHrs, minsBetween, escapeHtml,
} from '../utils.js';
import { openBlockModal } from '../components/blockModal.js';

const SLOT_MINUTES = 30; // each cell = 30min

let weekAnchor = null;
let dragState = null;
let weekMeetingsCache = { weekKey: null, events: [], fetchedAt: 0 };
const MEETINGS_TTL_MS = 60 * 1000; // refetch each minute so URL changes show up fast

export const renderCalendar = (root) => {
  if (!weekAnchor) weekAnchor = startOfWeek(new Date());

  const start = state.settings?.dayStartHour ?? 7;
  const end   = state.settings?.dayEndHour ?? 22;
  const slotsPerHour = 60 / SLOT_MINUTES;
  const totalSlots = (end - start) * slotsPerHour;

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekAnchor, i));
  const dayKeys = days.map(d => todayKey(d));

  const totalMins = state.blocks
    .filter(b => dayKeys.includes(b.date))
    .reduce((s, b) => s + minsBetween(b.start, b.end), 0);

  root.innerHTML = `
    <div class="cal-toolbar">
      <button class="nav-btn-cal" id="cal-prev" title="Semana anterior">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <button class="btn btn-sm btn-secondary" id="cal-today">Hoy</button>
      <button class="nav-btn-cal" id="cal-next" title="Semana siguiente">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
      <div class="cal-week-label">${escapeHtml(weekLabel(days))}</div>
      <div style="flex:1"></div>
      <div class="muted text-sm">Total: <strong style="color:var(--text)">${minsToHrs(totalMins) || '0'}</strong></div>
    </div>

    <div class="cal-grid" id="cal-grid" style="grid-template-rows: 30px repeat(${totalSlots}, 26px)">
      <div class="cal-corner"></div>
      ${days.map((d, i) => {
        const k = todayKey(d);
        const isToday = k === todayKey();
        const isWeekend = d.getDay() === 0 || d.getDay() === 6;
        return `
          <div class="cal-day-h ${isToday ? 'today' : ''} ${isWeekend ? 'weekend' : ''}" style="grid-column:${i + 2}">
            <div class="day-num">${d.getDate()}</div>
            <div>${dayName(d, true)}</div>
          </div>
        `;
      }).join('')}

      ${Array.from({ length: totalSlots }).map((_, slot) => {
        const hour = start + Math.floor(slot / slotsPerHour);
        const showLabel = slot % slotsPerHour === 0;
        return `
          <div class="cal-hour-label" style="grid-row:${slot + 2};grid-column:1">
            ${showLabel ? pad(hour) + ':00' : ''}
          </div>
        `;
      }).join('')}

      ${days.map((d, dayIdx) => {
        const k = todayKey(d);
        return Array.from({ length: totalSlots }).map((_, slot) => {
          const totalMin = (start * 60) + slot * SLOT_MINUTES;
          const hh = Math.floor(totalMin / 60);
          const mm = totalMin % 60;
          const time = `${pad(hh)}:${pad(mm)}`;
          return `
            <div class="cal-cell"
                 data-day="${k}" data-day-idx="${dayIdx}"
                 data-slot="${slot}" data-time="${time}"
                 style="grid-row:${slot + 2};grid-column:${dayIdx + 2}"></div>
          `;
        }).join('');
      }).join('')}
    </div>
  `;

  // Insert "now" indicator
  const now = new Date();
  const todayKeyStr = todayKey();
  const todayIdx = dayKeys.indexOf(todayKeyStr);
  if (todayIdx >= 0 && now.getHours() >= start && now.getHours() < end) {
    const minsFromStart = (now.getHours() - start) * 60 + now.getMinutes();
    const slot = Math.floor(minsFromStart / SLOT_MINUTES);
    const cell = root.querySelector(`.cal-cell[data-day-idx="${todayIdx}"][data-slot="${slot}"]`);
    if (cell) cell.classList.add('now-line');
  }

  // Render existing blocks
  for (const b of state.blocks) {
    const dayIdx = dayKeys.indexOf(b.date);
    if (dayIdx < 0) continue;
    placeBlock(root, b, dayIdx, start, end);
  }

  // Overlay Google Calendar meetings (async, then place after fetch)
  loadWeekMeetings(days, dayKeys).then(() => {
    for (const ev of weekMeetingsCache.events) {
      placeMeeting(root, ev, dayKeys, start, end);
    }
  });

  // Toolbar
  root.querySelector('#cal-prev').addEventListener('click', () => {
    weekAnchor = addDays(weekAnchor, -7);
    renderCalendar(root);
  });
  root.querySelector('#cal-next').addEventListener('click', () => {
    weekAnchor = addDays(weekAnchor, 7);
    renderCalendar(root);
  });
  root.querySelector('#cal-today').addEventListener('click', () => {
    weekAnchor = startOfWeek(new Date());
    renderCalendar(root);
  });

  // Drag-to-create
  setupDrag(root, start, end);
  // Drop targets for tasks dragged from board → create a block
  setupTaskDrop(root, start, end);
};

// Accept tasks dragged from the board and turn them into time blocks.
const setupTaskDrop = (root, startHour) => {
  const grid = root.querySelector('#cal-grid');
  if (!grid) return;
  grid.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-tempo-task')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const cell = e.target.closest('.cal-cell');
    grid.querySelectorAll('.cal-cell.drop-target').forEach(c => c.classList.remove('drop-target'));
    if (cell) cell.classList.add('drop-target');
  });
  grid.addEventListener('dragleave', (e) => {
    if (e.target.classList?.contains('cal-cell')) e.target.classList.remove('drop-target');
  });
  grid.addEventListener('drop', (e) => {
    const taskId = e.dataTransfer.getData('application/x-tempo-task');
    if (!taskId) return;
    e.preventDefault();
    grid.querySelectorAll('.cal-cell.drop-target').forEach(c => c.classList.remove('drop-target'));
    const cell = e.target.closest('.cal-cell');
    if (!cell) return;
    const t = state.tasks.find(x => x.id === taskId);
    if (!t) return;

    // Default duration: estimated pomodoros * focus-mins, fall back to 60min.
    const focusMin = state.pomodoroSettings?.focus || 25;
    const defaultMin = (t.pomodoros && t.pomodoros > 0) ? Math.min(240, t.pomodoros * focusMin) : 60;
    const slotMin = parseInt(cell.dataset.time.split(':')[0], 10) * 60 + parseInt(cell.dataset.time.split(':')[1], 10);
    const startTime = cell.dataset.time;
    const endMin = Math.min(24 * 60 - 1, slotMin + defaultMin);
    const endTime = `${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}`;

    openBlockModal({
      date: cell.dataset.day,
      start: startTime,
      end: endTime,
      title: t.text,
      projectId: t.projectId,
    });
  });
};

const weekLabel = (days) => {
  const a = days[0], b = days[6];
  if (a.getMonth() === b.getMonth()) {
    return `${a.getDate()}–${b.getDate()} ${monthName(a)} ${a.getFullYear()}`;
  }
  return `${a.getDate()} ${monthName(a, true)} – ${b.getDate()} ${monthName(b, true)} ${b.getFullYear()}`;
};

const setupDrag = (root, startHour, endHour) => {
  const grid = root.querySelector('#cal-grid');
  const slotsPerHour = 60 / SLOT_MINUTES;

  const cellAtPoint = (x, y) => {
    const els = document.elementsFromPoint(x, y);
    return els.find(el => el.classList.contains('cal-cell'));
  };

  grid.addEventListener('mousedown', (e) => {
    const cell = e.target.closest('.cal-cell');
    if (!cell) return;
    e.preventDefault();
    dragState = { startCell: cell, currentCell: cell, dayKey: cell.dataset.day, dayIdx: cell.dataset.dayIdx };
    cell.classList.add('selected');
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const cell = cellAtPoint(e.clientX, e.clientY);
    if (!cell || cell.dataset.dayIdx !== dragState.dayIdx) return;
    if (cell === dragState.currentCell) return;
    dragState.currentCell = cell;
    // Highlight range
    grid.querySelectorAll('.cal-cell.selected').forEach(c => c.classList.remove('selected'));
    const a = Number(dragState.startCell.dataset.slot);
    const b = Number(cell.dataset.slot);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    grid.querySelectorAll(`.cal-cell[data-day-idx="${dragState.dayIdx}"]`).forEach(c => {
      const s = Number(c.dataset.slot);
      if (s >= lo && s <= hi) c.classList.add('selected');
    });
  });

  document.addEventListener('mouseup', (e) => {
    if (!dragState) return;
    const a = Number(dragState.startCell.dataset.slot);
    const b = Number(dragState.currentCell.dataset.slot);
    const lo = Math.min(a, b), hi = Math.max(a, b) + 1;
    const startMin = startHour * 60 + lo * SLOT_MINUTES;
    const endMin = startHour * 60 + hi * SLOT_MINUTES;
    const startTime = `${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)}`;
    const endTime = `${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}`;
    grid.querySelectorAll('.cal-cell.selected').forEach(c => c.classList.remove('selected'));
    openBlockModal({ date: dragState.dayKey, start: startTime, end: endTime });
    dragState = null;
  });
};

const loadWeekMeetings = async (days, dayKeys) => {
  const weekKey = dayKeys[0];
  // Cache only briefly so changes to the URL list / vault are picked up fast.
  if (weekMeetingsCache.weekKey === weekKey
      && (Date.now() - weekMeetingsCache.fetchedAt) < MEETINGS_TTL_MS) return;
  try {
    const from = new Date(days[0]); from.setHours(0,0,0,0);
    const to = new Date(days[6]); to.setHours(23,59,59,999);
    const res = await api.getCalendarEvents(from.toISOString(), to.toISOString());
    weekMeetingsCache = {
      weekKey,
      events: res.connected ? (res.events || []) : [],
      fetchedAt: Date.now(),
    };
  } catch {
    weekMeetingsCache = { weekKey, events: [], fetchedAt: Date.now() };
  }
};
export const invalidateCalendarCache = () => {
  weekMeetingsCache = { weekKey: null, events: [], fetchedAt: 0 };
};

const placeMeeting = (root, ev, dayKeys, startHour, endHour) => {
  const grid = root.querySelector('#cal-grid');
  if (!grid) return;
  const s = new Date(ev.start);
  const e = new Date(ev.end);
  const k = todayKey(s);
  const dayIdx = dayKeys.indexOf(k);
  if (dayIdx < 0) return;
  if (ev.allDay) return; // skip all-day for now in the grid

  const cell = grid.querySelector(`.cal-cell[data-day-idx="${dayIdx}"]`);
  if (!cell) return;

  const startMin = s.getHours() * 60 + s.getMinutes();
  const endMin = e.getHours() * 60 + e.getMinutes();
  const dayStartMin = startHour * 60;
  const dayEndMin = endHour * 60;
  if (endMin <= dayStartMin || startMin >= dayEndMin) return;

  const fromTop = Math.max(0, startMin - dayStartMin);
  const height = Math.min(endMin, dayEndMin) - Math.max(startMin, dayStartMin);
  const headerH = 30;
  const cellH = 26;
  const px = (mins) => (mins / SLOT_MINUTES) * cellH;
  const top = headerH + px(fromTop);
  const h = Math.max(20, px(height) - 1);

  const cellRect = cell.getBoundingClientRect();
  const gridRect = grid.getBoundingClientRect();
  const left = cellRect.left - gridRect.left + cellRect.width * 0.5; // right half
  const width = cellRect.width * 0.5 - 2;

  const node = document.createElement('div');
  node.className = 'cal-block cal-meeting';
  node.style.cssText = `
    top: ${top}px;
    left: ${left}px;
    width: ${width}px;
    height: ${h}px;
    border-left-color: var(--blue);
    background: rgba(106,169,237,0.14);
    border-style: dashed;
  `;
  node.title = `${ev.summary}${ev.location ? ' · ' + ev.location : ''}`;
  node.innerHTML = `
    <div class="b-title">📅 ${escapeHtml(ev.summary)}</div>
    <div class="b-time">${pad(s.getHours())}:${pad(s.getMinutes())}–${pad(e.getHours())}:${pad(e.getMinutes())}</div>
  `;
  node.addEventListener('click', (clickEv) => {
    clickEv.stopPropagation();
    openBlockModal({
      date: k,
      start: `${pad(s.getHours())}:${pad(s.getMinutes())}`,
      end: `${pad(e.getHours())}:${pad(e.getMinutes())}`,
      title: ev.summary,
    });
  });
  grid.appendChild(node);
};

const placeBlock = (root, b, dayIdx, startHour, endHour) => {
  const grid = root.querySelector('#cal-grid');
  const cell = grid.querySelector(`.cal-cell[data-day-idx="${dayIdx}"]`);
  if (!cell) return;

  const [sh, sm] = b.start.split(':').map(Number);
  const [eh, em] = b.end.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;

  const dayStartMin = startHour * 60;
  const dayEndMin = endHour * 60;
  if (endMin <= dayStartMin || startMin >= dayEndMin) return;

  const fromTop = Math.max(0, startMin - dayStartMin);
  const height = Math.min(endMin, dayEndMin) - Math.max(startMin, dayStartMin);

  // measure cells
  const headerH = 30;
  const cellH = 26;
  const slotsPerHour = 60 / SLOT_MINUTES;
  const px = (mins) => (mins / SLOT_MINUTES) * cellH;

  const top = headerH + px(fromTop);
  const h = Math.max(20, px(height) - 1);

  const cellRect = cell.getBoundingClientRect();
  const gridRect = grid.getBoundingClientRect();
  const left = cellRect.left - gridRect.left;
  const width = cellRect.width - 2;

  const proj = findProject(b.projectId);
  const color = proj ? proj.color : 'var(--accent)';

  const node = document.createElement('div');
  node.className = 'cal-block';
  node.style.cssText = `
    top: ${top}px;
    left: ${left}px;
    width: ${width}px;
    height: ${h}px;
    border-left-color: ${color};
    background: ${proj ? proj.color + '22' : 'var(--surface-3)'};
  `;
  node.innerHTML = `
    <div class="b-title">${escapeHtml(b.title)}</div>
    <div class="b-time">${b.start}–${b.end}${proj ? ' · ' + escapeHtml(proj.name) : ''}</div>
  `;
  node.addEventListener('click', (e) => {
    e.stopPropagation();
    openBlockModal({ id: b.id });
  });
  grid.appendChild(node);
};
