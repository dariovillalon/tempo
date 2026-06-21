// taskModal.js — create/edit task with project + optional subproject

import {
  state, addTask, updateTask, deleteTask, duplicateTask, TASK_STATES, findProject,
  addTaskComment, deleteTaskComment, getAssignees,
} from '../state.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './toast.js';
import { escapeHtml, uid } from '../utils.js';
import { startPomodoroForTask } from '../views/pomodoro.js';
import { router } from '../router.js';

let editingId = null;
// Local working copy of subtasks for the modal session — flushed on save.
let pendingSubs = [];

const rootProjects = () =>
  state.projects.filter(p => p.status !== 'archived' && !p.parentId);

const subprojectsOf = (parentId) =>
  state.projects.filter(p => p.status !== 'archived' && p.parentId === parentId);

const fillStateAndProjectSel = (selectedProjectId) => {
  const stateSel = document.getElementById('task-state');
  stateSel.innerHTML = TASK_STATES.map(s => `<option value="${s.id}">${s.label}</option>`).join('');

  const projSel = document.getElementById('task-project');
  projSel.innerHTML = '<option value="">— sin proyecto —</option>' +
    rootProjects().map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  projSel.value = selectedProjectId || '';
};

// Render the subproject select for the chosen parent. Hides field when parent has no children.
const refreshSubprojectSel = (parentId, selectedSubId) => {
  const wrap = document.getElementById('task-subproject-field');
  const sel = document.getElementById('task-subproject');
  if (!parentId) {
    wrap.style.display = 'none';
    sel.innerHTML = '';
    return;
  }
  const subs = subprojectsOf(parentId);
  if (!subs.length) {
    wrap.style.display = 'none';
    sel.innerHTML = '';
    return;
  }
  wrap.style.display = '';
  sel.innerHTML = '<option value="">— ninguno —</option>' +
    subs.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  sel.value = selectedSubId || '';
};

// Resolve a stored projectId to (rootId, subId). If the project IS a root, sub is null.
// If it's a subproject, root = its parent.
const resolveProjectPair = (projectId) => {
  if (!projectId) return { rootId: '', subId: '' };
  const p = findProject(projectId);
  if (!p) return { rootId: '', subId: '' };
  if (p.parentId) return { rootId: p.parentId, subId: p.id };
  return { rootId: p.id, subId: '' };
};

export const openTaskModal = (data = {}) => {
  editingId = data.id || null;
  const t = editingId ? state.tasks.find(x => x.id === editingId) : null;
  const projectId = t?.projectId || data.projectId || '';
  const { rootId, subId } = resolveProjectPair(projectId);

  fillStateAndProjectSel(rootId);
  refreshSubprojectSel(rootId, subId);

  document.getElementById('task-modal-title').textContent = t ? 'Editar tarea' : 'Nueva tarea';
  document.getElementById('task-text').value = t?.text || data.text || '';
  document.getElementById('task-state').value = t?.state || data.state || 'inbox';
  document.getElementById('task-pomodoros').value = t?.pomodoros || '';
  document.getElementById('task-priority').value = t?.priority || 'med';
  document.getElementById('task-due').value = t?.due || '';
  document.getElementById('task-followup').value = t?.followUpAt || data.followUpAt || '';
  document.getElementById('task-recurrence').value = t?.recurrence || data.recurrence || '';
  document.getElementById('task-notes').value = t?.notes || '';
  document.getElementById('task-tags').value = (t?.tags || data.tags || []).join(', ');
  // Poblar el select de asignados con los actuales (dinámico desde settings)
  const aSel = document.getElementById('task-assignee');
  aSel.innerHTML = '<option value="">— sin asignar —</option>' +
    getAssignees().map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.label)}</option>`).join('');
  aSel.value = t?.assignee || data.assignee || '';
  pendingSubs = (t?.subtasks || data.subtasks || []).map(s => ({ ...s }));
  renderSubs();
  document.getElementById('task-sub-new').value = '';
  document.getElementById('task-delete').style.display = t ? '' : 'none';
  document.getElementById('task-clone').style.display = t ? '' : 'none';
  // Pomodoro + comments only make sense for tasks that already exist.
  document.getElementById('task-start-pomo').style.display = t ? '' : 'none';
  document.getElementById('task-comments-field').style.display = t ? '' : 'none';
  if (t) renderComments(t);

  openModal('modal-task');
};

// ----- Subtasks (managed locally, flushed on save) -----
const renderSubs = () => {
  const list = document.getElementById('task-subs-list');
  const count = document.getElementById('task-subs-count');
  if (!list) return;
  const done = pendingSubs.filter(s => s.done).length;
  count.textContent = pendingSubs.length ? `· ${done}/${pendingSubs.length}` : '';
  if (!pendingSubs.length) {
    list.innerHTML = `<div class="muted text-sm" style="padding:4px 0">Sin subtareas. Agregá una abajo.</div>`;
    return;
  }
  list.innerHTML = pendingSubs.map(s => `
    <div class="task-sub" data-sid="${escapeHtml(s.id)}">
      <input type="checkbox" ${s.done ? 'checked' : ''} data-sub-toggle>
      <input type="text" class="task-sub-text" value="${escapeHtml(s.text || '')}" data-sub-text>
      <button class="task-sub-x" data-sub-rm title="Borrar">×</button>
    </div>
  `).join('');
  list.querySelectorAll('[data-sub-toggle]').forEach(cb => cb.addEventListener('change', (e) => {
    const sid = e.target.closest('[data-sid]').dataset.sid;
    const s = pendingSubs.find(x => x.id === sid);
    if (s) { s.done = e.target.checked; renderSubs(); }
  }));
  list.querySelectorAll('[data-sub-text]').forEach(inp => inp.addEventListener('input', (e) => {
    const sid = e.target.closest('[data-sid]').dataset.sid;
    const s = pendingSubs.find(x => x.id === sid);
    if (s) s.text = e.target.value;
  }));
  list.querySelectorAll('[data-sub-rm]').forEach(b => b.addEventListener('click', (e) => {
    const sid = e.target.closest('[data-sid]').dataset.sid;
    pendingSubs = pendingSubs.filter(x => x.id !== sid);
    renderSubs();
  }));
};

const parseTags = (raw) =>
  (raw || '')
    .split(/[,\s]+/)
    .map(t => t.replace(/^#/, '').trim().toLowerCase())
    .filter(t => /^[a-z0-9_-]{1,24}$/.test(t));

const fmtCommentTime = (ts) => {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0,0,0,0);
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  const stampDay = new Date(d); stampDay.setHours(0,0,0,0);
  let datePart;
  if (stampDay.getTime() === today.getTime()) datePart = 'Hoy';
  else if (stampDay.getTime() === yest.getTime()) datePart = 'Ayer';
  else datePart = d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  const timePart = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  return `${datePart} · ${timePart}`;
};

const renderComments = (t) => {
  const list = document.getElementById('task-comments-list');
  const count = document.getElementById('task-comments-count');
  const comments = (t.comments || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  count.textContent = comments.length ? `· ${comments.length}` : '';
  if (!comments.length) {
    list.innerHTML = `<div class="muted text-sm" style="padding:6px 0">Sin comentarios todavía.</div>`;
    return;
  }
  list.innerHTML = comments.map(c => `
    <div class="task-comment" data-cid="${escapeHtml(c.id)}">
      <div class="task-comment-h">
        <span class="task-comment-time">${escapeHtml(fmtCommentTime(c.ts))}</span>
        <button class="task-comment-x" data-rm="${escapeHtml(c.id)}" title="Borrar comentario">×</button>
      </div>
      <div class="task-comment-text">${escapeHtml(c.text || '')}</div>
    </div>
  `).join('');
  list.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const cid = b.dataset.rm;
    if (!confirm('¿Borrar comentario?')) return;
    deleteTaskComment(t.id, cid);
    const updated = state.tasks.find(x => x.id === t.id);
    if (updated) renderComments(updated);
  }));
};

export const initTaskModal = () => {
  // When the project (root) changes, refresh the subproject select.
  document.getElementById('task-project').addEventListener('change', (e) => {
    refreshSubprojectSel(e.target.value, '');
  });

  document.getElementById('task-save').addEventListener('click', () => {
    const root = document.getElementById('task-project').value || null;
    const sub = document.getElementById('task-subproject').value || null;
    const data = {
      text: document.getElementById('task-text').value.trim(),
      state: document.getElementById('task-state').value,
      // If a subproject is chosen, the task lives under it; otherwise under the root.
      projectId: sub || root,
      pomodoros: Number(document.getElementById('task-pomodoros').value) || 0,
      priority: document.getElementById('task-priority').value,
      due: document.getElementById('task-due').value || null,
      followUpAt: document.getElementById('task-followup').value || null,
      recurrence: document.getElementById('task-recurrence').value || null,
      notes: document.getElementById('task-notes').value || '',
      tags: parseTags(document.getElementById('task-tags').value),
      subtasks: pendingSubs.filter(s => (s.text || '').trim()).map(s => ({ id: s.id, text: s.text.trim(), done: !!s.done })),
      assignee: document.getElementById('task-assignee').value || null,
    };
    if (!data.text) { toast('Escribí la tarea', 'error'); return; }
    if (editingId) {
      updateTask(editingId, data);
      toast('Tarea actualizada');
    } else {
      addTask(data);
      toast('Tarea creada', 'success');
    }
    closeModal('modal-task');
  });
  document.getElementById('task-delete').addEventListener('click', () => {
    if (!editingId) return;
    if (!confirm('¿Eliminar esta tarea?')) return;
    deleteTask(editingId);
    closeModal('modal-task');
    toast('Tarea eliminada');
  });

  // Duplicate the current task — closes the modal and re-opens on the clone so
  // you can keep tweaking. Saves any pending edits to the original first.
  document.getElementById('task-clone').addEventListener('click', () => {
    if (!editingId) return;
    // Persist any in-modal edits to the original before cloning so the clone reflects them.
    const root = document.getElementById('task-project').value || null;
    const sub = document.getElementById('task-subproject').value || null;
    updateTask(editingId, {
      text: document.getElementById('task-text').value.trim() || undefined,
      notes: document.getElementById('task-notes').value || '',
      tags: parseTags(document.getElementById('task-tags').value),
      subtasks: pendingSubs.filter(s => (s.text || '').trim()).map(s => ({ id: s.id, text: s.text.trim(), done: !!s.done })),
      projectId: sub || root,
      priority: document.getElementById('task-priority').value,
      due: document.getElementById('task-due').value || null,
      followUpAt: document.getElementById('task-followup').value || null,
      assignee: document.getElementById('task-assignee').value || null,
    });
    const dup = duplicateTask(editingId);
    if (!dup) { toast('No pude duplicar', 'error'); return; }
    toast(`Clon: ${dup.text.slice(0, 40)}`, 'success');
    closeModal('modal-task');
    setTimeout(() => openTaskModal({ id: dup.id }), 60);
  });

  // Add a new subtask on Enter
  document.getElementById('task-sub-new').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = e.target.value.trim();
    if (!v) return;
    pendingSubs.push({ id: uid(), text: v, done: false });
    e.target.value = '';
    renderSubs();
  });

  // Add a timestamped comment to the current task.
  const submitComment = () => {
    if (!editingId) return;
    const ta = document.getElementById('task-comment-new');
    const text = ta.value;
    if (!text.trim()) return;
    addTaskComment(editingId, text);
    ta.value = '';
    const updated = state.tasks.find(x => x.id === editingId);
    if (updated) renderComments(updated);
    toast('Comentario agregado', 'success');
  };
  document.getElementById('task-comment-add').addEventListener('click', submitComment);
  document.getElementById('task-comment-new').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submitComment();
    }
  });

  // Quick action: start a focus pomodoro tied to the current task. If the task
  // is in inbox/todo it gets bumped to "doing" so the board reflects what you're on.
  document.getElementById('task-start-pomo').addEventListener('click', () => {
    if (!editingId) return;
    const t = state.tasks.find(x => x.id === editingId);
    if (!t) return;
    if (t.state === 'inbox' || t.state === 'todo') {
      updateTask(editingId, { state: 'doing' });
    }
    startPomodoroForTask(editingId);
    closeModal('modal-task');
    router.go('pomodoro');
    toast(`🍅 Foco iniciado · ${t.text.slice(0, 40)}`, 'success');
  });
};
