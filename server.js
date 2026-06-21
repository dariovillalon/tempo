// Tempo Server
// Local-first productivity dashboard. Zero dependencies — uses only Node built-ins.

import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import tls from 'node:tls';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || process.env.TEMPO_PORT || '7777', 10);
// Optional password protection — set TEMPO_PASSWORD to require a login.
// Useful when exposing tempo to the internet via a tunnel (ngrok / cloudflared / etc.).
const TEMPO_PASSWORD = process.env.TEMPO_PASSWORD || '';

// ============================================================
// Persistencia: archivo local por defecto; Postgres si hay DATABASE_URL.
// (En la nube se usa la DB; en tu máquina sigue todo con data/*.json)
// ============================================================
const DATABASE_URL = process.env.DATABASE_URL || '';
let _pgPool = null;
async function pgPool() {
  if (!DATABASE_URL) return null;
  if (!_pgPool) {
    const { default: Pg } = await import('pg');
    _pgPool = new Pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await _pgPool.query('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, data JSONB NOT NULL)');
    console.log('  Postgres conectado (DATABASE_URL detectada)');
  }
  return _pgPool;
}
async function kvGet(key) {
  const p = await pgPool(); if (!p) return undefined;
  const r = await p.query('SELECT data FROM kv WHERE key = $1', [key]);
  return r.rows.length ? r.rows[0].data : undefined;
}
async function kvSet(key, data) {
  const p = await pgPool(); if (!p) return false;
  await p.query('INSERT INTO kv (key, data) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data', [key, JSON.stringify(data)]);
  return true;
}
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const NOTES_DIR = path.join(DATA_DIR, 'notes');
const BTC_ALERTS_FILE = path.join(DATA_DIR, 'btc-alerts.json');

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(BACKUP_DIR, { recursive: true });
await fs.mkdir(NOTES_DIR, { recursive: true });

// ============================================================
// State / config helpers
// ============================================================

function defaultState() {
  return {
    version: 2,
    projects: [
      {
        id: 'p_general',
        name: 'General',
        color: '#f0b952',
        icon: 'box',
        description: '',
        status: 'active',
        health: 'on-track',
        goal: '',
        milestones: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
    tasks: [],
    blocks: [],
    pomodoroLog: [],
    whiteboards: [],
    activity: [],
    pomodoroSettings: { focus: 25, shortBreak: 5, longBreak: 15, longEvery: 4 },
    settings: {
      dayStartHour: 7,
      dayEndHour: 22,
      weeklyGoalHours: 35,
      userName: 'Dario',
      theme: 'dark',
      autoImportObsidian: true,
      autoImportRoot: 'Projects',
      autoImportDepth: 1, // 0 = solo top-level, 1 = top + 1 nivel de subprojects
    },
    lastUsed: { projectId: null, view: 'today' },
    vault: null,
  };
}

async function getState() {
  const fallback = defaultState();
  if (DATABASE_URL) {
    const row = await kvGet('state');
    if (row) return { ...fallback, ...row, settings: { ...fallback.settings, ...(row.settings || {}) } };
    await kvSet('state', fallback);
    return fallback;
  }
  try {
    const content = await fs.readFile(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(content);
    // Merge with defaults to backfill missing fields after upgrades
    return { ...fallback, ...parsed, settings: { ...fallback.settings, ...(parsed.settings || {}) } };
  } catch {
    const initial = defaultState();
    await fs.writeFile(STATE_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
}

async function saveState(state) {
  if (DATABASE_URL) { await kvSet('state', state); return; }
  // Atomic write: write to temp, rename
  const tmp = STATE_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, STATE_FILE);
}

let backupTimer = null;
function scheduleBackup() {
  if (backupTimer) return;
  backupTimer = setTimeout(async () => {
    backupTimer = null;
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
      const dest = path.join(BACKUP_DIR, `state-${ts}.json`);
      await fs.copyFile(STATE_FILE, dest);
      // Keep only last 20
      const files = (await fs.readdir(BACKUP_DIR)).filter(f => f.startsWith('state-')).sort();
      while (files.length > 20) {
        await fs.unlink(path.join(BACKUP_DIR, files.shift()));
      }
    } catch (e) {
      console.warn('[backup] failed:', e.message);
    }
  }, 60_000);
}

async function getConfig() {
  if (DATABASE_URL) { const c = await kvGet('config'); return c || { vaultPath: null }; }
  try {
    return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'));
  } catch {
    return { vaultPath: null };
  }
}

async function saveConfig(config) {
  if (DATABASE_URL) { await kvSet('config', config); return; }
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ============================================================
// Vault scanning
// ============================================================

const NOTE_EXTS = new Set(['.md', '.markdown', '.txt', '.canvas', '.mdx']);

async function scanVault(rootPath) {
  const stats = {
    dirsScanned: 0,
    filesScanned: 0,
    notes: 0,
    otherFiles: {},
    errors: [],
  };

  async function walk(dir, depth = 0) {
    stats.dirsScanned++;
    if (depth > 12) return [];
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      stats.errors.push(`${dir}: ${e.message}`);
      return [];
    }
    const entries = [];
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const fullPath = path.join(dir, item.name);
      const relPath = path.relative(rootPath, fullPath);
      if (item.isDirectory()) {
        const children = await walk(fullPath, depth + 1);
        entries.push({ kind: 'directory', name: item.name, path: relPath, children });
      } else if (item.isFile()) {
        stats.filesScanned++;
        const ext = path.extname(item.name).toLowerCase();
        if (NOTE_EXTS.has(ext)) {
          stats.notes++;
          entries.push({ kind: 'file', name: item.name, path: relPath, ext: ext.slice(1) });
        } else {
          const e = ext || '(none)';
          stats.otherFiles[e] = (stats.otherFiles[e] || 0) + 1;
        }
      }
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  const tree = await walk(rootPath);
  return { tree, stats };
}

// ============================================================
// Tempo Project standard — Obsidian folder layout
// ============================================================
//
// Each project folder under <vault>/Projects/<Name>/ should contain:
//
//   _index.md   — frontmatter metadata + free-form description
//   tasks.md    — tasks grouped by state (## Inbox / Por hacer / En curso / Esperando / Hecho)
//   notes/      — free-form notes (any .md you want, optional)
//
// _index.md frontmatter (YAML-lite, parsed with a tolerant regex parser):
//
//   ---
//   tempo: project
//   name: Betwarrior
//   color: "#b598e8"
//   status: active           (active | paused | done | archived)
//   health: on-track         (on-track | at-risk | blocked)
//   goal: "Launch v3"
//   description: "..."
//   createdAt: "2025-12-01"
//   ---
//
// tasks.md format — each section heading maps to a Tempo task state.
// Checkbox state in a row overrides the section default (so `- [x]` always = done).
//
//   ## Inbox          → state: inbox
//   ## Por hacer      → state: todo
//   ## En curso       → state: doing
//   ## Esperando      → state: waiting
//   ## Hecho          → state: done
//
//   Row syntax:
//     - [ ] do the thing             (default state from section)
//     - [x] done item                (always: done)
//     - [/] in progress              (always: doing)
//     - [-] waiting/blocked          (always: waiting)
//     - [?] needs triage             (always: inbox)
//
//   Inline annotations:
//     #high #med #low      → priority
//     @YYYY-MM-DD          → due date
//     🍅3                   → pomodoros budgeted
//
// The same parser produces tasks on import, and a writer reproduces this layout
// on sync-out, so the file round-trips cleanly.
// ============================================================

const STATE_FROM_HEADING = {
  'inbox': 'inbox',
  'por hacer': 'todo', 'porhacer': 'todo', 'todo': 'todo', 'to do': 'todo', 'por-hacer': 'todo',
  'en curso': 'doing', 'encurso': 'doing', 'doing': 'doing', 'in progress': 'doing', 'wip': 'doing',
  'esperando': 'waiting', 'waiting': 'waiting', 'blocked': 'waiting', 'on hold': 'waiting',
  'hecho': 'done', 'done': 'done', 'completed': 'done', 'completadas': 'done', 'completas': 'done',
};
const HEADING_FROM_STATE = {
  inbox: 'Inbox', todo: 'Por hacer', doing: 'En curso', waiting: 'Esperando', done: 'Hecho',
};
const CHECKBOX_FROM_STATE = {
  inbox: ' ', todo: ' ', doing: '/', waiting: '-', done: 'x',
};
const STATE_FROM_CHECKBOX = {
  ' ': null, 'x': 'done', 'X': 'done', '/': 'doing', '-': 'waiting', '?': 'inbox',
};

const normalizeHeading = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

// Tolerant frontmatter parser — handles `key: value` and `key: "value"` and bare scalars.
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { meta: {}, body: text };
  const block = m[1];
  const meta = {};
  for (const line of block.split('\n')) {
    const mm = line.match(/^(\w[\w\-]*)\s*:\s*(.*)$/);
    if (!mm) continue;
    let val = mm[2].trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[mm[1]] = val;
  }
  return { meta, body: text.slice(m[0].length) };
}

function stringifyFrontmatter(meta, body = '') {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined || v === '') continue;
    const needsQuote = typeof v === 'string' && /[:#"'\n]/.test(v);
    lines.push(`${k}: ${needsQuote ? JSON.stringify(v) : v}`);
  }
  lines.push('---', '');
  return lines.join('\n') + (body || '');
}

// Parse tasks.md into structured task records.
// Returns: [{ text, state, priority, due, pomodoros, raw }]
function parseTasksMd(text) {
  const lines = text.split('\n');
  const out = [];
  let currentState = 'inbox';

  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      const norm = normalizeHeading(heading[1].replace(/[·:•].*$/, ''));
      if (STATE_FROM_HEADING[norm]) currentState = STATE_FROM_HEADING[norm];
      continue;
    }
    const task = line.match(/^\s*[-*+]\s+\[([ xX/?\-])\]\s+(.+?)\s*$/);
    if (!task) continue;
    const [, checkbox, rawText] = task;
    let state = STATE_FROM_CHECKBOX[checkbox];
    if (state == null) state = currentState;

    let text = rawText;

    let priority = 'med';
    text = text.replace(/(?:^|\s)#(high|med|low)\b/gi, (_, p) => {
      priority = p.toLowerCase(); return '';
    });

    let due = null;
    text = text.replace(/(?:^|\s)@(\d{4}-\d{2}-\d{2})\b/, (_, d) => {
      due = d; return '';
    });

    let pomodoros = 0;
    text = text.replace(/(?:^|\s)🍅(\d+)/, (_, n) => {
      pomodoros = parseInt(n, 10); return '';
    });

    out.push({
      text: text.trim(),
      state,
      priority,
      due,
      pomodoros,
    });
  }
  return out;
}

// ============================================================
// Task FILES (one .md per task) inside <project>/tasks/
// ============================================================
//
// Each task lives at <project>/tasks/<slug>-<id4>.md with frontmatter:
//
//   ---
//   id: abc12345
//   state: doing
//   priority: high
//   due: 2026-04-30
//   pomodoros: 3
//   pomodorosDone: 1
//   created: 2026-04-26T12:00:00Z
//   updated: 2026-04-26T18:30:00Z
//   ---
//   # Task title
//
//   <free-form notes / subtasks / context>

const slugifyTask = (s) => (s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 60) || 'tarea';

function taskFilename(t) {
  const id4 = (t.id || '').slice(0, 4) || Math.random().toString(36).slice(2, 6);
  return `${slugifyTask(t.text)}-${id4}.md`;
}

// Render a task file. Body layout:
//   # Title
//   <notes (free text)>
//   ## Comentarios
//   ### 2026-04-27 14:30
//   first comment
//   ### 2026-04-27 16:00
//   second comment
function renderTaskFile(t) {
  const meta = {
    id: t.id || '',
    state: t.state || 'inbox',
    priority: t.priority || 'med',
    due: t.due || '',
    followUp: t.followUpAt || '',
    recurrence: t.recurrence || '',
    pomodoros: t.pomodoros || 0,
    pomodorosDone: t.pomodorosDone || 0,
    created: t.createdAt ? new Date(t.createdAt).toISOString() : new Date().toISOString(),
    updated: new Date().toISOString(),
  };
  const title = t.text || 'Sin título';
  const notes = (t.notes || '').trim();
  const comments = Array.isArray(t.comments) ? t.comments : [];

  let body = `\n# ${title}\n\n`;
  if (notes) body += notes + '\n\n';
  if (comments.length) {
    body += '## Comentarios\n\n';
    // chronological — oldest first so the markdown reads top-down
    for (const c of [...comments].sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
      const d = new Date(c.ts || Date.now());
      const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      body += `### ${stamp}\n${(c.text || '').trim()}\n\n`;
    }
  }
  return stringifyFrontmatter(meta, body);
}

// Pull comments out of a body that follows the renderTaskFile layout.
// Returns { notesPart, comments[] } so callers can preserve free-form notes.
function extractComments(body = '') {
  const idx = body.search(/^##\s+Comentarios\s*$/m);
  if (idx < 0) return { notesPart: body.trim(), comments: [] };
  const notesPart = body.slice(0, idx).trim();
  const tail = body.slice(idx).split(/\n/).slice(1).join('\n'); // skip "## Comentarios" line
  const comments = [];
  // Split on ### YYYY-MM-DD HH:MM headers
  const RE = /^###\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})\s*$/m;
  let rest = tail;
  while (true) {
    const m = rest.match(RE);
    if (!m) break;
    const start = m.index + m[0].length;
    rest = rest.slice(start);
    // find next header to know where this comment ends
    const next = rest.match(RE);
    const text = (next ? rest.slice(0, next.index) : rest).trim();
    const [y, mo, d] = m[1].split('-').map(Number);
    const ts = new Date(y, mo - 1, d, +m[2], +m[3]).getTime();
    comments.push({ id: 'c_' + ts.toString(36), ts, text });
    if (!next) break;
  }
  return { notesPart, comments };
}

async function listTaskFolder(vaultPath, projectFolder) {
  const tasksDir = resolveVaultPath(vaultPath, path.join(projectFolder, 'tasks'));
  if (!existsSync(tasksDir)) return [];
  const items = await fs.readdir(tasksDir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const it of items) {
    if (!it.isFile()) continue;
    const ext = path.extname(it.name).toLowerCase();
    if (ext !== '.md' && ext !== '.markdown') continue;
    try {
      const raw = await fs.readFile(path.join(tasksDir, it.name), 'utf-8');
      const { meta, body } = parseFrontmatter(raw);
      const titleMatch = body.match(/^#+\s+(.+?)\s*$/m);
      const text = (titleMatch ? titleMatch[1] : it.name.replace(/\.md$/i, '').replace(/-[a-z0-9]{4,8}$/i, '').replace(/-/g, ' ')).trim();
      // Strip the title line, then split notes vs. comments
      const afterTitle = body.replace(/^[\s\S]*?^#+\s+.+\n+/m, '');
      const { notesPart, comments } = extractComments(afterTitle);
      out.push({
        id: meta.id || undefined,
        text,
        state: meta.state || 'inbox',
        priority: meta.priority || 'med',
        due: meta.due || null,
        followUpAt: meta.followUp || null,
        recurrence: meta.recurrence || null,
        pomodoros: parseInt(meta.pomodoros, 10) || 0,
        pomodorosDone: parseInt(meta.pomodorosDone, 10) || 0,
        notes: notesPart || '',
        comments,
        filename: it.name,
      });
    } catch {}
  }
  return out;
}

// Full sync: write the given tasks list into <project>/tasks/, deleting orphans.
async function syncTaskFolder(vaultPath, projectFolder, tasks) {
  const tasksDir = resolveVaultPath(vaultPath, path.join(projectFolder, 'tasks'));
  await fs.mkdir(tasksDir, { recursive: true });
  const existing = (await fs.readdir(tasksDir).catch(() => []))
    .filter(f => f.endsWith('.md') || f.endsWith('.markdown'));
  const wanted = new Set();
  for (const t of (tasks || [])) {
    const fname = taskFilename(t);
    wanted.add(fname);
    await fs.writeFile(path.join(tasksDir, fname), renderTaskFile(t), 'utf-8');
  }
  for (const f of existing) {
    if (!wanted.has(f)) {
      try { await fs.unlink(path.join(tasksDir, f)); } catch {}
    }
  }
  return { count: wanted.size, removed: existing.filter(f => !wanted.has(f)).length };
}

// Render a list of tasks back into our standard tasks.md format.
function renderTasksMd(projectName, tasks) {
  const order = ['inbox', 'todo', 'doing', 'waiting', 'done'];
  const grouped = Object.fromEntries(order.map(k => [k, []]));
  for (const t of tasks) (grouped[t.state] || grouped.inbox).push(t);

  const sections = [];
  sections.push(`# Tasks · ${projectName}`);
  sections.push('');
  sections.push('> Sincronizado con Tempo. Cada sección mapea a un estado de la tarea.');
  sections.push('> Formato: `- [ ] tarea #high @2026-04-30 🍅3`');
  sections.push('');
  for (const st of order) {
    sections.push(`## ${HEADING_FROM_STATE[st]}`);
    sections.push('');
    if (!grouped[st].length) {
      sections.push('_(vacío)_');
    } else {
      for (const t of grouped[st]) {
        const cb = CHECKBOX_FROM_STATE[st];
        const parts = [`- [${cb}] ${t.text || '(sin texto)'}`];
        if (t.priority && t.priority !== 'med') parts.push(`#${t.priority}`);
        if (t.due) parts.push(`@${t.due}`);
        if (t.pomodoros) parts.push(`🍅${t.pomodoros}`);
        sections.push(parts.join(' '));
      }
    }
    sections.push('');
  }
  return sections.join('\n');
}

// Heuristic: pick a description from the body of _index.md or the first line of a README.
// Skips headings, quotes, separators, and italic-only placeholders (e.g. `_(notas)_`).
function extractDescription(body) {
  if (!body) return '';
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (l.startsWith('#')) continue;
    if (l.startsWith('>')) continue;
    if (l.startsWith('---')) continue;
    if (/^[_*]\(.*\)[_*]$/.test(l)) continue; // italic placeholder
    if (/^[_*][^_*]+[_*]$/.test(l)) continue; // single italic line
    return l.slice(0, 280);
  }
  return '';
}

// Round-robin colour pick from the same palette state.js uses.
const PROJECT_COLORS = [
  '#f0b952', '#6ec18a', '#6aa9ed', '#e26b6b',
  '#e09454', '#b598e8', '#e285b5', '#6cc9bb',
];
function colorForIndex(i) {
  return PROJECT_COLORS[i % PROJECT_COLORS.length];
}

// Resolve a vault-relative folder path, ensuring it stays inside the vault.
function resolveVaultPath(vaultPath, relative) {
  const target = path.resolve(path.join(vaultPath, relative || ''));
  if (target !== vaultPath && !target.startsWith(vaultPath + path.sep)) {
    throw new Error('Path escapes vault');
  }
  return target;
}

// Inspect a single folder, returning a project-like descriptor.
async function describeProjectFolder(vaultPath, full, parentRel = null) {
  const rel = path.relative(vaultPath, full);
  const itemName = path.basename(full);
  let meta = {};
  let body = '';
  let hasIndex = false;
  let hasTasks = false;
  let taskCount = 0;
  let noteCount = 0;

  try {
    const idxRaw = await fs.readFile(path.join(full, '_index.md'), 'utf-8');
    const parsed = parseFrontmatter(idxRaw);
    meta = parsed.meta; body = parsed.body; hasIndex = true;
  } catch {}

  if (!hasIndex) {
    for (const fallback of ['README.md', 'readme.md', `${itemName}.md`]) {
      try {
        const raw = await fs.readFile(path.join(full, fallback), 'utf-8');
        const parsed = parseFrontmatter(raw);
        meta = { ...parsed.meta }; body = parsed.body;
        break;
      } catch {}
    }
  }

  // Tasks come ONLY from the tasks/ folder. We deliberately ignore the legacy
  // tasks.md so re-imports don't resurrect tasks the user already deleted in Tempo.
  try {
    const folderTasks = await listTaskFolder(vaultPath, rel);
    if (folderTasks.length) { hasTasks = true; taskCount = folderTasks.length; }
  } catch {}

  try {
    const innerItems = await fs.readdir(full, { withFileTypes: true });
    for (const it of innerItems) {
      if (!it.isFile()) continue;
      const lower = it.name.toLowerCase();
      if (lower === '_index.md' || lower === 'tasks.md') continue;
      if (NOTE_EXTS.has(path.extname(it.name).toLowerCase())) noteCount++;
    }
  } catch {}

  return {
    name: meta.name || itemName,
    folder: rel,
    parent: parentRel,
    hasIndex, hasTasks, taskCount, noteCount,
    description: meta.description || extractDescription(body),
    goal: meta.goal || '',
    color: meta.color || '',
    status: meta.status || 'active',
    health: meta.health || 'on-track',
  };
}

// List candidate project folders under <vault>/<rootRel>, recursing into
// subdirectories so subprojects can be imported with `parent` references.
// Skips folders named "notes" (per the Tempo standard) so notes aren't
// surfaced as fake subprojects.
async function listProjectFolders(vaultPath, rootRel, depth = 0, parentRel = null, acc = []) {
  const root = resolveVaultPath(vaultPath, rootRel);
  if (!existsSync(root)) return { rootRel, folders: acc };
  if (depth > 4) return { rootRel, folders: acc };
  const items = await fs.readdir(root, { withFileTypes: true });
  for (const item of items) {
    if (!item.isDirectory()) continue;
    if (item.name.startsWith('.')) continue;
    if (item.name.toLowerCase() === 'notes') continue;
    const full = path.join(root, item.name);
    const desc = await describeProjectFolder(vaultPath, full, parentRel);
    acc.push(desc);
    // Recurse into this folder for subprojects
    const childRel = path.relative(vaultPath, full);
    await listProjectFolders(vaultPath, childRel, depth + 1, desc.folder, acc);
  }
  if (depth === 0) {
    acc.sort((a, b) => {
      // group by ancestry: parents before children, then alpha
      if ((a.parent || '') !== (b.parent || '')) {
        if (!a.parent) return -1;
        if (!b.parent) return 1;
        return a.parent.localeCompare(b.parent);
      }
      return a.name.localeCompare(b.name);
    });
  }
  return { rootRel, folders: acc };
}

// Standardize a single project folder. Idempotent: keeps existing content where possible.
async function standardizeProjectFolder(vaultPath, folderRel, opts = {}) {
  const folder = resolveVaultPath(vaultPath, folderRel);
  await fs.mkdir(folder, { recursive: true });

  const indexPath = path.join(folder, '_index.md');
  const tasksPath = path.join(folder, 'tasks.md');
  const notesDir = path.join(folder, 'notes');

  // ---- _index.md
  let existingMeta = {};
  let existingBody = '';
  let hadIndex = false;
  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    const parsed = parseFrontmatter(raw);
    existingMeta = parsed.meta;
    existingBody = parsed.body;
    hadIndex = true;
  } catch {}

  // If no _index, try to bootstrap body from common entry-point files.
  // Order matters: README first, then <Name>.md, then notes.md.
  let bootstrapped = false;
  if (!hadIndex) {
    const folderName = path.basename(folder);
    const candidates = ['README.md', 'readme.md', `${folderName}.md`, 'notes.md', 'NOTES.md'];
    for (const fallback of candidates) {
      try {
        const raw = await fs.readFile(path.join(folder, fallback), 'utf-8');
        const parsed = parseFrontmatter(raw);
        existingMeta = { ...parsed.meta };
        existingBody = parsed.body;
        bootstrapped = true;
        break;
      } catch {}
    }
  }

  // Only auto-extract a description on the first standardize. After that,
  // trust whatever was written (even if it's empty) to keep the file stable
  // across repeated runs.
  const description = opts.description
    ?? existingMeta.description
    ?? (hadIndex ? '' : extractDescription(existingBody));

  const meta = {
    tempo: 'project',
    name: opts.name || existingMeta.name || path.basename(folder),
    color: opts.color || existingMeta.color || '',
    status: opts.status || existingMeta.status || 'active',
    health: opts.health || existingMeta.health || 'on-track',
    goal: opts.goal ?? existingMeta.goal ?? '',
    description,
    createdAt: existingMeta.createdAt || new Date().toISOString().slice(0, 10),
  };

  const projectName = meta.name;
  const bodyTrimmed = (existingBody || '').trim();
  const newBody = bodyTrimmed
    ? `\n${bodyTrimmed}\n`
    : `\n# ${projectName}\n\n${meta.description ? meta.description + '\n\n' : ''}## Resumen\n\n_(notas generales del proyecto)_\n\n## Recursos\n\n_(links, documentos y referencias)_\n`;

  await fs.writeFile(indexPath, stringifyFrontmatter(meta, newBody), 'utf-8');

  // ---- tasks/ folder (new format: one .md per task) — ONLY source we trust.
  // Legacy tasks.md is intentionally ignored so deleted-in-Tempo tasks don't resurrect.
  const projectFolderRel = path.relative(vaultPath, folder);
  let tasks = [];
  try { tasks = await listTaskFolder(vaultPath, projectFolderRel); } catch {}
  // Always ensure tasks/ folder exists so the user can drop notes/files in it.
  await fs.mkdir(path.join(folder, 'tasks'), { recursive: true });

  // ---- notes/
  await fs.mkdir(notesDir, { recursive: true });

  return {
    folder: path.relative(vaultPath, folder),
    name: projectName,
    meta,
    tasks,
  };
}

// Try to detect common Obsidian vault locations on the filesystem.
async function suggestVaults() {
  const home = os.homedir();
  const roots = [
    home,
    path.join(home, 'Documents'),
    path.join(home, 'Documents', 'Obsidian'),
    path.join(home, 'Obsidian'),
    path.join(home, 'iCloud Drive'),
    path.join(home, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents'),
    path.join(home, 'Library', 'CloudStorage'),
  ];
  const found = [];
  const seen = new Set();

  async function check(p, depth = 0) {
    if (depth > 3 || seen.has(p)) return;
    seen.add(p);
    try {
      const stat = await fs.stat(p);
      if (!stat.isDirectory()) return;
      const items = await fs.readdir(p, { withFileTypes: true });
      // If this folder has .obsidian, it's a vault
      if (items.some(i => i.name === '.obsidian' && i.isDirectory())) {
        found.push(p);
        return;
      }
      // Otherwise, recurse a bit into non-hidden subdirs
      for (const item of items) {
        if (item.isDirectory() && !item.name.startsWith('.') && !item.name.startsWith('Library')) {
          if (depth < 3) await check(path.join(p, item.name), depth + 1);
        }
      }
    } catch {}
  }

  for (const r of roots) {
    await check(r);
  }
  // Dedupe
  return [...new Set(found)];
}

// ============================================================
// Google Calendar via iCal subscription URL (read-only)
// ============================================================
//
// Get the URL from Google Calendar:
//   1. https://calendar.google.com → Settings (gear) → Settings
//   2. Pick the calendar in the left list
//   3. Scroll to "Integrate calendar"
//   4. Copy "Secret address in iCal format" (NOT the public address)
//   5. Paste into Tempo → Ajustes → Calendario
//
// We fetch + cache the .ics payload for 10 minutes, then expand recurring
// events for the requested date range. Supports FREQ=DAILY|WEEKLY|MONTHLY,
// INTERVAL, COUNT, UNTIL, BYDAY.

// Cache per-URL so multiple subscriptions don't fight each other.
const icsCache = new Map(); // url -> { fetchedAt, body }
const ICS_TTL_MS = 10 * 60 * 1000;

async function fetchICS(url) {
  const hit = icsCache.get(url);
  if (hit && (Date.now() - hit.fetchedAt) < ICS_TTL_MS) return hit.body;
  let httpUrl = url;
  if (httpUrl.startsWith('webcal://')) httpUrl = 'https://' + httpUrl.slice('webcal://'.length);
  const res = await fetch(httpUrl, { redirect: 'follow' });
  if (!res.ok) throw new Error(`ICS fetch ${res.status}`);
  const body = await res.text();
  icsCache.set(url, { fetchedAt: Date.now(), body });
  return body;
}

// Read the configured calendar URLs (supports legacy single-URL config too).
async function readIcsUrls() {
  const config = await getConfig();
  if (Array.isArray(config.icsUrls) && config.icsUrls.length) return config.icsUrls.filter(Boolean);
  if (config.icsUrl) return [config.icsUrl];
  return [];
}

// Tolerant ICS unfold + line-iterate. Joins continuation lines (start with space/tab).
function* icsLines(text) {
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  let buf = '';
  for (const line of raw) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      buf += line.slice(1);
    } else {
      if (buf) yield buf;
      buf = line;
    }
  }
  if (buf) yield buf;
}

// Unescape ICS text fields ("\n", "\,", "\;", "\\")
const unescapeICS = (s = '') =>
  s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

// Parse a DT* value with possible TZID/VALUE params.
// Returns { date: Date, allDay: boolean }
function parseICSDate(value, params) {
  // VALUE=DATE → all-day (YYYYMMDD)
  const isDate = (params?.VALUE === 'DATE') || /^\d{8}$/.test(value);
  if (isDate) {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    return { date: new Date(+m[1], +m[2] - 1, +m[3]), allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) {
    return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false };
  }
  // Floating local time (or with TZID we treat as local — good enough for personal calendar)
  return { date: new Date(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
}

function parseRRule(value) {
  if (!value) return null;
  const out = {};
  for (const part of value.split(';')) {
    const [k, v] = part.split('=');
    if (!k || !v) continue;
    out[k.toUpperCase()] = v;
  }
  return out;
}

// Parse the ICS into VEVENTs (no expansion yet).
function parseICS(text) {
  const events = [];
  let cur = null;
  for (const line of icsLines(text)) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.start) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;

    // Split "KEY;PARAM=VAL:VALUE"
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const left = line.slice(0, colon);
    const right = line.slice(colon + 1);
    const parts = left.split(';');
    const key = parts.shift().toUpperCase();
    const params = {};
    for (const p of parts) {
      const eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    }

    switch (key) {
      case 'UID': cur.uid = right; break;
      case 'SUMMARY': cur.summary = unescapeICS(right); break;
      case 'DESCRIPTION': cur.description = unescapeICS(right); break;
      case 'LOCATION': cur.location = unescapeICS(right); break;
      case 'DTSTART': {
        const d = parseICSDate(right, params);
        if (d) { cur.start = d.date; cur.allDay = d.allDay; }
        break;
      }
      case 'DTEND': {
        const d = parseICSDate(right, params);
        if (d) cur.end = d.date;
        break;
      }
      case 'RRULE': cur.rrule = parseRRule(right); break;
      case 'EXDATE': {
        const d = parseICSDate(right, params);
        if (d) cur.exdates.push(d.date.getTime());
        break;
      }
      case 'STATUS': cur.status = right; break;
    }
  }
  return events;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BYDAY_MAP = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Expand recurring events into instances within [from, to).
function expandEvents(events, from, to) {
  const out = [];
  for (const e of events) {
    if (!e.start) continue;
    const baseEnd = e.end || new Date(e.start.getTime() + (e.allDay ? DAY_MS : 60 * 60 * 1000));
    const dur = baseEnd.getTime() - e.start.getTime();

    if (!e.rrule) {
      if (e.start < to && baseEnd > from) {
        out.push(makeInstance(e, e.start, dur));
      }
      continue;
    }

    const r = e.rrule;
    const freq = (r.FREQ || '').toUpperCase();
    const interval = parseInt(r.INTERVAL || '1', 10);
    const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
    const until = r.UNTIL ? (parseICSDate(r.UNTIL, {})?.date || null) : null;
    const byday = r.BYDAY ? r.BYDAY.split(',').map(s => BYDAY_MAP[s.toUpperCase().slice(-2)]).filter(d => d != null) : null;

    let cursor = new Date(e.start);
    let produced = 0;
    let safety = 0;
    while (cursor <= to && produced < count && safety < 5000) {
      safety++;
      if (until && cursor > until) break;
      let emit = false;
      if (freq === 'DAILY') emit = true;
      else if (freq === 'WEEKLY') {
        emit = byday ? byday.includes(cursor.getDay()) : true;
      } else if (freq === 'MONTHLY') emit = true;
      else if (freq === 'YEARLY') emit = true;

      if (emit) {
        const t = cursor.getTime();
        if (!e.exdates.includes(t)) {
          const inst = new Date(cursor);
          if (inst < to && new Date(inst.getTime() + dur) > from) {
            out.push(makeInstance(e, inst, dur));
          }
          produced++;
        }
      }

      // advance cursor
      if (freq === 'DAILY') cursor = new Date(cursor.getTime() + DAY_MS * interval);
      else if (freq === 'WEEKLY') {
        // Step day by day; only advance interval weeks once we cross Sunday
        const next = new Date(cursor.getTime() + DAY_MS);
        // jump full week intervals from base
        if (byday) cursor = next;
        else cursor = new Date(cursor.getTime() + 7 * DAY_MS * interval);
      } else if (freq === 'MONTHLY') {
        cursor = new Date(cursor); cursor.setMonth(cursor.getMonth() + interval);
      } else if (freq === 'YEARLY') {
        cursor = new Date(cursor); cursor.setFullYear(cursor.getFullYear() + interval);
      } else break;
    }
  }
  // sort
  out.sort((a, b) => a.start - b.start);
  return out;
}

function makeInstance(e, start, durMs) {
  const end = new Date(start.getTime() + durMs);
  return {
    uid: e.uid,
    summary: e.summary || '(sin título)',
    description: e.description || '',
    location: e.location || '',
    allDay: !!e.allDay,
    start: start.toISOString(),
    end: end.toISOString(),
    status: e.status || 'CONFIRMED',
  };
}

// ============================================================
// Local notes (no Obsidian needed)
// Stored as <id>.md inside data/notes/ with YAML-lite frontmatter:
//   ---
//   title: "..."
//   projectId: <id|null>
//   createdAt: <ms>
//   updatedAt: <ms>
//   ---
//   <markdown body>
// ============================================================

const safeNoteId = (s) => /^[a-z0-9_-]+$/i.test(s);
const noteFile = (id) => path.join(NOTES_DIR, `${id}.md`);
const newNoteId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

async function readNote(id) {
  if (!safeNoteId(id)) throw new Error('bad id');
  const raw = await fs.readFile(noteFile(id), 'utf-8');
  const { meta, body } = parseFrontmatter(raw);
  const stat = await fs.stat(noteFile(id));
  return {
    id,
    title: meta.title || 'Sin título',
    projectId: meta.projectId && meta.projectId !== 'null' ? meta.projectId : null,
    createdAt: Number(meta.createdAt) || stat.birthtimeMs || stat.mtimeMs,
    updatedAt: Number(meta.updatedAt) || stat.mtimeMs,
    content: body || '',
    size: stat.size,
  };
}

async function writeNote({ id, title, content, projectId, createdAt }) {
  if (!safeNoteId(id)) throw new Error('bad id');
  const now = Date.now();
  const meta = {
    title: title || 'Sin título',
    projectId: projectId || null,
    createdAt: createdAt || now,
    updatedAt: now,
  };
  await fs.writeFile(noteFile(id), stringifyFrontmatter(meta, '\n' + (content || '')), 'utf-8');
  return { id, ...meta, content: content || '' };
}

async function listNotes() {
  const items = await fs.readdir(NOTES_DIR).catch(() => []);
  const out = [];
  for (const f of items) {
    if (!f.endsWith('.md')) continue;
    const id = f.slice(0, -3);
    if (!safeNoteId(id)) continue;
    try {
      const n = await readNote(id);
      out.push({
        id: n.id, title: n.title, projectId: n.projectId,
        createdAt: n.createdAt, updatedAt: n.updatedAt, size: n.size,
        snippet: (n.content || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      });
    } catch {}
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

// ============================================================
// HTTP helpers
// ============================================================

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const MAX = 50 * 1024 * 1024; // 50 MB cap
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const data = Buffer.concat(chunks).toString('utf-8');
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function expandPath(input) {
  if (!input) return null;
  let p = input.trim();
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

// ============================================================
// BTC price alerts
// ------------------------------------------------------------
// Persistencia en data/btc-alerts.json. Cada alerta tiene:
//   { id, target, direction:'below'|'above', email, active, cooldownHours,
//     createdAt, updatedAt, lastTriggeredAt, lastTriggerPrice, triggerCount, note }
// El scheduler corre cada CHECK_INTERVAL_MS y consulta CoinGecko.
// Cuando se cumple la condición y pasó el cooldown, dispara un email SMTP.
// ============================================================

const BTC_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 min
const BTC_DEFAULT_COOLDOWN_H = 6;
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true';

let lastBtcSnapshot = null; // { price, change24h, fetchedAt, source }

async function readBtcAlerts() {
  try {
    const raw = await fs.readFile(BTC_ALERTS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data.alerts) ? data : { alerts: [], log: [] };
  } catch {
    return { alerts: [], log: [] };
  }
}

async function writeBtcAlerts(data) {
  const tmp = BTC_ALERTS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, BTC_ALERTS_FILE);
}

function newAlertId() {
  return 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function fetchBtcPrice() {
  // Node 18+ tiene fetch global. Fallback de timeout vía AbortController.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(COINGECKO_URL, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Tempo/2.0' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const j = await res.json();
    const bitcoin = j?.bitcoin;
    if (!bitcoin || typeof bitcoin.usd !== 'number') throw new Error('Respuesta inesperada');
    return {
      price: bitcoin.usd,
      change24h: bitcoin.usd_24h_change ?? null,
      fetchedAt: Date.now(),
      lastUpdatedAt: bitcoin.last_updated_at ? bitcoin.last_updated_at * 1000 : Date.now(),
      source: 'coingecko',
    };
  } finally {
    clearTimeout(t);
  }
}

// ---- Mínimo cliente SMTP sobre TLS implícito (puerto 465) ----
// Implementado con node:tls para no agregar dependencias externas.
// Soporta Gmail App Password (AUTH LOGIN) usando SMTP_USER y SMTP_PASS.

function smtpEncodeUtf8Header(s) {
  // Si el asunto trae caracteres no-ASCII, codificar como =?UTF-8?B?...?= (RFC 2047)
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  const b64 = Buffer.from(s, 'utf-8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

function buildEmailMessage({ from, to, subject, text }) {
  const date = new Date().toUTCString();
  const fromAddr = typeof from === 'string' ? from : from.address;
  const fromName = typeof from === 'object' && from.name ? from.name : 'Tempo BTC Alerts';
  const headers = [
    `From: ${smtpEncodeUtf8Header(fromName)} <${fromAddr}>`,
    `To: ${to}`,
    `Subject: ${smtpEncodeUtf8Header(subject)}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 8bit`,
  ];
  // RFC 5321: dot-stuffing — líneas que empiezan con '.' deben duplicarlo.
  const body = (text || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  return headers.join('\r\n') + '\r\n\r\n' + body + '\r\n';
}

function smtpSend({ host, port, user, pass, from, to, subject, text }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host });
    let buffer = '';
    let stage = 'greet';
    const cleanup = (err, ok) => {
      socket.removeAllListeners();
      try { socket.destroy(); } catch {}
      if (err) reject(err); else resolve(ok);
    };
    const overall = setTimeout(() => cleanup(new Error('SMTP timeout')), 20000);

    const write = (line) => socket.write(line + '\r\n');

    socket.on('error', (e) => { clearTimeout(overall); cleanup(e); });
    socket.on('end',   () => { clearTimeout(overall); if (stage !== 'done') cleanup(new Error('SMTP cerrado prematuramente')); });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      // Cada respuesta SMTP termina con \r\n y la última línea no tiene '-' después del código.
      while (true) {
        const idx = buffer.indexOf('\r\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const code = parseInt(line.slice(0, 3), 10);
        const more = line.charAt(3) === '-';
        if (more) continue; // esperar última línea de la respuesta multi-línea
        try { handleResponse(code, line); }
        catch (e) { clearTimeout(overall); cleanup(e); return; }
      }
    });

    const handleResponse = (code, line) => {
      switch (stage) {
        case 'greet':
          if (code !== 220) throw new Error('SMTP greet: ' + line);
          stage = 'ehlo';
          write('EHLO tempo.local');
          break;
        case 'ehlo':
          if (code !== 250) throw new Error('SMTP EHLO: ' + line);
          stage = 'auth';
          write('AUTH LOGIN');
          break;
        case 'auth':
          if (code !== 334) throw new Error('SMTP AUTH: ' + line);
          stage = 'auth-user';
          write(Buffer.from(user, 'utf-8').toString('base64'));
          break;
        case 'auth-user':
          if (code !== 334) throw new Error('SMTP AUTH user: ' + line);
          stage = 'auth-pass';
          write(Buffer.from(pass, 'utf-8').toString('base64'));
          break;
        case 'auth-pass':
          if (code !== 235) throw new Error('SMTP AUTH pass: ' + line);
          stage = 'mail';
          write(`MAIL FROM:<${from.address || from}>`);
          break;
        case 'mail':
          if (code !== 250) throw new Error('SMTP MAIL FROM: ' + line);
          stage = 'rcpt';
          write(`RCPT TO:<${to}>`);
          break;
        case 'rcpt':
          if (code !== 250 && code !== 251) throw new Error('SMTP RCPT TO: ' + line);
          stage = 'data';
          write('DATA');
          break;
        case 'data':
          if (code !== 354) throw new Error('SMTP DATA: ' + line);
          stage = 'body';
          socket.write(buildEmailMessage({ from, to, subject, text }));
          socket.write('\r\n.\r\n');
          break;
        case 'body':
          if (code !== 250) throw new Error('SMTP body: ' + line);
          stage = 'quit';
          write('QUIT');
          break;
        case 'quit':
          stage = 'done';
          clearTimeout(overall);
          cleanup(null, { ok: true });
          break;
        default:
          throw new Error('SMTP stage desconocido: ' + stage);
      }
    };
  });
}

async function sendBtcAlertEmail({ to, alert, snapshot }) {
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const fromAddr = process.env.SMTP_FROM || user;
  if (!user || !pass) {
    throw new Error('SMTP_USER y SMTP_PASS no configurados (App Password de Gmail)');
  }
  const direction = alert.direction === 'above' ? 'subió a' : 'cayó a';
  const subject = `BTC ${direction} $${snapshot.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const lines = [
    `Se disparó tu alerta de Bitcoin.`,
    ``,
    `Precio actual:  $${snapshot.price.toLocaleString('en-US', { maximumFractionDigits: 2 })} USD`,
    `Cambio 24h:     ${snapshot.change24h != null ? snapshot.change24h.toFixed(2) + ' %' : 'n/d'}`,
    `Condición:      precio ${alert.direction === 'above' ? '>=' : '<='} $${Number(alert.target).toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
    alert.note ? `Nota:           ${alert.note}` : null,
    ``,
    `Hora:           ${new Date(snapshot.fetchedAt).toLocaleString('es-AR')}`,
    `Fuente:         CoinGecko`,
    ``,
    `— Tempo · BTC Alerts`,
  ].filter(Boolean);
  return smtpSend({
    host: 'smtp.gmail.com',
    port: 465,
    user,
    pass,
    from: { address: fromAddr, name: 'Tempo BTC Alerts' },
    to,
    subject,
    text: lines.join('\n'),
  });
}

function alertShouldFire(alert, price) {
  if (!alert.active) return false;
  const target = Number(alert.target);
  if (!Number.isFinite(target) || target <= 0) return false;
  if (alert.direction === 'above') return price >= target;
  // default: below
  return price <= target;
}

async function runBtcAlertCheck({ force = false } = {}) {
  let snapshot;
  try {
    snapshot = await fetchBtcPrice();
    lastBtcSnapshot = snapshot;
  } catch (e) {
    console.warn('[btc] precio no disponible:', e.message);
    return { ok: false, reason: e.message };
  }

  const data = await readBtcAlerts();
  if (!data.log) data.log = [];
  let changed = false;
  const now = Date.now();
  const fired = [];

  for (const alert of data.alerts) {
    if (!alertShouldFire(alert, snapshot.price)) continue;
    const cooldownMs = (alert.cooldownHours ?? BTC_DEFAULT_COOLDOWN_H) * 3600 * 1000;
    const since = alert.lastTriggeredAt ? (now - alert.lastTriggeredAt) : Infinity;
    if (!force && since < cooldownMs) continue;
    try {
      await sendBtcAlertEmail({ to: alert.email, alert, snapshot });
      alert.lastTriggeredAt = now;
      alert.lastTriggerPrice = snapshot.price;
      alert.triggerCount = (alert.triggerCount || 0) + 1;
      data.log.unshift({
        ts: now, alertId: alert.id, price: snapshot.price,
        target: alert.target, direction: alert.direction,
        email: alert.email, ok: true,
      });
      fired.push(alert.id);
      changed = true;
    } catch (e) {
      console.warn('[btc] envío email falló para', alert.email, '·', e.message);
      data.log.unshift({
        ts: now, alertId: alert.id, price: snapshot.price,
        target: alert.target, direction: alert.direction,
        email: alert.email, ok: false, error: e.message,
      });
      changed = true;
    }
  }

  if (data.log.length > 100) data.log.length = 100;
  if (changed) await writeBtcAlerts(data);
  return { ok: true, snapshot, fired };
}

// ============================================================
// API handler
// ============================================================

async function handleApi(req, res, parsedUrl) {
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/health') {
    return sendJSON(res, 200, { ok: true, version: '2.0' });
  }

  // ---- State ----
  if (pathname === '/api/state' && req.method === 'GET') {
    return sendJSON(res, 200, await getState());
  }
  if (pathname === '/api/state' && req.method === 'PUT') {
    try {
      const body = await readBody(req);
      if (!body || typeof body !== 'object') {
        return sendJSON(res, 400, { error: 'Invalid body' });
      }
      // Accept either { state: {...} } envelope or the state object directly
      const incoming = (body.state && typeof body.state === 'object') ? body.state : body;
      // Merge with current to preserve fields like vault that the client doesn't send
      const current = await getState().catch(() => defaultState());
      const merged = { ...current, ...incoming, version: 2 };
      await saveState(merged);
      scheduleBackup();
      return sendJSON(res, 200, { ok: true, savedAt: Date.now() });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // ---- Config ----
  if (pathname === '/api/config' && req.method === 'GET') {
    return sendJSON(res, 200, await getConfig());
  }

  // ---- Vault ----
  if (pathname === '/api/vault' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const vaultPath = expandPath(body.path);
      if (!vaultPath) return sendJSON(res, 400, { error: 'Missing path' });
      if (!existsSync(vaultPath)) return sendJSON(res, 400, { error: 'La carpeta no existe' });
      const stat = await fs.stat(vaultPath);
      if (!stat.isDirectory()) return sendJSON(res, 400, { error: 'La ruta no es una carpeta' });
      await saveConfig({ vaultPath });

      // Scan and return summary stats so the UI can show counts immediately
      let scan = null;
      try { scan = await scanVault(vaultPath); } catch {}

      // Persist a short summary in state.vault for UI badges
      try {
        const cur = await getState().catch(() => defaultState());
        cur.vault = {
          path: vaultPath,
          name: path.basename(vaultPath),
          notes: scan?.stats?.notes ?? 0,
          files: scan?.stats?.filesScanned ?? 0,
          folders: scan?.stats?.dirsScanned ?? 0,
          connectedAt: Date.now(),
        };
        await saveState(cur);
      } catch {}

      return sendJSON(res, 200, {
        ok: true,
        vault: {
          path: vaultPath,
          name: path.basename(vaultPath),
          notes: scan?.stats?.notes ?? 0,
          files: scan?.stats?.filesScanned ?? 0,
          folders: scan?.stats?.dirsScanned ?? 0,
        },
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/vault' && req.method === 'DELETE') {
    await saveConfig({ vaultPath: null });
    try {
      const cur = await getState();
      cur.vault = null;
      await saveState(cur);
    } catch {}
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/vault/tree' && req.method === 'GET') {
    const config = await getConfig();
    if (!config.vaultPath) return sendJSON(res, 200, { connected: false });
    if (!existsSync(config.vaultPath)) {
      return sendJSON(res, 200, { connected: false, error: 'Vault path no longer exists' });
    }
    try {
      const result = await scanVault(config.vaultPath);
      const name = path.basename(config.vaultPath);
      // Adapt to the client's expected tree shape: { kind, name, path, children }
      const adapt = (node) => ({
        kind: node.kind === 'directory' ? 'dir' : 'file',
        name: node.name,
        path: node.path,
        ext: node.ext,
        children: node.children ? node.children.map(adapt) : undefined,
      });
      const treeChildren = (result.tree || []).map(adapt);
      return sendJSON(res, 200, {
        connected: true,
        vaultPath: config.vaultPath,
        name,
        stats: result.stats,
        tree: { kind: 'root', name, path: '', children: treeChildren },
      });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  if (pathname === '/api/vault/file' && req.method === 'GET') {
    const config = await getConfig();
    if (!config.vaultPath) return sendJSON(res, 400, { error: 'No vault connected' });
    const relPath = parsedUrl.searchParams.get('path');
    if (!relPath) return sendJSON(res, 400, { error: 'Missing path' });
    const fullPath = path.resolve(path.join(config.vaultPath, relPath));
    if (!fullPath.startsWith(config.vaultPath)) {
      return sendJSON(res, 403, { error: 'Forbidden path' });
    }
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const stat = await fs.stat(fullPath);
      return sendJSON(res, 200, {
        content,
        path: relPath,
        size: stat.size,
        modified: stat.mtimeMs,
      });
    } catch (e) {
      return sendJSON(res, 404, { error: e.message });
    }
  }

  if (pathname === '/api/vault/save' && req.method === 'PUT') {
    const config = await getConfig();
    if (!config.vaultPath) return sendJSON(res, 400, { error: 'No vault connected' });
    try {
      const body = await readBody(req);
      const relPath = body.path;
      if (!relPath) return sendJSON(res, 400, { error: 'Missing path' });
      const fullPath = path.resolve(path.join(config.vaultPath, relPath));
      if (!fullPath.startsWith(config.vaultPath)) {
        return sendJSON(res, 403, { error: 'Forbidden' });
      }
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, body.content || '', 'utf-8');
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  if (pathname === '/api/vault/suggest' && req.method === 'GET') {
    try {
      const paths = await suggestVaults();
      const home = os.homedir();
      const suggestions = paths.map(p => ({
        path: p,
        label: path.basename(p) || p,
        isObsidianVault: true,
      }));
      // Also include common bare folders as fallbacks
      const fallbacks = [
        { path: path.join(home, 'Documents'), label: 'Documents' },
        { path: path.join(home, 'Obsidian'), label: 'Obsidian' },
      ];
      for (const f of fallbacks) {
        if (existsSync(f.path) && !suggestions.some(s => s.path === f.path)) {
          suggestions.push({ ...f, isObsidianVault: false });
        }
      }
      return sendJSON(res, 200, { suggestions, home });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // ---- Full-text search across vault notes + tasks/<*.md> contents ----
  if (pathname === '/api/search' && req.method === 'GET') {
    const config = await getConfig();
    const q = (parsedUrl.searchParams.get('q') || '').trim().toLowerCase();
    if (!q || q.length < 2) return sendJSON(res, 200, { hits: [] });
    if (!config.vaultPath) return sendJSON(res, 200, { hits: [] });

    const hits = [];
    const MAX = 40;
    const SIZE_LIMIT = 256 * 1024;

    async function walk(dir, depth = 0) {
      if (hits.length >= MAX) return;
      if (depth > 8) return;
      let items = [];
      try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        if (hits.length >= MAX) return;
        if (it.name.startsWith('.')) continue;
        const full = path.join(dir, it.name);
        if (it.isDirectory()) { await walk(full, depth + 1); continue; }
        if (!it.isFile()) continue;
        const ext = path.extname(it.name).toLowerCase();
        if (!NOTE_EXTS.has(ext)) continue;
        try {
          const stat = await fs.stat(full);
          if (stat.size > SIZE_LIMIT) continue;
          const raw = await fs.readFile(full, 'utf-8');
          const lower = raw.toLowerCase();
          const idx = lower.indexOf(q);
          if (idx < 0) continue;
          // Build a snippet around the match
          const start = Math.max(0, idx - 60);
          const end = Math.min(raw.length, idx + q.length + 80);
          let snippet = raw.slice(start, end).replace(/\s+/g, ' ').trim();
          if (start > 0) snippet = '…' + snippet;
          if (end < raw.length) snippet += '…';
          const rel = path.relative(config.vaultPath, full);
          // Tag tasks/ folder hits separately so the client can route them to the task modal
          const inTasksFolder = rel.includes('/tasks/') || rel.startsWith('tasks/');
          hits.push({
            kind: inTasksFolder ? 'task-file' : 'note',
            path: rel,
            name: it.name.replace(/\.(md|markdown|mdx|txt)$/i, ''),
            snippet,
          });
        } catch {}
      }
    }
    try { await walk(config.vaultPath); } catch {}
    return sendJSON(res, 200, { hits });
  }

  // ---- Calendar (Google iCal subscriptions, multiple) ----
  if (pathname === '/api/calendar/urls' && req.method === 'GET') {
    return sendJSON(res, 200, { urls: await readIcsUrls() });
  }
  if (pathname === '/api/calendar/urls' && req.method === 'POST') {
    // Accepts { urls: [string, ...] } — replaces the list.
    try {
      const body = await readBody(req);
      const urls = Array.isArray(body.urls) ? body.urls.map(u => (u || '').trim()).filter(Boolean) : [];
      for (const u of urls) {
        if (!/^(https?|webcal):\/\//i.test(u)) {
          return sendJSON(res, 400, { error: `URL inválida: ${u}` });
        }
      }
      const config = await getConfig();
      config.icsUrls = urls;
      delete config.icsUrl; // drop legacy single field
      await saveConfig(config);
      icsCache.clear();
      return sendJSON(res, 200, { ok: true, urls });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }
  // Legacy single-URL endpoint (kept for backwards compatibility)
  if (pathname === '/api/calendar/url' && req.method === 'GET') {
    const urls = await readIcsUrls();
    return sendJSON(res, 200, { url: urls[0] || null });
  }
  if (pathname === '/api/calendar/url' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const url = (body.url || '').trim();
      if (url && !/^(https?|webcal):\/\//i.test(url)) {
        return sendJSON(res, 400, { error: 'URL inválida' });
      }
      const config = await getConfig();
      config.icsUrls = url ? [url] : [];
      delete config.icsUrl;
      await saveConfig(config);
      icsCache.clear();
      return sendJSON(res, 200, { ok: true, url: url || null });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }
  // Atomic add/remove to avoid client-side race conditions when concurrent
  // edits race against an in-flight GET of the URL list.
  if (pathname === '/api/calendar/urls/add' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const url = (body.url || '').trim();
      if (!url) return sendJSON(res, 400, { error: 'URL vacía' });
      if (!/^(https?|webcal):\/\//i.test(url)) return sendJSON(res, 400, { error: 'URL inválida' });
      const config = await getConfig();
      const list = Array.isArray(config.icsUrls) ? config.icsUrls.slice() : (config.icsUrl ? [config.icsUrl] : []);
      if (!list.includes(url)) list.push(url);
      config.icsUrls = list;
      delete config.icsUrl;
      await saveConfig(config);
      icsCache.clear();
      return sendJSON(res, 200, { ok: true, urls: list });
    } catch (e) { return sendJSON(res, 400, { error: e.message }); }
  }
  if (pathname === '/api/calendar/urls/remove' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const url = (body.url || '').trim();
      if (!url) return sendJSON(res, 400, { error: 'URL vacía' });
      const config = await getConfig();
      const list = (Array.isArray(config.icsUrls) ? config.icsUrls : (config.icsUrl ? [config.icsUrl] : []))
        .filter(u => u !== url);
      config.icsUrls = list;
      delete config.icsUrl;
      await saveConfig(config);
      icsCache.clear();
      return sendJSON(res, 200, { ok: true, urls: list });
    } catch (e) { return sendJSON(res, 400, { error: e.message }); }
  }

  if (pathname === '/api/calendar/events' && req.method === 'GET') {
    try {
      const urls = await readIcsUrls();
      if (!urls.length) return sendJSON(res, 200, { connected: false, events: [] });
      const fromStr = parsedUrl.searchParams.get('from');
      const toStr = parsedUrl.searchParams.get('to');
      const from = fromStr ? new Date(fromStr) : new Date(Date.now() - DAY_MS);
      const to = toStr ? new Date(toStr) : new Date(Date.now() + 30 * DAY_MS);
      // Fetch all calendars in parallel; merge & sort by start.
      const all = await Promise.all(urls.map(async (u, i) => {
        try {
          const body = await fetchICS(u);
          return expandEvents(parseICS(body), from, to)
            .map(ev => ({ ...ev, calendar: i }));
        } catch (e) {
          console.warn('[ics] fetch failed for', u, e.message);
          return [];
        }
      }));
      const events = all.flat().sort((a, b) => a.start.localeCompare(b.start));
      return sendJSON(res, 200, { connected: true, events, sources: urls.length });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // ---- Local notes (independent of vault) ----
  if (pathname === '/api/notes' && req.method === 'GET') {
    try {
      const notes = await listNotes();
      return sendJSON(res, 200, { notes });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }
  if (pathname === '/api/notes' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const id = newNoteId();
      const note = await writeNote({
        id,
        title: body.title || 'Sin título',
        content: body.content || '',
        projectId: body.projectId || null,
      });
      return sendJSON(res, 200, { note });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }
  const noteMatch = pathname.match(/^\/api\/notes\/([a-z0-9_-]+)$/i);
  if (noteMatch) {
    const id = noteMatch[1];
    if (req.method === 'GET') {
      try { return sendJSON(res, 200, { note: await readNote(id) }); }
      catch (e) { return sendJSON(res, 404, { error: e.message }); }
    }
    if (req.method === 'PUT') {
      try {
        const body = await readBody(req);
        let prev = {};
        try { prev = await readNote(id); } catch {}
        const note = await writeNote({
          id,
          title: body.title ?? prev.title,
          content: body.content ?? prev.content,
          projectId: body.projectId !== undefined ? body.projectId : prev.projectId,
          createdAt: prev.createdAt,
        });
        return sendJSON(res, 200, { note });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }
    if (req.method === 'DELETE') {
      try { await fs.unlink(noteFile(id)); return sendJSON(res, 200, { ok: true }); }
      catch (e) { return sendJSON(res, 404, { error: e.message }); }
    }
  }

  // ---- Export / import full state ----
  if (pathname === '/api/export' && req.method === 'GET') {
    try {
      const cur = await getState();
      const notes = await listNotes();
      const fullNotes = [];
      for (const n of notes) {
        try { fullNotes.push(await readNote(n.id)); } catch {}
      }
      return sendJSON(res, 200, {
        exportedAt: Date.now(),
        version: 2,
        state: cur,
        notes: fullNotes,
      });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }
  if (pathname === '/api/import' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (body.state && typeof body.state === 'object') {
        const cur = await getState().catch(() => defaultState());
        const merged = { ...cur, ...body.state, version: 2 };
        await saveState(merged);
        scheduleBackup();
      }
      let imported = 0;
      if (Array.isArray(body.notes)) {
        for (const n of body.notes) {
          if (!n || typeof n !== 'object') continue;
          const id = safeNoteId(n.id || '') ? n.id : newNoteId();
          await writeNote({
            id,
            title: n.title || 'Sin título',
            content: n.content || '',
            projectId: n.projectId || null,
            createdAt: n.createdAt || Date.now(),
          });
          imported++;
        }
      }
      return sendJSON(res, 200, { ok: true, importedNotes: imported });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // ---- Project folders ----
  if (pathname === '/api/vault/list-projects' && req.method === 'GET') {
    const config = await getConfig();
    if (!config.vaultPath) return sendJSON(res, 400, { error: 'No vault connected' });
    const rootRel = parsedUrl.searchParams.get('path') || 'Projects';
    try {
      const result = await listProjectFolders(config.vaultPath, rootRel);
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  if (pathname === '/api/vault/standardize-project' && req.method === 'POST') {
    const config = await getConfig();
    if (!config.vaultPath) return sendJSON(res, 400, { error: 'No vault connected' });
    try {
      const body = await readBody(req);
      if (!body.folder) return sendJSON(res, 400, { error: 'Missing folder' });
      const result = await standardizeProjectFolder(config.vaultPath, body.folder, body);
      return sendJSON(res, 200, { ok: true, project: result });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  if (pathname === '/api/vault/import-projects' && req.method === 'POST') {
    // Standardize each requested folder, then return the parsed projects + tasks
    // for the client to merge into Tempo state.
    const config = await getConfig();
    if (!config.vaultPath) return sendJSON(res, 400, { error: 'No vault connected' });
    try {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return sendJSON(res, 400, { error: 'No projects selected' });
      // Sort: parents first (shorter folder paths), so child references resolve
      const sorted = items.slice().sort((a, b) =>
        (a.folder || '').split('/').length - (b.folder || '').split('/').length);
      const out = [];
      for (let i = 0; i < sorted.length; i++) {
        const it = sorted[i];
        if (!it.folder) continue;
        const result = await standardizeProjectFolder(config.vaultPath, it.folder, {
          name: it.name,
          color: it.color || colorForIndex(i),
          status: it.status,
          health: it.health,
          goal: it.goal,
          description: it.description,
        });
        // Pass through the parent folder reference so the client can wire parentId
        result.parent = it.parent || null;
        out.push(result);
      }
      return sendJSON(res, 200, { ok: true, projects: out });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // List tasks living under a project's tasks/ folder. Used for manual re-sync
  // pulls from vault → Tempo state.
  if (pathname === '/api/vault/list-tasks' && req.method === 'GET') {
    const config = await getConfig();
    if (!config.vaultPath) return sendJSON(res, 400, { error: 'No vault connected' });
    const folder = parsedUrl.searchParams.get('folder');
    if (!folder) return sendJSON(res, 400, { error: 'Missing folder' });
    try {
      const tasks = await listTaskFolder(config.vaultPath, folder);
      return sendJSON(res, 200, { ok: true, folder, tasks });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  if (pathname === '/api/vault/sync-tasks' && req.method === 'POST') {
    // Write a project's tasks into its <project>/tasks/ folder, one .md per task.
    // Orphan files (deleted in Tempo) get removed.
    const config = await getConfig();
    if (!config.vaultPath) return sendJSON(res, 400, { error: 'No vault connected' });
    try {
      const body = await readBody(req);
      if (!body.folder) return sendJSON(res, 400, { error: 'Missing folder' });
      const result = await syncTaskFolder(config.vaultPath, body.folder, body.tasks || []);
      return sendJSON(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // Delete the legacy tasks.md file from each given project folder. Optionally
  // also wipe the tasks/ folder content. Files in vault outside the requested
  // folders are NEVER touched.
  if (pathname === '/api/vault/clean-legacy-tasks' && req.method === 'POST') {
    const config = await getConfig();
    if (!config.vaultPath) return sendJSON(res, 400, { error: 'No vault connected' });
    try {
      const body = await readBody(req);
      const folders = Array.isArray(body.folders) ? body.folders : [];
      const alsoWipeTasksDir = !!body.alsoWipeTasksDir;
      let deletedMd = 0;
      let deletedFiles = 0;
      const errors = [];
      for (const rel of folders) {
        try {
          const folderAbs = resolveVaultPath(config.vaultPath, rel);
          const mdPath = path.join(folderAbs, 'tasks.md');
          if (existsSync(mdPath)) {
            await fs.unlink(mdPath);
            deletedMd++;
          }
          if (alsoWipeTasksDir) {
            const tasksDir = path.join(folderAbs, 'tasks');
            if (existsSync(tasksDir)) {
              const items = await fs.readdir(tasksDir);
              for (const f of items) {
                const ext = path.extname(f).toLowerCase();
                if (ext === '.md' || ext === '.markdown') {
                  await fs.unlink(path.join(tasksDir, f));
                  deletedFiles++;
                }
              }
            }
          }
        } catch (e) { errors.push(`${rel}: ${e.message}`); }
      }
      return sendJSON(res, 200, { ok: true, deletedMd, deletedFiles, errors });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  if (pathname === '/api/vault/list-dir' && req.method === 'GET') {
    // Browse the filesystem to help pick a vault folder
    const requested = parsedUrl.searchParams.get('path') || os.homedir();
    const dir = expandPath(requested);
    try {
      const items = await fs.readdir(dir, { withFileTypes: true });
      const folders = items
        .filter(i => i.isDirectory() && !i.name.startsWith('.'))
        .map(i => ({
          name: i.name,
          path: path.join(dir, i.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      // Detect if this folder is itself a vault
      const isVault = items.some(i => i.name === '.obsidian' && i.isDirectory());
      return sendJSON(res, 200, {
        path: dir,
        parent: path.dirname(dir) === dir ? null : path.dirname(dir),
        folders,
        isVault,
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // ---- BTC price alerts ----
  if (pathname === '/api/btc/price' && req.method === 'GET') {
    // Devuelve el último snapshot cacheado y refresca si está viejo (>2 min)
    try {
      const fresh = !lastBtcSnapshot || (Date.now() - lastBtcSnapshot.fetchedAt) > 2 * 60 * 1000;
      if (fresh) lastBtcSnapshot = await fetchBtcPrice();
      return sendJSON(res, 200, { ok: true, snapshot: lastBtcSnapshot });
    } catch (e) {
      return sendJSON(res, 502, { error: e.message, snapshot: lastBtcSnapshot || null });
    }
  }

  if (pathname === '/api/btc/alerts' && req.method === 'GET') {
    const data = await readBtcAlerts();
    return sendJSON(res, 200, {
      alerts: data.alerts,
      log: (data.log || []).slice(0, 25),
      snapshot: lastBtcSnapshot,
      mailConfigured: !!(process.env.SMTP_USER && process.env.SMTP_PASS),
      mailProvider: 'gmail-smtp',
      mailFrom: process.env.SMTP_FROM || process.env.SMTP_USER || '',
      checkIntervalMs: BTC_CHECK_INTERVAL_MS,
    });
  }

  if (pathname === '/api/btc/alerts' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const target = Number(body.target);
      if (!Number.isFinite(target) || target <= 0) {
        return sendJSON(res, 400, { error: 'Precio objetivo inválido' });
      }
      const email = (body.email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return sendJSON(res, 400, { error: 'Email inválido' });
      }
      const direction = body.direction === 'above' ? 'above' : 'below';
      const cooldownHours = Number.isFinite(Number(body.cooldownHours))
        ? Math.max(0.25, Number(body.cooldownHours))
        : BTC_DEFAULT_COOLDOWN_H;
      const data = await readBtcAlerts();
      const alert = {
        id: newAlertId(),
        target,
        direction,
        email,
        active: body.active !== false,
        cooldownHours,
        note: (body.note || '').trim() || null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastTriggeredAt: null,
        lastTriggerPrice: null,
        triggerCount: 0,
      };
      data.alerts.push(alert);
      await writeBtcAlerts(data);
      return sendJSON(res, 200, { ok: true, alert });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  const btcAlertMatch = pathname.match(/^\/api\/btc\/alerts\/([a-z0-9_]+)$/i);
  if (btcAlertMatch) {
    const id = btcAlertMatch[1];
    const data = await readBtcAlerts();
    const idx = data.alerts.findIndex(a => a.id === id);
    if (idx < 0) return sendJSON(res, 404, { error: 'Alerta no encontrada' });

    if (req.method === 'PUT') {
      try {
        const body = await readBody(req);
        const a = data.alerts[idx];
        if (body.target !== undefined) {
          const t = Number(body.target);
          if (!Number.isFinite(t) || t <= 0) return sendJSON(res, 400, { error: 'Precio inválido' });
          a.target = t;
        }
        if (body.email !== undefined) {
          const e = (body.email || '').trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return sendJSON(res, 400, { error: 'Email inválido' });
          a.email = e;
        }
        if (body.direction !== undefined) a.direction = body.direction === 'above' ? 'above' : 'below';
        if (body.active !== undefined) a.active = !!body.active;
        if (body.cooldownHours !== undefined) {
          const c = Number(body.cooldownHours);
          if (Number.isFinite(c) && c > 0) a.cooldownHours = Math.max(0.25, c);
        }
        if (body.note !== undefined) a.note = (body.note || '').trim() || null;
        if (body.resetTriggered === true) {
          a.lastTriggeredAt = null;
          a.lastTriggerPrice = null;
        }
        a.updatedAt = Date.now();
        await writeBtcAlerts(data);
        return sendJSON(res, 200, { ok: true, alert: a });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }

    if (req.method === 'DELETE') {
      data.alerts.splice(idx, 1);
      await writeBtcAlerts(data);
      return sendJSON(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/btc/check' && req.method === 'POST') {
    // Forzar un check manual (útil para testear)
    try {
      const body = await readBody(req).catch(() => ({}));
      const result = await runBtcAlertCheck({ force: !!body.force });
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  if (pathname === '/api/btc/test-email' && req.method === 'POST') {
    // Enviar un email de prueba para validar SMTP
    try {
      const body = await readBody(req);
      const to = (body.to || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return sendJSON(res, 400, { error: 'Email inválido' });
      }
      let snapshot = lastBtcSnapshot;
      try { snapshot = await fetchBtcPrice(); lastBtcSnapshot = snapshot; }
      catch { snapshot = snapshot || { price: 0, change24h: null, fetchedAt: Date.now() }; }
      await sendBtcAlertEmail({
        to,
        alert: { direction: 'below', target: snapshot.price, note: 'Email de prueba — verifica que SMTP funciona.' },
        snapshot,
      });
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  return sendJSON(res, 404, { error: 'Not found' });
}

// ============================================================
// Static file serving
// ============================================================

async function serveStatic(req, res, parsedUrl) {
  let pathname = decodeURIComponent(parsedUrl.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, pathname);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// ============================================================
// Server boot
// ============================================================

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Password gate (only active if TEMPO_PASSWORD is set)
  if (TEMPO_PASSWORD) {
    const hdr = req.headers.authorization || '';
    const expected = 'Basic ' + Buffer.from('tempo:' + TEMPO_PASSWORD).toString('base64');
    if (hdr !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Tempo"' });
      return res.end('Necesitás contraseña');
    }
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  try {
    if (parsedUrl.pathname.startsWith('/api/')) {
      await handleApi(req, res, parsedUrl);
    } else {
      await serveStatic(req, res, parsedUrl);
    }
  } catch (e) {
    console.error('[server]', e);
    sendJSON(res, 500, { error: e.message });
  }
});

// CLI argument: optional vault path to pre-configure
const args = process.argv.slice(2);
if (args[0]) {
  const initial = expandPath(args[0]);
  if (initial && existsSync(initial)) {
    try {
      const stat = await fs.stat(initial);
      if (stat.isDirectory()) {
        await saveConfig({ vaultPath: initial });
        console.log(`  Vault preset to: ${initial}`);
      }
    } catch {}
  } else {
    console.warn(`  CLI vault path not found: ${args[0]}`);
  }
}

// En la nube (Render/Railway) hay que escuchar en 0.0.0.0; local sigue en 127.0.0.1.
const HOST = (process.env.PORT || DATABASE_URL) ? '0.0.0.0' : '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╭───────────────────────────────────────────╮');
  console.log('  │                                           │');
  console.log('  │   Tempo  ·  http://localhost:' + PORT + '         │');
  console.log('  │                                           │');
  console.log('  ╰───────────────────────────────────────────╯');
  console.log('');
  console.log('  Data folder:  ' + DATA_DIR);
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    console.log('  BTC Alerts:   Email listo vía Gmail SMTP (' + process.env.SMTP_USER + ')');
  } else {
    console.log('  BTC Alerts:   Email NO configurado — exportá SMTP_USER y SMTP_PASS');
  }
  console.log('  Press Ctrl+C to stop');
  console.log('');
});

// ---- BTC alerts: scheduler cada 10 minutos ----
let btcAlertsTimer = null;
function startBtcAlertsScheduler() {
  if (btcAlertsTimer) return;
  // Primera corrida: a los 30s para que el server esté caliente y dar tiempo a configurar
  setTimeout(() => {
    runBtcAlertCheck().catch(e => console.warn('[btc] check inicial:', e.message));
  }, 30_000);
  btcAlertsTimer = setInterval(() => {
    runBtcAlertCheck().catch(e => console.warn('[btc] check:', e.message));
  }, BTC_CHECK_INTERVAL_MS);
}
startBtcAlertsScheduler();

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error('  Either close the other Tempo instance, or run:');
    console.error(`  TEMPO_PORT=7778 node server.js\n`);
    process.exit(1);
  }
  throw e;
});

process.on('SIGINT', () => {
  console.log('\n  Stopping...');
  server.close(() => process.exit(0));
});
