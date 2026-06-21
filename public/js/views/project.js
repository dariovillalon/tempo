// project.js — single project detail page

import { state, findProject, updateTask, TASK_STATES, addTask, tasksForProject } from '../state.js';
import { api } from '../api.js';
import {
  todayKey, addDays, dayName, minsBetween, minsToHrs, relTime, escapeHtml,
} from '../utils.js';
import { router } from '../router.js';
import { openProjectModal } from '../components/projectModal.js';
import { openTaskModal } from '../components/taskModal.js';
import { openBlockModal } from '../components/blockModal.js';
import { openStatusReport } from '../components/statusReport.js';
import { toast } from '../components/toast.js';

// ----- Resource extraction from _index.md -----
// Pulls every URL the user has dropped in (markdown links, bare links, section "Recursos").
// Repos / docs get auto-classified by hostname so we can tag them in the UI.
let indexCache = new Map(); // folderPath -> { content, parsedAt }

const URL_RE = /(https?:\/\/[^\s)\]>"']+)/g;
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

const classifyResource = (url) => {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (h.includes('github.com')) return { kind: 'github', icon: '⌥', label: 'GitHub' };
    if (h.includes('gitlab.com')) return { kind: 'gitlab', icon: '⌥', label: 'GitLab' };
    if (h.includes('figma.com')) return { kind: 'figma', icon: '◉', label: 'Figma' };
    if (h.includes('notion.so')) return { kind: 'notion', icon: '✎', label: 'Notion' };
    if (h.includes('docs.google.com')) return { kind: 'gdocs', icon: '◧', label: 'Google Docs' };
    if (h.includes('drive.google.com')) return { kind: 'gdrive', icon: '◍', label: 'Google Drive' };
    if (h.includes('linear.app')) return { kind: 'linear', icon: '➜', label: 'Linear' };
    if (h.includes('youtube.com') || h.includes('youtu.be')) return { kind: 'youtube', icon: '▶', label: 'YouTube' };
    if (h.includes('slack.com')) return { kind: 'slack', icon: '#', label: 'Slack' };
    return { kind: 'link', icon: '↗', label: h.replace(/^www\./, '') };
  } catch { return { kind: 'link', icon: '↗', label: 'link' }; }
};

const parseResources = (content) => {
  const resources = [];
  const seen = new Set();
  const push = (url, label = null) => {
    const cleaned = url.replace(/[.,;!?)\]]+$/, '');
    if (seen.has(cleaned)) return;
    seen.add(cleaned);
    resources.push({ url: cleaned, label, ...classifyResource(cleaned) });
  };
  // Markdown links first (preserve their labels)
  for (const m of content.matchAll(MD_LINK_RE)) push(m[2], m[1]);
  // Bare URLs
  for (const m of content.matchAll(URL_RE)) push(m[1]);
  return resources;
};

const loadIndexFor = async (project) => {
  if (!project.vaultFolder || !state.vault) return null;
  const filePath = `${project.vaultFolder}/_index.md`;
  const cached = indexCache.get(filePath);
  if (cached && Date.now() - cached.parsedAt < 60_000) return cached.content;
  try {
    const res = await api.getVaultFile(filePath);
    indexCache.set(filePath, { content: res.content, parsedAt: Date.now() });
    return res.content;
  } catch { return null; }
};

// --- shared cache for vault tree + per-file content (project page only) ---
let vaultTreeCache = null;
const fileCache = new Map();

const findSubtree = (node, relPath) => {
  if (!node) return null;
  if ((node.path || '') === relPath) return node;
  if (!node.children) return null;
  for (const c of node.children) {
    const found = findSubtree(c, relPath);
    if (found) return found;
  }
  return null;
};

const sortedChildren = (node) => {
  const items = (node?.children || []).slice();
  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' || a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return items;
};

const renderTreeNode = (node, depth = 0, openFolders, selectedPath) => {
  const isDir = node.kind === 'dir' || node.kind === 'directory';
  const indent = depth * 12 + 6;
  if (isDir) {
    const open = openFolders.has(node.path);
    const arrow = (node.children?.length ? (open ? '▾' : '▸') : '·');
    let html = `
      <div class="dir-node" data-dir="${escapeHtml(node.path)}" style="padding-left:${indent}px">
        <span style="width:10px;color:var(--text-3);font-size:10px">${arrow}</span>
        <span style="font-weight:600">${escapeHtml(node.name || '/')}</span>
      </div>`;
    if (open) {
      html += sortedChildren(node).map(c => renderTreeNode(c, depth + 1, openFolders, selectedPath)).join('');
    }
    return html;
  }
  // File
  const isMd = (node.ext || '').match(/^(md|markdown|mdx|txt|canvas)$/);
  if (!isMd) return '';
  const isActive = selectedPath === node.path;
  return `
    <div class="file-node ${isActive ? 'active' : ''}" data-file="${escapeHtml(node.path)}" style="padding-left:${indent + 12}px">
      <span style="opacity:0.5;font-size:10px">📄</span>
      <span>${escapeHtml(node.name.replace(/\.(md|markdown|mdx|txt|canvas)$/i, ''))}</span>
    </div>`;
};

const renderProjectNotes = async (host, project) => {
  if (!project.vaultFolder) {
    host.innerHTML = `
      <div class="muted text-sm" style="padding:14px">
        Sin carpeta vinculada. Editá el proyecto y elegí una carpeta del vault para ver tus notas acá.
      </div>`;
    return;
  }
  if (!state.vault) {
    host.innerHTML = `<div class="muted text-sm" style="padding:14px">Vault no conectado.</div>`;
    return;
  }

  if (!vaultTreeCache) {
    host.innerHTML = `<div class="muted text-sm" style="padding:14px">Cargando notas…</div>`;
    try {
      const res = await api.getVaultTree();
      vaultTreeCache = res.tree;
    } catch (e) {
      host.innerHTML = `<div class="muted text-sm" style="padding:14px;color:var(--red)">Error: ${escapeHtml(e.message)}</div>`;
      return;
    }
  }

  const subtree = findSubtree(vaultTreeCache, project.vaultFolder);
  if (!subtree) {
    host.innerHTML = `
      <div class="muted text-sm" style="padding:14px">
        La carpeta <code>${escapeHtml(project.vaultFolder)}</code> no existe en el vault.
        <button class="btn btn-ghost btn-sm" id="reload-vault" style="margin-left:8px">Recargar</button>
      </div>`;
    host.querySelector('#reload-vault').addEventListener('click', () => {
      vaultTreeCache = null;
      renderProjectNotes(host, project);
    });
    return;
  }

  // Default-open the project folder
  const openFolders = host._openFolders || new Set([project.vaultFolder]);
  host._openFolders = openFolders;

  // Pick a default file: _index.md, README.md, then first markdown
  let selectedPath = host._selectedPath;
  if (!selectedPath) {
    const findFirst = (n, names) => {
      if (!n.children) return null;
      for (const c of n.children) {
        if (c.kind === 'file' && names.includes(c.name.toLowerCase())) return c.path;
      }
      for (const c of n.children) {
        if (c.kind === 'file' && /\.(md|markdown|mdx)$/i.test(c.name)) return c.path;
      }
      return null;
    };
    selectedPath = findFirst(subtree, ['_index.md', 'readme.md']);
    host._selectedPath = selectedPath;
  }

  const treeHtml = sortedChildren(subtree).map(c =>
    renderTreeNode(c, 0, openFolders, selectedPath)).join('') ||
    `<div class="muted text-xs" style="padding:8px">(carpeta vacía)</div>`;

  host.innerHTML = `
    <div class="proj-notes-panel">
      <div class="proj-notes-tree">${treeHtml}</div>
      <div class="proj-notes-preview" id="proj-notes-preview">
        ${selectedPath ? '<div class="muted text-xs">Cargando…</div>' : '<div class="muted text-xs">Seleccioná un archivo a la izquierda.</div>'}
      </div>
    </div>
  `;

  // Tree interactions
  host.querySelectorAll('.dir-node').forEach(node => {
    node.addEventListener('click', () => {
      const p = node.dataset.dir;
      if (openFolders.has(p)) openFolders.delete(p);
      else openFolders.add(p);
      renderProjectNotes(host, project);
    });
  });
  host.querySelectorAll('.file-node').forEach(node => {
    node.addEventListener('click', async () => {
      host._selectedPath = node.dataset.file;
      renderProjectNotes(host, project);
    });
  });

  // Load file content
  if (selectedPath) {
    const preview = host.querySelector('#proj-notes-preview');
    try {
      let content = fileCache.get(selectedPath);
      if (!content) {
        const res = await api.getVaultFile(selectedPath);
        content = res.content;
        fileCache.set(selectedPath, content);
      }
      const html = window.marked ? window.marked.parse(content) : `<pre>${escapeHtml(content)}</pre>`;
      preview.innerHTML = html;
    } catch (e) {
      preview.innerHTML = `<div class="muted text-xs" style="color:var(--red)">No pude leer ${escapeHtml(selectedPath)}: ${escapeHtml(e.message)}</div>`;
    }
  }
};

export const resetProjectNotesCache = () => {
  vaultTreeCache = null;
  fileCache.clear();
};

// ----- Local notes (per project) -----
let localNotesCache = null;
let localNotesAt = 0;
const renderLocalNotesForProject = async (host, p, force = false) => {
  if (force || !localNotesCache || Date.now() - localNotesAt > 30_000) {
    host.innerHTML = `<div class="muted text-sm" style="padding:14px">Cargando…</div>`;
    try {
      const res = await api.listNotes();
      localNotesCache = res.notes || [];
      localNotesAt = Date.now();
    } catch (e) {
      host.innerHTML = `<div class="muted text-sm" style="padding:14px;color:var(--red)">${escapeHtml(e.message)}</div>`;
      return;
    }
  }
  const own = localNotesCache.filter(n => n.projectId === p.id);
  if (!own.length) {
    host.innerHTML = `<div class="muted text-sm" style="padding:8px 4px">Sin notas locales todavía. Tocá <strong>+ Nueva nota</strong>.</div>`;
    return;
  }
  host.innerHTML = `
    <div class="local-notes-list">
      ${own.map(n => `
        <div class="local-note-row" data-id="${escapeHtml(n.id)}">
          <span class="local-note-title">${escapeHtml(n.title || 'Sin título')}</span>
          <div class="local-note-meta">${n.snippet ? escapeHtml(n.snippet.slice(0, 100)) : '<em>vacío</em>'}</div>
          <div class="local-note-when">actualizada ${escapeHtml(new Date(n.updatedAt).toLocaleString('es-ES', { dateStyle:'short', timeStyle:'short' }))}</div>
        </div>
      `).join('')}
    </div>
  `;
  host.querySelectorAll('.local-note-row').forEach(node => {
    node.addEventListener('click', () => {
      // route to notes view; user can pick the note from the list
      router.go('notes');
    });
  });
};

const HEALTH_LABEL = { 'on-track': 'En curso', 'at-risk': 'En riesgo', 'blocked': 'Bloqueado' };
const STATUS_LABEL = { active: 'Activo', paused: 'Pausado', done: 'Terminado', archived: 'Archivado' };

export const renderProject = (root, id) => {
  const p = findProject(id);
  if (!p) {
    root.innerHTML = `<div class="empty"><div class="empty-title">Proyecto no encontrado</div></div>`;
    return 'Proyecto';
  }

  const tasks = state.tasks.filter(t => t.projectId === id);
  const blocks = state.blocks.filter(b => b.projectId === id);
  const pomos = state.pomodoroLog.filter(pl => pl.projectId === id);

  const totalMins = blocks.reduce((s, b) => s + minsBetween(b.start, b.end), 0);
  const tasksByState = {};
  TASK_STATES.forEach(s => { tasksByState[s.id] = tasks.filter(t => t.state === s.id); });

  const today = todayKey();
  const overdue = tasks.filter(t => t.state !== 'done' && t.due && t.due < today).length;

  const totalTasks = tasks.length;
  const doneTasks = tasksByState.done.length;
  const pct = totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0;

  // Last 14 days time chart
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(addDays(new Date(), -i));
  const dayMins = days.map(d => {
    const k = todayKey(d);
    return blocks.filter(b => b.date === k).reduce((s, b) => s + minsBetween(b.start, b.end), 0);
  });
  const maxDay = Math.max(1, ...dayMins);

  // Recent activity for this project
  const proj_activity = (state.activity || []).filter(a => a.projectId === id).slice(0, 20);

  root.innerHTML = `
    <div class="proj-detail-h">
      <div class="proj-detail-dot" style="background:${escapeHtml(p.color)}"></div>
      <div style="flex:1;min-width:0">
        <h2>${escapeHtml(p.name)}</h2>
        ${p.description ? `<div class="desc">${escapeHtml(p.description)}</div>` : ''}
        <div class="meta-row">
          <span class="pill health-${escapeHtml(p.health || 'on-track')}">
            <span class="dot" style="background:currentColor"></span>${HEALTH_LABEL[p.health] || p.health}
          </span>
          <span class="pill">${STATUS_LABEL[p.status] || p.status}</span>
          ${p.goal ? `<span class="pill">🎯 ${escapeHtml(p.goal)}</span>` : ''}
          <span class="pill">📅 creado ${relTime(p.createdAt)}</span>
        </div>
      </div>
      <div class="row gap-6">
        <button class="btn btn-secondary btn-sm" id="proj-add-task">+ Tarea</button>
        <button class="btn btn-secondary btn-sm" id="proj-add-block">+ Bloque</button>
        <button class="btn btn-ghost btn-sm" id="proj-status-report" title="Generar status report">📋 Status</button>
        ${p.vaultFolder && state.vault?.path ? `<button class="btn btn-ghost btn-sm" id="proj-open-obsidian" title="Abrir carpeta en Obsidian">↗ Obsidian</button>` : ''}
        ${p.vaultFolder ? `<button class="btn btn-ghost btn-sm" id="proj-sync" title="Sincronizar tareas a Obsidian">↗ Sync</button>` : ''}
        <button class="btn btn-ghost btn-sm" id="proj-edit">Editar</button>
      </div>
    </div>

    <div class="proj-resources" id="proj-resources"></div>
    <div class="proj-where" id="proj-where"></div>

    <div class="proj-detail-grid">
      <div class="col-4">
        <div class="card">
          <div class="card-header"><div class="card-title">Resumen</div></div>
          <div class="col gap-10">
            <div>
              <div class="stat-label">Progreso</div>
              <div class="progress-bar"><div class="progress-fill" style="width:${pct}%;background:${escapeHtml(p.color)}"></div></div>
              <div class="text-xs muted" style="margin-top:4px">${doneTasks}/${totalTasks} tareas (${pct}%)</div>
            </div>
            <div>
              <div class="stat-label">Tiempo trackeado</div>
              <div class="stat-value">${minsToHrs(totalMins) || '0'}</div>
            </div>
            <div>
              <div class="stat-label">Pomodoros</div>
              <div class="stat-value">${pomos.length} <span class="unit">🍅</span></div>
            </div>
            ${overdue ? `<div style="color:var(--red);font-size:12.5px;font-weight:600">⚠ ${overdue} tarea${overdue === 1 ? '' : 's'} vencida${overdue === 1 ? '' : 's'}</div>` : ''}
          </div>
        </div>

        <div class="card" style="margin-top:14px">
          <div class="card-header"><div class="card-title">Actividad</div></div>
          <div class="activity-list">
            ${proj_activity.map(a => `
              <div class="activity-item">
                <div class="when">${relTime(a.ts)}</div>
                <div class="text">${a.text}</div>
              </div>`).join('') || '<div class="muted text-sm">Sin actividad aún</div>'}
          </div>
        </div>
      </div>

      <div class="col-8">
        <div class="card">
          <div class="card-header">
            <div class="card-title">Tiempo · últimos 14 días</div>
            <div class="card-sub">${minsToHrs(dayMins.reduce((a, b) => a + b, 0)) || '0'}</div>
          </div>
          <div class="time-chart" style="height:120px">
            ${days.map((d, i) => {
              const h = Math.max(2, (dayMins[i] / maxDay) * 100);
              const isToday = todayKey(d) === todayKey();
              return `
                <div class="bar-wrap" title="${dayName(d)}: ${minsToHrs(dayMins[i]) || '0'}">
                  <div class="bar ${dayMins[i] > 0 ? 'has-time' : ''}" style="height:${h}px;${isToday ? `background:${escapeHtml(p.color)}` : ''}"></div>
                  <div class="label">${dayName(d, true).slice(0, 1)}</div>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <div class="card" style="margin-top:14px">
          <div class="card-header">
            <div class="card-title">Tareas</div>
            <div class="card-sub">${totalTasks}</div>
          </div>
          <div class="col" style="gap:14px">
            ${TASK_STATES.map(col => {
              const ts = tasksByState[col.id];
              if (!ts.length) return '';
              return `
                <div>
                  <div class="text-xs muted" style="text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:6px">${escapeHtml(col.label)} · ${ts.length}</div>
                  <div class="col gap-6">
                    ${ts.map(t => {
                      const overdueT = t.due && t.due < today && t.state !== 'done';
                      return `
                        <div class="today-task ${t.state === 'done' ? 'done' : ''}" data-task="${t.id}">
                          <div class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                          <div class="text">${escapeHtml(t.text)}</div>
                          <div class="meta">
                            ${t.priority === 'high' ? '<span class="pill" style="background:var(--red-soft);color:var(--red)">alta</span>' : ''}
                            ${overdueT ? '<span class="pill" style="background:var(--red-soft);color:var(--red)">vencida</span>' : ''}
                            ${t.pomodoros ? `<span class="pill mono">${t.pomodorosDone || 0}/${t.pomodoros}🍅</span>` : ''}
                          </div>
                        </div>
                      `;
                    }).join('')}
                  </div>
                </div>
              `;
            }).join('') || '<div class="muted text-sm">Sin tareas todavía. Creá una con + Tarea</div>'}
          </div>
        </div>

        ${p.vaultFolder ? `
          <div class="card" style="margin-top:14px">
            <div class="card-header">
              <div>
                <div class="card-title">Notas del proyecto</div>
                <div class="card-sub" style="font-family:var(--font-mono);font-size:11px">${escapeHtml(p.vaultFolder)}/notes/</div>
              </div>
              <button class="btn btn-secondary btn-sm" id="proj-new-vault-note" title="Crear nota en notes/ del proyecto">+ Nueva nota</button>
            </div>
            <div id="proj-notes-host"></div>
          </div>
        ` : `
          <div class="card" style="margin-top:14px">
            <div class="card-header"><div class="card-title">Notas del proyecto</div></div>
            <div class="muted text-sm" style="padding:8px 4px">
              Sin carpeta de Obsidian vinculada. Editá el proyecto y elegí una carpeta del vault para tener notas y recursos acá.
            </div>
          </div>
        `}
      </div>
    </div>
  `;

  root.querySelector('#proj-edit').addEventListener('click', () => openProjectModal(id));
  root.querySelector('#proj-add-task').addEventListener('click', () => openTaskModal({ projectId: id, state: 'todo' }));
  root.querySelector('#proj-add-block').addEventListener('click', () => openBlockModal({ projectId: id, date: today }));
  root.querySelector('#proj-status-report').addEventListener('click', () => openStatusReport(id));

  const syncBtn = root.querySelector('#proj-sync');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      const orig = syncBtn.textContent;
      syncBtn.textContent = 'Sincronizando…';
      try {
        await api.standardizeProject({
          folder: p.vaultFolder,
          name: p.name,
          color: p.color,
          status: p.status,
          health: p.health,
          goal: p.goal,
          description: p.description,
        });
        await api.syncTasks(p.vaultFolder, p.name, tasksForProject(id));
        // bust the cache so the freshly written _index/tasks show up
        resetProjectNotesCache();
        toast('Sincronizado a Obsidian', 'success');
        // re-render notes panel
        const host = root.querySelector('#proj-notes-host');
        if (host) renderProjectNotes(host, p);
      } catch (e) {
        toast('Error: ' + e.message, 'error');
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = orig;
      }
    });
  }

  if (p.vaultFolder) {
    const host = root.querySelector('#proj-notes-host');
    if (host) renderProjectNotes(host, p);
  }

  // New vault note button: writes to <vaultFolder>/notes/<title>.md
  const newVn = root.querySelector('#proj-new-vault-note');
  if (newVn) newVn.addEventListener('click', async () => {
    if (!p.vaultFolder) return;
    const title = prompt('Nombre de la nota:', 'Nueva nota');
    if (!title) return;
    const slug = title.trim()
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'nota';
    const filePath = `${p.vaultFolder}/notes/${slug}.md`;
    try {
      await api.saveVaultFile(filePath, `# ${title}\n\n`);
      // bust caches and re-render
      resetProjectNotesCache();
      toast(`Nota creada en ${filePath}`, 'success');
      const host = root.querySelector('#proj-notes-host');
      if (host) renderProjectNotes(host, p);
    } catch (e) {
      toast('Error: ' + e.message, 'error');
    }
  });

  root.querySelectorAll('.today-task[data-task]').forEach(node => {
    const tid = node.dataset.task;
    node.querySelector('.check').addEventListener('click', (e) => {
      e.stopPropagation();
      const t = state.tasks.find(x => x.id === tid);
      updateTask(tid, { state: t.state === 'done' ? 'todo' : 'done' });
      router.refresh();
    });
    node.addEventListener('click', () => openTaskModal({ id: tid }));
  });

  // Open in Obsidian (uses obsidian:// URI scheme)
  const obsBtn = root.querySelector('#proj-open-obsidian');
  if (obsBtn) obsBtn.addEventListener('click', () => {
    const vaultName = state.vault?.name || '';
    const filePath = `${p.vaultFolder}/_index.md`;
    const url = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`;
    window.location.href = url;
  });

  // ---- Where-we-left + Resources panels (async; depend on _index.md) ----
  renderWhereWeLeft(root.querySelector('#proj-where'), p);
  renderResources(root.querySelector('#proj-resources'), p);

  return p.name;
};

// "Donde quedamos" — most recent block + activity + currently-doing + next 3 todos.
const renderWhereWeLeft = (host, p) => {
  if (!host) return;
  const blocks = state.blocks.filter(b => b.projectId === p.id)
    .sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start));
  const lastBlock = blocks[0];
  const lastActivity = (state.activity || []).find(a => a.projectId === p.id);
  const doing = state.tasks.filter(t => t.projectId === p.id && t.state === 'doing');
  const nextTodos = state.tasks
    .filter(t => t.projectId === p.id && (t.state === 'todo' || t.state === 'inbox'))
    .sort((a, b) => {
      const pri = { high: 0, med: 1, low: 2 };
      return (pri[a.priority] || 1) - (pri[b.priority] || 1);
    })
    .slice(0, 3);

  if (!lastBlock && !lastActivity && !doing.length && !nextTodos.length) return;

  host.innerHTML = `
    <div class="card where-card" style="margin-bottom:14px">
      <div class="card-header">
        <div class="card-title">Dónde quedamos</div>
        <div class="card-sub">contexto rápido para arrancar</div>
      </div>
      <div class="where-grid">
        <div>
          <div class="where-label">Último trabajo</div>
          ${lastBlock
            ? `<div class="where-content">
                <strong>${escapeHtml(lastBlock.title || '(sin título)')}</strong>
                <div class="text-xs muted">${escapeHtml(lastBlock.date)} · ${escapeHtml(lastBlock.start)}–${escapeHtml(lastBlock.end)} · ${minsToHrs(minsBetween(lastBlock.start, lastBlock.end))}</div>
                ${lastBlock.notes ? `<div class="text-sm" style="margin-top:4px;color:var(--text-2)">${escapeHtml(lastBlock.notes.slice(0, 240))}</div>` : ''}
              </div>`
            : `<div class="muted text-sm">Sin bloques registrados aún.</div>`}
        </div>
        <div>
          <div class="where-label">En curso (${doing.length})</div>
          ${doing.length
            ? `<div class="where-content">
                ${doing.slice(0, 3).map(t => `<div data-where-task="${t.id}" class="where-task">${escapeHtml(t.text)}</div>`).join('')}
              </div>`
            : `<div class="muted text-sm">Nada en doing.</div>`}
        </div>
        <div>
          <div class="where-label">Next steps</div>
          ${nextTodos.length
            ? `<div class="where-content">
                ${nextTodos.map(t => `
                  <div data-where-task="${t.id}" class="where-task">
                    ${t.priority === 'high' ? '<span style="color:var(--red);margin-right:4px">●</span>' : ''}
                    ${escapeHtml(t.text)}
                  </div>`).join('')}
              </div>`
            : `<div class="muted text-sm">Sin tareas en cola. Creá una.</div>`}
        </div>
        ${lastActivity ? `
          <div>
            <div class="where-label">Última actividad</div>
            <div class="where-content">
              <div class="text-sm">${lastActivity.text || ''}</div>
              <div class="text-xs muted" style="margin-top:2px">${relTime(lastActivity.ts)}</div>
            </div>
          </div>` : ''}
      </div>
    </div>
  `;
  host.querySelectorAll('[data-where-task]').forEach(n => {
    n.addEventListener('click', () => openTaskModal({ id: n.dataset.whereTask }));
  });
};

// Render resources: combina los manuales del proyecto + los que aparezcan en _index.md.
const renderResources = async (host, p) => {
  if (!host) return;
  const seen = new Set();
  const all = [];
  // 1) Manuales (state)
  for (const r of (p.resources || [])) {
    if (!r?.url || seen.has(r.url)) continue;
    seen.add(r.url);
    all.push({ url: r.url, label: r.label || null, ...classifyResource(r.url) });
  }
  // 2) Auto-detectados en _index.md (si hay vault)
  if (p.vaultFolder && state.vault?.path) {
    const content = await loadIndexFor(p);
    if (content) {
      for (const r of parseResources(content)) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        all.push(r);
      }
    }
  }
  if (!all.length) return;
  host.innerHTML = `
    <div class="resources-bar">
      <div class="resources-label">Recursos</div>
      <div class="resources-chips">
        ${all.slice(0, 16).map(r => `
          <a class="resource-chip kind-${r.kind}" href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer" title="${escapeHtml(r.url)}">
            <span class="r-icon">${r.icon}</span>
            <span class="r-text">${escapeHtml(r.label || r.url)}</span>
          </a>
        `).join('')}
      </div>
    </div>
  `;
};
