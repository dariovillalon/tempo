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
import { call, fatal, smtpConfig, sendPendingMails as sendPending } from './lib/tempo-cli.mjs';
import { smtpSend } from './lib/smtp.mjs';

const sendPendingMails = () => sendPending('/api/flights');

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
      // emailed habla del mail de ESTA corrida, no de reintentos viejos
      const mine = res.mailId ? res.macMail.byId[res.mailId] : null;
      if (mine?.sent) { res.emailed = true; res.emailError = null; }
      else if (mine) res.emailError = mine.error;
      else if (res.mailId && !res.emailed) res.emailError = res.macMail.paused ? 'avisos pausados' : 'el mail no salió';
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
    if (r.failed.length || r.unrecorded.length) process.exit(4);
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
