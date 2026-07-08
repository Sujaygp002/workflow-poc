# Admin Pages — Employees, Entity, and External Users management screens
**Source:** `src/pages/employees/Employees.jsx`, `src/pages/entity/Entity.jsx`, `src/pages/external/ExternalUsers.jsx`
**Read this when:** changing account creation/deactivation UI, HHAH/PG/practitioner entity creation, PG↔practitioner mapping, practitioner-login NPI matching, or password-reset flows.

## What it does
Three internal admin screens (main app sidebar, no auth gate on the pages themselves):
- **`/employees`** (`Employees.jsx`) — CRUD-ish management of internal worker-portal accounts: create, reset password, activate/deactivate toggle.
- **`/entity`** (`Entity.jsx`) — create the reference entities: Agencies (HHAH), Physician Groups (PG), Practitioners; and map PGs to practitioners (the link the Coverage Map and practitioner logins depend on).
- **`/external-users`** (`ExternalUsers.jsx`) — create/manage the logins for the HHAH portal (`/hhh-login`) and PG portal (`/pg-login`), including PG *practitioner* logins that must map (by NPI) to an Entity-page practitioner.

## Key functions / exports
| name | signature (params -> return) | behavior in one line | called by |
|---|---|---|---|
| `Employees` (default) | `() -> JSX` | Lists employees via `listEmployees()`, hosts AddEmployeeCard + per-row actions | route `/employees` in `src/App.jsx` |
| `AddEmployeeCard` | `({onCreated}) -> JSX` | Validates (name+username required, password ≥8, match), calls `createEmployee`, passes result up | `Employees` |
| `ResetPasswordRow` (both files) | `({employee\|user, onDone, onCancel}) -> JSX` | Inline `<tr>` form; calls `updateEmployee`/`updateExternalUser` with `{id, password}` | employee/user table rows |
| `toggleActive` (both files) | `(row) -> Promise` | `window.confirm` on deactivate only, then `update*({id, active})` + refresh | Active toggle + Deactivate/Reactivate buttons |
| `Entity` (default) | `() -> JSX` | Three `EntityCard`s (agency/PG/practitioner) + PG↔practitioner mapping panel | route `/entity` |
| `mergeCreated` | `(listKey, row) -> void` | Optimistically prepends the POST-response row into `data[listKey]`, deduped by id, so it's usable before the follow-up GET | `submitAgency/Pg/Practitioner` |
| `submitMapping` | `(event) -> Promise` | Loops `mapPgToPractitioner({pgId, practitionerId})` **sequentially** (API maps one per call), collects per-practitioner failures | mapping form |
| `ExternalUsers` (default) | `() -> JSX` | `Promise.all([listExternalUsers(), fetchReferenceData()])`; table of users w/ type/role badges | route `/external-users` |
| `CreateExternalUserCard` | `({reference, onCreated}) -> JSX` | Type radio (hhah/pg), PG role radio (admin/practitioner), NPI→practitioner mapping picker, calls `createExternalUser` | `ExternalUsers` |
| `npiDigitsOf` | `(value) -> string` | Digits-only NPI normalizer — mirrors server `normalizeNpi` in `api/_lib/normalizers.js` | NPI matching |

## Data shapes
Employee row (from `listEmployees()`): `{ id, username, display_name, job_role, totp_enabled, active, created_at }`.
`createEmployee` payload/response:
```js
// payload
{ username, displayName, jobRole?, password }
// response
{ employee: { id, display_name, username, job_role, totp_enabled, active, created_at, updated_at } }
```
Note: TOTP enrollment was removed from the login flow. The server still generates and stores a `totp_secret` in the DB column (NOT NULL constraint) but it is unused at login. No secret is returned to the client.
External user row: `{ id, username, display_name, user_type: 'hhah'|'pg', role: 'admin'|'practitioner', agency_name?, pg_name?, practitioner_name?, npi?, active, created_at }`.
`createExternalUser` payload:
```js
{ username, displayName, password, userType: 'hhah'|'pg',
  // hhah: role forced 'admin'
  agencyId?,
  // pg:
  pgId?, role?, practitionerName?, npi?, practitionerId? } // last 3 only when role==='practitioner'
```
Entity reference (from `fetchReferenceData()`): `{ hhahs: [{id,name,npi,contact_info:{email?,phone_number?}}], physicianGroups: [{id,name,npi,contact_info:{physician_ids?:[]}}], practitioners: [{id,physician_name,npi_digits,history:{PG_names?:[]}}] }`.
PG↔practitioner mapping state lives in `physician_groups.contact_info.physician_ids[]` (array of practitioner ids) — the mapping panel and PG card "N mapped practitioners" both read it.

## Invariants & gotchas
- **Worker login is single-factor** (username + password only); TOTP enrollment was removed. The `totp_secret` column still exists and is populated at employee creation (DB NOT NULL), but it is not verified at login. The `totp_enabled` field in the employee row is legacy and unused by the login path — see the verified code facts in `api/auth/index.js` `workerLogin`.
- `MIN_PASSWORD = 8` is duplicated in `Employees.jsx` and `ExternalUsers.jsx` — change both (server also validates, see [auth routes](../../backend/routes/auth.md)).
- Practitioner login creation is a **two-step dependency**: the practitioner must first exist on the Entity page; `CreateExternalUserCard` filters `reference.practitioners` to exact `npi_digits === npiDigitsOf(npi)` matches, auto-selects when exactly one matches, and clears a selection that stops matching. The server re-verifies the NPI/practitioner match — the client filter is UX, not security.
- For HHAH users the role is silently forced to `'admin'` in the payload; the role radio only appears for PG type.
- `submitMapping` runs sequentially on purpose (one practitioner per API call); already-mapped practitioners render checked+disabled via `mappedIdsForSelectedPg` so they can't be re-selected. Partial failures show as `name: message` joined with `·` — the loop does not abort.
- `mergeCreated` exists because the follow-up `refresh()` GET can be slow; the mapping picker must be able to use a just-created practitioner immediately. It reads the created row from the POST response keys `body.agency` / `body.pg` / `body.practitioner`.
- Deactivation asks `window.confirm`; reactivation does not. Deactivated rows render with `opacity-60` but keep all actions.
- Practitioner NPI is required on Entity create (`replace(/\D/g,'')` must be non-empty); agency/PG NPI is optional.

## Change recipes
1. **Add a field to employee creation**: add state + `<Field>` input in `AddEmployeeCard` (`Employees.jsx`), include it in the `createEmployee` payload, then extend the server handler and `createEmployee` in `src/lib/authApi.js` — see [auth routes](../../backend/routes/auth.md) and [frontend lib](../lib.md).
2. **Add a column to either user table**: add a `<th>` and matching `<td>` in `Employees`/`ExternalUsers`; bump the `colSpan={7}` on the loading/empty/`ResetPasswordRow` rows to the new column count.
3. **Add a new external-user role**: extend the `RadioPill` group + payload logic in `CreateExternalUserCard`, add a badge case in `RoleBadge`, then update server-side role validation in `api/_lib/identityRepo.js` ([identity repo](../../backend/lib/identity-repo.md)) and the portal gate in the target portal page ([portals](portals.md)).
4. **Change how PG↔practitioner mapping is stored**: today it's `contact_info.physician_ids` — update `mapPgToPractitioner` server-side, then `mappedIdsForSelectedPg`/`currentMappings` in `Entity.jsx` AND `practitionersByPg` in `src/pages/map/graph.js` ([monitoring](monitoring.md)) which reads the same array.
5. **Add validation to entity creation**: edit the relevant `submitAgency/submitPg/submitPractitioner` in `Entity.jsx`; keep the `mergeCreated` + `refresh()` pair after a successful POST.

## Related
- [auth model](../../business/auth-model.md) — employee/external account rules, TOTP, sessions
- [auth routes](../../backend/routes/auth.md) — server handlers these forms POST to
- [frontend lib](../lib.md) — `authApi.js` / `workflowApi.js` client contracts
- [portals](portals.md) — where external users actually log in
- [monitoring](monitoring.md) — Coverage Map consumes the PG↔practitioner mapping
