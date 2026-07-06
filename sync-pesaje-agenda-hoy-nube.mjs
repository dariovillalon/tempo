// Sube a la nube (Neon) SOLO: el pesaje de HOY y las reuniones/bloques de HOY.
// Lossless: merge por id/fecha. No borra ni toca comidas, entrenos ni nada más.
// Día: 1er argumento YYYY-MM-DD; por defecto, hoy (hora local del sistema).
import fs from 'node:fs';

const pad = n => String(n).padStart(2, '0');
const now = new Date();
const DIA = process.argv[2] || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

const url = fs.readFileSync('data/.cloud-url', 'utf8').trim();
const local = JSON.parse(fs.readFileSync('data/state.json', 'utf8'));
const lf = local.fitness || {};
const localWeigh = (lf.weighIns || []).find(w => w.date === DIA);
const localBlocks = (local.blocks || []).filter(b => b.date === DIA);

const { default: Pg } = await import('pg');
const pool = new Pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();

try {
  // Transacción con lock de fila: evita pisar escrituras concurrentes (web abierta u otro script).
  await client.query('BEGIN');
  const r = await client.query("SELECT data FROM kv WHERE key = 'state' FOR UPDATE");
  if (!r.rows.length) {
    console.error('No encontré el state en la nube. Aborto.');
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
    process.exit(1);
  }
  const web = r.rows[0].data;

  // ---- Pesaje ----
  web.fitness = web.fitness || {};
  web.fitness.weighIns = Array.isArray(web.fitness.weighIns) ? web.fitness.weighIns : [];
  let pesajeMsg = 'sin pesaje local para ' + DIA;
  if (localWeigh) {
    web.fitness.weighIns = web.fitness.weighIns.filter(w => w.id !== localWeigh.id && w.date !== DIA);
    web.fitness.weighIns.push(localWeigh);
    if (local.fitness?.profile?.weightKg && web.fitness.profile) web.fitness.profile.weightKg = local.fitness.profile.weightKg;
    pesajeMsg = `pesaje ${DIA}: ${localWeigh.kg} kg`;
  }

  // ---- Reuniones / bloques ----
  web.blocks = Array.isArray(web.blocks) ? web.blocks : [];
  const ids = new Set(web.blocks.map(b => b.id));
  let added = 0;
  for (const b of localBlocks) { if (!ids.has(b.id)) { web.blocks.push(b); added++; } }

  web.rev = (web.rev | 0) + 1; // optimistic locking: las pestañas con rev viejo reciben 409
  await client.query("UPDATE kv SET data = $1 WHERE key = 'state'", [JSON.stringify(web)]);
  await client.query('COMMIT');
  console.log(`OK: ${pesajeMsg} | reuniones nuevas: ${added} (de ${localBlocks.length} locales en ${DIA}). Recargá la web (Cmd+Shift+R).`);
} catch (e) {
  try { await client.query('ROLLBACK'); } catch {}
  throw e;
} finally {
  client.release();
  await pool.end();
}
