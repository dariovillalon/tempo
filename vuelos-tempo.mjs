#!/usr/bin/env node
// vuelos-tempo.mjs — puente entre la tarea diaria de vuelos (Claude + Chrome en
// la Mac) y Tempo. Ver VUELOS-ALERTAS.md.
//
//   node vuelos-tempo.mjs due               → rutas que tocan revisar hoy (+ último precio)
//   node vuelos-tempo.mjs all               → todo /api/flights
//   node vuelos-tempo.mjs report <archivo>  → sube precios validados, manda los mails
//                                              pendientes desde la Mac e imprime alertas
//   node vuelos-tempo.mjs mail-pending      → reintenta los mails de alerta que no salieron
//   node vuelos-tempo.mjs test-mail         → manda un mail de prueba desde la Mac
//
// Los mails salen desde la Mac (Gmail SMTP con SMTP_USER/SMTP_PASS del .env)
// porque Render gratis bloquea los puertos SMTP desde sep-2025.
//
// Lee TEMPO_PASSWORD (y opcional TEMPO_URL) del entorno o del .env de esta carpeta.
// TEMPO_URL por defecto: la web en Render. Para probar contra un server local:
//   TEMPO_URL=http://localhost:7788 node vuelos-tempo.mjs due
//
// Códigos de salida: 0 ok · 1 error · 2 uso incorrecto · 3 el server rechazó ofertas
// (la respuesta igual se imprime, con `rejected`) · 4 mail-pending no pudo mandar alguno.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { smtpSend } from './lib/smtp.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = 'https://tempo-kqoo.onrender.com';
const TIMEOUT_MS = 120_000; // Render free duerme: el primer request puede tardar ~1 min
const RETRIES = 3;

// Mismas reglas que el loader de server.js: export opcional, trim, comillas solo si cierran.
const ENV_KEYS = ['TEMPO_URL', 'TEMPO_PASSWORD', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_HOST', 'SMTP_PORT'];

async function readEnvFile() {
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

async function loadEnv() {
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

// ---- Mails desde la Mac ----
async function smtpConfig() {
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

// Manda los mails que Tempo dejó pendientes y le avisa el resultado de cada uno.
async function sendPendingMails() {
  const { mails } = await call('GET', '/api/flights/mail-pending');
  const out = { sent: 0, failed: [] };
  if (!mails?.length) return out;
  const cfg = await smtpConfig();
  for (const m of mails) {
    let ok = false, error = null;
    if (!cfg) error = 'faltan SMTP_USER y SMTP_PASS en el .env de la Mac';
    else {
      try { await smtpSend({ ...cfg, to: m.to, subject: m.subject, text: m.text }); ok = true; }
      catch (e) { error = e.message; }
    }
    if (ok) out.sent++; else out.failed.push({ id: m.id, error });
    try { await call('POST', '/api/flights/mail-result', { id: m.id, ok, error }); }
    catch (e) { out.failed.push({ id: m.id, error: 'no pude avisarle a Tempo: ' + e.message }); }
  }
  return out;
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
    // Después del reporte: mandar desde la Mac lo que Tempo dejó pendiente (incluye
    // los de corridas anteriores que no salieron). Un fallo acá no invalida el reporte.
    try {
      res.macMail = await sendPendingMails();
      if (res.alerts?.length && !res.emailed && res.macMail.sent > 0 && !res.macMail.failed.length) res.emailed = true;
      if (res.macMail.failed.length) res.emailError = res.macMail.failed[0].error;
    } catch (e) {
      res.macMail = { sent: 0, failed: [{ error: e.message }] };
      if (res.alerts?.length) res.emailError = e.message;
    }
    console.log(JSON.stringify(res, null, 2));
    if (Array.isArray(res.rejected) && res.rejected.length) {
      console.error(`vuelos-tempo: el server rechazó ${res.rejected.length} oferta(s); ver "rejected"`);
      process.exit(3);
    }
  } else if (cmd === 'mail-pending') {
    const r = await sendPendingMails();
    console.log(JSON.stringify(r, null, 2));
    if (r.failed.length) process.exit(4);
  } else if (cmd === 'test-mail') {
    const cfg = await smtpConfig();
    if (!cfg) throw fatal('Faltan SMTP_USER y SMTP_PASS en el .env de esta carpeta');
    const { settings } = await call('GET', '/api/flights/due');
    await smtpSend({
      ...cfg, to: settings.email,
      subject: 'Mail de prueba de Tempo Vuelos',
      text: 'Si te llegó este mail, la Mac puede mandarte las alertas de vuelos baratos.\n\n— Tempo · Vuelos',
    });
    console.log(JSON.stringify({ ok: true, to: settings.email }, null, 2));
  } else {
    console.error('Uso: node vuelos-tempo.mjs due | all | report <archivo.json> | mail-pending | test-mail');
    process.exit(2);
  }
} catch (e) {
  console.error('vuelos-tempo: ' + e.message);
  process.exit(1);
}
