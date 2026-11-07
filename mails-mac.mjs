#!/usr/bin/env node
// mails-mac.mjs — reenvía desde la Mac los mails que Tempo (en Render) dejó
// pendientes: alertas de BTC y de Vuelos. Render gratis bloquea SMTP desde
// sep-2025, así que el server arma el mail y la Mac lo manda con Gmail
// (SMTP_USER/SMTP_PASS del .env).
//
// Lo corre launchd cada 5 minutos (LaunchAgent com.dario.tempo-mails, log en
// ~/Library/Logs/tempo-mails.log). Sin nada pendiente no imprime nada.
//
// Códigos de salida: 0 ok · 1 no pudo hablar con Tempo · 4 algún mail falló o no se anotó.

import { sendPendingMails } from './lib/tempo-cli.mjs';

const stamp = () => new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
let exit = 0;

for (const [name, api] of [['BTC', '/api/btc'], ['Vuelos', '/api/flights']]) {
  try {
    const r = await sendPendingMails(api);
    const happened = r.sent || r.failed.length || r.retired.length || r.unrecorded.length || r.skipped;
    if (happened) {
      console.log(`${stamp()} ${name}: enviados ${r.sent}, fallidos ${r.failed.length}, retirados ${r.retired.length}`
        + (r.unrecorded.length ? `, sin anotar en Tempo ${r.unrecorded.length}` : '')
        + (r.skipped ? ` (${r.skipped})` : '')
        + (r.failed.length ? ` · ${r.failed[0].error}` : ''));
    }
    if (r.failed.length || r.unrecorded.length) exit = Math.max(exit, 4);
  } catch (e) {
    console.log(`${stamp()} ${name}: no pude hablar con Tempo (${e.message})`);
    exit = exit || 1;
  }
}

process.exit(exit);
