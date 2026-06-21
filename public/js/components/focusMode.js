// focusMode.js — distraction-free overlay tied to a task + the pomodoro timer.
// Reads timer state from the pomodoro module (no second timer instance).

import { state, findProject, updateTask, addTaskComment, deleteTaskComment } from '../state.js';
import { startPomodoroForTask, getTimerState, toggleTimer, skipTimer } from '../views/pomodoro.js';
import { escapeHtml } from '../utils.js';
import { toast } from './toast.js';

let overlay, projectEl, taskEl, timeEl, modeEl, toggleBtn, skipBtn, doneBtn, exitBtn;
let commentNewEl, commentAddBtn, commentListEl;
let activeTaskId = null;
let tickHandle = null;

const fmtCommentTime = (ts) => {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const stampDay = new Date(d); stampDay.setHours(0, 0, 0, 0);
  const datePart = stampDay.getTime() === today.getTime()
    ? 'Hoy'
    : d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
  const timePart = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${datePart} · ${timePart}`;
};

const renderComments = () => {
  if (!commentListEl) return;
  const t = activeTaskId ? state.tasks.find(x => x.id === activeTaskId) : null;
  const comments = t ? (t.comments || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)) : [];
  if (!comments.length) {
    commentListEl.innerHTML = `<div class="focus-comments-empty">Sin comentarios todavía.</div>`;
    return;
  }
  // Show the latest 3 to keep the focus screen calm.
  commentListEl.innerHTML = comments.slice(0, 3).map(c => `
    <div class="focus-comment" data-cid="${escapeHtml(c.id)}">
      <span class="focus-comment-time">${escapeHtml(fmtCommentTime(c.ts))}</span>
      <span class="focus-comment-text">${escapeHtml(c.text || '')}</span>
      <button class="focus-comment-x" data-rm="${escapeHtml(c.id)}" title="Borrar comentario">×</button>
    </div>
  `).join('');
  commentListEl.querySelectorAll('[data-rm]').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!activeTaskId) return;
    if (!confirm('¿Borrar comentario?')) return;
    deleteTaskComment(activeTaskId, btn.dataset.rm);
    renderComments();
  }));
};

const fmt = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
};

const render = () => {
  if (!overlay?.classList.contains('open')) return;
  const t = getTimerState();
  timeEl.textContent = fmt(t.remainingMs);
  modeEl.textContent = t.mode === 'focus' ? 'Foco' : (t.mode === 'long' ? 'Break largo' : 'Break corto');
  toggleBtn.textContent = t.running ? 'Pausar' : 'Iniciar';
  overlay.classList.toggle('break', t.mode !== 'focus');
};

export const enterFocusMode = (taskId) => {
  if (!overlay) return;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) { toast('Tarea no encontrada', 'error'); return; }
  activeTaskId = taskId;

  // Bump to "doing" so the rest of the app reflects what you're focused on.
  if (task.state === 'inbox' || task.state === 'todo') {
    updateTask(taskId, { state: 'doing' });
  }

  const proj = findProject(task.projectId);
  projectEl.textContent = proj ? proj.name : '';
  projectEl.style.color = proj?.color || 'var(--text-3)';
  taskEl.textContent = task.text || 'Sin título';

  // Start (or just retarget) the pomodoro for this task.
  startPomodoroForTask(taskId);

  overlay.classList.add('open');
  document.body.classList.add('focus-on');

  // Reset the comment input on entry and paint the latest comments for this task.
  if (commentNewEl) commentNewEl.value = '';
  renderComments();

  // Tick the display in case the global ticker isn't enough
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(render, 500);
  render();
};

const exitFocusMode = () => {
  if (!overlay) return;
  overlay.classList.remove('open');
  document.body.classList.remove('focus-on');
  if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
};

export const initFocusMode = () => {
  overlay = document.getElementById('focus-overlay');
  if (!overlay) return;
  projectEl = document.getElementById('focus-project');
  taskEl = document.getElementById('focus-task');
  timeEl = document.getElementById('focus-time');
  modeEl = document.getElementById('focus-mode');
  toggleBtn = document.getElementById('focus-toggle');
  skipBtn = document.getElementById('focus-skip');
  doneBtn = document.getElementById('focus-done');
  exitBtn = document.getElementById('focus-exit');
  commentNewEl = document.getElementById('focus-comment-new');
  commentAddBtn = document.getElementById('focus-comment-add');
  commentListEl = document.getElementById('focus-comments-list');

  toggleBtn.addEventListener('click', () => { toggleTimer(); render(); });
  skipBtn.addEventListener('click', () => { skipTimer(); render(); });
  doneBtn.addEventListener('click', () => {
    if (!activeTaskId) return;
    updateTask(activeTaskId, { state: 'done' });
    toast('Tarea marcada como hecha 🎉', 'success');
    exitFocusMode();
  });
  exitBtn.addEventListener('click', exitFocusMode);

  const submitComment = () => {
    if (!activeTaskId) return;
    const text = commentNewEl?.value || '';
    if (!text.trim()) return;
    addTaskComment(activeTaskId, text);
    if (commentNewEl) commentNewEl.value = '';
    renderComments();
    toast('Comentario agregado', 'success');
  };
  if (commentAddBtn) commentAddBtn.addEventListener('click', submitComment);
  if (commentNewEl) commentNewEl.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submitComment();
    }
    // Stop Esc inside the textarea from also closing the overlay — confusing UX
    // when you're typing and accidentally hit Esc.
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.target.blur();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      // Don't exit if the user is typing in the comment box.
      if (document.activeElement === commentNewEl) return;
      exitFocusMode();
    }
  });
};
