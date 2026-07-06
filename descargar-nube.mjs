// Descarga el estado de la NUBE (Neon) a un backup local con fecha.
// No modifica nada en la nube: solo lee. Guarda en data/backups-nube/.
// También baja las filas 'config' y 'btc-alerts' (si existen) como
// config-<fecha>.json y btc-alerts-<fecha>.json.
import fs from 'node:fs';

const url = fs.readFileSync('data/.cloud-url', 'utf8').trim();
const { default: Pg } = await import('pg');
const pool = new Pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

const r = await pool.query("SELECT key, data FROM kv WHERE key IN ('state', 'config', 'btc-alerts')");
await pool.end();
const rows = new Map(r.rows.map(row => [row.key, row.data]));
if (!rows.has('state')) { console.error('No encontré el state en la nube. Aborto.'); process.exit(1); }

const pad = n => String(n).padStart(2, '0');
const d = new Date();
const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const DIR = 'data/backups-nube';
fs.mkdirSync(DIR, { recursive: true });

const dest = `${DIR}/state-${ts}.json`;
fs.writeFileSync(dest, JSON.stringify(rows.get('state'), null, 2));
let configMsg = 'sin config en la nube';
if (rows.has('config')) {
  fs.writeFileSync(`${DIR}/config-${ts}.json`, JSON.stringify(rows.get('config'), null, 2));
  configMsg = `config-${ts}.json guardado`;
}
let btcMsg = 'sin btc-alerts en la nube';
if (rows.has('btc-alerts')) {
  fs.writeFileSync(`${DIR}/btc-alerts-${ts}.json`, JSON.stringify(rows.get('btc-alerts'), null, 2));
  btcMsg = `btc-alerts-${ts}.json guardado`;
}

// Rotación: conservar solo los últimos 30 backups de cada tipo.
for (const prefix of ['state-', 'config-', 'btc-alerts-']) {
  const files = fs.readdirSync(DIR).filter(f => f.startsWith(prefix) && f.endsWith('.json')).sort();
  while (files.length > 30) fs.unlinkSync(`${DIR}/${files.shift()}`);
}

const kb = Math.round(fs.statSync(dest).size / 1024);
const kept = fs.readdirSync(DIR).filter(f => f.startsWith('state-') && f.endsWith('.json')).length;
console.log(`OK: backup de la nube guardado en ${dest} (${kb} KB). Config: ${configMsg}. BTC: ${btcMsg}. Backups guardados: ${kept}.`);
