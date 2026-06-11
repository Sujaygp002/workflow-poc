import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSql } from '../api/_lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../db/migrations');

async function main() {
  const sql = getSql();
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  await sql.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  for (const file of files) {
    const applied = await sql`SELECT id FROM schema_migrations WHERE id = ${file} LIMIT 1`;
    if (applied.length) {
      console.log(`skip ${file}`);
      continue;
    }

    const sqlText = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    await sql.query(sqlText);
    await sql`INSERT INTO schema_migrations (id) VALUES (${file})`;
    console.log(`applied ${file}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
