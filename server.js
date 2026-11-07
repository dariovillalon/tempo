// Tempo Server
// Local-first productivity dashboard. Zero dependencies — uses only Node built-ins.

import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, createReadStream, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import crypto from 'node:crypto';
import { smtpSend } from './lib/smtp.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Minimal .env loader (sin dependencias): toma <app>/.env si existe.
// Las variables ya presentes en el entorno real tienen prioridad.
try {
  const envFile = path.join(__dirname, '.env');
  if (existsSync(envFile)) {
    for (const raw of readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      // PORT/HOST cambian la dirección de escucha (0.0.0.0): solo desde el
      // entorno real (Render/tunel), nunca desde un archivo local.
      if (m[1] === 'PORT' || m[1] === 'TEMPO_PORT' || m[1] === 'HOST') continue;
      let v = m[2].trim();
      if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
} catch { /* .env es opcional */ }

const PORT = parseInt(process.env.PORT || process.env.TEMPO_PORT || '7777', 10);
// Optional password protection — set TEMPO_PASSWORD to require a login.
// Useful when exposing tempo to the internet via a tunnel (ngrok / cloudflared / etc.).
const TEMPO_PASSWORD = process.env.TEMPO_PASSWORD || '';
// CORS: por defecto NO se emiten headers (la app es same-origin y no los necesita).
// Seteá ALLOWED_ORIGIN solo si un consumidor cross-origin legítimo lo requiere.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

// ============================================================
// Persistencia: archivo local por defecto; Postgres si hay DATABASE_URL.
// (En la nube se usa la DB; en tu máquina sigue todo con data/*.json)
// ============================================================
const DATABASE_URL = process.env.DATABASE_URL || '';

// Modo nube sin contraseña = estado + vault expuestos a internet. Cortar acá.
if (DATABASE_URL && !TEMPO_PASSWORD) {
  console.error('  ERROR: DATABASE_URL está configurada (modo nube) pero falta TEMPO_PASSWORD.');
  console.error('  Configurá TEMPO_PASSWORD para proteger la instancia y reiniciá.');
  process.exit(1);
}

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
// Insert-if-absent: para seeds. Devuelve la fila ganadora (la nuestra o la que
// otro escritor concurrente metió primero) — un upsert acá pisaría datos.
async function kvSeed(key, data) {
  const p = await pgPool(); if (!p) return data;
  const r = await p.query('INSERT INTO kv (key, data) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(data)]);
  if (r.rowCount === 1) return data;
  return (await kvGet(key)) ?? data;
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
    rev: 0, // contador monotónico para bloqueo optimista (409 en escrituras viejas)
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

// Mutex en proceso: serializa los read-modify-write del estado (el backend de
// archivo no tiene CAS, y Node intercala awaits entre getState y saveState).
let _stateChain = Promise.resolve();
function withStateLock(fn) {
  const run = _stateChain.then(fn, fn);
  _stateChain = run.catch(() => {});
  return run;
}

// Escritura condicional (CAS) para el backend Postgres: los scripts *-nube.mjs
// actualizan la fila kv por fuera del server, así que el compare va en SQL.
// Devuelve false si otro escritor pisó el estado (rev distinto al esperado).
async function saveStateChecked(state, expectedRev) {
  if (DATABASE_URL) {
    const p = await pgPool();
    const r = await p.query(
      "UPDATE kv SET data = $1 WHERE key = 'state' AND COALESCE((data->>'rev')::int, 0) = $2",
      [JSON.stringify(state), expectedRev]
    );
    return r.rowCount === 1;
  }
  await saveState(state); // atómico (tmp+rename); serializado por withStateLock
  return true;
}

// Escritura iniciada por el server (vault/import): no rechaza por rev, pero
// usa CAS con reintentos para no pisar a un escritor externo (scripts .mjs en pg).
// Devuelve el rev nuevo para que la respuesta HTTP se lo informe al cliente.
async function bumpStateWith(mutateFn) {
  return withStateLock(async () => {
    for (let i = 0; i < 3; i++) {
      const cur = await getState().catch(() => defaultState());
      const currentRev = Number.isInteger(cur.rev) ? cur.rev : 0;
      mutateFn(cur);
      cur.rev = currentRev + 1;
      if (await saveStateChecked(cur, currentRev)) return cur.rev;
    }
    throw new Error('el estado en la nube cambió repetidamente, no pude guardar');
  });
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
    } catch (e) {
      // Sin log la tarea desaparece del sync en silencio
      console.warn('[sync] task ilegible', it.name, '·', e.message);
    }
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
      // Si no se puede borrar, la tarea huérfana resucita en el próximo import
      try { await fs.unlink(path.join(tasksDir, f)); } catch (e) {
        console.warn('[sync] no pude borrar', f, '·', e.message);
      }
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
const icsCache = new Map(); // url -> { fetchedAt, body } | { fetchedAt, error }
const ICS_TTL_MS = 10 * 60 * 1000;
const ICS_ERR_RETRY_MS = 60 * 1000;

async function fetchICS(url) {
  const hit = icsCache.get(url);
  if (hit && (Date.now() - hit.fetchedAt) < (hit.ttl || ICS_TTL_MS)) {
    // Los fallos también se cachean: un calendario caído (404) no se re-pide
    // (ni frena Hoy/Agenda hasta 10s) en cada render durante el TTL.
    if (hit.error) throw Object.assign(new Error(hit.error), { cached: true });
    return hit.body;
  }
  let httpUrl = url;
  if (httpUrl.startsWith('webcal://')) httpUrl = 'https://' + httpUrl.slice('webcal://'.length);
  // Timeout vía AbortController (mismo patrón que fetchBtcPrice): cubre también
  // un body que se cuelga a mitad de descarga, no solo los headers.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(httpUrl, { redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) {
      res.body?.cancel().catch(() => {}); // liberar el socket sin esperar al GC
      throw new Error(`ICS fetch ${res.status}`);
    }
    const body = await res.text();
    icsCache.set(url, { fetchedAt: Date.now(), body });
    return body;
  } catch (e) {
    const error = e.message || String(e);
    // 4xx (calendario borrado o privado) es permanente: TTL completo. Timeout,
    // red o 5xx: reintentar en 1 min, que un tropiezo no esconda la agenda 10 min.
    const ttl = /^ICS fetch 4\d\d$/.test(error) ? ICS_TTL_MS : ICS_ERR_RETRY_MS;
    icsCache.set(url, { fetchedAt: Date.now(), error, ttl });
    throw e;
  } finally {
    clearTimeout(t);
  }
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
      case 'RECURRENCE-ID': {
        // Instancia puntual modificada de un evento recurrente (p.ej. reunión movida):
        // este VEVENT reemplaza al slot original de la serie.
        const d = parseICSDate(right, params);
        if (d) cur.recurrenceId = d.date.getTime();
        break;
      }
      case 'EXDATE': {
        // Puede traer múltiples fechas separadas por coma en una sola línea
        for (const v of right.split(',')) {
          const d = parseICSDate(v.trim(), params);
          if (d) cur.exdates.push(d.date.getTime());
        }
        break;
      }
      case 'STATUS': cur.status = right; break;
    }
  }
  return events;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BYDAY_MAP = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Inicio de semana en hora local, para aplicar INTERVAL en reglas WEEKLY+BYDAY.
// wkst: día de inicio de semana según RFC 5545 (default MO = 1).
function startOfWeekMs(d, wkst) {
  const diff = (d.getDay() - wkst + 7) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff).getTime();
}

// Expand recurring events into instances within [from, to).
function expandEvents(events, from, to) {
  const out = [];
  // Overrides con RECURRENCE-ID: al expandir el RRULE hay que saltear esos
  // slots (el VEVENT modificado se emite solo por la rama sin rrule) para no
  // mostrar la reunión dos veces (horario viejo + horario nuevo).
  const overrides = new Set();
  for (const e of events) {
    if (e.uid && e.recurrenceId != null) overrides.add(e.uid + '|' + e.recurrenceId);
  }
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
    const wkst = BYDAY_MAP[(r.WKST || 'MO').toUpperCase()] ?? 1;

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
        // INTERVAL con BYDAY: solo emitir en las semanas que tocan (p.ej. un
        // evento bisemanal no debe aparecer todas las semanas).
        if (emit && byday && interval > 1) {
          const weeks = Math.round((startOfWeekMs(cursor, wkst) - startOfWeekMs(e.start, wkst)) / (7 * DAY_MS));
          if (weeks % interval !== 0) emit = false;
        }
      } else if (freq === 'MONTHLY') emit = true;
      else if (freq === 'YEARLY') emit = true;

      if (emit) {
        const t = cursor.getTime();
        if (!e.exdates.includes(t)) {
          if (e.uid && overrides.has(e.uid + '|' + t)) {
            // Slot reemplazado por un VEVENT con RECURRENCE-ID: cuenta como
            // ocurrencia (para COUNT) pero no se emite desde la serie.
            produced++;
          } else {
            const inst = new Date(cursor);
            if (inst < to && new Date(inst.getTime() + dur) > from) {
              out.push(makeInstance(e, inst, dur));
            }
            produced++;
          }
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
    } catch (e) {
      // Sin log la nota desaparece del listado en silencio
      console.warn('[notes] nota ilegible', id, '·', e.message);
    }
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
// Persistencia: data/btc-alerts.json en local; fila kv 'btc-alerts' en modo
// nube (DATABASE_URL) — el filesystem de Render es efímero y las alertas
// morían en cada deploy. Cada alerta tiene:
//   { id, target, direction:'below'|'above', email, active, cooldownHours,
//     createdAt, updatedAt, lastTriggeredAt, lastTriggerPrice, triggerCount, note }
// El scheduler corre cada CHECK_INTERVAL_MS y consulta CoinGecko.
// Cuando se cumple la condición y pasó el cooldown, dispara un email SMTP.
// ============================================================

const BTC_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 min
const BTC_DEFAULT_COOLDOWN_H = 6;
const BTC_REARM_PCT = 0.01; // histéresis: re-armar cuando el precio vuelve 1% al lado seguro del target
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true';

let lastBtcSnapshot = null; // { price, change24h, fetchedAt, source }
let smtpFailCount = 0;      // fallos SMTP consecutivos
let smtpBackoffUntil = 0;   // no reintentar envíos antes de este timestamp
const SMTP_BACKOFF_MAX_MS = 6 * 3600 * 1000; // tope del backoff exponencial: 6 h

const BTC_LOG_MAX = 200; // tope del log persistido (newest-first) para que la fila kv no crezca sin límite

// mailVia 'mac': Render gratis bloquea SMTP, así que la alerta deja el mail armado
// como pendiente y lo manda la Mac (mails-mac.mjs, launchd cada 5 min). En local,
// sin DATABASE_URL, el default sigue siendo mandar por SMTP desde el server.
const btcDefaultMailVia = () => (DATABASE_URL ? 'mac' : 'server');
function normalizeBtcAlerts(data) {
  const mailVia = data?.mailVia === 'mac' || data?.mailVia === 'server' ? data.mailVia : btcDefaultMailVia();
  if (!data || !Array.isArray(data.alerts)) return { alerts: [], log: [], mailVia };
  return { alerts: data.alerts, log: Array.isArray(data.log) ? data.log : [], mailVia };
}

// Serializa read-modify-write de la fila 'btc-alerts' (scheduler + resultados de la Mac)
let btcChain = Promise.resolve();
function withBtcLock(fn) {
  const run = btcChain.then(fn, fn);
  btcChain = run.catch(() => {});
  return run;
}
const BTC_MAIL_TTL_MS = 24 * 3600 * 1000; // una alerta de precio de hace más de un día ya no sirve
// Único de verdad: alimenta el log y la clave del diario de la Mac (un id repetido
// dejaría un mail reenviándose cada 5 min).
const btcMailId = () => 'b_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);

async function readBtcAlertsFile() {
  try {
    return normalizeBtcAlerts(JSON.parse(await fs.readFile(BTC_ALERTS_FILE, 'utf-8')));
  } catch {
    return { alerts: [], log: [] };
  }
}

async function readBtcAlerts() {
  if (DATABASE_URL) {
    const row = await kvGet('btc-alerts');
    if (row !== undefined) return normalizeBtcAlerts(row);
    // Seed único: la fila kv todavía no existe. Si el deploy trae un
    // data/btc-alerts.json con datos (bundle viejo), migrarlo; si no, arrancar
    // vacío. kvSeed es insert-if-absent: si otro request/scheduler seedeó (o
    // escribió una alerta) mientras leíamos el archivo, gana esa fila.
    const seed = await readBtcAlertsFile();
    return normalizeBtcAlerts(await kvSeed('btc-alerts', seed));
  }
  return readBtcAlertsFile();
}

async function writeBtcAlerts(data) {
  // Cap del log (newest-first por unshift): conservar solo los más recientes.
  if (Array.isArray(data.log) && data.log.length > BTC_LOG_MAX) data.log.length = BTC_LOG_MAX;
  if (DATABASE_URL) { await kvSet('btc-alerts', data); return; }
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

// Cliente SMTP mínimo (TLS implícito, puerto 465): lib/smtp.mjs, compartido con vuelos-tempo.mjs.

function buildBtcAlertEmail({ to, alert, snapshot }) {
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
  return { to, subject, text: lines.join('\n') };
}

async function sendBtcAlertEmail({ to, alert, snapshot }) {
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  if (!user || !pass) throw new Error('SMTP_USER y SMTP_PASS no configurados (App Password de Gmail)');
  const mail = buildBtcAlertEmail({ to, alert, snapshot });
  return smtpSend({
    host: 'smtp.gmail.com', port: 465, user, pass,
    from: { address: process.env.SMTP_FROM || user, name: 'Tempo BTC Alerts' },
    to: mail.to, subject: mail.subject, text: mail.text,
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

  return withBtcLock(async () => {
  const data = await readBtcAlerts();
  if (!data.log) data.log = [];
  let changed = false;
  const now = Date.now();
  const fired = [];

  for (const alert of data.alerts) {
    // Histéresis: tras disparar, la alerta queda desarmada (armed=false) hasta
    // que el precio se aleje BTC_REARM_PCT del target hacia el lado seguro.
    // Alertas viejas sin el campo se tratan como armadas (=== false, no !).
    if (alert.armed === false) {
      const target = Number(alert.target);
      const rearm = alert.direction === 'above'
        ? snapshot.price <= target * (1 - BTC_REARM_PCT)
        : snapshot.price >= target * (1 + BTC_REARM_PCT);
      if (rearm) { alert.armed = true; changed = true; }
    }
    if (!alertShouldFire(alert, snapshot.price)) continue;
    if (!force && alert.armed === false) continue;
    const cooldownMs = (alert.cooldownHours ?? BTC_DEFAULT_COOLDOWN_H) * 3600 * 1000;
    const since = alert.lastTriggeredAt ? (now - alert.lastTriggeredAt) : Infinity;
    if (!force && since < cooldownMs) continue;
    if (data.mailVia === 'mac') {
      // El mail queda armado (con el precio de este momento) y lo manda la Mac
      alert.lastTriggeredAt = now;
      alert.lastTriggerPrice = snapshot.price;
      alert.triggerCount = (alert.triggerCount || 0) + 1;
      alert.armed = false;
      data.log.unshift({
        id: btcMailId(), ts: now, alertId: alert.id, price: snapshot.price,
        target: alert.target, direction: alert.direction, email: alert.email,
        ok: false, pending: true, via: 'mac',
        mail: buildBtcAlertEmail({ to: alert.email, alert, snapshot }),
      });
      fired.push(alert.id);
      changed = true;
      continue;
    }
    // Backoff exponencial por fallos SMTP consecutivos (Date.now() y no `now`:
    // el primer fallo del ciclo suprime los envíos restantes del mismo ciclo).
    if (!force && Date.now() < smtpBackoffUntil) continue;
    try {
      await sendBtcAlertEmail({ to: alert.email, alert, snapshot });
      alert.lastTriggeredAt = now;
      alert.lastTriggerPrice = snapshot.price;
      alert.triggerCount = (alert.triggerCount || 0) + 1;
      alert.armed = false; // desarmada hasta que el precio se aleje del target
      smtpFailCount = 0;
      smtpBackoffUntil = 0;
      data.log.unshift({
        ts: now, alertId: alert.id, price: snapshot.price,
        target: alert.target, direction: alert.direction,
        email: alert.email, ok: true,
      });
      fired.push(alert.id);
      changed = true;
    } catch (e) {
      console.warn('[btc] envío email falló para', alert.email, '·', e.message);
      // Nota: NO desarmamos la alerta acá — un envío fallido debe reintentarse
      // cuando venza el backoff (10min, 20min, 40min... tope 6h).
      smtpFailCount++;
      smtpBackoffUntil = Date.now() + Math.min(
        BTC_CHECK_INTERVAL_MS * 2 ** (smtpFailCount - 1),
        SMTP_BACKOFF_MAX_MS,
      );
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
  return { ok: true, snapshot, fired, smtpBackoffUntil: smtpBackoffUntil || null, mailVia: data.mailVia };
  });
}

// ============================================================
// Vuelos: ofertas validadas + alertas por email
// ------------------------------------------------------------
// El server NO busca precios. Los valida una tarea diaria de Claude en la Mac
// de Dario (Chrome, hasta la página de pago del vendedor) y los manda con
// POST /api/flights/report (ver VUELOS-ALERTAS.md y vuelos-tempo.mjs).
// Acá se guardan, se arma el historial y se manda el mail cuando una oferta
// es "muy buena" (precio validado X% debajo del piso del rango normal de
// Google, o debajo del tope en USD del seguimiento).
// Persistencia: data/flights.json local; fila kv 'flights' en la nube.
// Este proceso es el único escritor de esa fila y serializa sus escrituras
// con withFlightsLock (Render corre una sola instancia).
// ============================================================

const FLIGHTS_FILE = path.join(DATA_DIR, 'flights.json');
const FLIGHTS_HISTORY_MAX = 120;  // puntos por seguimiento
const FLIGHTS_RUNS_MAX = 60;
const FLIGHTS_LOG_MAX = 100;
const FLIGHTS_DEALS_MAX = 80;
const FLIGHTS_REPORT_MAX_DEALS = 50;
const FLIGHTS_CHECKED_MAX = 50;
const FLIGHTS_DEFAULT_EMAIL = 'dariovillalon17@gmail.com';
const FLIGHTS_REALERT_DROP = 0.03;          // re-avisar si baja 3% más que el último aviso
const FLIGHTS_REALERT_AFTER_MS = 7 * 86400000; // o si pasó una semana del último aviso
const FLIGHTS_MAIL_RETRY_MS = 7 * 86400000;   // un mail que no salió se reintenta desde la Mac durante una semana
const IATA_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const FLIGHTS_DEFAULT_WATCHES = [
  ['BUE', 'PUJ', 'Punta Cana',  'caribe', true],
  ['BUE', 'CUN', 'Cancún',      'caribe', true],
  ['COR', 'CUN', 'Cancún',      'caribe', true],
  ['BUE', 'AUA', 'Aruba',       'caribe', true],
  ['COR', 'PUJ', 'Punta Cana',  'caribe', true],
  ['BUE', 'MIA', 'Miami',       'eeuu',   true],
  ['BUE', 'LIS', 'Lisboa',      'europa', true, '2027-02-01'],
  ['BUE', 'BCN', 'Barcelona',   'europa', true],
].map(([origin, dest, destName, region, beach, from = '2027-03-01']) => ({
  id: `w_${origin}_${dest}`.toLowerCase(),
  kind: 'roundtrip',
  origin, dest, destName, region, beach,
  window: { from, to: '2027-06-30' },
  nights: { min: 7, max: 14 },
  everyDays: 2,
  maxUsd: null,
  active: true,
  note: null,
  lastCheckedAt: null,
  lastAlert: null,
}));

function flightsDefaults() {
  return {
    // mailVia 'mac': Render gratis bloquea SMTP (25/465/587), así que el server deja
    // el mail pendiente y lo manda vuelos-tempo.mjs desde la Mac. 'server' = SMTP acá.
    settings: { email: FLIGHTS_DEFAULT_EMAIL, alertPct: 15, paused: false, mailVia: 'mac' },
    watches: FLIGHTS_DEFAULT_WATCHES.map(w => ({ ...w })),
    deals: [],
    history: {},
    runs: [],
    log: [],
    stats: { mailsSent: 0 },
  };
}

function normalizeFlights(data) {
  const d = flightsDefaults();
  if (!data || typeof data !== 'object') return d;
  const s = data.settings && typeof data.settings === 'object' ? data.settings : {};
  return {
    settings: {
      email: typeof s.email === 'string' && s.email ? s.email : d.settings.email,
      alertPct: Number.isFinite(Number(s.alertPct)) ? Number(s.alertPct) : d.settings.alertPct,
      paused: !!s.paused,
      mailVia: s.mailVia === 'server' ? 'server' : 'mac',
    },
    watches: Array.isArray(data.watches) ? data.watches : d.watches,
    deals: Array.isArray(data.deals) ? data.deals : [],
    history: data.history && typeof data.history === 'object' && !Array.isArray(data.history) ? data.history : {},
    runs: Array.isArray(data.runs) ? data.runs : [],
    log: Array.isArray(data.log) ? data.log : [],
    stats: { mailsSent: Number(data.stats?.mailsSent) || 0 },
  };
}

async function readFlightsFile() {
  try { return JSON.parse(await fs.readFile(FLIGHTS_FILE, 'utf-8')); }
  catch { return null; }
}

async function readFlights() {
  if (DATABASE_URL) {
    const row = await kvGet('flights');
    if (row !== undefined) return normalizeFlights(row);
    return normalizeFlights(await kvSeed('flights', normalizeFlights(await readFlightsFile())));
  }
  return normalizeFlights(await readFlightsFile());
}

async function writeFlights(data) {
  if (data.runs.length > FLIGHTS_RUNS_MAX) data.runs.length = FLIGHTS_RUNS_MAX;
  if (data.log.length > FLIGHTS_LOG_MAX) data.log.length = FLIGHTS_LOG_MAX;
  if (data.deals.length > FLIGHTS_DEALS_MAX) data.deals.length = FLIGHTS_DEALS_MAX;
  for (const k of Object.keys(data.history)) {
    const h = data.history[k];
    if (Array.isArray(h) && h.length > FLIGHTS_HISTORY_MAX) h.splice(0, h.length - FLIGHTS_HISTORY_MAX);
  }
  if (DATABASE_URL) { await kvSet('flights', data); return; }
  const tmp = FLIGHTS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, FLIGHTS_FILE);
}

// Serializa read-modify-write de la fila 'flights' dentro de este proceso.
let flightsChain = Promise.resolve();
function withFlightsLock(fn) {
  const run = flightsChain.then(fn, fn);
  flightsChain = run.catch(() => {});
  return run;
}

const fStr = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : (v == null ? null : String(v).slice(0, max))) || null;
const fNum = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
const fUrl = (v) => {
  const s = fStr(v, 1000);
  if (!s) return null;
  try { const u = new URL(s); return (u.protocol === 'https:' || u.protocol === 'http:') ? u.toString() : null; }
  catch { return null; }
};
const fIata = (v) => { const s = typeof v === 'string' ? v.trim().toUpperCase() : ''; return IATA_RE.test(s) ? s : null; };
// Ids en el mismo alfabeto que acepta DELETE /api/flights/deals/:id
const slugId = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
const fDate = (v) => { const s = fStr(v, 10); return s && DATE_RE.test(s) ? s : null; };
const fTs = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

function sanitizeWatchInput(body, base) {
  const w = base ? { ...base } : {
    id: 'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'roundtrip', region: null, beach: false, active: true, note: null,
    window: { from: null, to: null }, nights: { min: 7, max: 14 }, everyDays: 2, maxUsd: null,
    lastCheckedAt: null, lastAlert: null,
  };
  if (body.origin !== undefined) { const o = fIata(body.origin); if (!o) throw new Error('Origen inválido (código IATA de 3 letras)'); w.origin = o; }
  if (body.dest !== undefined) { const d = fIata(body.dest); if (!d) throw new Error('Destino inválido (código IATA de 3 letras)'); w.dest = d; }
  if (!w.origin || !w.dest) throw new Error('Falta origen o destino');
  if (body.destName !== undefined) w.destName = fStr(body.destName, 60) || w.dest;
  if (!w.destName) w.destName = w.dest;
  if (body.kind !== undefined) w.kind = body.kind === 'multi' ? 'multi' : 'roundtrip';
  if (body.region !== undefined) w.region = ['caribe', 'eeuu', 'europa', 'brasil', 'otro'].includes(body.region) ? body.region : 'otro';
  if (body.beach !== undefined) w.beach = !!body.beach;
  if (body.active !== undefined) w.active = !!body.active;
  if (body.note !== undefined) w.note = fStr(body.note, 300);
  if (body.window !== undefined) {
    const from = fDate(body.window?.from), to = fDate(body.window?.to);
    if (!from || !to || from > to) throw new Error('Ventana de fechas inválida');
    w.window = { from, to };
  }
  if (body.nights !== undefined) {
    const min = Math.round(fNum(body.nights?.min) ?? 0), max = Math.round(fNum(body.nights?.max) ?? 0);
    if (min < 1 || max < min || max > 60) throw new Error('Noches inválidas');
    w.nights = { min, max };
  }
  if (body.everyDays !== undefined) {
    const e = Math.round(fNum(body.everyDays) ?? 0);
    if (e < 1 || e > 30) throw new Error('Frecuencia inválida (1 a 30 días)');
    w.everyDays = e;
  }
  if (body.maxUsd !== undefined) w.maxUsd = body.maxUsd === null || body.maxUsd === '' ? null : fNum(body.maxUsd);
  return w;
}

// Devuelve { deal } o { error }. Una oferta sin seguimiento ni id recibe un
// id estable derivado de sus tramos, así el re-aviso y el reemplazo funcionan.
function sanitizeDeal(raw, nowTs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'la oferta no es un objeto' };
  const priceUsd = fNum(raw.priceUsd);
  if (priceUsd == null || priceUsd <= 0) {
    return { error: 'priceUsd tiene que ser un número JSON mayor a 0, con punto decimal (ej. 558.9)' };
  }
  const legs = (Array.isArray(raw.legs) ? raw.legs : []).slice(0, 8).map(l => ({
    from: fIata(l?.from), to: fIata(l?.to), date: fDate(l?.date),
    times: fStr(l?.times, 60), airline: fStr(l?.airline, 80), flight: fStr(l?.flight, 60),
    stops: fStr(l?.stops, 80), seller: fStr(l?.seller, 60), priceUsd: fNum(l?.priceUsd),
  })).filter(l => l.from && l.to);
  const kind = raw.kind === 'multi' ? 'multi' : 'roundtrip';
  if (kind === 'multi' && legs.length < 2) return { error: 'una oferta multi necesita al menos 2 tramos con códigos IATA' };
  let normal = null;
  if (raw.normal && typeof raw.normal === 'object') {
    const lo = fNum(raw.normal.lo), hi = fNum(raw.normal.hi);
    if (lo && hi && hi >= lo) normal = { lo, hi, label: fStr(raw.normal.label, 200) };
  }
  // Los multi no se cuelgan de un seguimiento de ida y vuelta
  const watchId = kind === 'roundtrip' ? fStr(raw.watchId, 80) : null;
  let id = raw.id != null ? slugId(fStr(raw.id, 120) || '') : '';
  if (!id && watchId) id = slugId(watchId);
  if (!id && legs.length) {
    id = slugId((kind === 'multi' ? 'm_' : 'd_') + legs.map(l => `${l.from}${l.to}${(l.date || '').replace(/-/g, '')}`).join('_'));
  }
  if (!id) return { error: 'falta id (o watchId, o tramos para derivarlo)' };
  return { deal: {
    id,
    watchId,
    kind,
    title: fStr(raw.title, 120),
    origin: fIata(raw.origin) || legs[0]?.from || null,
    dest: fIata(raw.dest) || legs[0]?.to || null,
    destName: fStr(raw.destName, 60),
    legs,
    priceUsd,
    approx: !!raw.approx,
    priceArs: fNum(raw.priceArs),
    seller: fStr(raw.seller, 60),
    fare: fStr(raw.fare, 80),
    seatsLeft: fStr(raw.seatsLeft, 120),
    baggage: fStr(raw.baggage, 200),
    normal,
    maxUsd: fNum(raw.maxUsd) || null,
    googleNote: fStr(raw.googleNote, 300),
    beach: !!raw.beach,
    region: fStr(raw.region, 20),
    notes: (Array.isArray(raw.notes) ? raw.notes : []).slice(0, 6).map(n => fStr(n, 300)).filter(Boolean),
    links: (Array.isArray(raw.links) ? raw.links : []).slice(0, 4)
      .map(l => ({ label: fStr(l?.label, 60) || 'Ver', url: fUrl(l?.url) })).filter(l => l.url),
    evidence: fStr(raw.evidence, 1000),
    validated: raw.validated !== false,
    validatedAt: fTs(raw.validatedAt) ?? nowTs,
  } };
}

function dealVerdict(deal) {
  if (!deal.normal) return 'sin-ref';
  if (deal.priceUsd < deal.normal.lo) return 'bajo';
  if (deal.priceUsd > deal.normal.hi) return 'alto';
  return 'normal';
}

// "Muy buena": validada y X% debajo del piso normal, o debajo del tope del seguimiento.
function dealIsGreat(deal, watch, alertPct) {
  if (!deal.validated) return false;
  const cap = watch?.maxUsd ?? deal.maxUsd;
  if (cap && deal.priceUsd <= cap) return true;
  if (!deal.normal) return false;
  return deal.priceUsd <= deal.normal.lo * (1 - alertPct / 100);
}

function shouldRealert(lastAlert, deal, nowTs) {
  if (!lastAlert || !Number.isFinite(lastAlert.priceUsd)) return true;
  if (deal.priceUsd <= lastAlert.priceUsd * (1 - FLIGHTS_REALERT_DROP)) return true;
  return (nowTs - (lastAlert.ts || 0)) > FLIGHTS_REALERT_AFTER_MS;
}

const fmtUsd = (n) => 'USD ' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 });
const fmtArs = (n) => 'ARS ' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 0 });

function flightsEmailText(deals) {
  const out = [deals.length === 1 ? 'Apareció un vuelo muy barato.' : `Aparecieron ${deals.length} vuelos muy baratos.`, ''];
  for (const d of deals) {
    const route = d.legs.length ? d.legs.map(l => `${l.from}→${l.to}`).join(', ') : `${d.origin}→${d.dest}`;
    out.push(`■ ${d.title || route}`);
    out.push(`  Precio:   ${d.approx ? '≈ ' : ''}${fmtUsd(d.priceUsd)}${d.priceArs ? ` (${fmtArs(d.priceArs)})` : ''} ${d.kind === 'multi' ? 'total del multidestino' : 'ida y vuelta'}, 1 adulto`);
    if (d.normal) {
      const pct = Math.round((1 - d.priceUsd / d.normal.lo) * 100);
      out.push(`  Normal:   ${fmtUsd(d.normal.lo)}–${fmtUsd(d.normal.hi).replace('USD ', '')} según Google${pct > 0 ? ` (${pct}% debajo del piso)` : ''}`);
    }
    for (const l of d.legs) {
      out.push(`  Tramo:    ${l.from}→${l.to} ${l.date || ''} ${l.airline || ''}${l.stops ? ' · ' + l.stops : ''}`.trimEnd());
    }
    if (d.seller) out.push(`  Dónde:    ${d.seller}${d.fare ? ' · tarifa ' + d.fare : ''}`);
    if (d.seatsLeft) out.push(`  Asientos: ${d.seatsLeft}`);
    for (const l of d.links) out.push(`  ${l.label}: ${l.url}`);
    out.push(`  Validado: ${new Date(d.validatedAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);
    out.push('');
  }
  out.push('Los precios cambian rápido: confirmalo en la página antes de pagar.');
  out.push('', '— Tempo · Vuelos');
  return out.join('\n');
}

function buildFlightsEmail(to, deals) {
  const d0 = deals[0];
  const pct = d0.normal ? Math.round((1 - d0.priceUsd / d0.normal.lo) * 100) : null;
  const subject = deals.length === 1
    ? `Vuelo barato: ${d0.title || `${d0.origin}→${d0.dest}`} ${fmtUsd(d0.priceUsd)}${pct > 0 ? ` (−${pct}%)` : ''}`
    : `${deals.length} vuelos baratos · desde ${fmtUsd(Math.min(...deals.map(d => d.priceUsd)))}`;
  return { to, subject, text: flightsEmailText(deals) };
}

async function sendFlightsEmail(to, deals) {
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  if (!user || !pass) throw new Error('SMTP_USER y SMTP_PASS no configurados (App Password de Gmail)');
  const mail = buildFlightsEmail(to, deals);
  return smtpSend({
    host: 'smtp.gmail.com', port: 465, user, pass,
    from: { address: process.env.SMTP_FROM || user, name: 'Tempo Vuelos' },
    to: mail.to, subject: mail.subject, text: mail.text,
  });
}

// Mails de alerta que todavía no salieron: los nuevos con mailVia 'mac' y los que
// fallaron por SMTP (incluye entradas viejas sin `pending`). Vencen a la semana.
const flightsLogId = (l) => l.id || ('m_' + Number(l.ts).toString(36));
function pendingFlightMails(data, nowTs) {
  return data.log.filter(l => !l.ok && !l.resolved && Array.isArray(l.deals) && l.deals.length
    && nowTs - l.ts < FLIGHTS_MAIL_RETRY_MS);
}

// Qué mails pendientes mandar y cuáles retirar. data.log va del más nuevo al más
// viejo: una oferta va solo en el aviso más nuevo que la incluye (nada de mails
// repetidos), y solo si sigue siendo "muy buena" a un precio no más de 3% arriba
// del avisado (nunca "Vuelo barato" con un precio que ya no lo es). Se arma con la
// oferta vigente (links y precio de hoy). Es solo lectura: los avisos a retirar
// vuelven en `stale` y el CLI los cierra con mail-result {resolve: true}.
function planPendingMails(data, nowTs) {
  const watchById = new Map(data.watches.map(w => [w.id, w]));
  const covered = new Set();
  const mails = [], stale = [];
  for (const l of pendingFlightMails(data, nowTs)) {
    const id = flightsLogId(l);
    const fresh = [];
    let reason = null;
    for (const x of l.deals) {
      if (covered.has(x.id)) continue;
      const d = data.deals.find(dd => dd.id === x.id);
      if (!d) { reason ||= 'la oferta ya no existe'; continue; }
      const w = d.watchId ? watchById.get(d.watchId) : null;
      const still = dealIsGreat(d, w, data.settings.alertPct)
        && d.priceUsd <= Number(x.priceUsd) * (1 + FLIGHTS_REALERT_DROP);
      if (!still) { reason ||= 'ya no es barato'; continue; }
      fresh.push(d);
    }
    if (!fresh.length) { stale.push({ id, reason: reason || 'ya salió en un aviso más nuevo' }); continue; }
    for (const d of fresh) covered.add(d.id);
    mails.push({ id, fromName: 'Tempo Vuelos', ...buildFlightsEmail(l.to, fresh) });
  }
  return { mails, stale };
}

function dueWatches(data, nowTs) {
  return data.watches.filter(w => w.active && (
    !w.lastCheckedAt || (nowTs - w.lastCheckedAt) >= (w.everyDays || 2) * 86400000 - 3 * 3600000
  ));
}

// Integra un reporte de la tarea diaria. Devuelve el resumen para la tarea
// (que decide el push con `alerts`). Idempotente por runId: el CLI reintenta
// el POST si se corta la respuesta y no queremos historial ni avisos dobles.
async function applyFlightsReport(body) {
  return withFlightsLock(async () => {
    const nowTs = Date.now();
    const data = await readFlights();
    const runId = fStr(body.runId, 80);
    if (runId) {
      const prev = data.runs.find(r => r.runId === runId);
      if (prev?.response) return { ...prev.response, duplicate: true };
    }
    const watchById = new Map(data.watches.map(w => [w.id, w]));
    const known = (id) => !!id && watchById.has(id);

    const rejected = [];
    const accepted = [];
    (Array.isArray(body.deals) ? body.deals.slice(0, FLIGHTS_REPORT_MAX_DEALS) : []).forEach((raw, index) => {
      const r = sanitizeDeal(raw, nowTs);
      if (r.error) rejected.push({ index, watchId: fStr(raw?.watchId, 80), reason: r.error });
      else accepted.push(r.deal);
    });
    // Un watchId que no existe no se guarda (historial y vista quedan limpios)
    for (const d of accepted) if (d.watchId && !known(d.watchId)) d.watchId = null;
    // Una sola oferta por seguimiento (o por id) en cada reporte: la más barata
    const byKey = new Map();
    for (const d of accepted) {
      const key = d.watchId ? 'w:' + d.watchId : 'id:' + d.id;
      const prev = byKey.get(key);
      if (!prev || d.priceUsd < prev.priceUsd) byKey.set(key, d);
    }
    const deals = [...byKey.values()];

    const checked = new Set();
    for (const x of (Array.isArray(body.checked) ? body.checked.slice(0, FLIGHTS_CHECKED_MAX) : [])) {
      const id = fStr(x, 80); if (known(id)) checked.add(id);
    }
    const failures = (Array.isArray(body.failures) ? body.failures : []).slice(0, 30)
      .map(f => ({ watchId: fStr(f?.watchId, 80), reason: fStr(f?.reason, 300) }));
    for (const f of failures) if (known(f.watchId)) checked.add(f.watchId);

    const great = [];
    for (const d of deals) {
      d.verdict = dealVerdict(d);
      const w = d.watchId ? watchById.get(d.watchId) : null;
      const prevDeal = data.deals.find(x => x.id === d.id);
      // El tope de un multi lo fija Dario una vez; la tarea no tiene por qué repetirlo
      if (!w && d.maxUsd == null && prevDeal?.maxUsd) d.maxUsd = prevDeal.maxUsd;
      if (w) {
        checked.add(w.id);
        if (!d.destName) d.destName = w.destName;
        if (!d.beach && w.beach) d.beach = true;
        if (!d.region) d.region = w.region;
        (data.history[w.id] ||= []).push({
          ts: d.validatedAt, priceUsd: d.priceUsd,
          out: d.legs[0]?.date || null, ret: d.legs[d.legs.length - 1]?.date || null,
          verdict: d.verdict,
        });
      }
      d.great = dealIsGreat(d, w, data.settings.alertPct);
      const last = w ? w.lastAlert : prevDeal?.lastAlert;
      d.lastAlert = last || null;
      if (d.great && !data.settings.paused && shouldRealert(last, d, nowTs)) great.push({ d, w });
      data.deals = data.deals.filter(x => x.id !== d.id && (!w || x.watchId !== w.id));
      data.deals.unshift(d);
    }
    // Una ruta cuya oferta vino rota no cuenta como chequeada: que se reintente
    for (const r of rejected) if (r.watchId && !deals.some(d => d.watchId === r.watchId)) checked.delete(r.watchId);
    for (const id of checked) watchById.get(id).lastCheckedAt = nowTs;

    // El aviso queda registrado aunque el mail no salga todavía: el push de la tarea
    // lo entrega igual y así no se repite cada corrida. Con mailVia 'mac' el mail
    // queda pendiente y lo manda vuelos-tempo.mjs (Render gratis bloquea SMTP).
    let emailed = false, emailError = null;
    const alertDeals = great.map(g => g.d);
    if (alertDeals.length) {
      const to = data.settings.email;
      const entry = {
        id: 'm_' + nowTs.toString(36), ts: nowTs, to, ok: false, error: null, pending: true,
        via: data.settings.mailVia, runId,
        deals: alertDeals.map(d => ({ id: d.id, title: d.title, priceUsd: d.priceUsd })),
      };
      if (data.settings.mailVia === 'server') {
        try {
          await sendFlightsEmail(to, alertDeals);
          emailed = true;
          Object.assign(entry, { ok: true, pending: false, resolved: true, sentAt: Date.now() });
          data.stats.mailsSent += 1;
        } catch (e) {
          emailError = e.message;
          entry.error = e.message;
          console.warn('[flights] mail falló (queda pendiente para la Mac):', e.message);
        }
      }
      for (const g of great) {
        const la = { ts: nowTs, priceUsd: g.d.priceUsd, mailed: emailed };
        if (g.w) g.w.lastAlert = la;
        g.d.lastAlert = la;
      }
      data.log.unshift(entry);
    }

    const response = {
      ok: true,
      stored: deals.length,
      rejected,
      alerts: alertDeals.map(d => ({
        id: d.id, kind: d.kind, title: d.title, priceUsd: d.priceUsd, approx: d.approx,
        normalLo: d.normal?.lo ?? null, seller: d.seller,
        dates: d.legs.map(l => l.date).filter(Boolean),
      })),
      emailed, emailError,
      mailPending: alertDeals.length > 0 && !emailed,
      mailId: alertDeals.length ? data.log[0].id : null,
    };
    data.runs.unshift({
      ts: nowTs,
      runId,
      startedAt: fTs(body.runAt),
      checked: [...checked],
      validated: deals.length,
      rejected: rejected.length,
      alerts: alertDeals.length,
      emailed,
      failures,
      note: fStr(body.note, 500),
      response,
    });
    await writeFlights(data);
    return response;
  });
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
      // Bloqueo optimista: el cliente manda `rev` (top-level del body, con
      // fallback a incoming.rev). Sin rev = cliente legacy → se acepta.
      const clientRev = Number.isInteger(body.rev) ? body.rev
                      : (Number.isInteger(incoming.rev) ? incoming.rev : null);
      const result = await withStateLock(async () => {
        // Merge with current to preserve fields like vault that the client doesn't send
        const current = await getState().catch(() => defaultState());
        const currentRev = Number.isInteger(current.rev) ? current.rev : 0;
        if (clientRev !== null && clientRev < currentRev) {
          return { status: 409, body: { error: 'Conflicto: hay una versión más nueva del estado', rev: currentRev } };
        }
        const merged = { ...current, ...incoming, version: 2, rev: currentRev + 1 };
        const ok = await saveStateChecked(merged, currentRev);
        if (!ok) {
          // La fila de pg cambió abajo nuestro (un script externo ganó la carrera)
          const fresh = await getState().catch(() => defaultState());
          return { status: 409, body: { error: 'Conflicto: hay una versión más nueva del estado', rev: fresh.rev ?? 0 } };
        }
        return { status: 200, body: { ok: true, savedAt: Date.now(), rev: merged.rev } };
      });
      if (result.status === 200) scheduleBackup();
      return sendJSON(res, result.status, result.body);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // ---- Config ----
  if (pathname === '/api/config' && req.method === 'GET') {
    const config = await getConfig();
    // vaultAvailable: el vault vive en el filesystem del Mac; en Render el
    // path apunta a una carpeta que no existe → false, y el frontend puede
    // esconder/degradar las features del vault en la nube.
    // Sin vault configurado = capaz de conectar uno (no bloquear el alta);
    // configurado pero inexistente = Render mirando una ruta del Mac → false.
    const vaultAvailable = !config.vaultPath || existsSync(config.vaultPath);
    return sendJSON(res, 200, { ...config, vaultAvailable });
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
      // Read-modify-write: config.json también guarda icsUrls; escribir solo
      // { vaultPath } borraba las suscripciones de calendario.
      const config = await getConfig();
      config.vaultPath = vaultPath;
      await saveConfig(config);

      // Scan and return summary stats so the UI can show counts immediately
      let scan = null;
      try { scan = await scanVault(vaultPath); } catch (e) {
        console.warn('[vault] scan falló para', vaultPath, '·', e.message);
      }

      // Persist a short summary in state.vault for UI badges
      let newRev = null;
      try {
        newRev = await bumpStateWith(cur => {
          cur.vault = {
            path: vaultPath,
            name: path.basename(vaultPath),
            notes: scan?.stats?.notes ?? 0,
            files: scan?.stats?.filesScanned ?? 0,
            folders: scan?.stats?.dirsScanned ?? 0,
            connectedAt: Date.now(),
          };
        });
      } catch (e) {
        console.warn('[vault] no pude persistir state.vault:', e.message);
      }

      // rev: el cliente lo necesita para que su próximo PUT no dé 409 espurio
      return sendJSON(res, 200, {
        ok: true,
        rev: newRev,
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
    // Read-modify-write para no pisar icsUrls (ver POST /api/vault)
    const config = await getConfig();
    config.vaultPath = null;
    await saveConfig(config);
    let newRev = null;
    try {
      newRev = await bumpStateWith(cur => { cur.vault = null; });
    } catch (e) {
      console.warn('[vault] no pude reflejar la desconexión en state:', e.message);
    }
    return sendJSON(res, 200, { ok: true, rev: newRev });
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
    // resolveVaultPath valida el confinamiento con separador (startsWith a secas
    // dejaba escapar a hermanos tipo MiVault-backup vía ..)
    let fullPath;
    try { fullPath = resolveVaultPath(config.vaultPath, relPath); }
    catch { return sendJSON(res, 403, { error: 'Forbidden path' }); }
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
      let fullPath;
      try { fullPath = resolveVaultPath(config.vaultPath, relPath); }
      catch { return sendJSON(res, 403, { error: 'Forbidden' }); }
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
          if (!e.cached) console.warn('[ics] fetch failed for', u, e.message); // el cacheado ya se logueó
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
        // El backup omitiría la nota en silencio — avisar al menos por consola
        try { fullNotes.push(await readNote(n.id)); } catch (e) {
          console.warn('[export] nota ilegible', n.id, '·', e.message);
        }
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
      let newRev = null;
      if (body.state && typeof body.state === 'object') {
        // Import es acción explícita del usuario: no rechaza por rev, pero lo
        // bumpea (con CAS) para que los clientes detecten el cambio.
        newRev = await bumpStateWith(cur => {
          Object.assign(cur, body.state);
          cur.version = 2;
        });
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
      return sendJSON(res, 200, { ok: true, importedNotes: imported, rev: newRev });
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
      mailConfigured: data.mailVia === 'mac' || !!(process.env.SMTP_USER && process.env.SMTP_PASS),
      mailProvider: data.mailVia === 'mac' ? 'mac' : 'gmail-smtp',
      mailVia: data.mailVia,
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
        armed: true, // histéresis: se desarma al disparar y re-arma al alejarse el precio
      };
      // Con lock: el scheduler y los resultados de la Mac escriben la misma fila
      await withBtcLock(async () => {
        const data = await readBtcAlerts();
        data.alerts.push(alert);
        await writeBtcAlerts(data);
      });
      return sendJSON(res, 200, { ok: true, alert });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  const btcAlertMatch = pathname.match(/^\/api\/btc\/alerts\/([a-z0-9_]+)$/i);
  if (btcAlertMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const id = btcAlertMatch[1];
    try {
      // Validar el body afuera; leer-modificar-escribir adentro del lock (el
      // scheduler y /mail-result escriben la misma fila: sin lock se pisan).
      const body = req.method === 'PUT' ? await readBody(req) : null;
      if (body) {
        if (body.target !== undefined) {
          const t = Number(body.target);
          if (!Number.isFinite(t) || t <= 0) return sendJSON(res, 400, { error: 'Precio inválido' });
        }
        if (body.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((body.email || '').trim())) {
          return sendJSON(res, 400, { error: 'Email inválido' });
        }
      }
      const result = await withBtcLock(async () => {
        const data = await readBtcAlerts();
        const idx = data.alerts.findIndex(a => a.id === id);
        if (idx < 0) return null;
        if (req.method === 'DELETE') {
          data.alerts.splice(idx, 1);
          await writeBtcAlerts(data);
          return { ok: true };
        }
        const a = data.alerts[idx];
        if (body.target !== undefined) {
          a.target = Number(body.target);
          a.armed = true; // el latch refería al target viejo
        }
        if (body.email !== undefined) a.email = (body.email || '').trim();
        if (body.direction !== undefined) {
          a.direction = body.direction === 'above' ? 'above' : 'below';
          a.armed = true; // el latch refería a la dirección vieja
        }
        if (body.active !== undefined) a.active = !!body.active;
        if (body.cooldownHours !== undefined) {
          const c = Number(body.cooldownHours);
          if (Number.isFinite(c) && c > 0) a.cooldownHours = Math.max(0.25, c);
        }
        if (body.note !== undefined) a.note = (body.note || '').trim() || null;
        if (body.resetTriggered === true) {
          a.lastTriggeredAt = null;
          a.lastTriggerPrice = null;
          a.armed = true;
        }
        a.updatedAt = Date.now();
        await writeBtcAlerts(data);
        return { ok: true, alert: a };
      });
      if (!result) return sendJSON(res, 404, { error: 'Alerta no encontrada' });
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
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

  if (pathname === '/api/btc/mail-pending' && req.method === 'GET') {
    const data = await readBtcAlerts();
    const nowTs = Date.now();
    const pend = data.log.filter(l => !l.ok && !l.resolved && l.pending && l.mail);
    return sendJSON(res, 200, {
      mails: pend.filter(l => nowTs - l.ts < BTC_MAIL_TTL_MS).map(l => ({ id: l.id, fromName: 'Tempo BTC Alerts', ...l.mail })),
      stale: pend.filter(l => nowTs - l.ts >= BTC_MAIL_TTL_MS).map(l => ({ id: l.id, reason: 'vencido: la alerta tiene más de 24 h' })),
    });
  }

  if (pathname === '/api/btc/mail-result' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const id = typeof body.id === 'string' ? body.id.slice(0, 40) : '';
      if (!id) return sendJSON(res, 400, { error: 'Falta id' });
      const result = await withBtcLock(async () => {
        const data = await readBtcAlerts();
        const l = data.log.find(x => x.id === id && !x.ok && !x.resolved) || data.log.find(x => x.id === id);
        if (!l) return null;
        if (l.ok || (l.resolved && body.ok !== true)) return { ok: true, already: true };
        const err = typeof body.error === 'string' ? body.error.slice(0, 300) : null;
        if (body.ok === true) Object.assign(l, { ok: true, error: null, pending: false, resolved: true, sentAt: Date.now() });
        else if (body.resolve === true) Object.assign(l, { pending: false, resolved: true, error: err || 'retirado' });
        else l.error = err || 'falló el envío desde la Mac';
        await writeBtcAlerts(data);
        return { ok: true };
      });
      if (!result) return sendJSON(res, 404, { error: 'Mail no encontrado' });
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
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
      const testAlert = { direction: 'below', target: snapshot.price, note: 'Email de prueba — verifica que el envío funciona.' };
      const queued = await withBtcLock(async () => {
        const data = await readBtcAlerts();
        if (data.mailVia !== 'mac') return false;
        const now = Date.now();
        data.log.unshift({
          id: btcMailId(), ts: now, type: 'test', price: snapshot.price, target: snapshot.price,
          direction: 'below', email: to, ok: false, pending: true, via: 'mac',
          mail: buildBtcAlertEmail({ to, alert: testAlert, snapshot }),
        });
        await writeBtcAlerts(data);
        return true;
      });
      if (queued) return sendJSON(res, 200, { ok: true, queued: true });
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

  // ---- Vuelos ----
  if (pathname === '/api/flights' && req.method === 'GET') {
    const data = await readFlights();
    const nowTs = Date.now();
    const due = new Set(dueWatches(data, nowTs).map(w => w.id));
    const watchById = new Map(data.watches.map(w => [w.id, w]));
    return sendJSON(res, 200, {
      settings: data.settings,
      watches: data.watches.map(w => ({ ...w, due: due.has(w.id) })),
      // "Muy buena" se recalcula al leer: si Dario cambia el umbral o un tope,
      // la pestaña lo refleja sin esperar al próximo chequeo
      deals: data.deals.map(d => ({ ...d, great: dealIsGreat(d, d.watchId ? watchById.get(d.watchId) : null, data.settings.alertPct) })),
      stats: data.stats,
      history: data.history,
      runs: data.runs.slice(0, 20),
      log: data.log.slice(0, 25),
      mailConfigured: !!(process.env.SMTP_USER && process.env.SMTP_PASS),
      serverTime: nowTs,
    });
  }

  if (pathname === '/api/flights/due' && req.method === 'GET') {
    const data = await readFlights();
    return sendJSON(res, 200, {
      settings: data.settings,
      // Pausar frena solo los avisos (mail y push): los precios se siguen chequeando
      due: dueWatches(data, Date.now()),
      // Lo último validado por seguimiento, para que la tarea compare
      last: Object.fromEntries(data.watches.map(w => {
        const h = data.history[w.id];
        return [w.id, Array.isArray(h) && h.length ? h[h.length - 1] : null];
      })),
      multi: data.deals.filter(d => d.kind === 'multi').map(d => ({ id: d.id, title: d.title, priceUsd: d.priceUsd, maxUsd: d.maxUsd ?? null, legs: d.legs, seller: d.seller, validatedAt: d.validatedAt })),
    });
  }

  if (pathname === '/api/flights/report' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 400, { error: 'JSON inválido: ' + e.message }); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.deals)) {
      return sendJSON(res, 400, { error: 'El reporte tiene que ser { deals: [...] }' });
    }
    try {
      return sendJSON(res, 200, await applyFlightsReport(body));
    } catch (e) {
      console.error('[flights] report falló:', e);
      return sendJSON(res, 500, { error: e.message });
    }
  }

  if (pathname === '/api/flights/settings' && req.method === 'PUT') {
    try {
      const body = await readBody(req);
      const settings = await withFlightsLock(async () => {
        const data = await readFlights();
        if (body.email !== undefined) {
          const e = (body.email || '').trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('Email inválido');
          data.settings.email = e;
        }
        if (body.alertPct !== undefined) {
          const p = body.alertPct === '' || body.alertPct === null ? NaN : Number(body.alertPct);
          if (!Number.isFinite(p) || p < 0 || p > 80) throw new Error('Porcentaje inválido (0 a 80)');
          data.settings.alertPct = p;
        }
        if (body.paused !== undefined) {
          // Al pausar se retiran los mails pendientes: al despausar no salen avisos viejos
          if (body.paused && !data.settings.paused) {
            for (const l of pendingFlightMails(data, Date.now())) {
              Object.assign(l, { pending: false, resolved: true, error: 'avisos pausados' });
            }
          }
          data.settings.paused = !!body.paused;
        }
        if (body.mailVia !== undefined) {
          if (!['mac', 'server'].includes(body.mailVia)) throw new Error('mailVia tiene que ser "mac" o "server"');
          data.settings.mailVia = body.mailVia;
        }
        await writeFlights(data);
        return data.settings;
      });
      return sendJSON(res, 200, { ok: true, settings });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/flights/watches' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const watch = await withFlightsLock(async () => {
        const data = await readFlights();
        const w = sanitizeWatchInput(body, null);
        if (!w.window.from) throw new Error('Falta la ventana de fechas');
        data.watches.push(w);
        await writeFlights(data);
        return w;
      });
      return sendJSON(res, 200, { ok: true, watch });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  const flightWatchMatch = pathname.match(/^\/api\/flights\/watches\/([a-z0-9_]+)$/i);
  if (flightWatchMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const id = flightWatchMatch[1];
    try {
      const body = req.method === 'PUT' ? await readBody(req) : null;
      const result = await withFlightsLock(async () => {
        const data = await readFlights();
        const idx = data.watches.findIndex(w => w.id === id);
        if (idx < 0) return null;
        if (req.method === 'DELETE') {
          data.watches.splice(idx, 1);
          delete data.history[id];
          data.deals = data.deals.filter(d => d.watchId !== id);
          await writeFlights(data);
          return { ok: true };
        }
        const before = data.watches[idx];
        const w = sanitizeWatchInput(body, before);
        if (w.origin !== before.origin || w.dest !== before.dest) {
          // Otra ruta: el historial, la oferta y el último aviso eran de la anterior
          w.lastAlert = null;
          w.lastCheckedAt = null;
          delete data.history[id];
          data.deals = data.deals.filter(d => d.watchId !== id);
        } else if (JSON.stringify(w.window) !== JSON.stringify(before.window) || JSON.stringify(w.nights) !== JSON.stringify(before.nights)) {
          w.lastCheckedAt = null; // que el próximo chequeo busque con las fechas nuevas
        }
        if (body.resetAlert === true) w.lastAlert = null;
        data.watches[idx] = w;
        await writeFlights(data);
        return { ok: true, watch: w };
      });
      if (!result) return sendJSON(res, 404, { error: 'Seguimiento no encontrado' });
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  const flightDealMatch = pathname.match(/^\/api\/flights\/deals\/([a-z0-9_-]+)$/i);
  if (flightDealMatch && req.method === 'PUT') {
    // Solo el tope de aviso (maxUsd): el resto de la oferta lo escribe la tarea
    const id = flightDealMatch[1];
    try {
      const body = await readBody(req);
      if (body.maxUsd === undefined) return sendJSON(res, 400, { error: 'Falta maxUsd' });
      const maxUsd = body.maxUsd === null || body.maxUsd === '' ? null : fNum(body.maxUsd);
      if (body.maxUsd !== null && body.maxUsd !== '' && !maxUsd) return sendJSON(res, 400, { error: 'Tope inválido' });
      const deal = await withFlightsLock(async () => {
        const data = await readFlights();
        const d = data.deals.find(x => x.id === id);
        if (!d) return null;
        d.maxUsd = maxUsd;
        await writeFlights(data);
        return d;
      });
      if (!deal) return sendJSON(res, 404, { error: 'Oferta no encontrada' });
      return sendJSON(res, 200, { ok: true, deal });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }
  if (flightDealMatch && req.method === 'DELETE') {
    const id = flightDealMatch[1];
    const found = await withFlightsLock(async () => {
      const data = await readFlights();
      const before = data.deals.length;
      data.deals = data.deals.filter(d => d.id !== id);
      if (data.deals.length === before) return false;
      await writeFlights(data);
      return true;
    });
    if (!found) return sendJSON(res, 404, { error: 'Oferta no encontrada' });
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/flights/mail-pending' && req.method === 'GET') {
    const data = await readFlights();
    if (data.settings.paused) return sendJSON(res, 200, { mails: [], stale: [], paused: true });
    return sendJSON(res, 200, planPendingMails(data, Date.now()));
  }

  if (pathname === '/api/flights/mail-result' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const id = fStr(body.id, 40);
      if (!id) return sendJSON(res, 400, { error: 'Falta id' });
      const result = await withFlightsLock(async () => {
        const data = await readFlights();
        const l = data.log.find(x => flightsLogId(x) === id);
        if (!l) return null;
        if (l.ok || (l.resolved && body.ok !== true)) return { ok: true, already: true }; // reintento del POST: no contar dos veces
        const nowTs = Date.now();
        l.id = id;
        l.via = 'mac';
        if (body.ok !== true && body.resolve === true) {
          // Aviso retirado (ya no es barato, oferta borrada, repetido): no se manda
          Object.assign(l, { pending: false, resolved: true, error: fStr(body.error, 300) || 'retirado' });
        } else if (body.ok === true) {
          Object.assign(l, { ok: true, error: null, pending: false, resolved: true, sentAt: nowTs });
          data.stats.mailsSent += 1;
          const ids = new Set(l.deals.map(x => x.id));
          for (const d of data.deals) if (ids.has(d.id) && d.lastAlert) d.lastAlert.mailed = true;
          for (const w of data.watches) if (ids.has(w.id) && w.lastAlert) w.lastAlert.mailed = true;
        } else {
          l.error = fStr(body.error, 300) || 'falló el envío desde la Mac';
          l.pending = true;
        }
        await writeFlights(data);
        return { ok: true };
      });
      if (!result) return sendJSON(res, 404, { error: 'Mail no encontrado' });
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/flights/test-email' && req.method === 'POST') {
    try {
      const body = await readBody(req).catch(() => ({}));
      const data = await readFlights();
      if (data.settings.mailVia === 'mac') {
        return sendJSON(res, 409, { error: 'Los mails los manda la Mac. Probalo desde la carpeta de Tempo con: node vuelos-tempo.mjs test-mail' });
      }
      const to = (body.to || data.settings.email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return sendJSON(res, 400, { error: 'Email inválido' });
      await sendFlightsEmail(to, [{
        title: 'Mail de prueba de Tempo Vuelos', origin: 'EZE', dest: 'PUJ',
        legs: [{ from: 'EZE', to: 'PUJ', date: '2027-04-17', airline: 'Ejemplo' }],
        priceUsd: 1, approx: false, priceArs: null, normal: null, seller: 'prueba',
        fare: null, seatsLeft: null, links: [], validatedAt: Date.now(),
      }]);
      return sendJSON(res, 200, { ok: true, to });
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

  // Guard con path.sep: startsWith a secas dejaría pasar hermanos tipo public-x
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
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

// Header Basic esperado, precomputado una sola vez. La comparación por request
// va por digest sha256 + timingSafeEqual: tiempo constante (no filtra prefijos)
// y sin el requisito de longitudes iguales de timingSafeEqual.
const EXPECTED_AUTH = TEMPO_PASSWORD
  ? 'Basic ' + Buffer.from('tempo:' + TEMPO_PASSWORD).toString('base64')
  : '';

const server = http.createServer(async (req, res) => {
  // CORS: solo si ALLOWED_ORIGIN está seteado. Sin la variable no se emite
  // ningún header Access-Control-* y el navegador aplica same-origin (la app
  // se sirve desde este mismo server y usa fetch relativos, no necesita CORS).
  if (ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Password gate (only active if TEMPO_PASSWORD is set)
  if (TEMPO_PASSWORD) {
    const hdr = req.headers.authorization || '';
    const a = crypto.createHash('sha256').update(hdr).digest();
    const b = crypto.createHash('sha256').update(EXPECTED_AUTH).digest();
    if (!crypto.timingSafeEqual(a, b)) {
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

  // CSRF: un form de otro sitio puede mandar POST text/plain sin preflight y el
  // navegador adjunta la Basic auth cacheada. Exigir JSON en todo POST/PUT/PATCH
  // de la API fuerza el preflight, que este server nunca autoriza. La app y
  // vuelos-tempo.mjs siempre mandan application/json.
  if (parsedUrl.pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      return sendJSON(res, 415, { error: 'Content-Type tiene que ser application/json' });
    }
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
        // Read-modify-write para no pisar icsUrls (ver POST /api/vault)
        const config = await getConfig();
        config.vaultPath = initial;
        await saveConfig(config);
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
