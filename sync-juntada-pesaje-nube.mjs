// Sincroniza a la nube (Neon) SOLO: las comidas del 27/06 y el pesaje del 28/06.
// Lossless: hace merge (no borra ni duplica nada). Recalcula los totales del día.
import fs from 'node:fs';

const DIA = '2026-06-27';
const WEIGH_DATE = '2026-06-28';

const url = fs.readFileSync('data/.cloud-url', 'utf8').trim();
const local = JSON.parse(fs.readFileSync('data/state.json', 'utf8'));
const lf = local.fitness || {};
const localDay = (lf.days || {})[DIA] || {};
const localWeigh = (lf.weighIns || []).find(w => w.date === WEIGH_DATE);

const { default: Pg } = await import('pg');
const pool = new Pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

const r = await pool.query("SELECT data FROM kv WHERE key = 'state'");
if (!r.rows.length) { console.error('No encontré el state en la nube. Aborto.'); await pool.end(); process.exit(1); }
const web = r.rows[0].data;
web.fitness = web.fitness || {};
web.fitness.days = web.fitness.days || {};
web.fitness.weighIns = web.fitness.weighIns || [];

// --- merge de comidas del 27/06 (por id, sin duplicar) ---
const webDay = web.fitness.days[DIA] || {};
const webMeals = Array.isArray(webDay.meals) ? webDay.meals : [];
const ids = new Set(webMeals.map(m => m.id));
const merged = [...webMeals];
for (const m of (localDay.meals || [])) if (!ids.has(m.id)) merged.push(m);
const before = webMeals.length;
const out = { ...webDay, meals: merged };
out.calories = merged.reduce((a, m) => a + (m.kcal || 0), 0);
out.protein  = merged.reduce((a, m) => a + (m.protein || 0), 0);
web.fitness.days[DIA] = out;

// --- pesaje del 28/06 (reemplaza si ya existe ese día) ---
let weighMsg = 'sin pesaje local para esa fecha';
if (localWeigh) {
  web.fitness.weighIns = web.fitness.weighIns.filter(w => w.date !== WEIGH_DATE);
  web.fitness.weighIns.push(localWeigh);
  web.fitness.weighIns.sort((a, b) => a.date < b.date ? -1 : 1);
  weighMsg = `${localWeigh.kg} kg cargado`;
}

await pool.query("UPDATE kv SET data = $1 WHERE key = 'state'", [JSON.stringify(web)]);
await pool.end();
console.log(`OK comidas ${DIA}: ${before} -> ${merged.length} (${out.calories} kcal / ${out.protein} g prot)`);
console.log(`OK pesaje ${WEIGH_DATE}: ${weighMsg}`);
console.log('Listo. Recargá la web con Cmd+Shift+R.');
