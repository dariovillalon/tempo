// today.js — daily standup view: greeting, key metrics, today's plan

import { state, updateTask, findProject } from '../state.js';
import { api } from '../api.js';
import { todayKey, fmtDate, dayName, minsBetween, minsToHrs, escapeHtml, addDays, pad } from '../utils.js';
import { router } from '../router.js';
import { openTaskModal } from '../components/taskModal.js';
import { openBlockModal } from '../components/blockModal.js';
import { openReviewModal } from '../components/reviewModal.js';
import { fitnessTodaySnapshot } from './fitness.js';

// Tips de "La psicología del dinero" (Morgan Housel), uno por capítulo. Rota por día.
const MONEY_TIPS = [
  { n: 1, text: 'Nadie está loco: cada uno decide con la plata según su historia. No te juzgues (ni juzgues) tan rápido.' },
  { n: 2, text: 'Suerte y riesgo: detrás de muchos éxitos y fracasos hay azar. No copies ciegamente ni te castigues por un mal resultado.' },
  { n: 3, text: 'Nunca es suficiente: si no sabés cuándo parar, ninguna cifra alcanza. Definí tu "suficiente".' },
  { n: 4, text: 'Interés compuesto: lo que importa no es el rendimiento espectacular, sino uno bueno sostenido por mucho tiempo.' },
  { n: 5, text: 'Hacerse rico vs. seguir siéndolo: ganar es una cosa, conservar es otra (humildad + frugalidad + algo de paranoia).' },
  { n: 6, text: 'Cara o cruz: podés equivocarte la mitad de las veces e ir muy bien. Unas pocas decisiones explican casi todo.' },
  { n: 7, text: 'Libertad: el mayor dividendo del dinero es controlar tu tiempo. Esa es la verdadera riqueza.' },
  { n: 8, text: 'La paradoja del auto: nadie te admira por tus cosas tanto como creés. Comprás status que casi nadie mira.' },
  { n: 9, text: 'Riqueza es lo que NO ves: son los autos no comprados y el dinero ahorrado. Lo que mostrás es gasto, no riqueza.' },
  { n: 10, text: 'Ahorrar: tu tasa de ahorro pesa más que tu ingreso o tu rendimiento. Podés ahorrar sin una razón puntual.' },
  { n: 11, text: 'Razonable > racional: elegí una estrategia que puedas sostener y con la que duermas, aunque no sea "óptima".' },
  { n: 12, text: 'Sorpresa: lo más importante suele ser lo que nadie vio venir. Esperá lo inesperado.' },
  { n: 13, text: 'Margen de error: dejá colchón. El margen de seguridad te deja aguantar para que el largo plazo juegue a favor.' },
  { n: 14, text: 'Vas a cambiar: tus metas de hoy no son las de mañana. Evitá los extremos y aceptá que vas a cambiar de idea.' },
  { n: 15, text: 'Nada es gratis: la volatilidad es el precio de los buenos rendimientos. Pagalo como entrada, no como multa.' },
  { n: 16, text: 'Cuidado con las señales: no copies a quien juega otro juego (otro horizonte y objetivos) distinto al tuyo.' },
  { n: 17, text: 'El pesimismo seduce: suena más inteligente, pero el optimismo paciente suele pagar mejor.' },
  { n: 18, text: 'Creés lo que te conviene: ojo con las historias que te contás sobre el dinero.' },
  { n: 19, text: 'Sé humilde en el éxito y compasivo en el fracaso. Jugá tu propio juego.' },
  { n: 20, text: 'Simplificá: ahorrá mucho, invertí en algo amplio y barato, y dejá pasar el tiempo.' },
];
const dayOfYear = () => { const d = new Date(); return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000); };
const dailyMoneyTip = () => MONEY_TIPS[dayOfYear() % MONEY_TIPS.length];
const ACTIVE_BREAKS = [
  'Parate, estirá cuello y hombros 1–2 min.',
  'Caminá 2 min y aprovechá para tomar agua.',
  'Regla 20-20-20: mirá algo lejano 20 seg y respirá hondo.',
  'Movilidad: 5 sentadillas + rotaciones de cadera y muñecas.',
  'Levantate, soltá la espalda y relajá la mandíbula.',
];
const activeBreakTip = () => ACTIVE_BREAKS[new Date().getHours() % ACTIVE_BREAKS.length];

// Tablero "Lo que sigue": próxima comida, próximo evento, estado nutrición/agua, pausa activa, recomendación y tip del día.
const buildNextUp = (tk) => {
  const snap = fitnessTodaySnapshot();
  const now = new Date(); const nowHHMM = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const nextEv = state.blocks.filter(b => b.date === tk && b.start && b.start >= nowHHMM).sort((a, b) => a.start < b.start ? -1 : 1)[0];
  const rows = [];
  if (snap.hasProfile && snap.nextMeal) {
    const hh = String(snap.nextMeal.hour).padStart(2, '0');
    rows.push(`<div class="nx-row"><span class="nx-ico">🍽️</span><div><b>Próxima comida:</b> ${escapeHtml(snap.nextMeal.label)} · ~${hh}:00 <span class="muted">(~${snap.nextMeal.kcal} kcal, ${snap.nextMeal.prot} g prot)</span></div></div>`);
  }
  if (nextEv) rows.push(`<div class="nx-row"><span class="nx-ico">${nextEv.kind === 'meeting' ? '📅' : '💼'}</span><div><b>Próximo en agenda:</b> ${escapeHtml(nextEv.start)} · ${escapeHtml(nextEv.title || '(sin título)')}</div></div>`);
  let chips = '';
  if (snap.hasProfile) {
    const chip = (lbl, val, goal, unit, ok) => `<span class="nx-chip ${ok ? 'ok' : ''}">${lbl} ${val}/${goal}${unit}</span>`;
    chips = `<div class="nx-chips">
      ${chip('🔥', snap.calories, snap.calTarget, '', snap.calories >= snap.calTarget)}
      ${chip('🥩', snap.protein, snap.protTarget, 'g', snap.protein >= snap.protTarget * 0.95)}
      ${chip('💧', (snap.water / 1000).toFixed(1), (snap.waterGoal / 1000).toFixed(1), 'L', snap.water >= snap.waterGoal)}
    </div>`;
  }
  const alertsHtml = (snap.alerts || []).map(a => `<div class="fit-alert ${a.level}">${escapeHtml(a.text)}</div>`).join('');
  const rec = snap.recommendation ? `<div class="nx-row"><span class="nx-ico">💡</span><div><b>Recomendación:</b> ${escapeHtml(snap.recommendation.text)}</div></div>` : '';
  const breakRow = `<div class="nx-row"><span class="nx-ico">🤸</span><div><b>Pausa activa:</b> ${escapeHtml(activeBreakTip())}</div></div>`;
  const prompt = !snap.hasProfile ? '<div class="muted text-xs">Completá tu perfil en Fitness para ver comida, proteína y agua acá.</div>' : '';
  const tip = dailyMoneyTip();
  const inner = rows.join('') + chips + alertsHtml + breakRow + rec + prompt;
  return `<div class="card nextup-card"><div class="card-title">Lo que sigue</div>${inner || '<div class="muted text-xs">Nada pendiente ahora mismo. 👌</div>'}</div>
    <div class="card moneytip-card"><div class="nx-row"><span class="nx-ico">💰</span><div><b>Psicología del dinero · cap. ${tip.n}:</b> ${escapeHtml(tip.text)}</div></div></div>`;
};

// Cache today's calendar events briefly so URL changes / vault edits are seen quickly.
let calendarCache = { day: null, events: [], fetchedAt: 0 };
const TODAY_MEETINGS_TTL_MS = 60 * 1000;
const loadTodayMeetings = async (root) => {
  const key = todayKey();
  if (calendarCache.day === key && (Date.now() - calendarCache.fetchedAt) < TODAY_MEETINGS_TTL_MS) return;
  try {
    const start = new Date(); start.setHours(0,0,0,0);
    const end = new Date(start); end.setHours(23,59,59,999);
    const res = await api.getCalendarEvents(start.toISOString(), end.toISOString());
    calendarCache = {
      day: key,
      events: res.connected ? (res.events || []) : [],
      connected: !!res.connected,
      fetchedAt: Date.now(),
    };
    const agenda = root.querySelector('#today-agenda');
    if (agenda) agenda.innerHTML = renderAgendaInner();
    wireAgenda(root);
  } catch (e) {
    calendarCache = { day: key, events: [], connected: false, fetchedAt: Date.now() };
  }
};

const greeting = () => {
  const h = new Date().getHours();
  if (h < 6)  return 'Madrugada';
  if (h < 12) return 'Buen día';
  if (h < 19) return 'Buenas tardes';
  return 'Buenas noches';
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

export const renderToday = (root) => {
  const tk = todayKey();
  const today = new Date();

  // --- metrics
  const blocksToday = state.blocks.filter(b => b.date === tk);
  const trackedToday = blocksToday.reduce((sum, b) => sum + minsBetween(b.start, b.end), 0);

  const pomosToday = state.pomodoroLog.filter(p =>
    todayKey(new Date(p.completedAt)) === tk && p.type !== 'break').length;

  const tasksDoing = state.tasks.filter(t => t.state === 'doing').length;
  const overdueTasks = state.tasks.filter(t =>
    t.state !== 'done' && t.due && t.due < tk).length;

  const streak = computeStreak();

  const dueToday = state.tasks.filter(t =>
    (t.due === tk || t.state === 'doing') && t.state !== 'done')
    .sort((a, b) => {
      const pri = { high: 0, med: 1, low: 2 };
      return (pri[a.priority] || 1) - (pri[b.priority] || 1);
    });

  // Follow-ups due today (or overdue follow-ups)
  const followUpsToday = state.tasks
    .filter(t => t.state !== 'done' && t.followUpAt && t.followUpAt <= tk)
    .sort((a, b) => (a.followUpAt || '').localeCompare(b.followUpAt || ''));

  // Overdue tasks not in doing (those already show in dueToday)
  const overdueList = state.tasks
    .filter(t => t.state !== 'done' && t.due && t.due < tk && t.state !== 'doing')
    .sort((a, b) => a.due.localeCompare(b.due));

  const projectsAtRisk = state.projects.filter(p =>
    p.status === 'active' && (p.health === 'at-risk' || p.health === 'blocked'));

  // --- render
  root.innerHTML = `
    <div class="today-grid">
      <div>
        <div class="row" style="justify-content:space-between;align-items:flex-start;margin-bottom:6px;flex-wrap:wrap">
          <h1 class="today-greeting" style="margin:0">${greeting()}, <span class="accent">${escapeHtml(state.settings?.userName || 'Dario')}</span>.</h1>
          <button class="btn btn-secondary btn-sm" id="close-day-btn" title="Cerrar el día — escribe entry en DailyNotes/">📝 Cerrar día</button>
        </div>
        <div class="today-date">${fmtDate(today, { weekday: true, year: true })}</div>

        ${buildNextUp(tk)}

        <div class="today-stats">
          <div class="stat-card">
            <div class="stat-label">Trackeado hoy</div>
            <div class="stat-value">${minsToHrs(trackedToday) || '0m'}</div>
            <div class="stat-trend">${blocksToday.length} bloque${blocksToday.length === 1 ? '' : 's'}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Pomodoros</div>
            <div class="stat-value">${pomosToday} <span class="unit">🍅</span></div>
            <div class="stat-trend">enfoque hoy</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">En curso</div>
            <div class="stat-value">${tasksDoing}</div>
            <div class="stat-trend">tarea${tasksDoing === 1 ? '' : 's'} activa${tasksDoing === 1 ? '' : 's'}</div>
          </div>
          <div class="stat-card streak-card">
            <div class="stat-label">Racha</div>
            <div class="stat-value streak-num">${streak}</div>
            <div class="stat-trend">día${streak === 1 ? '' : 's'} con foco</div>
          </div>
        </div>

        <div class="card" id="today-agenda-card">
          <div class="card-header">
            <div class="card-title">Agenda de hoy</div>
            <div class="row gap-6">
              <button class="btn btn-sm btn-ghost" id="add-block-today">+ Bloque</button>
              <button class="btn btn-sm btn-ghost" id="add-task-today">+ Tarea</button>
            </div>
          </div>
          <div id="today-agenda">${renderAgendaInner()}</div>
        </div>

        <div class="card" style="margin-top:14px">
          <div class="card-header">
            <div class="card-title">Tareas de hoy</div>
            <div class="card-sub">${dueToday.length}</div>
          </div>
          ${dueToday.length === 0
            ? `<div class="empty" style="padding:18px"><div class="empty-title">Día limpio</div>No hay tareas marcadas para hoy.</div>`
            : `<div class="today-list">${dueToday.map(renderTaskRow).join('')}</div>`}
        </div>

        ${followUpsToday.length > 0 ? `
          <div class="card" style="margin-top:14px;border-left:3px solid var(--violet)">
            <div class="card-header">
              <div class="card-title">Seguimientos de hoy</div>
              <div class="card-sub">${followUpsToday.length}</div>
            </div>
            <div class="today-list">${followUpsToday.map(renderTaskRow).join('')}</div>
          </div>
        ` : ''}

        ${overdueList.length > 0 ? `
          <div class="card" style="margin-top:14px;border-left:3px solid var(--red)">
            <div class="card-header">
              <div class="card-title">Atrasadas</div>
              <div class="card-sub">${overdueList.length}</div>
            </div>
            <div class="today-list">${overdueList.slice(0, 8).map(renderTaskRow).join('')}</div>
          </div>
        ` : ''}
      </div>

      <aside class="col gap-14">
        ${overdueTasks > 0 ? `
          <div class="card" style="border-color:var(--red);background:var(--red-soft)">
            <div class="card-title" style="color:var(--red)">⚠️ ${overdueTasks} tarea${overdueTasks === 1 ? '' : 's'} vencida${overdueTasks === 1 ? '' : 's'}</div>
            <div class="card-sub" style="margin-top:6px">Revisá el board para reorganizar.</div>
            <button class="btn btn-sm btn-ghost" id="goto-board" style="margin-top:8px">Ir al Board →</button>
          </div>
        ` : ''}

        ${projectsAtRisk.length > 0 ? `
          <div class="card">
            <div class="card-header">
              <div class="card-title">Proyectos a atender</div>
            </div>
            <div class="col gap-6">
              ${projectsAtRisk.map(p => `
                <div class="project-pill" data-pid="${p.id}" style="cursor:pointer">
                  <span class="dot" style="background:${escapeHtml(p.color)}"></span>
                  <span class="name">${escapeHtml(p.name)}</span>
                  <span class="health ${escapeHtml(p.health)}"></span>
                </div>`).join('')}
            </div>
          </div>
        ` : ''}

        <div class="card">
          <div class="card-header">
            <div class="card-title">Esta semana</div>
          </div>
          ${renderWeekChart()}
        </div>

        <div class="card">
          <div class="card-header">
            <div class="card-title">Atajos</div>
          </div>
          <div class="col gap-6" style="font-size:12.5px;color:var(--text-2)">
            <div><kbd style="font-family:var(--font-mono);background:var(--surface-3);padding:2px 6px;border-radius:4px">⌘K</kbd> · búsqueda</div>
            <div><kbd style="font-family:var(--font-mono);background:var(--surface-3);padding:2px 6px;border-radius:4px">g</kbd> + <kbd style="font-family:var(--font-mono);background:var(--surface-3);padding:2px 6px;border-radius:4px">t/d/c/b/p/n</kbd> · navegar</div>
            <div><kbd style="font-family:var(--font-mono);background:var(--surface-3);padding:2px 6px;border-radius:4px">n</kbd> · nueva tarea · <kbd style="font-family:var(--font-mono);background:var(--surface-3);padding:2px 6px;border-radius:4px">?</kbd> · ayuda</div>
          </div>
        </div>
      </aside>
    </div>
  `;

  root.querySelectorAll('.today-task[data-task]').forEach(node => {
    const id = node.dataset.task;
    node.querySelector('.check').addEventListener('click', (e) => {
      e.stopPropagation();
      const t = state.tasks.find(x => x.id === id);
      updateTask(id, { state: t.state === 'done' ? 'todo' : 'done' });
      router.refresh();
    });
    node.addEventListener('click', () => openTaskModal({ id }));
  });

  wireAgenda(root);

  // Refresh meetings async; reuse cache if same day
  loadTodayMeetings(root);

  root.querySelectorAll('.project-pill[data-pid]').forEach(node => {
    node.addEventListener('click', () => router.go(`project/${node.dataset.pid}`));
  });

  const goB = root.querySelector('#goto-board'); if (goB) goB.addEventListener('click', () => router.go('board'));
  root.querySelector('#add-block-today').addEventListener('click', () => openBlockModal({ date: tk }));
  root.querySelector('#add-task-today').addEventListener('click', () => openTaskModal({ state: 'doing' }));
  const closeDay = root.querySelector('#close-day-btn');
  if (closeDay) closeDay.addEventListener('click', () => openReviewModal('day'));
};

const fmtHHMM = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

// Build the unified agenda (calendar meetings + Tempo blocks) sorted by start time.
const renderAgendaInner = () => {
  const tk = todayKey();
  const blocks = state.blocks.filter(b => b.date === tk).map(b => {
    const p = findProject(b.projectId);
    return {
      kind: 'block',
      id: b.id,
      title: b.title || '(sin título)',
      start: b.start, end: b.end,
      sortKey: b.start,
      project: p,
      mins: minsBetween(b.start, b.end),
    };
  });

  const events = (calendarCache.events || []).map(ev => {
    const s = new Date(ev.start);
    const e = new Date(ev.end);
    const allDay = !!ev.allDay;
    return {
      kind: 'meeting',
      id: ev.uid,
      title: ev.summary,
      location: ev.location,
      description: ev.description,
      start: allDay ? '00:00' : fmtHHMM(s),
      end: allDay ? '23:59' : fmtHHMM(e),
      sortKey: allDay ? '00:00' : fmtHHMM(s),
      allDay,
      mins: Math.max(0, Math.round((e - s) / 60000)),
    };
  });

  const items = [...events, ...blocks].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  if (!items.length) {
    const calMsg = calendarCache.connected
      ? 'Sin reuniones ni bloques. Creá uno con + Bloque o conectá tu calendario en Ajustes.'
      : 'Sin bloques planificados. Conectá Google Calendar (Ajustes) para ver tus reuniones acá.';
    return `<div class="empty" style="padding:18px"><div class="empty-title">Día limpio</div>${calMsg}</div>`;
  }

  // Find the next upcoming item (for highlight)
  const now = new Date();
  const nowHHMM = fmtHHMM(now);
  const nextIdx = items.findIndex(it => it.sortKey >= nowHHMM);

  return `
    <div class="agenda-list">
      ${items.map((it, i) => {
        const isNext = i === nextIdx;
        const past = it.end < nowHHMM && it.end !== '23:59';
        const color = it.kind === 'meeting' ? 'var(--blue)' : (it.project?.color || 'var(--accent)');
        return `
          <div class="agenda-row ${isNext ? 'is-next' : ''} ${past ? 'is-past' : ''} ${it.kind}" data-${it.kind}="${escapeHtml(it.id || '')}">
            <div class="agenda-time">
              <div class="t-start">${escapeHtml(it.start)}</div>
              <div class="t-end">${escapeHtml(it.end)}</div>
            </div>
            <div class="agenda-bar" style="background:${color}"></div>
            <div class="agenda-body">
              <div class="agenda-title">
                ${it.kind === 'meeting' ? '<span class="agenda-tag">📅</span>' : ''}
                ${escapeHtml(it.title)}
              </div>
              <div class="agenda-meta">
                ${it.kind === 'meeting'
                  ? `${it.allDay ? 'todo el día' : minsToHrs(it.mins)}${it.location ? ' · 📍 ' + escapeHtml(it.location) : ''}`
                  : `${minsToHrs(it.mins)}${it.project ? ' · <span class="dot" style="background:'+escapeHtml(it.project.color)+'"></span> ' + escapeHtml(it.project.name) : ''}`}
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
};

const wireAgenda = (root) => {
  root.querySelectorAll('.agenda-row[data-block]').forEach(node => {
    node.addEventListener('click', () => openBlockModal({ id: node.dataset.block }));
  });
  // Meetings open block creation pre-filled with the meeting's time/title for time tracking
  root.querySelectorAll('.agenda-row[data-meeting]').forEach(node => {
    node.addEventListener('click', () => {
      const title = node.querySelector('.agenda-title')?.textContent.trim().replace(/^📅\s*/, '');
      const start = node.querySelector('.t-start')?.textContent;
      const end = node.querySelector('.t-end')?.textContent;
      openBlockModal({ date: todayKey(), start, end, title });
    });
  });
};

const renderTaskRow = (t) => {
  const p = findProject(t.projectId);
  const isDone = t.state === 'done';
  const isOverdue = t.due && t.due < todayKey() && !isDone;
  return `
    <div class="today-task ${isDone ? 'done' : ''}" data-task="${t.id}">
      <div class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
      <div class="text">${escapeHtml(t.text)}</div>
      <div class="meta">
        ${t.priority === 'high' ? '<span class="pill" style="background:var(--red-soft);color:var(--red)">alta</span>' : ''}
        ${p ? `<span class="pill"><span class="dot" style="background:${escapeHtml(p.color)}"></span>${escapeHtml(p.name)}</span>` : ''}
        ${isOverdue ? `<span class="pill" style="background:var(--red-soft);color:var(--red)">vencida</span>` : ''}
        ${t.pomodoros ? `<span class="pill" style="font-family:var(--font-mono)">${t.pomodorosDone || 0}/${t.pomodoros}🍅</span>` : ''}
      </div>
    </div>
  `;
};

const renderWeekChart = () => {
  const today = new Date();
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(addDays(today, -i));

  const max = Math.max(1, ...days.map(d => {
    const k = todayKey(d);
    return state.blocks.filter(b => b.date === k).reduce((s, b) => s + minsBetween(b.start, b.end), 0);
  }));

  const bars = days.map(d => {
    const k = todayKey(d);
    const mins = state.blocks.filter(b => b.date === k).reduce((s, b) => s + minsBetween(b.start, b.end), 0);
    const h = Math.max(2, (mins / max) * 110);
    const isToday = k === todayKey();
    return `
      <div class="bar-wrap" title="${minsToHrs(mins) || '0'}">
        <div class="bar ${mins > 0 ? 'has-time' : ''}" style="height:${h}px;background:${isToday ? 'var(--accent)' : ''}"></div>
        <div class="label" style="${isToday ? 'color:var(--accent);font-weight:600' : ''}">${dayName(d, true).slice(0, 1).toUpperCase()}</div>
      </div>
    `;
  }).join('');

  const total = days.reduce((s, d) => {
    const k = todayKey(d);
    return s + state.blocks.filter(b => b.date === k).reduce((ss, b) => ss + minsBetween(b.start, b.end), 0);
  }, 0);

  return `
    <div class="time-chart">${bars}</div>
    <div style="font-size:11px;color:var(--text-3);text-align:center;margin-top:6px">
      Total: <strong style="color:var(--text)">${minsToHrs(total) || '0'}</strong>
    </div>
  `;
};
