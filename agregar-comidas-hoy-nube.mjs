// Agrega/actualiza SOLO las comidas de un día en la nube (Neon), sin tocar nada más.
// Lossless: merge de meals por id (no duplica), recalcula totales.
// Día: 1er argumento YYYY-MM-DD; si no se pasa, usa el ÚLTIMO día con comidas en local.
import fs from 'node:fs';

const url = fs.readFileSync('data/.cloud-url', 'utf8').trim();
const local = JSON.parse(fs.readFileSync('data/state.json', 'utf8'));
const days = local.fitness?.days || {};
const conComida = Object.keys(days).filter(k => (days[k]?.meals || []).length).sort();
const DIA = process.argv[2] || conComida[conComida.length - 1];
const localDay = days[DIA];
if (!localDay || !(localDay.meals || []).length) { console.error(`No hay comidas locales para ${DIA}. Aborto.`); process.exit(1); }

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
  web.fitness = web.fitness || {};
  web.fitness.days = web.fitness.days || {};
  const webDay = web.fitness.days[DIA] || {};

  const webMeals = Array.isArray(webDay.meals) ? webDay.meals : [];
  const ids = new Set(webMeals.map(m => m.id));
  const merged = [...webMeals];
  for (const m of (localDay.meals || [])) if (!ids.has(m.id)) merged.push(m);

  const before = webMeals.length;
  const out = { ...webDay, ...localDay, meals: merged };
  out.calories = merged.reduce((a, m) => a + (m.kcal || 0), 0);
  out.protein  = merged.reduce((a, m) => a + (m.protein || 0), 0);
  web.fitness.days[DIA] = out;

  web.rev = (web.rev | 0) + 1; // optimistic locking: las pestañas con rev viejo reciben 409
  await client.query("UPDATE kv SET data = $1 WHERE key = 'state'", [JSON.stringify(web)]);
  await client.query('COMMIT');
  console.log(`OK: comidas de ${DIA} en la nube. meals ${before} -> ${merged.length}. Total ${out.calories} kcal / ${out.protein} g prot. Recargá la web (Cmd+Shift+R).`);
} catch (e) {
  try { await client.query('ROLLBACK'); } catch {}
  throw e;
} finally {
  client.release();
  await pool.end();
}
