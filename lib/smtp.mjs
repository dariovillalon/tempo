// smtp.mjs — cliente SMTP mínimo sobre TLS implícito (puerto 465), sin dependencias.
// Soporta Gmail App Password (AUTH LOGIN). Lo usan server.js (BTC Alerts) y
// vuelos-tempo.mjs (mails de Vuelos desde la Mac: Render gratis bloquea SMTP).

import tls from 'node:tls';

// ---- Mínimo cliente SMTP sobre TLS implícito (puerto 465) ----
// Implementado con node:tls para no agregar dependencias externas.
// Soporta Gmail App Password (AUTH LOGIN) usando SMTP_USER y SMTP_PASS.

export function smtpEncodeUtf8Header(s) {
  // Si el asunto trae caracteres no-ASCII, codificar como =?UTF-8?B?...?= (RFC 2047)
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  const b64 = Buffer.from(s, 'utf-8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

export function buildEmailMessage({ from, to, subject, text }) {
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

export function smtpSend({ host, port, user, pass, from, to, subject, text }) {
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

    // Un connect bloqueado (ej. Render gratis cierra los puertos SMTP) llega como
    // AggregateError con message vacío: mostrar el código para que el log diga algo.
    socket.on('error', (e) => {
      clearTimeout(overall);
      const detail = e.message || e.code || (e.errors || []).map(x => x.code || x.message).filter(Boolean).join(', ') || 'error de conexión';
      cleanup(new Error(`SMTP ${host}:${port}: ${detail}`));
    });
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
