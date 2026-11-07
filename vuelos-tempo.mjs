#!/usr/bin/env node
// vuelos-tempo.mjs — puente entre la tarea diaria de vuelos (Claude + Chrome en
// la Mac) y Tempo. Ver VUELOS-ALERTAS.md.
//
//   node vuelos-tempo.mjs due               → rutas que tocan revisar hoy (+ último precio)
//   node vuelos-tempo.mjs all               → todo /api/flights
//   node vuelos-tempo.mjs report <archivo>  → sube precios validados; imprime alertas
//
// Lee TEMPO_PASSWORD (y opcional TEMPO_URL) del entorno o del .env de esta carpeta.
// TEMPO_URL por defecto: la web en Render. Para probar contra un server local:
//   TEMPO_URL=http://localhost:7788 node vuelos-tempo.mjs due
//
// Códigos de salida: 0 ok · 1 error · 2 uso incorrecto · 3 el server rechazó ofertas
// (la respuesta igual se imprime, con `rejected`).

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = 'https://tempo-kqoo.onrender.com';
const TIMEOUT_MS = 120_000; // Render free duerme: el primer request puede tardar ~1 min
const RETRIES = 3;

// Mismas reglas que el loader de server.js: export opcional, trim, comillas solo si cierran.
async function loadEnv() {
  const env = { TEMPO_URL: process.env.TEMPO_URL, TEMPO_PASSWORD: process.env.TEMPO_PASSWORD };
  try {
    const raw = await fs.readFile(path.join(DIR, '.env'), 'utf-8');
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(?:export\s+)?(TEMPO_URL|TEMPO_PASSWORD)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
      if (env[m[1]] === undefined) env[m[1]] = v;
    }
  } catch { /* .env opcional */ }

  let url;
  try { url = new URL(env.TEMPO_URL || DEFAULT_URL); }
  catch { throw fatal('TEMPO_URL no es una URL válida'); }
  // Nunca imprimir la URL: si trae credenciales, el error las filtraría al push
  if (url.username || url.password) throw fatal('TEMPO_URL no debe incluir usuario ni clave; usá TEMPO_PASSWORD');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!env.TEMPO_PASSWORD && !local) throw fatal('TEMPO_PASSWORD no encontrada (entorno o .env de esta carpeta)');
  return { base: url.origin, password: env.TEMPO_PASSWORD || '' };
}

function fatal(msg) { return Object.assign(new Error(msg), { fatal: true }); }

const describe = (e) => {
  if (e.name === 'AbortError') return `timeout de ${TIMEOUT_MS / 1000}s`;
  const code = e.cause?.code || e.cause?.name;
  return `${e.message}${code ? ` (${code})` : ''}`;
};

async function call(method, route, body) {
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

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'due') {
    console.log(JSON.stringify(await call('GET', '/api/flights/due'), null, 2));
  } else if (cmd === 'all') {
    console.log(JSON.stringify(await call('GET', '/api/flights'), null, 2));
  } else if (cmd === 'report' && arg) {
    const text = await fs.readFile(path.resolve(arg), 'utf-8');
    const payload = JSON.parse(text);
    if (!payload || !Array.isArray(payload.deals)) throw fatal('El archivo tiene que tener { deals: [...] }');
    // runId estable por contenido: si el POST se corta y se reintenta (acá o
    // corriendo el comando de nuevo con el mismo archivo), el server no lo aplica dos veces.
    payload.runId ||= 'r_' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
    const res = await call('POST', '/api/flights/report', payload);
    console.log(JSON.stringify(res, null, 2));
    if (Array.isArray(res.rejected) && res.rejected.length) {
      console.error(`vuelos-tempo: el server rechazó ${res.rejected.length} oferta(s); ver "rejected"`);
      process.exit(3);
    }
  } else {
    console.error('Uso: node vuelos-tempo.mjs due | all | report <archivo.json>');
    process.exit(2);
  }
} catch (e) {
  console.error('vuelos-tempo: ' + e.message);
  process.exit(1);
}
