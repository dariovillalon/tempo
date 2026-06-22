// pomodoro.js — focus timer

import {
  state, logPomodoro, updatePomodoroSettings,
  findProject, addTaskComment, deleteTaskComment,
} from '../state.js';
import { todayKey, addDays, dayName } from '../utils.js';
import { escapeHtml } from '../utils.js';
import { toast } from '../components/toast.js';

let timer = {
  running: false,
  mode: 'focus',     // 'focus' | 'short' | 'long'
  remainingMs: 25 * 60 * 1000,
  totalMs: 25 * 60 * 1000,
  taskId: null,
  label: null,       // etiqueta libre (ej: un bloque de trabajo sin tarea)
  projectId: null,
  startedAt: null,
  intervalId: null,
  cycleCount: 0,
};

const formatTime = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

const updateMiniDisplay = () => {
  const time = document.getElementById('pom-mini-time');
  const label = document.getElementById('pom-mini-label');
  const prog = document.getElementById('pom-mini-progress');
  const wrap = document.getElementById('pom-mini');
  if (!time) return;
  time.textContent = formatTime(timer.remainingMs);
  label.textContent = timer.mode === 'focus' ? 'Foco' : (timer.mode === 'long' ? 'Largo' : 'Break');
  const C = 2 * Math.PI * 10; // circumference for r=10
  const ratio = timer.totalMs ? (1 - timer.remainingMs / timer.totalMs) : 0;
  if (prog) {
    prog.setAttribute('stroke-dasharray', String(C));
    prog.setAttribute('stroke-dashoffset', String(C * (1 - ratio)));
  }
  if (wrap) wrap.classList.toggle('running', timer.running);
};

const setMode = (mode) => {
  const s = state.pomodoroSettings || { focus: 25, shortBreak: 5, longBreak: 15, longEvery: 4 };
  let mins = s.focus;
  if (mode === 'short') mins = s.shortBreak;
  if (mode === 'long') mins = s.longBreak;
  timer.mode = mode;
  timer.totalMs = mins * 60 * 1000;
  timer.remainingMs = timer.totalMs;
};

const tick = () => {
  if (!timer.running) return;
  const now = Date.now();
  const elapsed = now - timer._lastTick;
  timer._lastTick = now;
  timer.remainingMs -= elapsed;

  if (timer.remainingMs <= 0) {
    finish();
  } else {
    rerender();
  }
};

const start = () => {
  timer.running = true;
  timer.startedAt = Date.now();
  timer._lastTick = Date.now();
  timer.intervalId = setInterval(tick, 250);
};

const pause = () => {
  timer.running = false;
  if (timer.intervalId) { clearInterval(timer.intervalId); timer.intervalId = null; }
};

const reset = () => {
  pause();
  setMode(timer.mode);
};

const finish = () => {
  pause();
  // Log if it was a focus session
  if (timer.mode === 'focus') {
    logPomodoro({
      duration: state.pomodoroSettings?.focus || 25,
      taskId: timer.taskId,
      projectId: timer.projectId,
      type: 'focus',
    });
    timer.cycleCount++;
    // Decide next break
    const longEvery = state.pomodoroSettings?.longEvery || 4;
    setMode(timer.cycleCount % longEvery === 0 ? 'long' : 'short');
  } else {
    setMode('focus');
  }
  // Notify
  notify();
  rerender();
};

const notify = () => {
  try {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification('Tempo', { body: timer.mode === 'focus' ? '¡Foco completado! Tomá un break.' : 'Break terminado, volvé al foco.' });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission();
      }
    }
  } catch {}
  // Alarma: secuencia de beeps para que se escuche bien
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const baseFreq = timer.mode === 'focus' ? 880 : 523; // foco terminó = más agudo
    const beeps = 4;
    const beepDur = 0.25;
    const gap = 0.12;
    for (let i = 0; i < beeps; i++) {
      const t0 = ctx.currentTime + i * (beepDur + gap);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = baseFreq;
      osc.connect(gain); gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
      gain.gain.setValueAtTime(0.35, t0 + beepDur - 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + beepDur);
      osc.start(t0);
      osc.stop(t0 + beepDur + 0.02);
    }
  } catch {}
};

let lastRoot = null;

const rerender = () => {
  if (lastRoot && lastRoot.isConnected && lastRoot.querySelector('.pom-time')) {
    paint(lastRoot, /*partial*/ true);
  }
  updateMiniDisplay();
};

const fmtCommentTime = (ts) => {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  const stampDay = new Date(d); stampDay.setHours(0, 0, 0, 0);
  let datePart;
  if (stampDay.getTime() === today.getTime()) datePart = 'Hoy';
  else if (stampDay.getTime() === yest.getTime()) datePart = 'Ayer';
  else datePart = d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
  const timePart = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${datePart} · ${timePart}`;
};

// Refresh just the comment list (and count), without touching the textarea —
// so adding a comment doesn't blow away whatever the user is typing next.
const refreshCommentList = (root) => {
  const list = root.querySelector('#pom-comments-list');
  const count = root.querySelector('#pom-comments-count');
  if (!list) return;
  const t = timer.taskId ? state.tasks.find(x => x.id === timer.taskId) : null;
  const comments = t ? (t.comments || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)) : [];
  if (count) count.textContent = comments.length ? `· ${comments.length}` : '';
  if (!comments.length) {
    list.innerHTML = `<div class="muted text-sm" style="padding:4px 0">Sin comentarios todavía.</div>`;
    return;
  }
  // Show only the latest 5 inline — the full list lives in the task modal.
  list.innerHTML = comments.slice(0, 5).map(c => `
    <div class="pom-comment" data-cid="${escapeHtml(c.id)}">
      <div class="pom-comment-h">
        <span class="pom-comment-time">${escapeHtml(fmtCommentTime(c.ts))}</span>
        <button class="pom-comment-x" data-rm="${escapeHtml(c.id)}" title="Borrar comentario">×</button>
      </div>
      <div class="pom-comment-text">${escapeHtml(c.text || '')}</div>
    </div>
  `).join('');
  list.querySelectorAll('[data-rm]').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const cid = btn.dataset.rm;
    if (!timer.taskId) return;
    if (!confirm('¿Borrar comentario?')) return;
    deleteTaskComment(timer.taskId, cid);
    refreshCommentList(root);
  }));
};

export const renderPomodoro = (root) => {
  lastRoot = root;
  paint(root, false);

  // Cleanup on view exit
  window._viewCleanup = () => { lastRoot = null; };
};

const paint = (root, partial) => {
  if (partial) {
    const time = root.querySelector('.pom-time');
    const mode = root.querySelector('.pom-mode');
    const prog = root.querySelector('.pom-circle .progress');
    const startBtn = root.querySelector('#pom-start');
    if (time) time.textContent = formatTime(timer.remainingMs);
    if (mode) mode.textContent = timer.mode === 'focus' ? 'Foco' : (timer.mode === 'long' ? 'Break largo' : 'Break corto');
    if (prog) {
      const r = 130;
      const C = 2 * Math.PI * r;
      const ratio = timer.totalMs ? (1 - timer.remainingMs / timer.totalMs) : 0;
      prog.setAttribute('stroke-dasharray', String(C));
      prog.setAttribute('stroke-dashoffset', String(C * (1 - ratio)));
    }
    const circleEl = root.querySelector('.pom-circle');
    if (circleEl) circleEl.classList.toggle('break', timer.mode !== 'focus');
    if (startBtn) startBtn.textContent = timer.running ? 'Pausar' : 'Iniciar';
    return;
  }

  const r = 130;
  const C = 2 * Math.PI * r;
  const ratio = timer.totalMs ? (1 - timer.remainingMs / timer.totalMs) : 0;
  const dashoffset = C * (1 - ratio);

  // History (last 7 days)
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(addDays(new Date(), -i));
  const historyByDay = days.map(d => {
    const k = todayKey(d);
    const pomos = state.pomodoroLog.filter(p => todayKey(new Date(p.completedAt)) === k && p.type !== 'break');
    return { date: d, key: k, count: pomos.length };
  });

  const tasks = state.tasks.filter(t => t.state !== 'done' && t.state !== 'archived');

  root.innerHTML = `
    <div class="pom-wrap">
      <div class="pom-presets">
        <button class="pom-preset ${timer.mode === 'focus' ? 'active' : ''}" data-mode="focus">Foco · ${state.pomodoroSettings?.focus || 25}m</button>
        <button class="pom-preset ${timer.mode === 'short' ? 'active' : ''}" data-mode="short">Break · ${state.pomodoroSettings?.shortBreak || 5}m</button>
        <button class="pom-preset ${timer.mode === 'long' ? 'active' : ''}" data-mode="long">Largo · ${state.pomodoroSettings?.longBreak || 15}m</button>
      </div>

      <div style="margin-top:30px"></div>

      <div class="pom-circle-wrap">
        <svg class="pom-circle ${timer.mode !== 'focus' ? 'break' : ''}" viewBox="0 0 280 280">
          <circle class="track" cx="140" cy="140" r="${r}"/>
          <circle class="progress" cx="140" cy="140" r="${r}" stroke-dasharray="${C}" stroke-dashoffset="${dashoffset}"/>
        </svg>
        <div class="pom-time-display">
          <div class="pom-time">${formatTime(timer.remainingMs)}</div>
          <div class="pom-mode">${timer.mode === 'focus' ? 'Foco' : (timer.mode === 'long' ? 'Break largo' : 'Break corto')}</div>
        </div>
      </div>

      <div class="pom-controls">
        <button class="btn btn-primary pom-btn-big" id="pom-start">${timer.running ? 'Pausar' : 'Iniciar'}</button>
        <button class="btn btn-secondary pom-btn-big" id="pom-reset">Reiniciar</button>
        <button class="btn btn-ghost pom-btn-big" id="pom-skip">Saltar</button>
      </div>

      ${(timer.label && !timer.taskId) ? `<div class="pom-block-label">💼 Trabajando en: <b>${escapeHtml(timer.label)}</b></div>` : ''}

      <div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap;justify-content:center">
        <label style="font-size:11px;color:var(--text-3);text-transform:uppercase">Tarea actual</label>
        <select class="select" id="pom-task" style="min-width:280px">
          <option value="">— ninguna —</option>
          ${tasks.map(t => {
            const p = findProject(t.projectId);
            const lab = (p ? `[${p.name}] ` : '') + (t.text || '').slice(0, 60);
            return `<option value="${t.id}" ${timer.taskId === t.id ? 'selected' : ''}>${escapeHtml(lab)}</option>`;
          }).join('')}
        </select>
        <button class="btn btn-secondary btn-sm" id="pom-focus-mode" title="Pantalla completa con timer, oculta todo lo demás" ${timer.taskId ? '' : 'disabled style="opacity:.5"'}>🎯 Focus mode</button>
      </div>

      <div class="pom-comments-block" id="pom-comments-block" style="${timer.taskId ? '' : 'display:none'}">
        <div class="pom-comments-head">
          <span class="pom-comments-label">Comentarios <span class="muted" id="pom-comments-count"></span></span>
        </div>
        <div class="pom-comment-input">
          <textarea id="pom-comment-new" class="textarea" rows="2" placeholder="Anotá algo sobre lo que estás haciendo… (⌘/Ctrl+Enter para guardar)"></textarea>
          <button class="btn btn-primary btn-sm" id="pom-comment-add">Agregar</button>
        </div>
        <div class="pom-comments-list" id="pom-comments-list"></div>
      </div>

      <div class="pom-history">
        <div class="card-title" style="margin-bottom:10px">Últimos 7 días</div>
        ${historyByDay.map(h => `
          <div class="pom-day-row">
            <div style="width:60px;font-size:12px;color:var(--text-3)">${dayName(h.date, true)}</div>
            <div class="pom-tomatoes">
              ${Array(h.count).fill('<div class="pom-tomato" title="🍅"></div>').join('') || '<span style="color:var(--text-4);font-size:11.5px">·</span>'}
            </div>
            <div class="mono text-sm muted">${h.count}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  root.querySelectorAll('.pom-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      pause();
      setMode(btn.dataset.mode);
      paint(root, false);
    });
  });
  root.querySelector('#pom-start').addEventListener('click', () => {
    if (timer.running) pause(); else start();
    paint(root, true);
  });
  root.querySelector('#pom-reset').addEventListener('click', () => {
    reset(); paint(root, false);
  });
  root.querySelector('#pom-skip').addEventListener('click', () => {
    finish();
  });
  root.querySelector('#pom-task').addEventListener('change', (e) => {
    timer.taskId = e.target.value || null;
    const t = timer.taskId ? state.tasks.find(x => x.id === timer.taskId) : null;
    timer.projectId = t?.projectId || null;
    paint(root, false);
  });
  const fmBtn = root.querySelector('#pom-focus-mode');
  if (fmBtn) fmBtn.addEventListener('click', async () => {
    if (!timer.taskId) return;
    // Lazy import to avoid circular dep with focusMode → pomodoro
    const { enterFocusMode } = await import('../components/focusMode.js');
    enterFocusMode(timer.taskId);
  });

  // Comments wiring (only meaningful when a task is selected, but we wire it
  // unconditionally — the block hides itself if there is no task).
  const submitComment = () => {
    if (!timer.taskId) { toast('Elegí una tarea primero', 'error'); return; }
    const ta = root.querySelector('#pom-comment-new');
    const text = ta?.value || '';
    if (!text.trim()) return;
    addTaskComment(timer.taskId, text);
    if (ta) ta.value = '';
    refreshCommentList(root);
    toast('Comentario agregado', 'success');
  };
  const addBtn = root.querySelector('#pom-comment-add');
  if (addBtn) addBtn.addEventListener('click', submitComment);
  const newTa = root.querySelector('#pom-comment-new');
  if (newTa) newTa.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submitComment();
    }
  });
  // First paint of the recent comments list
  refreshCommentList(root);
};

// Topbar mini-control: clicking it goes to pomodoro view (handled in app.js)
// Also keep mini display ticking even when not in view
export const startGlobalTicker = () => {
  setInterval(updateMiniDisplay, 1000);
};

// Public helper: kick off a focus pomodoro tied to a specific task. Switches the
// timer to focus mode, attributes time to the task + its project, and starts it.
// If a session is already running, it just re-targets to this task without
// resetting the time, so you don't lose progress.
export const startPomodoroForTask = (taskId) => {
  const task = taskId ? state.tasks.find(t => t.id === taskId) : null;
  if (!task) return;
  timer.taskId = task.id;
  timer.projectId = task.projectId || null;
  timer.label = null;
  if (!timer.running) {
    if (timer.mode !== 'focus') setMode('focus');
    if (timer.remainingMs <= 0) setMode('focus');
    start();
  }
  rerender();
};

// Lanza un pomodoro de foco para un bloque de trabajo (sin tarea), con una etiqueta libre.
export const startPomodoroForBlock = (label, projectId) => {
  timer.taskId = null;
  timer.projectId = projectId || null;
  timer.label = label || 'Bloque de trabajo';
  if (!timer.running) {
    if (timer.mode !== 'focus') setMode('focus');
    if (timer.remainingMs <= 0) setMode('focus');
    start();
  }
  rerender();
};

// Read-only getters/controls used by Focus Mode (distraction-free overlay).
export const getTimerState = () => ({
  running: timer.running,
  mode: timer.mode,
  remainingMs: timer.remainingMs,
  totalMs: timer.totalMs,
  taskId: timer.taskId,
  projectId: timer.projectId,
});
export const toggleTimer = () => { if (timer.running) pause(); else start(); rerender(); };
export const skipTimer  = () => { finish(); };
