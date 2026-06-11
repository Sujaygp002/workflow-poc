import { neon } from '@neondatabase/serverless';
import { DATABASE_URL } from './config.js';

let sqlClient;

export function getSql() {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }
  if (!sqlClient) {
    sqlClient = neon(DATABASE_URL);
  }
  return sqlClient;
}

export async function jsonParam(value) {
  return JSON.stringify(value ?? {});
}
