# Auth Route — worker login, external portal login, employee/external-user CRUD
**Source:** `api/auth/index.js`
**Read this when:** changing any login flow (worker password, HHAH/PG portal), session echo, logout, or the create/list/update actions for employees and external users.

## What it does
Single serverless endpoint `/api/auth` that dispatches on `body.action` for POST and supports `GET ?session=1` to echo the current session's principal. Worker (employee) login is **single-factor**: `workerLogin` verifies the username + password and returns `{token, employee}` directly — there is no second stage and no `workerTotp` action. External (HHAH/PG portal) login is also single-factor password. Also hosts the admin CRUD for employees and external users. All errors are `httpError`s mapped by `handleError` (`api/_lib/http.js`) to their status.

> **Note:** TOTP helpers (`generateTotpSecret`, `verifyTotp`, `totpCode`, `otpauthUrl`) still exist in `api/_lib/auth.js` and `totp_secret` is stored on employee rows (the column is NOT NULL, so `createEmployee` generates and stores one), but they are **legacy/unused by the login flow** — worker login is single-factor password only, and the TOTP secret is never returned to the caller.

## Key functions / exports
| name | signature (params -> return) | behavior in one line | called by |
|---|---|---|---|
| `handler` (default) | `(req, res)` | GET `?session=1` → `sessionEcho`; POST → action switch; else 405/400 | Vercel routing (`/api/auth`) |
| `workerLogin` | `({username, password}) -> {token, employee}` | verifies employee password, issues a 12 h `complete` session token; single-factor, no second stage | action `workerLogin` ← `src/lib/authApi.js` |
| `externalLogin` | `({username, password}) -> {token, user}` | single-stage login for `external_users`; user enriched with agency/PG names | action `externalLogin` ← HHAH/PG portal pages |
| `sessionEcho` | `(req) -> {principalType, employee\|user}` | validates the Bearer `complete` session (either type) and returns its principal | `GET /api/auth?session=1` (page-load session restore) |
| `createEmployee` | `({username, displayName, jobRole, password}) -> {employee}` | dup-checks username, hashes password, generates a TOTP secret stored in the DB (legacy/unused by login) — **secret is NOT returned to the caller** | action `createEmployee` ← employees admin page |
| `updateEmployee` | `({id, displayName, jobRole, active, password}) -> {employee}` | partial update; omitted fields untouched; `password` re-hashed if present | action `updateEmployee` |
| `createExternalUser` | `(body) -> {user}` | validates userType scope (hhah→agencyId, pg→pgId, practitioner→practitionerId+NPI match) then inserts | action `createExternalUser` ← external users admin page |
| `updateExternalUser` | `({id, active, password, displayName}) -> {user}` | partial update of the only 3 mutable fields | action `updateExternalUser` |
| `publicEmployee` / `publicExternalUser` | `(row) -> object \| null` | strip secrets; external variant passes through joined `*_name` fields only when present | all employee/user responses |
| `externalSessionUser` | `async (user) -> object` | camelCase session shape + live `agencyName`/`pgName` lookups via `getSql()` | `externalLogin`, `sessionEcho` |

## Data shapes
```js
// POST /api/auth — always { action: '<name>', ...params }. Responses:
workerLogin      -> { token, employee: {id, username, displayName} } // 200; single-factor
externalLogin    -> { token, user: externalSessionUser }             // 200
logout           -> { ok: true }                                     // 200; Bearer = any token; never fails
createEmployee   -> { employee: publicEmployee }                     // 201 — TOTP secret stored in DB but NOT returned (legacy/unused by login)
listEmployees    -> { employees: publicEmployee[] }                  // 200
updateEmployee   -> { employee }                                     // 200
createExternalUser -> { user: publicExternalUser }                   // 201
listExternalUsers  -> { users: publicExternalUser[] }  // incl. agency_name/pg_name/practitioner_name
updateExternalUser -> { user }                                       // 200
// unknown action -> 400 { error: 'Unsupported auth action.' }

// externalSessionUser (portal session identity — drives portal scoping)
{ id, username, displayName, userType: 'hhah'|'pg', role: 'admin'|'practitioner',
  agencyId, agencyName, pgId, pgName, practitionerId, npi }

// GET /api/auth?session=1 (Bearer required)
{ principalType: 'employee', employee: {id, username, displayName} }
| { principalType: 'external', user: externalSessionUser }
```
Errors: 401 invalid credentials/session, 400 validation, 409 duplicate username, 404 unknown id on update — all as `{ error, ...details }`.

## Invariants & gotchas
- **Admin CRUD actions are unauthenticated** — `createEmployee`, `listEmployees`, `updateEmployee`, `createExternalUser`, `listExternalUsers`, `updateExternalUser` never call `requireSession`. POC-deliberate; add a guard here (recipe 3) before any real exposure.
- **Worker login is single-factor** — `workerLogin` returns `{token, employee}` directly. No `workerTotp` action exists. The `totp_secret` column and TOTP helpers in `api/_lib/auth.js` are legacy/unused by the login flow. `createEmployee` stores a generated TOTP secret in the DB (to satisfy the NOT NULL column) but does **not** return it to the caller.
- Login failures are deliberately uniform: wrong username, wrong password, and **inactive account** all return the same 401 `Invalid username or password` (no account enumeration).
- `createExternalUser` role rules: `userType:'hhah'` forces `role:'admin'` and requires `agencyId`; `userType:'pg'` requires `pgId`, role `admin|'practitioner'`; `role:'practitioner'` additionally requires `practitionerId` **and** an NPI whose `normalizeNpi` digits equal the mapped `practitioners.npi_digits` — a mismatch is a 400, so the practitioner row must exist with the right NPI first.
- Password length (≥8) is enforced solely by `hashPassword` throwing 400 — there is no separate check in this route.
- `logout` is best-effort (`.catch(() => {})`): always `{ ok: true }` even with a bogus/absent token.
- Update actions treat **absent** JSON keys as "keep" (they arrive `undefined`); sending `"jobRole": null` explicitly clears it. See [identity repo](../lib/identity-repo.md) semantics.
- Creates return **201**; everything else 200. `GET` without `?session=1` is a 400, other methods 405.

## Change recipes
1. **Add a new auth action:** write an `async function` in `api/auth/index.js`, add a `case` to the `switch` in `handler`, map rows through `publicEmployee`/`publicExternalUser`, then add the client wrapper in `src/lib/authApi.js` (`postAuth({ action: ... })`).
2. **Add a field to external users at creation:** extend validation + the `resolved` object in `createExternalUser`, thread through `createExternalUserRow` (see [identity repo](../lib/identity-repo.md) recipe 1 for the SQL side), and add it to `publicExternalUser` + `externalSessionUser` if portals need it.
3. **Protect the admin CRUD:** at the top of each CRUD case (or once before the switch for those actions) call `requireSession(req, { type: 'employee' })` from `api/_lib/auth.js`; the thrown 401s already flow through `handleError`. Update the admin pages (`src/pages/employees/`, `src/pages/external/`) to send the worker Bearer token.
5. **Change what a portal session knows:** edit `externalSessionUser` (it does live `home_health_agencies`/`physician_groups` name lookups); both `externalLogin` and `sessionEcho` pick it up automatically — then update consumers in `src/lib/authApi.js` and the portal pages.

## Related
- [auth primitives](../lib/auth.md) — hashing, TOTP, session mint/verify used here
- [identity repo](../lib/identity-repo.md) — the SQL layer behind every action
- [auth business model](../../business/auth-model.md) — roles, login policy, portal scoping rules
- [frontend lib](../../frontend/lib.md) — `src/lib/authApi.js` client contract for these actions
- [admin pages](../../frontend/pages/admin.md) — employees/external-user management UIs
- [portals](../../frontend/pages/portals.md) — HHAH/PG pages consuming `externalLogin`
- [db schema](../../db/schema.md) — identity table DDL and CHECK constraints
