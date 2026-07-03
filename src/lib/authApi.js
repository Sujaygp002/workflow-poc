// Command Center auth client. Bearer tokens live in sessionStorage under
// per-surface keys; every protected call sends Authorization: Bearer <token>.
const TOKEN_KEYS = {
  worker: 'cc_worker_token',
  hhah: 'cc_hhah_token',
  pg: 'cc_pg_token',
};

export function getAuthToken(kind) {
  const key = TOKEN_KEYS[kind];
  if (!key) return null;
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setAuthToken(kind, token) {
  const key = TOKEN_KEYS[kind];
  if (!key) return;
  try {
    if (token) sessionStorage.setItem(key, token);
    else sessionStorage.removeItem(key);
  } catch {
    // sessionStorage unavailable (SSR/test) — tokens just won't persist.
  }
}

export function clearAuthToken(kind) {
  setAuthToken(kind, null);
}

export function authHeaders(kind) {
  const token = getAuthToken(kind);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function postAuth(body, headers = {}) {
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || 'Auth request failed');
    error.status = res.status;
    throw error;
  }
  return data;
}

// ── Worker (employee) 2FA login ──────────────────────────────────────────────
export async function workerLogin({ username, password }) {
  return postAuth({ action: 'workerLogin', username, password });
}

export async function workerTotp({ code, tempToken }) {
  const result = await postAuth(
    { action: 'workerTotp', code },
    { Authorization: `Bearer ${tempToken}` },
  );
  if (result.token) setAuthToken('worker', result.token);
  return result;
}

// ── External portal login (kind: 'hhah' | 'pg') ─────────────────────────────
export async function externalLogin({ username, password, kind }) {
  const result = await postAuth({ action: 'externalLogin', username, password });
  if (kind && result.token) setAuthToken(kind, result.token);
  return result;
}

export async function logout(kind) {
  try {
    await postAuth({ action: 'logout' }, authHeaders(kind));
  } finally {
    clearAuthToken(kind);
  }
  return { ok: true };
}

export async function getSession(kind) {
  const res = await fetch('/api/auth?session=1', { headers: authHeaders(kind) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || 'No active session');
    error.status = res.status;
    throw error;
  }
  return data;
}

// ── Employees (Command Center admin surface) ────────────────────────────────
export async function createEmployee({ username, displayName, jobRole, password }) {
  return postAuth({ action: 'createEmployee', username, displayName, jobRole, password });
}

export async function listEmployees() {
  const result = await postAuth({ action: 'listEmployees' });
  return result.employees || [];
}

export async function updateEmployee({ id, displayName, jobRole, active, password }) {
  return postAuth({ action: 'updateEmployee', id, displayName, jobRole, active, password });
}

// ── External users ───────────────────────────────────────────────────────────
export async function createExternalUser(payload) {
  return postAuth({ action: 'createExternalUser', ...payload });
}

export async function listExternalUsers() {
  const result = await postAuth({ action: 'listExternalUsers' });
  return result.users || [];
}

export async function updateExternalUser({ id, active, password, displayName }) {
  return postAuth({ action: 'updateExternalUser', id, active, password, displayName });
}
