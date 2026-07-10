import { neon } from '@neondatabase/serverless';
import pg from 'pg';
import { DATABASE_URL } from './config.js';

let sqlClient;

function isNeonUrl(url) {
  return /\.neon\.tech\b/.test(url);
}

// Wraps node-postgres Pool in the same API shape neon(url) returns:
// - tagged template literal: sql`SELECT ... ${x}` → rows array (lazy: runs on await)
// - nested fragments compose: sql`... ${cond ? sql`AND x = ${y}` : sql``}`
// - sql.query(text, params?) → rows array
const PG_FRAGMENT = Symbol('pgSqlFragment');

function makePgSql(url) {
  // Strip sslmode from the URL — pg v8 treats sslmode=require as verify-full
  // (rejects self-signed RDS certs). We set ssl explicitly instead.
  const cleanUrl = url.replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]uselibpqcompat=[^&]*/g, '');
  const pool = new pg.Pool({
    connectionString: cleanUrl,
    ssl: /sslmode=(require|verify)/.test(url) ? { rejectUnauthorized: false } : false,
  });

  // Flatten a template into (text, params), splicing nested fragments inline
  // instead of binding them — mirrors Neon's composable queries.
  function build(strings, values, params) {
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i];
      if (value && typeof value === 'object' && value[PG_FRAGMENT]) {
        text += build(value.strings, value.values, params);
      } else {
        params.push(value);
        text += `$${params.length}`;
      }
      text += strings[i + 1];
    }
    return text;
  }

  const sql = (strings, ...values) => ({
    [PG_FRAGMENT]: true,
    strings,
    values,
    // Lazy thenable: the query only runs when awaited, so fragments that are
    // interpolated into a parent template never execute on their own.
    then(onFulfilled, onRejected) {
      const params = [];
      const text = build(strings, values, params);
      return pool.query(text, params).then((r) => r.rows).then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      return this.then(undefined, onRejected);
    },
  });

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
