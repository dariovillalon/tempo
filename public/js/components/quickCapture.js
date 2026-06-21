// quickCapture.js — Cmd+K command palette + search

import { state, addTask, findProject } from '../state.js';
import { api } from '../api.js';
import { toast } from './toast.js';
import { router } from '../router.js';
import { escapeHtml, debounce, todayKey, addDays } from '../utils.js';
import { openTaskModal } from './taskModal.js';

// Parse "tarea texto @viernes #high 🍅3 +Snowflake" into structured fields.
// Recognised tokens (any order, anywhere):
//   @YYYY-MM-DD | @hoy | @manana | @ayer | @lunes..@domingo | @+N
//   #high | #med | #low | #alta | #media | #baja | #urgente
//   🍅N or 🍅(N) or pomo:N
//   +ProjectName  (case-insensitive prefix match against root projects;
//                  "+Project/Sub" also matches a subproject of that root)
const PRIORITY_MAP = { alta: 'high', media: 'med', baja: 'low', urgente: 'high' };
const DAY_NAMES = {
  lun: 1, mar: 2, mie: 3, mié: 3, jue: 4, vie: 5, sab: 6, sáb: 6, dom: 0,
  lunes: 1, martes: 2, miercoles: 3, miércoles: 3, jueves: 4, viernes: 5, sabado: 6, sábado: 6, domingo: 0,
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0,
};
const _todayKey = (d) => todayKey(d);
const parseDateExpr = (raw) => {
  if (!raw) return null;
  const s = raw.toLowerCase().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const today = new Date(); today.setHours(0,0,0,0);
  if (s === 'hoy' || s === 'today') return _todayKey(today);
  if (['manana','mañana','tomorrow','tom'].includes(s)) return _todayKey(addDays(today, 1));
  if (s === 'ayer') return _todayKey(addDays(today, -1));
  if (/^\+\d+$/.test(s)) return _todayKey(addDays(today, parseInt(s.slice(1), 10)));
  const dayIdx = DAY_NAMES[s] ?? DAY_NAMES[s.slice(0, 3)];
  if (dayIdx != null) {
    let cursor = new Date(today);
    do { cursor = addDays(cursor, 1); } while (cursor.getDay() !== dayIdx);
    return _todayKey(cursor);
  }
  return null;
};
const parseQuickCapture = (q) => {
  const parsed = { text: q, priority: 'med', due: null, pomodoros: 0, projectId: null, projectName: null, recognized: [] };
  let s = q;
  // priority
  const pri = s.match(/(?:^|\s)#(high|med|low|alta|media|baja|urgente)\b/i);
  if (pri) { s = s.replace(pri[0], ' '); const v = pri[1].toLowerCase(); parsed.priority = PRIORITY_MAP[v] || v; parsed.recognized.push(`prioridad:${parsed.priority}`); }
  // pomodoros
  const pom = s.match(/(?:^|\s)(?:🍅\s*\(?\s*(\d+)\s*\)?|pomo:(\d+))/i);
  if (pom) { s = s.replace(pom[0], ' '); parsed.pomodoros = parseInt(pom[1] || pom[2], 10) || 0; parsed.recognized.push(`🍅${parsed.pomodoros}`); }
  // due date
  const due = s.match(/(?:^|\s)@([\w+\-áéíóúñ]+)/i);
  if (due) {
    const d = parseDateExpr(due[1]);
    if (d) { s = s.replace(due[0], ' '); parsed.due = d; parsed.recognized.push(`vence:${d}`); }
  }
  // project — supports "+Project" or "+Project/Sub"
  const proj = s.match(/(?:^|\s)\+([\w\-áéíóúñ./]+)/i);
  if (proj) {
    const [rootName, subName] = proj[1].split('/').map(x => x.trim());
    const lower = (x) => (x || '').toLowerCase();
    const root = state.projects.find(p => !p.parentId && lower(p.name).startsWith(lower(rootName)));
    if (root) {
      let target = root;
      if (subName) {
        const sub = state.projects.find(p => p.parentId === root.id && lower(p.name).startsWith(lower(subName)));
        if (sub) target = sub;
      }
      s = s.replace(proj[0], ' ');
      parsed.projectId = target.id;
      parsed.projectName = target.name;
      parsed.recognized.push(`📁 ${target.name}`);
    }
  }
  parsed.text = s.trim().replace(/\s+/g, ' ');
  return parsed;
};

const COMMANDS = [
  { cmd: '/hoy',       label: 'Ir a Hoy',         route: 'today' },
  { cmd: '/dashboard', label: 'Ir a Dashboard',   route: 'dashboard' },
  { cmd: '/calendar',  label: 'Ir a Calendario',  route: 'calendar' },
  { cmd: '/board',     label: 'Ir a Board',       route: 'board' },
  { cmd: '/pizarra',   label: 'Ir a Pizarra',     route: 'whiteboard' },
  { cmd: '/pomodoro',  label: 'Ir a Pomodoro',    route: 'pomodoro' },
  { cmd: '/notas',     label: 'Ir a Notas',       route: 'notes' },
  { cmd: '/ajustes',   label: 'Ir a Ajustes',     route: 'settings' },
  { cmd: '/nueva',     label: 'Nueva tarea (modal)', action: 'new-task' },
  { cmd: '/proyecto',  label: 'Nuevo proyecto', action: 'new-project' },
];

let backdrop, input, hints, activeIdx = 0, currentList = [];
let notesCache = null;
let notesCacheAt = 0;
let searchAbort = null;
let searchHits = [];
let searchQuery = '';

const close = () => {
  backdrop.classList.remove('open');
  input.value = '';
  activeIdx = 0;
};

const ensureNotes = async () => {
  // refetch every 60s while open
  if (notesCache && Date.now() - notesCacheAt < 60_000) return notesCache;
  try {
    const res = await api.listNotes();
    notesCache = res.notes || [];
    notesCacheAt = Date.now();
  } catch { notesCache = notesCache || []; }
  return notesCache;
};

const buildList = (q) => {
  const ql = q.toLowerCase();
  if (!q) {
    return [
      { kind: 'hint', label: 'Escribí para buscar tareas, notas, proyectos. O usa /comando.', cmd: '?', dim: true },
      ...COMMANDS.slice(0, 6),
    ];
  }
  if (q.startsWith('/')) {
    return COMMANDS.filter(c => c.cmd.startsWith(ql));
  }

  const list = [];
  // Always offer to create a task with the typed text — and parse smart tokens.
  const parsed = parseQuickCapture(q);
  const hint = parsed.recognized.length ? ' · ' + parsed.recognized.join(' · ') : '';
  list.push({
    kind: 'create-task',
    label: `Crear: ${parsed.text || q}${hint}`,
    cmd: '+',
    _parsed: parsed,
  });

  // Tasks (open)
  const tasks = state.tasks
    .filter(t => (t.text || '').toLowerCase().includes(ql))
    .slice(0, 5)
    .map(t => {
      const p = findProject(t.projectId);
      return {
        kind: 'open-task', label: t.text, cmd: t.state,
        taskId: t.id, color: p?.color || null,
      };
    });
  list.push(...tasks);

  // Projects
  const ps = state.projects
    .filter(p => (p.name || '').toLowerCase().includes(ql))
    .slice(0, 4)
    .map(p => ({ kind: 'open-project', label: `Proyecto: ${p.name}`, cmd: '→', projectId: p.id, color: p.color }));
  list.push(...ps);

  // Notes (cached) — local title/snippet match
  const notes = (notesCache || [])
    .filter(n => (n.title + ' ' + (n.snippet || '')).toLowerCase().includes(ql))
    .slice(0, 5)
    .map(n => ({ kind: 'open-note', label: `Nota: ${n.title || 'Sin título'}`, cmd: '📝', noteId: n.id }));
  list.push(...notes);

  // Full-text vault hits (notes + task files)
  if (searchQuery === ql) {
    for (const h of searchHits.slice(0, 8)) {
      list.push({
        kind: h.kind === 'task-file' ? 'open-vault-file' : 'open-vault-file',
        label: `${h.kind === 'task-file' ? '☑' : '📄'} ${h.name} — ${h.snippet}`,
        cmd: h.kind === 'task-file' ? 'task' : 'note',
        vaultPath: h.path,
      });
    }
  }

  // Commands
  list.push(...COMMANDS.filter(c => c.label.toLowerCase().includes(ql)).slice(0, 3));

  return list;
};

const render = () => {
  const q = input.value.trim();
  const list = buildList(q);
  currentList = list;
  if (activeIdx >= list.length) activeIdx = Math.max(0, list.length - 1);

  hints.innerHTML = list.map((item, i) => {
    const dot = item.color
      ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${item.color}"></span>`
      : `<span class="cmd">${escapeHtml(item.cmd || '')}</span>`;
    return `
      <div class="qc-hint ${i === activeIdx ? 'active' : ''} ${item.dim ? 'muted' : ''}" data-i="${i}">
        ${dot}
        <span class="label">${escapeHtml(item.label)}</span>
      </div>
    `;
  }).join('') || `<div class="qc-hint muted">Sin resultados.</div>`;

  hints.querySelectorAll('.qc-hint').forEach(node => {
    node.addEventListener('click', () => { activeIdx = Number(node.dataset.i); execute(); });
  });
};

// Run a vault full-text search ~400ms after the user stops typing.
const runVaultSearch = debounce(async () => {
  const q = (input?.value || '').trim().toLowerCase();
  if (!q || q.startsWith('/') || q.length < 2) { searchHits = []; searchQuery = ''; render(); return; }
  if (!state.vault?.path) return;
  if (searchAbort) { try { searchAbort.abort(); } catch {} }
  searchAbort = new AbortController();
  try {
    const res = await api.searchVault(q);
    searchHits = res.hits || [];
    searchQuery = q;
    render();
  } catch {}
}, 350);

const debouncedRender = debounce(() => { render(); runVaultSearch(); }, 80);

const execute = () => {
  const item = currentList[activeIdx];
  const q = input.value.trim();
  if (!item && !q) return close();

  if (item?.route) { router.go(item.route); return close(); }
  if (item?.action === 'new-task') { close(); openTaskModal({ state: 'inbox' }); return; }
  if (item?.action === 'new-project') { close(); document.getElementById('add-project-btn').click(); return; }
  if (item?.kind === 'open-project') { router.go(`project/${item.projectId}`); return close(); }
  if (item?.kind === 'open-task') { close(); openTaskModal({ id: item.taskId }); return; }
  if (item?.kind === 'open-note') { router.go('notes'); close(); return; }
  if (item?.kind === 'open-vault-file') {
    // Notes view picks up the path from window.__pendingVaultPath
    window.__pendingVaultPath = item.vaultPath;
    router.go('notes');
    close();
    return;
  }
  if (q && (item?.kind === 'create-task' || !item)) {
    const p = item?._parsed || parseQuickCapture(q);
    addTask({
      text: p.text || q,
      state: p.due === todayKey() ? 'doing' : 'inbox',
      projectId: p.projectId || null,
      priority: p.priority || 'med',
      due: p.due || null,
      pomodoros: p.pomodoros || 0,
    });
    toast(`Tarea agregada${p.recognized.length ? ' (' + p.recognized.join(', ') + ')' : ''}`, 'success');
    return close();
  }
  close();
};

export const initQuickCapture = () => {
  backdrop = document.getElementById('qc-backdrop');
  input = document.getElementById('qc-input');
  hints = document.getElementById('qc-hints');
  if (!backdrop || !input || !hints) return;

  input.addEventListener('input', debouncedRender);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return close();
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(currentList.length - 1, activeIdx + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); execute(); }
  });

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const btn = document.getElementById('quick-capture-btn');
  if (btn) btn.addEventListener('click', () => openQuickCapture());

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'p')) {
      e.preventDefault();
      openQuickCapture();
    }
  });
};

export const openQuickCapture = async () => {
  backdrop.classList.add('open');
  setTimeout(() => input.focus(), 50);
  render();
  await ensureNotes();
  render();
};
