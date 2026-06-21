// dashboard.js — executive cockpit. Designed to surface things you can't see in
// the sidebar/today/board: weekly metrics, what needs attention, upcoming meetings,
// what got done, and per-root-project KPIs.

import { state, findProject, updateTask } from '../state.js';
import { api } from '../api.js';
import {
  todayKey, addDays, dayName, minsBetween, minsToHrs, relTime, escapeHtml, pad,
} from '../utils.js';
import { router } from '../router.js';
import { openProjectModal } from '../components/projectModal.js';
import { openImportModal } from '../components/importModal.js';
import { openTaskModal } from '../components/taskModal.js';
import { openReviewModal } from '../components/reviewModal.js';

let weekMeetingsCache = { weekKey: null, events: [] };

const STATUS_LABEL = { active: 'Activo', paused: 'Pausado', done: 'Terminado', archived: 'Archivado' };
const HEALTH_LABEL = { 'on-track': 'En curso', 'at-risk': 'En riesgo', 'blocked': 'Bloqueado' };

// Collect a project plus all descendants — used to roll up subproject metrics into root.
const allDescendantIds = (rootId) => {
  const out = new Set([rootId]);
  const walk = (pid) => {
    for (const c of state.projects.filter(p => p.parentId === pid)) {
      out.add(c.id); walk(c.id);
    }
  };
  walk(rootId);
  return out;
};

const STALE_DAYS = 7;
const isStale = (project) => {
  const ids = allDescendantIds(project.id);
  // last activity for this project or any descendant
  const last = (state.activity || []).find(a => ids.has(a.projectId));
  const lastBlock = state.blocks.filter(b => ids.has(b.projectId))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
  const ts = Math.max(
    last?.ts || 0,
    lastBlock ? new Date(lastBlock.date + 'T' + (lastBlock.start || '00:00')).getTime() : 0,
  );
  if (!ts) return true; // never touched
  return (Date.now() - ts) > STALE_DAYS * 86400_000;
};

export const renderDashboard = (root) => {
  const today = new Date();
  const tk = todayKey();

  // ---- Weekly window (rolling last 7 days) ----
  const weekStart = new Date(today); weekStart.setDate(weekStart.getDate() - 6); weekStart.setHours(0, 0, 0, 0);
  const dayKeys = []; for (let i = 6; i >= 0; i--) dayKeys.push(todayKey(addDays(today, -i)));

  const weekBlocks = state.blocks.filter(b => dayKeys.includes(b.date));
  const weekMins = weekBlocks.reduce((s, b) => s + minsBetween(b.start, b.end), 0);
  const weekGoalMin = (state.settings?.weeklyGoalHours || 35) * 60;
  const weekPct = Math.min(100, (weekMins / weekGoalMin) * 100);

  const weekPomos = (state.pomodoroLog || []).filter(p =>
    dayKeys.includes(todayKey(new Date(p.completedAt))) && p.type !== 'break').length;

  const weekTasksDone = state.tasks.filter(t =>
    t.state === 'done' && t.createdAt && dayKeys.includes(todayKey(new Date(t.createdAt))));
  // Use activity log to find tasks that TRANSITIONED to done this week (more accurate)
  const doneThisWeek = (state.activity || []).filter(a =>
    a.type === 'task.state' && /Hecho/.test(a.text || '') &&
    dayKeys.includes(todayKey(new Date(a.ts))));

  const streak = computeStreak();

  // ---- Attention buckets ----
  const inboxCount = state.tasks.filter(t => t.state === 'inbox').length;
  const overdueFollowUps = state.tasks.filter(t =>
    t.state !== 'done' && t.followUpAt && t.followUpAt <= tk).length;
  const overdueTasks = state.tasks.filter(t =>
    t.state !== 'done' && t.due && t.due < tk).length;
  const stuckDoing = state.tasks.filter(t => {
    if (t.state !== 'doing') return false;
    // proxy: no activity touching this task in last 3 days
    const last = (state.activity || []).find(a => a.taskId === t.id);
    return !last || (Date.now() - last.ts) > 3 * 86400_000;
  }).length;

  // ---- Per-root-project rollup ----
  const roots = state.projects.filter(p => !p.parentId && p.status !== 'archived');
  const rootStats = roots.map(p => {
    const ids = allDescendantIds(p.id);
    const tasks = state.tasks.filter(t => ids.has(t.projectId));
    const done = tasks.filter(t => t.state === 'done').length;
    const open = tasks.length - done;
    const overdueP = tasks.filter(t => t.state !== 'done' && t.due && t.due < tk).length;
    const blocks = weekBlocks.filter(b => ids.has(b.projectId));
    const weekMinsP = blocks.reduce((s, b) => s + minsBetween(b.start, b.end), 0);
    const stale = isStale(p);
    return { p, tasks: tasks.length, done, open, overdueP, weekMinsP, stale, ids };
  });
  const stalePCount = rootStats.filter(s => s.stale).length;

  // ---- Per-day minutes for the chart ----
  const dayMins = dayKeys.map(k => weekBlocks
    .filter(b => b.date === k).reduce((s, b) => s + minsBetween(b.start, b.end), 0));
  const maxDayMin = Math.max(1, ...dayMins);

  // ---- Project breakdown (week minutes per ROOT, rolling up children) ----
  const projTimeRoot = {};
  for (const r of rootStats) projTimeRoot[r.p.id] = r.weekMinsP;

  // ---- Build attention items only when nonzero ----
  const attention = [];
  if (inboxCount)         attention.push({ kind: 'inbox',    count: inboxCount,         label: `${inboxCount} en Inbox sin asignar`,   action: () => router.go('board') });
  if (overdueFollowUps)   attention.push({ kind: 'followup', count: overdueFollowUps,   label: `${overdueFollowUps} seguimiento(s) pendiente(s)`, action: () => router.go('today') });
  if (overdueTasks)       attention.push({ kind: 'overdue',  count: overdueTasks,       label: `${overdueTasks} tarea(s) vencida(s)`,  action: () => router.go('today') });
  if (stuckDoing)         attention.push({ kind: 'stuck',    count: stuckDoing,         label: `${stuckDoing} en doing sin movimiento (3d+)`, action: () => router.go('board') });
  if (stalePCount)        attention.push({ kind: 'stale',    count: stalePCount,        label: `${stalePCount} proyecto(s) sin actividad ${STALE_DAYS}d+` });

  // ---- Render ----
  root.innerHTML = `
    <div class="view-h">
      <h2>Dashboard</h2>
      <div class="view-h-actions">
        <button class="btn btn-ghost" id="dash-weekly-review" title="Cerrar la semana — escribe entry en DailyNotes/">📝 Cerrar semana</button>
        <button class="btn btn-ghost" id="dash-import-projects" title="Importar carpetas de Obsidian como proyectos">↓ Importar</button>
        <button class="btn btn-secondary" id="dash-add-project">+ Nuevo proyecto</button>
      </div>
    </div>

    <!-- KPI strip -->
    <div class="kpi-strip">
      <div class="kpi-card">
        <div class="kpi-label">Foco esta semana</div>
        <div class="kpi-value">${escapeHtml(minsToHrs(weekMins) || '0m')}</div>
        <div class="kpi-progress"><div class="kpi-progress-fill" style="width:${weekPct}%"></div></div>
        <div class="kpi-trend">${weekPct.toFixed(0)}% de ${weekGoalMin / 60}h</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Pomodoros</div>
        <div class="kpi-value">${weekPomos} <span class="unit">🍅</span></div>
        <div class="kpi-trend">esta semana</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Tareas terminadas</div>
        <div class="kpi-value">${doneThisWeek.length}</div>
        <div class="kpi-trend">últimos 7 días</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Reuniones</div>
        <div class="kpi-value" id="kpi-meetings">—</div>
        <div class="kpi-trend">esta semana</div>
      </div>
      <div class="kpi-card streak-card">
        <div class="kpi-label">Racha</div>
        <div class="kpi-value streak-num">${streak}</div>
        <div class="kpi-trend">día(s) con foco</div>
      </div>
    </div>

    ${attention.length ? `
      <div class="card attention-card" style="margin-top:14px">
        <div class="card-header">
          <div class="card-title">Atención requerida</div>
          <div class="card-sub">qué te está esperando</div>
        </div>
        <div class="attention-grid">
          ${attention.map((a, i) => `
            <div class="attention-pill ${a.kind} ${a.action ? 'clickable' : ''}" data-att="${i}">
              <span class="att-count">${a.count}</span>
              <span class="att-label">${escapeHtml(a.label)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    ` : `
      <div class="card" style="margin-top:14px;border-left:3px solid var(--green)">
        <div class="card-title">Sin pendientes urgentes</div>
        <div class="card-sub" style="margin-top:4px">Inbox limpio, seguimientos al día, nada vencido. 🎉</div>
      </div>
    `}

    <div class="dash-grid" style="margin-top:14px">
      <!-- Project portfolio: only ROOTS with real KPIs -->
      <div class="dash-cell">
        <div class="card">
          <div class="card-header">
            <div class="card-title">Proyectos · raíces</div>
            <div class="card-sub">${roots.length} activo(s) · subproyectos en sidebar</div>
          </div>
          ${roots.length === 0
            ? `<div class="empty" style="padding:14px">Sin proyectos. Tocá <strong>Importar</strong>.</div>`
            : `<div class="root-grid">
                ${rootStats.map(s => renderRootCard(s)).join('')}
              </div>`}
        </div>
      </div>

      <div class="dash-cell col-8">
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">Tiempo · últimos 7 días</div>
              <div class="card-sub">${minsToHrs(weekMins) || '0'} de ${weekGoalMin / 60}h (${weekPct.toFixed(0)}%)</div>
            </div>
          </div>
          <div class="time-chart" style="height:160px">
            ${dayMins.map((m, i) => {
              const k = dayKeys[i];
              const h = Math.max(2, (m / maxDayMin) * 130);
              const isToday = k === tk;
              return `
                <div class="bar-wrap" title="${k}: ${minsToHrs(m) || '0'}">
                  <div class="bar ${m > 0 ? 'has-time' : ''}" style="height:${h}px;${isToday ? 'background:var(--accent)' : ''}"></div>
                  <div class="label" style="${isToday ? 'color:var(--accent);font-weight:600' : ''}">${dayName(addDays(today, -(6 - i)), true)}</div>
                </div>
              `;
            }).join('')}
          </div>
          ${renderProjectBreakdownByRoot(rootStats)}
        </div>

        <div class="card" style="margin-top:14px" id="upcoming-meetings-card">
          <div class="card-header">
            <div class="card-title">Próximas reuniones</div>
            <div class="card-sub" id="upcoming-meetings-sub">cargando…</div>
          </div>
          <div id="upcoming-meetings-body">
            <div class="muted text-sm" style="padding:8px">Cargando agenda…</div>
          </div>
        </div>
      </div>

      <div class="dash-cell col-4">
        <div class="card">
          <div class="card-header"><div class="card-title">Hecho esta semana</div></div>
          ${doneThisWeek.length === 0
            ? `<div class="muted text-sm" style="padding:8px 4px">Nada terminado todavía.</div>`
            : `<div class="activity-list">
                ${doneThisWeek.slice(0, 12).map(a => `
                  <div class="activity-item">
                    <div class="when">${relTime(a.ts)}</div>
                    <div class="text">${a.text || ''}</div>
                  </div>`).join('')}
              </div>`}
        </div>

        <div class="card" style="margin-top:14px">
          <div class="card-header"><div class="card-title">Actividad reciente</div></div>
          <div class="activity-list">
            ${(state.activity || []).slice(0, 16).map(a => `
              <div class="activity-item">
                <div class="when">${relTime(a.ts)}</div>
                <div class="text">${a.text || ''}</div>
              </div>`).join('') || '<div class="muted text-sm" style="padding:8px 4px">Sin actividad.</div>'}
          </div>
        </div>
      </div>
    </div>
  `;

  // Wire actions
  root.querySelector('#dash-add-project').addEventListener('click', () => openProjectModal());
  root.querySelector('#dash-import-projects').addEventListener('click', () => openImportModal());
  root.querySelector('#dash-weekly-review').addEventListener('click', () => openReviewModal('week'));
  root.querySelectorAll('.proj-card').forEach(c => {
    c.addEventListener('click', (e) => {
      if (e.target.closest('[data-edit]')) return;
      router.go(`project/${c.dataset.id}`);
    });
    const eb = c.querySelector('[data-edit]');
    if (eb) eb.addEventListener('click', (e) => { e.stopPropagation(); openProjectModal(c.dataset.id); });
  });
  root.querySelectorAll('.attention-pill[data-att]').forEach(node => {
    const i = Number(node.dataset.att);
    if (attention[i]?.action) node.addEventListener('click', attention[i].action);
  });

  // Async-load meetings
  loadUpcomingMeetings(root);
};

const renderRootCard = ({ p, tasks, done, open, overdueP, weekMinsP, stale }) => {
  const pct = tasks ? Math.round((done / tasks) * 100) : 0;
  return `
    <div class="proj-card" data-id="${p.id}" style="border-left-color:${escapeHtml(p.color)}">
      <div class="proj-card-head">
        <span class="dot" style="background:${escapeHtml(p.color)}"></span>
        <span class="name">${escapeHtml(p.name)}</span>
        ${stale ? '<span class="pill" style="background:var(--orange-soft);color:var(--orange);font-size:9.5px">stale</span>' : ''}
        <button class="btn-icon" data-edit title="Editar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%;background:${escapeHtml(p.color)}"></div></div>
      <div class="root-card-stats">
        <div><strong>${open}</strong><span>open</span></div>
        <div><strong>${done}</strong><span>done</span></div>
        ${overdueP ? `<div style="color:var(--red)"><strong>${overdueP}</strong><span>vencidas</span></div>` : ''}
        <div style="margin-left:auto"><strong>${minsToHrs(weekMinsP) || '0'}</strong><span>esta sem.</span></div>
      </div>
    </div>
  `;
};

const renderProjectBreakdownByRoot = (rootStats) => {
  const entries = rootStats.filter(s => s.weekMinsP > 0).sort((a, b) => b.weekMinsP - a.weekMinsP);
  if (!entries.length) return '';
  const max = Math.max(...entries.map(s => s.weekMinsP));
  return `
    <div class="divider"></div>
    <div class="card-title" style="margin-bottom:10px">Distribución por proyecto</div>
    <div class="proj-breakdown">
      ${entries.map(s => {
        const pct = (s.weekMinsP / max) * 100;
        return `
          <div class="breakdown-row">
            <span class="dot" style="width:8px;height:8px;border-radius:50%;background:${escapeHtml(s.p.color)}"></span>
            <span class="name">${escapeHtml(s.p.name)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${escapeHtml(s.p.color)}"></div></div>
            <span class="val">${minsToHrs(s.weekMinsP)}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
};

const computeStreak = () => {
  const log = state.pomodoroLog || [];
  if (!log.length) return 0;
  const days = new Set(log.map(p => todayKey(new Date(p.completedAt))));
  let streak = 0;
  let cursor = new Date();
  while (days.has(todayKey(cursor))) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
};

const loadUpcomingMeetings = async (root) => {
  try {
    const today = new Date();
    const from = new Date(today); from.setHours(0,0,0,0);
    const to = new Date(from); to.setDate(to.getDate() + 7);
    const res = await api.getCalendarEvents(from.toISOString(), to.toISOString());
    const events = res.connected ? (res.events || []) : [];
    const now = Date.now();
    const upcoming = events.filter(ev => new Date(ev.end).getTime() >= now).slice(0, 8);

    const kpi = root.querySelector('#kpi-meetings');
    if (kpi) kpi.textContent = events.length;

    const sub = root.querySelector('#upcoming-meetings-sub');
    const body = root.querySelector('#upcoming-meetings-body');
    if (!body) return;
    if (!res.connected) {
      sub.textContent = 'sin calendario conectado';
      body.innerHTML = `<div class="muted text-sm" style="padding:8px">Conectá Google Calendar en <strong>Ajustes</strong> para verlas acá.</div>`;
      return;
    }
    if (!upcoming.length) {
      sub.textContent = '0 próximas';
      body.innerHTML = `<div class="muted text-sm" style="padding:8px">Sin reuniones próximas. 🍵</div>`;
      return;
    }
    sub.textContent = `${upcoming.length} próximas`;
    body.innerHTML = `
      <div class="upcoming-list">
        ${upcoming.map(ev => {
          const s = new Date(ev.start);
          const e = new Date(ev.end);
          const dateStr = s.toDateString() === today.toDateString()
            ? 'Hoy'
            : s.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: 'short' });
          return `
            <div class="upcoming-row">
              <div class="up-day">${escapeHtml(dateStr)}</div>
              <div class="up-time">${ev.allDay ? 'todo el día' : pad(s.getHours()) + ':' + pad(s.getMinutes())}</div>
              <div class="up-title">📅 ${escapeHtml(ev.summary)}</div>
              <div class="up-loc">${ev.location ? escapeHtml(ev.location) : ''}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  } catch (e) {
    const body = root.querySelector('#upcoming-meetings-body');
    if (body) body.innerHTML = `<div class="muted text-sm" style="padding:8px;color:var(--red)">Error: ${escapeHtml(e.message)}</div>`;
  }
};
