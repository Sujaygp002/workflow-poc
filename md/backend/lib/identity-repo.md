# Identity Repo — SQL for employees, external users, and auth sessions
**Source:** `api/_lib/identityRepo.js`
**Read this when:** adding/altering columns on `employees` / `external_users` / `auth_sessions`, changing username normalization, changing what user fields are readable/updatable, or session persistence behavior.

## What it does
Thin JDBC-style data layer (Neon tagged-template SQL via `db.js getSql()`) for the three identity tables created in `db/migrations/003_identity_and_builder.sql`. No business logic: validation, hashing, and public-shape mapping live in `api/_lib/auth.js` and `api/auth/index.js`. Usernames are normalized (`trim().toLowerCase()`) at **both** insert and lookup. `find*`/`get*` return full rows **including secrets** (`password_hash`, `totp_secret`); `list*` return only public columns.

## Key functions / exports
| name | signature (params -> return) | behavior in one line | called by |
|---|---|---|---|
| `createEmployeeRow` | `({username, displayName, jobRole, passwordHash, totpSecret}) -> public row` | INSERT with lowercased username; RETURNING public cols (no secrets) | `createEmployee` in `api/auth/index.js` |
| `findEmployeeByUsername` | `(username) -> full row \| null` | lowercased lookup; **includes `password_hash` + `totp_secret`** (totp_secret is stored but unused by the single-factor login) | `workerLogin`, `createEmployee` dup-check |
| `getEmployee` | `(id) -> full row \| null` | by-id fetch, full row | `requireSession` (auth.js), `updateEmployeeRow`, `api/_lib/builderCompiler.js` |
| `listEmployees` | `() -> public rows[]` | public cols only, newest first | `listEmployees` action; `api/workflows/index.js` (builder bucket assignment) |
| `updateEmployeeRow` | `(id, {displayName, jobRole, active, passwordHash}) -> public row \| null` | read-modify-write; **`undefined` = keep current, `null`/value = overwrite**; bumps `updated_at` | `updateEmployee` in `api/auth/index.js` |
| `createExternalUserRow` | `({username, displayName, passwordHash, userType, role='admin', agencyId, pgId, practitionerId, npi}) -> public row` | INSERT external portal user; nullable scope FKs default null | `createExternalUser` in `api/auth/index.js` |
| `findExternalUserByUsername` | `(username) -> full row \| null` | lowercased lookup, full row incl. `password_hash` | `externalLogin`, dup-check |
| `getExternalUser` | `(id) -> full row \| null` | by-id fetch | `requireSession` (auth.js), `updateExternalUserRow` |
| `listExternalUsers` | `() -> rows[]` | public cols **plus** LEFT-JOINed `agency_name`, `pg_name`, `practitioner_name` | `listExternalUsers` action |
| `updateExternalUserRow` | `(id, {active, passwordHash, displayName}) -> public row \| null` | same `undefined`-keeps semantics; only these 3 fields are updatable (scope FKs are immutable post-create) | `updateExternalUser` in `api/auth/index.js` |
| `createSession` | `({tokenHash, principalType, principalId, stage, expiresAt, meta={}}) -> row` | INSERT into `auth_sessions`; `meta` serialized via `db.js jsonParam` `::jsonb` | `createSessionFor` in `api/_lib/auth.js` |
| `findSessionByTokenHash` | `(tokenHash) -> row \| null` | unique lookup on `token_hash` | `requireSession` |
| `deleteSessionByTokenHash` | `(tokenHash) -> boolean` | DELETE returning whether a row existed | `destroySession`, expired-row cleanup in `requireSession` |
| `deleteExpiredSessions` | `() -> void` | `DELETE ... WHERE expires_at < now()` lazy sweep | `requireSession` on every call |
| `EMPLOYEE_PUBLIC_COLS` / `EXTERNAL_PUBLIC_COLS` | string constants | documentation of the public column sets (queries inline them — tagged templates can't interpolate identifiers) | exported, currently unreferenced |

## Data shapes
```js
// employees row (full — find/get only; public shape omits password_hash + totp_secret)
{ id: uuid, username, display_name, job_role, password_hash: 's2$…',
  totp_secret: 'BASE32…', totp_enabled: true, active: true, created_at, updated_at }

// external_users row (full). CHECKs enforced by DB (migration 003):
//   user_type IN ('hhah','pg'); role IN ('admin','practitioner')
//   hhah => agency_id NOT NULL; pg => pg_id NOT NULL; practitioner => practitioner_id NOT NULL
{ id, username, display_name, password_hash, user_type: 'hhah'|'pg',
  role: 'admin'|'practitioner', agency_id, pg_id, practitioner_id, npi,
  active, created_at, updated_at }

// listExternalUsers adds: agency_name, pg_name, practitioner_name (nullable, from LEFT JOINs)

// auth_sessions row
{ id, token_hash /* sha256 hex, UNIQUE */, principal_type: 'employee'|'external',
  principal_id: uuid /* no FK — validated at read time by requireSession */,
  stage: 'password'|'complete', expires_at, meta: jsonb, created_at }
```

## Invariants & gotchas
- **Username normalization must stay symmetric**: `create*Row` and `find*ByUsername` both `trim().toLowerCase()`. If you add another lookup path, normalize the same way or logins will miss.
- **`find*`/`get*` leak secrets by design** (login + TOTP need them). Never return these rows to a client raw — map through `publicEmployee`/`publicExternalUser` in `api/auth/index.js`.
- **`undefined` vs `null` in updates matters**: `updateEmployeeRow`/`updateExternalUserRow` keep the current value only when a field is `undefined`; explicit `null` overwrites (e.g. clears `job_role`). Callers passing destructured request bodies get this for free — absent JSON keys arrive as `undefined`.
- Updates are **read-modify-write** (SELECT then UPDATE), not atomic; concurrent updates last-write-wins per field snapshot. Fine for this POC's admin UI.
- `updateExternalUserRow` deliberately cannot change `user_type`, `role`, `agency_id`, `pg_id`, `practitioner_id`, `npi` — scope is fixed at creation; deactivate + recreate to rescope.
- `auth_sessions.principal_id` has **no FK** — deleting an employee/external user leaves orphan sessions, but `requireSession` 401s them because the principal fetch returns null.
- `employees.totp_enabled` defaults true and `totp_secret` is stored, but the current single-factor login does not use them — they are legacy columns. TOTP verification is not part of the login flow.
- `createEmployeeRow`/`createExternalUserRow` will throw the raw Postgres unique-violation on duplicate usernames; routes avoid this by dup-checking with `find*ByUsername` first (a benign race for a POC).
- Session expiry cleanup is **lazy only** (`deleteExpiredSessions` inside `requireSession`); no scheduled job.

## Change recipes
1. **Add a column to employees/external_users:** ADD COLUMN in a new `db/migrations/*.sql`, add it to the INSERT + RETURNING in `create*Row`, the SELECT list in `list*`, the SET/RETURNING in `update*Row` (with the `undefined`-keeps pattern), then expose it in `publicEmployee`/`publicExternalUser` in `api/auth/index.js`.
2. **Make an external-user field editable post-create:** add it to `updateExternalUserRow`'s param object + SET clause (follow the `x === undefined ? current.x : x` idiom), then thread it through `updateExternalUser` in `api/auth/index.js` and the client call in `src/lib/authApi.js`.
3. **Add a new lookup (e.g. by agency):** new exported `async function` here using `getSql()`; return public cols unless the caller genuinely needs secrets, and say which in a comment.
4. **Store more on sessions:** prefer `meta` jsonb (no migration); only add real columns if you must query on them — then update `createSession`'s INSERT and `db/migrations`.

## Related
- [auth primitives](./auth.md) — hashing/TOTP/session logic layered on this repo
- [auth route](../routes/auth.md) — the only CRUD caller; maps rows to public shapes
- [db schema](../../db/schema.md) — full DDL + CHECK constraints for these tables
- [utils](./utils.md) — `db.js getSql`/`jsonParam` used by every function here
- [repositories](./repositories.md) — the sibling domain repo for patients/orders/runs
