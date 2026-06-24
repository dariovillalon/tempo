// Actualiza SOLO la biblioteca de comidas (foodLibrary) en la nube (Neon),
// SIN tocar comidas/días/pesajes. Lossless: preserva todo lo demás de la web.
// Toma la foodLibrary curada de tu data/state.json local y la pisa en la nube.
import fs from 'node:fs';

const url = fs.readFileSync('data/.cloud-url', 'utf8').trim();
const local = JSON.parse(fs.readFileSync('data/state.json', 'utf8'));
const newLib = local.fitness?.foodLibrary || [];
if (!newLib.length) { console.error('No hay foodLibrary local. Aborto.'); process.exit(1); }

const { default: Pg } = await import('pg');
const pool = new Pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

const r = await pool.query("SELECT data FROM kv WHERE key = 'state'");
if (!r.rows.length) { console.error('No encontré el state en la nube. Aborto.'); await pool.end(); process.exit(1); }

const web = r.rows[0].data;
web.fitness = web.fitness || {};
const before = (web.fitness.foodLibrary || []).length;
web.fitness.foodLibrary = newLib; // <-- único campo que se cambia

await pool.query("UPDATE kv SET data = $1 WHERE key = 'state'", [JSON.stringify(web)]);
await pool.end();
console.log(`OK: foodLibrary en la nube ${before} -> ${newLib.length} items. Recargá la web (Cmd+Shift+R).`);
