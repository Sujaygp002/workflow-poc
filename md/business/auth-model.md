# Auth Model — employees vs external users, sessions, portal scoping

**Source:** `api/_lib/auth.js`, `api/_lib/identityRepo.js`, `api/auth/index.js`, `db/migrations/003_identity_and_builder.sql`; guards in `api/work-items/*`, `api/orders/index.js`, `api/workflows/bulk-upload/start.js`
**Read this when:** changing who can log in where, login flows, external-user roles/scoping, or which routes require auth.

## The business rules
1. **Two kinds of accounts.** **Employees** are internal staff who work tasks (worker portal). **External users** are partners: HHAH agency staff and PG (physician group) people.
2. **Nothing is seeded — fresh auth everywhere.** No test credentials. A portal only accepts accounts created in Command Center (Employees page / External Users page).
3. **Worker login is single-factor** (username + password). `workerLogin` returns `{token, employee}` directly — there is no TOTP second stage.
4. **External login is single-factor** (username + password) and is **type-gated**: `/hhh-login` accepts only `user_type='hhah'`, `/pg-login` only `user_type='pg'`.
5. **PG users have a role.** `admin` sees a "Coming soon" dashboard (view-only). `practitioner` (created with a name + NPI mapped to an Entity practitioner) gets the Bulk Sign screen.
6. **Portal scope comes from the session, not the client.** An HHAH user's uploads are stamped with their agency; a PG practitioner signs only for their PG. The client never chooses the scope id.
7. **Command Center admin pages are intentionally UNAUTHENTICATED** (Employees/Entity/External Users/Builder) — a POC convenience. Only the worker + partner portals enforce login.

> **Note:** TOTP helper functions (`generateTotpSecret`, `verifyTotp`, `totpCode`, `otpauthUrl`) exist in `api/_lib/auth.js` and `totp_secret` is stored on employee rows, but they are **legacy/unused by the current login flow**. All four surfaces (worker portal, HHAH portal, PG portal, admin SPA) use single-factor password authentication.

## How the rules map to code
| Rule | Code |
|---|---|
| Password hashing | `hashPassword`/`verifyPassword` (scrypt) in `auth.js` |
| Sessions | `createSessionFor`/`requireSession`/`destroySession` in `auth.js`; `auth_sessions` table |
| Single-factor worker login | `workerLogin` → `{token, employee}` (12 h complete session) in `api/auth/index.js` |
| External login + type gate | `externalLogin` in `api/auth/index.js`; frontend rejects the wrong type; upload/sign routes re-check type |
| Roles & practitioner mapping + NPI check | `createExternalUser` in `api/auth/index.js` verifies `practitionerId` NPI == typed NPI |
| Scope from session | `bulk-upload/start.js` `stampSessionAgency`; `orders bulkSign` uses `externalUser.pg_id` |
| Employee/external CRUD | `identityRepo.js` (`createEmployee`, `getEmployee`, `listEmployees`, `createExternalUser`, `getExternalUser`, session CRUD) |

## Data shapes
```js
// employees: { id, username, display_name, job_role, password_hash, totp_secret, totp_enabled, active }
// external_users: { id, username, display_name, password_hash,
//   user_type:'hhah'|'pg', role:'admin'|'practitioner',
//   agency_id?, pg_id?, practitioner_id?, npi?, active }
// auth_sessions: { token_hash /* sha256 */, principal_type:'employee'|'external',
//   principal_id, stage:'complete', expires_at, meta }
```
Worker login (single-factor; client holds the token; server stores only its sha256):
`POST /api/auth {action:'workerLogin', username, password}` → `{token, employee}` (12-h complete session).
External: `POST /api/auth {action:'externalLogin', username, password}` → `{token, user:{…, userType, role, agencyId, agencyName, pgId, pgName, practitionerId, npi}}`.
Client token keys (sessionStorage): `cc_worker_token`, `cc_hhah_token`, `cc_pg_token` (see [frontend lib](../frontend/lib.md)).

## Invariants & gotchas
- **The DB constraints enforce the role/scope shape:** `external_users` CHECKs require an `agency_id` for hhah, a `pg_id` for pg, and a `practitioner_id` for `role='practitioner'` (see [schema](../db/schema.md)). You can't create an inconsistent external user.
- **NPI is re-verified server-side** at practitioner-user creation — a typed NPI that doesn't match the mapped Entity practitioner is rejected. The Entity practitioner is the source of truth ([data-reads route](../backend/routes/data-reads.md)).
- **`requireSession` requires the `complete` stage** — worker and external sessions are both issued as `complete` directly. Inactive principals 401 even with a valid token.
- **Raw tokens are never stored** (only sha256) — you can't list or recover a session token; logout needs the client's copy.
- **Admin pages have no guard** — this is deliberate (POC) but means the main URL is effectively a house key. Don't assume Employees/Entity/External Users are protected.

## Change recipes
1. **Add an auth guard to a route:** `const { employee } = await requireSession(req, {type:'employee'})` (or `{type:'external'}` → `{externalUser}`); see [auth primitives](../backend/lib/auth.md) recipe 2.
2. **Add an external role or scope:** extend `external_users` (migration + CHECKs in [schema](../db/schema.md)), `createExternalUser` in `api/auth/index.js`, the [External Users page](../frontend/pages/admin.md), and the target portal's role handling ([portals](../frontend/pages/portals.md)).
3. **Change session lifetime:** edit `auth.js` (`COMPLETE_STAGE_TTL_MS`) — see [auth primitives](../backend/lib/auth.md) recipe 1.
4. **Protect the admin pages:** wrap the admin routes' data calls with a session, or gate `App.jsx` — currently intentionally open.

## Related
- [auth primitives](../backend/lib/auth.md) — scrypt/TOTP/session function contracts
- [identity repo](../backend/lib/identity-repo.md) — employee/external/session SQL
- [auth route](../backend/routes/auth.md) — the single-factor login + CRUD HTTP surface
- [db schema](../db/schema.md) — `employees`/`external_users`/`auth_sessions` DDL + CHECKs
- [admin frontend](../frontend/pages/admin.md) — Employees + External Users pages
- [portals frontend](../frontend/pages/portals.md) — `/hhh-login` + `/pg-login` behavior
- [frontend lib](../frontend/lib.md) — `authApi.js` token handling
