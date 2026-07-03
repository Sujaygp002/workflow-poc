// Identity domain SQL: employees, external users, auth sessions.
import { getSql, jsonParam } from './db.js';

const EMPLOYEE_PUBLIC_COLS = 'id, username, display_name, job_role, totp_enabled, active, created_at, updated_at';
const EXTERNAL_PUBLIC_COLS = 'id, username, display_name, user_type, role, agency_id, pg_id, practitioner_id, npi, active, created_at, updated_at';

// ── Employees ────────────────────────────────────────────────────────────────
export async function createEmployeeRow({ username, displayName, jobRole, passwordHash, totpSecret }) {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO employees (username, display_name, job_role, password_hash, totp_secret)
    VALUES (${String(username).trim().toLowerCase()}, ${displayName}, ${jobRole || null}, ${passwordHash}, ${totpSecret})
    RETURNING id, username, display_name, job_role, totp_enabled, active, created_at, updated_at
  `;
  return rows[0];
}

export async function findEmployeeByUsername(username) {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM employees WHERE username = ${String(username || '').trim().toLowerCase()} LIMIT 1
  `;
  return rows[0] || null;
}

export async function getEmployee(id) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM employees WHERE id = ${id} LIMIT 1`;
  return rows[0] || null;
}

export async function listEmployees() {
  const sql = getSql();
  return sql`
    SELECT id, username, display_name, job_role, totp_enabled, active, created_at, updated_at
    FROM employees
    ORDER BY created_at DESC
  `;
}

export async function updateEmployeeRow(id, { displayName, jobRole, active, passwordHash } = {}) {
  const sql = getSql();
  const current = await getEmployee(id);
  if (!current) return null;
  const rows = await sql`
    UPDATE employees
    SET display_name = ${displayName === undefined ? current.display_name : displayName},
        job_role = ${jobRole === undefined ? current.job_role : jobRole},
        active = ${active === undefined ? current.active : !!active},
        password_hash = ${passwordHash === undefined ? current.password_hash : passwordHash},
        updated_at = now()
    WHERE id = ${id}
    RETURNING id, username, display_name, job_role, totp_enabled, active, created_at, updated_at
  `;
  return rows[0] || null;
}

// ── External users ───────────────────────────────────────────────────────────
export async function createExternalUserRow({
  username, displayName, passwordHash, userType, role = 'admin',
  agencyId = null, pgId = null, practitionerId = null, npi = null,
}) {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO external_users (username, display_name, password_hash, user_type, role, agency_id, pg_id, practitioner_id, npi)
    VALUES (
      ${String(username).trim().toLowerCase()}, ${displayName}, ${passwordHash}, ${userType}, ${role},
      ${agencyId}, ${pgId}, ${practitionerId}, ${npi}
    )
    RETURNING id, username, display_name, user_type, role, agency_id, pg_id, practitioner_id, npi, active, created_at, updated_at
  `;
  return rows[0];
}

export async function findExternalUserByUsername(username) {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM external_users WHERE username = ${String(username || '').trim().toLowerCase()} LIMIT 1
  `;
  return rows[0] || null;
}

export async function getExternalUser(id) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM external_users WHERE id = ${id} LIMIT 1`;
  return rows[0] || null;
}

export async function listExternalUsers() {
  const sql = getSql();
  return sql`
    SELECT u.id, u.username, u.display_name, u.user_type, u.role, u.agency_id, u.pg_id,
           u.practitioner_id, u.npi, u.active, u.created_at, u.updated_at,
           a.name AS agency_name,
           g.name AS pg_name,
           p.physician_name AS practitioner_name
    FROM external_users u
    LEFT JOIN home_health_agencies a ON a.id = u.agency_id
    LEFT JOIN physician_groups g ON g.id = u.pg_id
    LEFT JOIN practitioners p ON p.id = u.practitioner_id
    ORDER BY u.created_at DESC
  `;
}

export async function updateExternalUserRow(id, { active, passwordHash, displayName } = {}) {
  const sql = getSql();
  const current = await getExternalUser(id);
  if (!current) return null;
  const rows = await sql`
    UPDATE external_users
    SET active = ${active === undefined ? current.active : !!active},
        password_hash = ${passwordHash === undefined ? current.password_hash : passwordHash},
        display_name = ${displayName === undefined ? current.display_name : displayName},
        updated_at = now()
    WHERE id = ${id}
    RETURNING id, username, display_name, user_type, role, agency_id, pg_id, practitioner_id, npi, active, created_at, updated_at
  `;
  return rows[0] || null;
}

// ── Sessions ─────────────────────────────────────────────────────────────────
export async function createSession({ tokenHash, principalType, principalId, stage, expiresAt, meta = {} }) {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO auth_sessions (token_hash, principal_type, principal_id, stage, expires_at, meta)
    VALUES (${tokenHash}, ${principalType}, ${principalId}, ${stage}, ${expiresAt}, ${await jsonParam(meta)}::jsonb)
    RETURNING *
  `;
  return rows[0];
}

export async function findSessionByTokenHash(tokenHash) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM auth_sessions WHERE token_hash = ${tokenHash} LIMIT 1`;
  return rows[0] || null;
}

export async function deleteSessionByTokenHash(tokenHash) {
  const sql = getSql();
  const rows = await sql`DELETE FROM auth_sessions WHERE token_hash = ${tokenHash} RETURNING id`;
  return rows.length > 0;
}

export async function deleteExpiredSessions() {
  const sql = getSql();
  await sql`DELETE FROM auth_sessions WHERE expires_at < now()`;
}

export { EMPLOYEE_PUBLIC_COLS, EXTERNAL_PUBLIC_COLS };
