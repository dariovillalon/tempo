// board.js — Kanban view with drag-and-drop, hierarchical project filter,
// tag filter, search, ticket cloning and bulk archive.

import { state, updateTask, findProject, addTask, duplicateTask, archiveDoneTasks, TASK_STATES, getAssignees } from '../state.js';
import { todayKey, escapeHtml, fromKey, addDays } from '../utils.js';
import { openTaskModal } from '../components/taskModal.js';
import { toast } from '../components/toast.js';

// Quick snooze: move to "esperando", set followUpAt to today + N days.
const snoozeTask = (id, days) => {
  const target = addDays(new Date(), days);
  const yyyy = target.getFullYear();
  const mm = String(target.getMonth() + 1).padStart(2, '0');
  const dd = String(target.getDate()).padStart(2, '0');
  updateTask(id, { state: 'waiting', followUpAt: `${yyyy}-${mm}-${dd}` });
  toast(`Snooze ${days}d → ${dd}/${mm}`, 'success');
};

let projectFilter = 'all';   // 'all' | rootProjectId
let subFilter = 'all';       // 'all' | subprojectId
let prioFilter = 'all';
let tagFilter = 'all';       // 'all' | tag string
let assigneeFilter = 'all';  // 'all' | 'unassigned' | 'Dario' | 'Mariel'
let searchTerm = '';
const collapsedCols = new Set(); // columnas plegadas del board

// Collect all tags currently used by tasks (deduped, sorted).
const collectTags = (scopedTasks) => {
  const set = new Set();
  for (const t of scopedTasks) {
    for (const tag of (t.tags || [])) set.add(tag);
    // Inline #tags in the title also count
    for (const m of (t.text || '').matchAll(/(?:^|\s)#([a-z0-9_-]{1,24})/gi)) set.add(m[1].toLowerCase());
  }
  return [...set].sort();
};

// Walk a project + descendants. Used to scope tasks under a chosen root.
const descendantIds = (rootId) => {
  const out = new Set([rootId]);
  const walk = (pid) => {
    for (const c of state.projects.filter(p => p.parentId === pid)) {
      out.add(c.id);
      walk(c.id);
    }
  };
  walk(rootId);
  return out;
};

const taskHasTag = (t, tag) => {
  if ((t.tags || []).includes(tag)) return true;
  const re = new RegExp(`(?:^|\\s)#${tag}(?![a-z0-9_-])`, 'i');
  return re.test(t.text || '');
};

export const renderBoard = (root) => {
  // Preservar la posición del scroll: el board se re-renderiza al mover/filtrar
  // y sin esto la página saltaría arriba.
  const _sc = document.getElementById('view-content');
  const _top = _sc ? _sc.scrollTop : 0;
  if (_sc && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { _sc.scrollTop = _top; });

  const projs = state.projects.filter(p => p.status !== 'archived');
  const roots = projs.filter(p => !p.parentId);

  if (projectFilter !== 'all' && !roots.find(p => p.id === projectFilter)) projectFilter = 'all';
  const subs = projectFilter !== 'all' ? projs.filter(p => p.parentId === projectFilter) : [];
  if (subFilter !== 'all' && !subs.find(p => p.id === subFilter)) subFilter = 'all';

  // Tags discovered from currently scoped tasks (so the filter reflects what's visible)
  const allowedIdsForTagScan = projectFilter === 'all'
    ? null
    : (subFilter !== 'all' ? new Set([subFilter]) : descendantIds(projectFilter));
  const tagPool = state.tasks
    .filter(t => allowedIdsForTagScan == null || allowedIdsForTagScan.has(t.projectId));
  const tags = collectTags(tagPool);
  if (tagFilter !== 'all' && !tags.includes(tagFilter)) tagFilter = 'all';

  root.innerHTML = `
    <div class="view-h">
      <h2>Board</h2>
      <div class="view-h-actions">
        <input type="search" class="input board-search" id="board-search" placeholder="Buscar… (texto, #tag)" value="${escapeHtml(searchTerm)}">
        <button class="btn btn-ghost btn-sm" id="board-archive-done" title="Archivar todas las tareas hechas">Archivar hechas</button>
        <button class="btn btn-secondary" id="add-task-board">+ Nueva tarea</button>
      </div>
    </div>

    <div class="board-toolbar">
      <div class="board-filter-group" id="proj-filter">
        <button class="board-filter ${projectFilter === 'all' ? 'active' : ''}" data-pf="all">Todos</button>
        ${roots.map(p => `
          <button class="board-filter ${projectFilter === p.id ? 'active' : ''}" data-pf="${p.id}">
            <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${escapeHtml(p.color)};margin-right:5px;vertical-align:middle"></span>
            ${escapeHtml(p.name)}
          </button>
        `).join('')}
      </div>

      <div class="board-filter-group" id="prio-filter">
        <button class="board-filter ${prioFilter === 'all' ? 'active' : ''}" data-prio="all">Toda prioridad</button>
        <button class="board-filter ${prioFilter === 'high' ? 'active' : ''}" data-prio="high">Alta</button>
        <button class="board-filter ${prioFilter === 'med' ? 'active' : ''}" data-prio="med">Media</button>
        <button class="board-filter ${prioFilter === 'low' ? 'active' : ''}" data-prio="low">Baja</button>
      </div>

      <div class="board-filter-group" id="assignee-filter">
        <button class="board-filter ${assigneeFilter === 'all' ? 'active' : ''}" data-af="all">Todas las personas</button>
        ${getAssignees().map(a => `
          <button class="board-filter ${assigneeFilter === a.id ? 'active' : ''}" data-af="${escapeHtml(a.id)}">
            <span class="assignee-chip" style="background:${escapeHtml(a.color)}">${escapeHtml(a.initials)}</span>
            ${escapeHtml(a.label)}
          </button>
        `).join('')}
        <button class="board-filter ${assigneeFilter === 'unassigned' ? 'active' : ''}" data-af="unassigned">Sin asignar</button>
      </div>
    </div>

    ${subs.length ? `
      <div class="board-toolbar" style="margin-top:-8px">
        <div class="board-filter-group" id="sub-filter">
          <button class="board-filter ${subFilter === 'all' ? 'active' : ''}" data-sf="all">Todos los sub</button>
          ${subs.map(p => `
            <button class="board-filter ${subFilter === p.id ? 'active' : ''}" data-sf="${p.id}">
              <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${escapeHtml(p.color)};margin-right:5px;vertical-align:middle"></span>
              ${escapeHtml(p.name)}
            </button>
          `).join('')}
        </div>
      </div>
    ` : ''}

    ${tags.length ? `
      <div class="board-toolbar" style="margin-top:-8px">
        <div class="board-filter-group" id="tag-filter">
          <button class="board-filter ${tagFilter === 'all' ? 'active' : ''}" data-tf="all">Todos los tags</button>
          ${tags.map(t => `
            <button class="board-filter ${tagFilter === t ? 'active' : ''}" data-tf="${escapeHtml(t)}">
              #${escapeHtml(t)}
            </button>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <div class="kanban">
      ${TASK_STATES.map(col => renderColumn(col)).join('')}
    </div>
  `;

  // Wire filters
  root.querySelector('#proj-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pf]');
    if (!btn) return;
    projectFilter = btn.dataset.pf;
    subFilter = 'all';
    tagFilter = 'all';
    renderBoard(root);
  });
  const subF = root.querySelector('#sub-filter');
  if (subF) subF.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sf]');
    if (!btn) return;
    subFilter = btn.dataset.sf;
    renderBoard(root);
  });
  root.querySelector('#prio-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-prio]');
    if (!btn) return;
    prioFilter = btn.dataset.prio;
    renderBoard(root);
  });
  root.querySelector('#assignee-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-af]');
    if (!btn) return;
    assigneeFilter = btn.dataset.af;
    renderBoard(root);
  });
  const tagF = root.querySelector('#tag-filter');
  if (tagF) tagF.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tf]');
    if (!btn) return;
    tagFilter = btn.dataset.tf;
    renderBoard(root);
  });

  // Search — debounced via input
  let st;
  root.querySelector('#board-search').addEventListener('input', (e) => {
    clearTimeout(st);
    const v = e.target.value;
    st = setTimeout(() => {
      searchTerm = v;
      const cursorPos = e.target.selectionStart;
      renderBoard(root);
      // Restore focus + cursor after re-render
      const next = document.getElementById('board-search');
      if (next) { next.focus(); try { next.setSelectionRange(cursorPos, cursorPos); } catch (_) {} }
    }, 180);
  });

  root.querySelector('#add-task-board').addEventListener('click', () => openTaskModal({ state: 'inbox' }));
  root.querySelector('#board-archive-done').addEventListener('click', () => {
    const scopeId = projectFilter !== 'all'
      ? (subFilter !== 'all' ? subFilter : null)   // when a root is selected we archive the WHOLE root via its descendants
      : null;
    if (scopeId) {
      // single project — straightforward
      const n = archiveDoneTasks(scopeId);
      toast(n ? `Archivé ${n} tarea(s)` : 'No había tareas hechas', n ? 'success' : 'info');
    } else if (projectFilter !== 'all') {
      // root + all descendants
      let total = 0;
      for (const pid of descendantIds(projectFilter)) total += archiveDoneTasks(pid);
      toast(total ? `Archivé ${total} tarea(s)` : 'No había tareas hechas', total ? 'success' : 'info');
    } else {
      const n = archiveDoneTasks();
      toast(n ? `Archivé ${n} tarea(s)` : 'No había tareas hechas', n ? 'success' : 'info');
    }
    renderBoard(root);
  });

  // Wire cards
  root.querySelectorAll('.kanban-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.snooze-menu') || e.target.closest('[data-snooze]')) return;
      if (e.target.closest('[data-clone]')) return;
      openTaskModal({ id: card.dataset.id });
    });
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.setData('application/x-tempo-task', card.dataset.id);
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));

    // Right-click quick snooze
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const days = parseInt(prompt('Snooze cuántos días?', '3') || '0', 10);
      if (days > 0) snoozeTask(card.dataset.id, days);
      renderBoard(root);
    });
  });
  root.querySelectorAll('[data-snooze]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      snoozeTask(btn.dataset.snooze, parseInt(btn.dataset.days, 10));
      renderBoard(root);
    });
  });
  root.querySelectorAll('[data-clone]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dup = duplicateTask(btn.dataset.clone);
      if (dup) toast(`Clon: ${dup.text.slice(0, 40)}`, 'success');
      renderBoard(root);
    });
  });

  // Plegar / desplegar columnas
  root.querySelectorAll('[data-coltoggle]').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = btn.dataset.coltoggle;
    if (collapsedCols.has(id)) collapsedCols.delete(id); else collapsedCols.add(id);
    renderBoard(root);
  }));

  // Wire columns
  root.querySelectorAll('.kanban-col').forEach(col => {
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      if (!id) return;
      const newState = col.dataset.state;
      const t = state.tasks.find(x => x.id === id);
      if (t && t.state !== newState) {
        updateTask(id, { state: newState });
        renderBoard(root);
      }
    });
  });

  root.querySelectorAll('.kanban-add').forEach(btn => {
    btn.addEventListener('click', () => openTaskModal({ state: btn.dataset.state }));
  });
};

const matchesSearch = (t) => {
  if (!searchTerm.trim()) return true;
  const q = searchTerm.trim().toLowerCase();
  // #tag → tag-only search
  if (q.startsWith('#')) {
    const tag = q.slice(1);
    return taskHasTag(t, tag);
  }
  return (t.text || '').toLowerCase().includes(q)
      || (t.notes || '').toLowerCase().includes(q);
};

const renderColumn = (col) => {
  const allowedIds = projectFilter === 'all'
    ? null
    : (subFilter !== 'all' ? new Set([subFilter]) : descendantIds(projectFilter));

  const tasks = state.tasks
    .filter(t => t.state === col.id)
    .filter(t => allowedIds == null || allowedIds.has(t.projectId))
    .filter(t => prioFilter === 'all' || t.priority === prioFilter)
    .filter(t => tagFilter === 'all' || taskHasTag(t, tagFilter))
    .filter(t => assigneeFilter === 'all'
      || (assigneeFilter === 'unassigned' ? !t.assignee : t.assignee === assigneeFilter))
    .filter(matchesSearch)
    .sort((a, b) => {
      const pri = { high: 0, med: 1, low: 2 };
      const dueA = a.due || 'z'; const dueB = b.due || 'z';
      const dueCmp = dueA.localeCompare(dueB);
      if (dueCmp !== 0) return dueCmp;
      return (pri[a.priority] || 1) - (pri[b.priority] || 1);
    });

  const collapsed = collapsedCols.has(col.id);
  return `
    <div class="kanban-col ${collapsed ? 'is-collapsed' : ''}" data-state="${col.id}">
      <div class="kanban-col-h">
        <button class="kanban-col-toggle" data-coltoggle="${col.id}" title="${collapsed ? 'Expandir' : 'Plegar'}">${collapsed ? '▸' : '▾'}</button>
        <span class="kanban-col-label">${escapeHtml(col.label)}</span>
        <span class="count">${tasks.length}</span>
      </div>
      ${collapsed ? '' : `<div class="kanban-col-body">
        ${tasks.map(renderCard).join('') || '<div class="empty" style="padding:8px 4px;font-size:11.5px">vacío</div>'}
      </div>
      <button class="kanban-add" data-state="${col.id}">+ Agregar tarea</button>`}
    </div>
  `;
};

// Inline #tags pulled out of the title so they show up as pills.
const splitTagsFromText = (text) => {
  const tags = [];
  const cleaned = (text || '').replace(/(?:^|\s)#([a-z0-9_-]{1,24})/gi, (_m, tag) => {
    tags.push(tag.toLowerCase());
    return ' ';
  }).replace(/\s+/g, ' ').trim();
  return { cleaned, tags };
};

const renderCard = (t) => {
  const p = findProject(t.projectId);
  const today = todayKey();
  let dueClass = '';
  let dueText = '';
  if (t.due) {
    if (t.due < today && t.state !== 'done') { dueClass = 'overdue'; dueText = '⚠ vencida'; }
    else if (t.due === today) { dueClass = 'today'; dueText = 'hoy'; }
    else {
      const d = fromKey(t.due);
      dueText = d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
    }
  }

  let followText = '';
  let followClass = '';
  if (t.followUpAt) {
    if (t.followUpAt < today) { followClass = 'overdue'; followText = '⏰ pendiente'; }
    else if (t.followUpAt === today) { followClass = 'today'; followText = '⏰ hoy'; }
    else {
      const d = fromKey(t.followUpAt);
      followText = '⏰ ' + d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
    }
  }

  const { cleaned, tags } = splitTagsFromText(t.text);
  const allTags = [...new Set([...(t.tags || []), ...tags])];
  const subs = t.subtasks || [];
  const subDone = subs.filter(s => s.done).length;

  const assignee = t.assignee ? getAssignees().find(a => a.id === t.assignee) : null;
  const assigneeChip = assignee
    ? `<span class="assignee-chip card-assignee" style="background:${escapeHtml(assignee.color)}" title="Asignado: ${escapeHtml(assignee.label)}">${escapeHtml(assignee.initials)}</span>`
    : '';

  return `
    <div class="kanban-card" data-id="${t.id}" draggable="true">
      <div class="priority-bar ${escapeHtml(t.priority || 'med')}"></div>
      <button class="card-clone" data-clone="${t.id}" title="Duplicar tarea">⎘</button>
      ${assigneeChip}
      <div class="card-text">${escapeHtml(cleaned || t.text)}</div>
      ${allTags.length ? `<div class="card-tags">${allTags.map(tg => `<span class="card-tag">#${escapeHtml(tg)}</span>`).join('')}</div>` : ''}
      ${subs.length ? `
        <div class="card-subprogress" title="Subtareas">
          <div class="card-subprogress-bar"><div class="card-subprogress-fill" style="width:${(subDone / subs.length) * 100}%"></div></div>
          <span>${subDone}/${subs.length}</span>
        </div>` : ''}
      <div class="card-meta">
        ${p ? `<span class="pill"><span class="dot" style="background:${escapeHtml(p.color)}"></span>${escapeHtml(p.name)}</span>` : ''}
        ${dueText ? `<span class="due-pill ${dueClass}">${escapeHtml(dueText)}</span>` : ''}
        ${followText ? `<span class="due-pill ${followClass}" title="Seguimiento">${escapeHtml(followText)}</span>` : ''}
        ${t.pomodoros ? `<span class="pomos">${t.pomodorosDone || 0}/${t.pomodoros}🍅</span>` : ''}
        <span class="snooze-menu" title="Snooze (right-click para custom)">
          <button class="snooze-btn" data-snooze="${t.id}" data-days="1">1d</button>
          <button class="snooze-btn" data-snooze="${t.id}" data-days="3">3d</button>
          <button class="snooze-btn" data-snooze="${t.id}" data-days="7">1w</button>
        </span>
      </div>
    </div>
  `;
};
