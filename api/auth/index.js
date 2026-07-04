// Identity domain: worker (employee) 2FA login, external portal login,
// employee + external user CRUD. POST action dispatch + GET ?session=1 echo.
import { handleError, methodNotAllowed, readJson, sendJson } from '../_lib/http.js';
import {
  bearerToken,
  createSessionFor,
  destroySession,
  generateTotpSecret,
  hashPassword,
  httpError,
  requireSession,
  verifyPassword,
} from '../_lib/auth.js';
import {
  createEmployeeRow,
  createExternalUserRow,
  findEmployeeByUsername,
  findExternalUserByUsername,
  listEmployees,
  listExternalUsers,
  updateEmployeeRow,
  updateExternalUserRow,
} from '../_lib/identityRepo.js';
import { getSql } from '../_lib/db.js';
import { normalizeNpi } from '../_lib/normalizers.js';

function publicEmployee(row) {
  if (!row) return null;
  const { id, username, display_name, job_role, totp_enabled, active, created_at, updated_at } = row;
  return { id, username, display_name, job_role, totp_enabled, active, created_at, updated_at };
}

function publicExternalUser(row) {
  if (!row) return null;
  const {
    id, username, display_name, user_type, role, agency_id, pg_id, practitioner_id, npi,
    active, created_at, updated_at, agency_name, pg_name, practitioner_name,
  } = row;
  return {
    id, username, display_name, user_type, role, agency_id, pg_id, practitioner_id, npi,
    active, created_at, updated_at,
    ...(agency_name !== undefined ? { agency_name } : {}),
    ...(pg_name !== undefined ? { pg_name } : {}),
    ...(practitioner_name !== undefined ? { practitioner_name } : {}),
  };
}

async function externalSessionUser(user) {
  const sql = getSql();
  let agencyName = null;
  let pgName = null;
  if (user.agency_id) {
    const rows = await sql`SELECT name FROM home_health_agencies WHERE id = ${user.agency_id} LIMIT 1`;
    agencyName = rows[0]?.name || null;
  }
  if (user.pg_id) {
    const rows = await sql`SELECT name FROM physician_groups WHERE id = ${user.pg_id} LIMIT 1`;
    pgName = rows[0]?.name || null;
  }
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    userType: user.user_type,
    role: user.role,
    agencyId: user.agency_id,
    agencyName,
    pgId: user.pg_id,
    pgName,
    practitionerId: user.practitioner_id,
    npi: user.npi,
  };
}

// Worker login is single-factor (username + password). 2FA/TOTP was removed:
// a successful password check mints a complete session immediately.
async function workerLogin({ username, password }) {
  const employee = await findEmployeeByUsername(username);
  if (!employee || !employee.active || !verifyPassword(password, employee.password_hash)) {
    throw httpError(401, 'Invalid username or password');
  }
  const { token } = await createSessionFor({ principalType: 'employee', principalId: employee.id });
  return {
    token,
    employee: { id: employee.id, username: employee.username, displayName: employee.display_name },
  };
}

async function externalLogin({ username, password }) {
  const user = await findExternalUserByUsername(username);
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    throw httpError(401, 'Invalid username or password');
  }
  const { token } = await createSessionFor({ principalType: 'external', principalId: user.id });
  return { token, user: await externalSessionUser(user) };
}

async function createEmployee({ username, displayName, jobRole, password }) {
  if (!username || !String(username).trim()) throw httpError(400, 'Username is required');
  if (!displayName || !String(displayName).trim()) throw httpError(400, 'Display name is required');
  const existing = await findEmployeeByUsername(username);
  if (existing) throw httpError(409, 'That username is already taken');
  // 2FA/TOTP login was removed, so no enrollment secret is shown. The DB column
  // is NOT NULL, so still store a generated secret (unused at login).
  const employee = await createEmployeeRow({
    username,
    displayName: String(displayName).trim(),
    jobRole: jobRole || null,
    passwordHash: hashPassword(password),
    totpSecret: generateTotpSecret(),
  });
  return { employee: publicEmployee(employee) };
}

async function updateEmployee({ id, displayName, jobRole, active, password }) {
  if (!id) throw httpError(400, 'Employee id is required');
  const employee = await updateEmployeeRow(id, {
    displayName,
    jobRole,
    active,
    passwordHash: password === undefined ? undefined : hashPassword(password),
  });
  if (!employee) throw httpError(404, 'Employee not found');
  return { employee: publicEmployee(employee) };
}

async function createExternalUser(body) {
  const {
    username, password, displayName, userType, agencyId, pgId,
    role = 'admin', practitionerName, npi, practitionerId,
  } = body;
  if (!username || !String(username).trim()) throw httpError(400, 'Username is required');
  if (!displayName || !String(displayName).trim()) throw httpError(400, 'Display name is required');
  if (!['hhah', 'pg'].includes(userType)) throw httpError(400, 'userType must be "hhah" or "pg"');
  const existing = await findExternalUserByUsername(username);
  if (existing) throw httpError(409, 'That username is already taken');

  let resolved = { agencyId: null, pgId: null, practitionerId: null, npi: null, role: 'admin' };
  if (userType === 'hhah') {
    if (!agencyId) throw httpError(400, 'HHAH users need an agencyId');
    resolved.agencyId = agencyId;
  } else {
    if (!pgId) throw httpError(400, 'PG users need a pgId');
    resolved.pgId = pgId;
    if (!['admin', 'practitioner'].includes(role)) throw httpError(400, 'role must be "admin" or "practitioner"');
    resolved.role = role;
    if (role === 'practitioner') {
      if (!practitionerId) throw httpError(400, 'PG practitioner users must map to a practitioner');
      const npiDigits = normalizeNpi(npi);
      if (!npiDigits) throw httpError(400, 'PG practitioner users need an NPI');
      const sql = getSql();
      const rows = await sql`SELECT id, npi_digits FROM practitioners WHERE id = ${practitionerId} LIMIT 1`;
      const practitioner = rows[0];
      if (!practitioner) throw httpError(400, 'Mapped practitioner not found');
      if (practitioner.npi_digits !== npiDigits) {
        throw httpError(400, 'NPI does not match the mapped practitioner');
      }
      resolved.practitionerId = practitioner.id;
      resolved.npi = npiDigits;
    }
  }

  const user = await createExternalUserRow({
    username,
    displayName: String(displayName).trim() || practitionerName || username,
    passwordHash: hashPassword(password),
    userType,
    role: resolved.role,
    agencyId: resolved.agencyId,
    pgId: resolved.pgId,
    practitionerId: resolved.practitionerId,
    npi: resolved.npi,
  });
  return { user: publicExternalUser(user) };
}

async function updateExternalUser({ id, active, password, displayName }) {
  if (!id) throw httpError(400, 'User id is required');
  const user = await updateExternalUserRow(id, {
    active,
    displayName,
    passwordHash: password === undefined ? undefined : hashPassword(password),
  });
  if (!user) throw httpError(404, 'User not found');
  return { user: publicExternalUser(user) };
}

async function sessionEcho(req) {
  const { session, employee, externalUser } = await requireSession(req, {});
  if (session.principal_type === 'employee') {
    return {
      principalType: 'employee',
      employee: { id: employee.id, username: employee.username, displayName: employee.display_name },
    };
  }
  return { principalType: 'external', user: await externalSessionUser(externalUser) };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      if (req.query?.session === '1') return sendJson(res, 200, await sessionEcho(req));
      return sendJson(res, 400, { error: 'Use ?session=1 or POST an action.' });
    }
    if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

    const body = await readJson(req);
    switch (body.action) {
      case 'workerLogin':
        return sendJson(res, 200, await workerLogin(body));
      case 'externalLogin':
        return sendJson(res, 200, await externalLogin(body));
      case 'logout':
        await destroySession(bearerToken(req)).catch(() => {});
        return sendJson(res, 200, { ok: true });
      case 'createEmployee':
        return sendJson(res, 201, await createEmployee(body));
      case 'listEmployees':
        return sendJson(res, 200, { employees: (await listEmployees()).map(publicEmployee) });
      case 'updateEmployee':
        return sendJson(res, 200, await updateEmployee(body));
      case 'createExternalUser':
        return sendJson(res, 201, await createExternalUser(body));
      case 'listExternalUsers':
        return sendJson(res, 200, { users: (await listExternalUsers()).map(publicExternalUser) });
      case 'updateExternalUser':
        return sendJson(res, 200, await updateExternalUser(body));
      default:
        return sendJson(res, 400, { error: 'Unsupported auth action.' });
    }
  } catch (error) {
    return handleError(res, error);
  }
}
