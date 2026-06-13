// Hardcoded defaults for a personal test app. Env vars (e.g. on Vercel)
// override these when set. Do NOT use this pattern for anything with real
// users — these are live credentials committed to the repo.

export const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://neondb_owner:npg_6tOLXbu8rahk@ep-steep-bonus-at6zoyzh-pooler.c-9.us-east-1.aws.neon.tech/neondb?channel_binding=require&sslmode=require';

export const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  'AQ.Ab8RN6IDhfGCleaVVOl3XO7ZzUWZBoXScfD2j0giXMug_4hKRA';

export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

export const BLOB_READ_WRITE_TOKEN =
  process.env.BLOB_READ_WRITE_TOKEN ||
  'vercel_blob_rw_Mj10cXp6A8JClcKA_h10io6jawhYAs0hUbuQHDR8GFSxe8u';

// SMTP for outbound email (missing-upload notifications). These are real mail
// credentials, so they are env-only — set them on Vercel (or in a local .env).
// When unset, the mailer logs the email instead of sending (no-op fallback).
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE ("true"/"false"), SMTP_USER, SMTP_PASS, SMTP_FROM
export const SMTP_HOST = process.env.SMTP_HOST || '';
export const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
export const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
export const SMTP_USER = process.env.SMTP_USER || '';
export const SMTP_PASS = process.env.SMTP_PASS || '';
export const SMTP_FROM = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@hhh-intake.local';
