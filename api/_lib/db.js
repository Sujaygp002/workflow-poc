import { neon } from '@neondatabase/serverless';
import pg from 'pg';
import { DATABASE_URL } from './config.js';

let sqlClient;

function isNeonUrl(url) {
  return /\.neon\.tech\b/.test(url);
}

// Wraps node-postgres Pool in the same API shape neon(url) returns:
// - tagged template literal: sql`SELECT ... ${x}` → rows array
// - sql.query(text, params?) → rows array
function makePgSql(url) {
  const pool = new pg.Pool({
    connectionString: url,
    ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : false,
  });

  const sql = async (strings, ...values) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) {
      text += `$${i + 1}${strings[i + 1]}`;
    }
    const result = await pool.query(text, values);
    return result.rows;
  };

  sql.query = async (text, params = []) => {
    const result = await pool.query(text, params);
    return result.rows;
  };

  return sql;
}

export function getSql() {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }
  if (!sqlClient) {
    sqlClient = isNeonUrl(DATABASE_URL) ? neon(DATABASE_URL) : makePgSql(DATABASE_URL);
  }
  return sqlClient;
}

export async function jsonParam(value) {
  return JSON.stringify(value ?? {});
}
