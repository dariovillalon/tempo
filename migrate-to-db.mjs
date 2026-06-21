// Migra tus datos locales (data/state.json y data/config.json) a Postgres.
// Uso (una sola vez, apuntando a la DB de la nube):
//   DATABASE_URL="postgres://..." npm run migrate
import fs from 'node:fs/promises';
import Pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('❌ Falta DATABASE_URL. Ejemplo: DATABASE_URL="postgres://..." npm run migrate'); process.exit(1); }

const pool = new Pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
await pool.query('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, data JSONB NOT NULL)');

async function up(key, file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf-8'));
    await pool.query(
      'INSERT INTO kv (key, data) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data',
      [key, JSON.stringify(data)]
    );
    console.log(`✓ Migrado "${key}" desde ${file}`);
  } catch (e) {
    console.log(`· Omito "${key}" (${e.message})`);
  }
}

await up('state', './data/state.json');
await up('config', './data/config.json');
await pool.end();
console.log('✅ Listo. Tus datos ya están en Postgres.');
