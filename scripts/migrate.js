import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSql } from '../api/_lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../db/migrations');

function splitSqlStatements(sqlText) {
  const statements = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarQuoteTag = null;

  for (let index = 0; index < sqlText.length; index += 1) {
    const char = sqlText[index];
    const next = sqlText[index + 1];

    if (inLineComment) {
      current += char;
      if (char === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        index += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (dollarQuoteTag) {
      if (sqlText.startsWith(dollarQuoteTag, index)) {
        current += dollarQuoteTag;
        index += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
        continue;
      }
      current += char;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && char === '-' && next === '-') {
      current += char + next;
      index += 1;
      inLineComment = true;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && char === '/' && next === '*') {
      current += char + next;
      index += 1;
      inBlockComment = true;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && char === '$') {
      const match = sqlText.slice(index).match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        dollarQuoteTag = match[0];
        current += dollarQuoteTag;
        index += dollarQuoteTag.length - 1;
        continue;
      }
    }

    if (!inDoubleQuote && char === "'") {
      current += char;
      if (inSingleQuote && next === "'") {
        current += next;
        index += 1;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote && char === '"') {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && char === ';') {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      continue;
    }

    current += char;
  }

  const trailingStatement = current.trim();
  if (trailingStatement) statements.push(trailingStatement);
  return statements;
}

async function main() {
  const sql = getSql();
  const reset = process.argv.includes('--reset') || process.env.DB_RESET === '1';

  if (reset) {
    // Clean wipe: drop and recreate the public schema so the fresh single
    // migration is the only source of truth. Destroys ALL data.
    console.log('reset: dropping public schema');
    await sql.query('DROP SCHEMA public CASCADE');
    await sql.query('CREATE SCHEMA public');
  }

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
    for (const statement of splitSqlStatements(sqlText)) {
      await sql.query(statement);
    }
    await sql`INSERT INTO schema_migrations (id) VALUES (${file})`;
    console.log(`applied ${file}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
