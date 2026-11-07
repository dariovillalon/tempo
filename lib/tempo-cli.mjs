// tempo-cli.mjs — lo compartido por los scripts de la Mac que hablan con Tempo
// (vuelos-tempo.mjs y mails-mac.mjs): .env, llamadas a la API con reintentos por
// el arranque en frío de Render, y envío de mails pendientes con Gmail SMTP
// (Render gratis bloquea SMTP desde sep-2025).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smtpSend } from './smtp.mjs';

// Raíz del repo (este archivo vive en lib/): ahí están .env y data/
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'https://tempo-kqoo.onrender.com';
const TIMEOUT_MS = 120_000; // Render free duerme: el primer request puede tardar ~1 min
const RETRIES = 3;

// Mismas reglas que el loader de server.js: export opcional, trim, comillas solo si cierran.
const ENV_KEYS = ['TEMPO_URL', 'TEMPO_PASSWORD', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_HOST', 'SMTP_PORT'];

export async function readEnvFile() {
  const env = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  try {
    const raw = await fs.readFile(path.join(DIR, '.env'), 'utf-8');
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(?:export\s+)?([A-Z_]+)\s*=\s*(.*)$/);
      if (!m || !ENV_KEYS.includes(m[1])) continue;
      let v = m[2].trim();
      if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
      if (env[m[1]] === undefined) env[m[1]] = v;
    }
  } catch { /* .env opcional */ }
  return env;
}

export async function loadEnv() {
  const env = await readEnvFile();
  let url;
  try { url = new URL(env.TEMPO_URL || DEFAULT_URL); }
  catch { throw fatal('TEMPO_URL no es una URL válida'); }
  // Nunca imprimir la URL: si trae credenciales, el error las filtraría al push
  if (url.username || url.password) throw fatal('TEMPO_URL no debe incluir usuario ni clave; usá TEMPO_PASSWORD');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!env.TEMPO_PASSWORD && !local) throw fatal('TEMPO_PASSWORD no encontrada (entorno o .env de esta carpeta)');
  return { base: url.origin, password: env.TEMPO_PASSWORD || '' };
}

export function fatal(msg) { return Object.assign(new Error(msg), { fatal: true }); }

const describe = (e) => {
  if (e.name === 'AbortError') return `timeout de ${TIMEOUT_MS / 1000}s`;
  const code = e.cause?.code || e.cause?.name;
  return `${e.message}${code ? ` (${code})` : ''}`;
};

export async function call(method, route, body) {
  const { base, password } = await loadEnv();
  const headers = { Accept: 'application/json' };
  if (password) headers.Authorization = 'Basic ' + Buffer.from('tempo:' + password).toString('base64');
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(base + route, {
        method, headers, signal: ctrl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
      if (res.ok) return data;
      // 502/503/504 = Render despertando o deployando: reintentar. Lo demás es error real.
      if (![502, 503, 504].includes(res.status)) throw fatal(`HTTP ${res.status}: ${data.error || data.raw || ''}`);
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = new Error(describe(e));
    } finally {
      clearTimeout(t);
    }
    if (attempt < RETRIES) await new Promise(r => setTimeout(r, 15_000 * attempt));
  }
  throw new Error(`${lastErr.message} (después de ${RETRIES} intentos)`);
}

// ---- Mails desde la Mac ----
export async function smtpConfig() {
  const env = await readEnvFile();
  if (!env.SMTP_USER || !env.SMTP_PASS) return null;
  return {
    host: env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(env.SMTP_PORT) || 465,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: { address: env.SMTP_FROM || env.SMTP_USER, name: 'Tempo Vuelos' },
  };
}

// Diario local de mails ya entregados (data/ está gitignoreado), con clave
// "<api>:<id>". Se anota apenas Gmail acepta el mail y se borra cuando Tempo
// confirmó el resultado: si ese aviso falla (Render deployando, corte), la
// corrida siguiente solo avisa y no reenvía.
const JOURNAL = path.join(DIR, 'data', 'mails-enviados.json');
const JOURNAL_TTL_MS = 8 * 86400000;
async function readJournal() {
  try {
    const j = JSON.parse(await fs.readFile(JOURNAL, 'utf-8'));
    const now = Date.now();
    return Object.fromEntries(Object.entries(j).filter(([, ts]) => now - ts < JOURNAL_TTL_MS));
  } catch { return {}; }
}
async function writeJournal(j) {
  await fs.mkdir(path.dirname(JOURNAL), { recursive: true });
  const tmp = JOURNAL + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(j, null, 2));
  await fs.rename(tmp, JOURNAL);
}

// Candado entre procesos (launchd cada 5 min + la tarea diaria): dos envíos
// simultáneos del mismo pendiente mandarían el mail dos veces. mkdir es atómico.
const LOCK = path.join(DIR, 'data', '.mails-lock');
const LOCK_STALE_MS = 10 * 60 * 1000;
export async function withMailLock(fn, { waitMs = 90_000 } = {}) {
  await fs.mkdir(path.dirname(LOCK), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try { await fs.mkdir(LOCK); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(LOCK);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { await fs.rm(LOCK, { recursive: true, force: true }); continue; }
      } catch { continue; }
      if (Date.now() > until) return { skipped: true };
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  try { return await fn(); }
  finally { await fs.rm(LOCK, { recursive: true, force: true }).catch(() => {}); }
}

// Manda los mails que Tempo dejó pendientes en `api` ('/api/flights' o '/api/btc'),
// retira los que ya no corresponden (`stale`) y le avisa a Tempo cada resultado.
export async function sendPendingMails(api) {
  const out = { sent: 0, failed: [], retired: [], unrecorded: [], paused: false, byId: {} };
  const locked = await withMailLock(async () => {
    const plan = await call('GET', `${api}/mail-pending`);
    if (plan.paused) { out.paused = true; return; }
    const journal = await readJournal();
    const cfg = await smtpConfig();

    for (const st of plan.stale || []) {
      try { await call('POST', `${api}/mail-result`, { id: st.id, ok: false, resolve: true, error: st.reason }); out.retired.push(st); }
      catch (e) { out.unrecorded.push({ id: st.id, error: e.message }); }
    }

    for (const m of plan.mails || []) {
      const key = `${api}:${m.id}`;
      let ok = false, error = null;
      if (journal[key]) ok = true; // ya salió en una corrida anterior: solo falta avisarle a Tempo
      else if (!cfg) error = 'faltan SMTP_USER y SMTP_PASS en el .env de la Mac';
      else {
        try {
          const from = { ...cfg.from, name: m.fromName || cfg.from.name };
          await smtpSend({ ...cfg, from, to: m.to, subject: m.subject, text: m.text });
          ok = true;
          journal[key] = Date.now();
          await writeJournal(journal);
        } catch (e) { error = e.message; }
      }
      out.byId[m.id] = { sent: ok, error };
      if (ok) out.sent++; else out.failed.push({ id: m.id, error });
      try {
        await call('POST', `${api}/mail-result`, { id: m.id, ok, error });
        if (journal[key]) { delete journal[key]; await writeJournal(journal); }
      } catch (e) {
        out.unrecorded.push({ id: m.id, error: 'no pude avisarle a Tempo: ' + e.message });
      }
    }
  });
  if (locked?.skipped) out.skipped = 'otro proceso está mandando mails; se reintenta en la próxima corrida';
  return out;
}
