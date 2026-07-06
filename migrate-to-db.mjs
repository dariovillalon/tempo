// Migra tus datos locales (data/state.json y data/config.json) a Postgres.
// Uso (una sola vez, apuntando a la DB de la nube):
//   DATABASE_URL="postgres://..." npm run migrate
import fs from 'node:fs/promises';
import Pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('❌ Falta DATABASE_URL. Ejemplo: DATABASE_URL="postgres://..." npm run migrate'); process.exit(1); }

const pool = new Pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
await pool.query('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, data JSONB NOT NULL)');

const client = await pool.connect();

async function up(key, file) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch (e) {
    // Archivo ausente/ilegible: omitir está bien (config.json puede no existir).
    console.log(`· Omito "${key}" (${e.message})`);
    return;
  }
  // OJO: los errores de DB NO se tragan acá — abortarían la transacción
  // compartida y el COMMIT de una tx abortada "pasa" como ROLLBACK silencioso,
  // imprimiendo éxito sin haber migrado nada.
  if (key === 'state') {
    // Pisa la nube a propósito (es una migración), pero serializado: lockea la fila
    // y sube el rev para que las pestañas abiertas sepan que su copia quedó vieja.
    const r = await client.query("SELECT data FROM kv WHERE key = 'state' FOR UPDATE");
    const cloudRev = r.rows.length ? (r.rows[0].data?.rev | 0) : 0;
    data.rev = cloudRev + 1;
  }
  await client.query(
    'INSERT INTO kv (key, data) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data',
    [key, JSON.stringify(data)]
  );
  console.log(`✓ Migrado "${key}" desde ${file}`);
}

try {
  await client.query('BEGIN');
  await up('state', './data/state.json');
  await up('config', './data/config.json');
  await client.query('COMMIT');
} catch (e) {
  try { await client.query('ROLLBACK'); } catch {}
  console.error(`❌ Migración abortada, no se escribió nada: ${e.message}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
if (process.exitCode) process.exit(1);
console.log('✅ Listo. Tus datos ya están en Postgres.');
