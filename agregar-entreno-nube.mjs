// Agrega SOLO la sesión de entreno de hoy a la nube (Neon), sin tocar nada más.
// Lossless: lee el estado de la web, hace append a fitness.workoutLogs y guarda.
// Idempotente: si ya existe la sesión (mismo id), no la duplica.
import fs from 'node:fs';

const url = fs.readFileSync('data/.cloud-url', 'utf8').trim();
const entry = JSON.parse(fs.readFileSync('data/_entreno_hoy.json', 'utf8'));

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
  web.fitness.workoutLogs = Array.isArray(web.fitness.workoutLogs) ? web.fitness.workoutLogs : [];

  const before = web.fitness.workoutLogs.length;
  web.fitness.workoutLogs = web.fitness.workoutLogs.filter(w => w.id !== entry.id); // evita duplicado
  web.fitness.workoutLogs.push(entry); // <-- único cambio: agrega la sesión de hoy

  web.rev = (web.rev | 0) + 1; // optimistic locking: las pestañas con rev viejo reciben 409
  await client.query("UPDATE kv SET data = $1 WHERE key = 'state'", [JSON.stringify(web)]);
  await client.query('COMMIT');
  console.log(`OK: sesión de entreno agregada a la nube. workoutLogs ${before} -> ${web.fitness.workoutLogs.length}. Recargá la web.`);
} catch (e) {
  try { await client.query('ROLLBACK'); } catch {}
  throw e;
} finally {
  client.release();
  await pool.end();
}
