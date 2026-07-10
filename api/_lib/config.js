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

// SMTP for outbound email (missing-upload notifications). Hardcoded fallbacks for
// a personal test app — env vars still override. These are a real Gmail account +
// app password committed to public git history; rotate before any real use.
export const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
export const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
export const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
export const SMTP_USER = process.env.SMTP_USER || 'invovationmailer2026@gmail.com';
export const SMTP_PASS = process.env.SMTP_PASS || 'dnhjnqyfcufgzqqn';
export const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'no-reply@hhh-intake.local';

// AWS S3 for blob storage (replaces Vercel Blob in AWS deployment)
export const S3_BUCKET = process.env.S3_BUCKET || '';
export const S3_REGION = process.env.S3_REGION || 'eu-north-1';
export const S3_PUBLIC_URL_BASE = process.env.S3_PUBLIC_URL_BASE || '';

// Twilio for outbound agency SMS / calls. ENV-ONLY — NO hardcoded fallbacks (this
// is a NEW credential; the repo is public, so a leaked live token is unacceptable).
// When any of SID / token / from-number is unset, the twilio module degrades
// gracefully to { sent:false, skipped:true, reason:'twilio_not_configured' } and
// never throws. TWILIO_TO_OVERRIDE (optional) redirects every outbound to one test
// number for safe demoing.
export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
export const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
export const TWILIO_TO_OVERRIDE = process.env.TWILIO_TO_OVERRIDE || '';
