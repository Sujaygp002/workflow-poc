// Command Center auth primitives — dependency-free (node:crypto only).
// Password hashing (scrypt), TOTP (RFC 6238 via HMAC-SHA1 HOTP), bearer sessions.
import crypto from 'node:crypto';
import {
  createSession as dbCreateSession,
  deleteExpiredSessions,
  deleteSessionByTokenHash,
  findSessionByTokenHash,
  getEmployee,
  getExternalUser,
} from './identityRepo.js';

// ── Password hashing (scrypt) ────────────────────────────────────────────────
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw httpError(400, 'Password must be at least 8 characters');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `s2$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 's2') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password ?? ''), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ── Base32 (RFC 4648, no padding) ────────────────────────────────────────────
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ── TOTP (RFC 6238: HMAC-SHA1, 6 digits, 30 s period) ───────────────────────
export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(keyBuffer, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', keyBuffer).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

export function totpCode(secretB32, timestampMs = Date.now()) {
  const counter = Math.floor(timestampMs / 1000 / 30);
  return hotp(base32Decode(secretB32), counter);
}

export function verifyTotp(secretB32, code, timestampMs = Date.now()) {
  const submitted = String(code || '').trim();
  if (!/^\d{6}$/.test(submitted)) return false;
  const key = base32Decode(secretB32);
  const counter = Math.floor(timestampMs / 1000 / 30);
  for (const skew of [-1, 0, 1]) {
    const expected = hotp(key, counter + skew);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(submitted))) return true;
  }
  return false;
}

export function otpauthUrl(username, secretB32) {
  const label = encodeURIComponent(`CommandCenter:${username}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=CommandCenter&algorithm=SHA1&digits=6&period=30`;
}

// ── Sessions ─────────────────────────────────────────────────────────────────
const PASSWORD_STAGE_TTL_MS = 5 * 60 * 1000;      // 5 min to enter the TOTP code
const COMPLETE_STAGE_TTL_MS = 12 * 60 * 60 * 1000; // 12 h working session

export function httpError(status, message, details = null) {
  const error = new Error(message);
  error.status = status;
  if (details) error.details = details;
  return error;
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export async function createSessionFor({ principalType, principalId, stage = 'complete', meta = {} }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = stage === 'password' ? PASSWORD_STAGE_TTL_MS : COMPLETE_STAGE_TTL_MS;
  const session = await dbCreateSession({
    tokenHash: hashToken(token),
    principalType,
    principalId,
    stage,
    expiresAt: new Date(Date.now() + ttl).toISOString(),
    meta,
  });
  return { token, session };
}

export function bearerToken(req) {
  const header = req.headers?.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

// Reads the bearer header, resolves the non-expired session + its principal.
// Throws a 401-mapped error on any failure. `type` = 'employee' | 'external'.
export async function requireSession(req, { type, stage = 'complete' } = {}) {
  const token = bearerToken(req);
  if (!token) throw httpError(401, 'Authentication required');
  await deleteExpiredSessions().catch(() => {});
  const session = await findSessionByTokenHash(hashToken(token));
  if (!session) throw httpError(401, 'Invalid or expired session');
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await deleteSessionByTokenHash(session.token_hash).catch(() => {});
    throw httpError(401, 'Invalid or expired session');
  }
  if (stage && session.stage !== stage) throw httpError(401, 'Invalid session stage');
  if (type && session.principal_type !== type) throw httpError(401, 'Wrong session type');

  if (session.principal_type === 'employee') {
    const employee = await getEmployee(session.principal_id);
    if (!employee || !employee.active) throw httpError(401, 'Account is inactive');
    return { session, employee };
  }
  const externalUser = await getExternalUser(session.principal_id);
  if (!externalUser || !externalUser.active) throw httpError(401, 'Account is inactive');
  return { session, externalUser };
}

export async function destroySession(token) {
  if (!token) return false;
  return deleteSessionByTokenHash(hashToken(token));
}
