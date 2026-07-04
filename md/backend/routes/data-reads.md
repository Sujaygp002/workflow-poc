# Data-Read Routes — patients, orders, reference-data (entities), area-intake

**Source:** `api/patients/index.js`, `api/patients/[id].js`, `api/orders/index.js`, `api/reference-data/index.js`, `api/area-intake/index.js`
**Read this when:** changing patient/order/entity/area reads, entity creation (Entity page), PG-practitioner mapping, or PG bulk signing.

## What it does
Four route files serve reads (and a few writes) the frontend needs:
- **patients** — `GET /api/patients` lists patients (optional `?hhahId=` scope, or `?view=units` for patient units); `GET /api/patients/[id]` returns the full patient hierarchy tree.
- **orders** — `GET /api/orders` lists orders (`?hhahId=` scope) or the PG unsigned queue (`?pgUnsigned=1&pgId=`); `POST {action:'bulkSign'}` signs orders (**requires a PG-practitioner session**).
- **reference-data** — `GET` returns the entity snapshot (`{hhahs, physicianGroups, practitioners}`); `POST` creates an agency/PG/practitioner or maps a PG→practitioner (Entity page). No auth.
- **area-intake** — `GET` area intake status (Trigger 1 monitor), `POST` runs/simulates an area check.

## Key functions / exports
| route | method / action | signature -> return | behavior |
|---|---|---|---|
| patients/index | GET | `?hhahId?, ?view=units` → `{patients}` \| `{units}` | `listPatients({hhahId})` / `listPatientUnits()` |
| patients/[id] | GET | `?id` → `{...tree}` | `getPatientTree(id)` (unit→records→admissions→episodes→orders) |
| orders/index | GET | `?pgUnsigned=1&pgId` \| `?hhahId` → `{orders}` | `listPgUnsignedOrders(pgId)` / `listOrders({hhahId})` |
| orders/index | POST `bulkSign` | `{orderIds[], date?}` (bearer) → `{updatedCount, skippedCount, updated, skipped}` | `requireSession {type:'external'}` + must be pg/practitioner; `pgId` from session; `bulkSignOrders(...)` |
| reference-data | GET | → `{hhahs, physicianGroups, practitioners}` | `listReferenceData()` |
| reference-data | POST `createAgency` | `{name, npi?, contact?}` → `{agency}` | `createHhahFromPayload` (name required) |
| reference-data | POST `createPg` | `{name, npi?}` → `{pg}` | `createPgFromPayload` |
| reference-data | POST `createPractitioner` | `{name, npi}` → `{practitioner}` | `createPractitionerFromPayload`; **NPI required** (`normalizeNpi` non-empty) |
| reference-data | POST `mapPgPractitioner` | `{pgId, practitionerId}` → `{pg}` | `mapPgToPractitioner` (writes `physician_groups.contact_info.physician_ids[]`) |
| area-intake | GET | `?date?` → `{areas}` | `listAreaIntakeStatus` |
| area-intake | POST | `{areaId, checkDate?, now?, forceExpired?}` → result | `runAreaIntakeCheck` |

## Data shapes
`listPatients` rows carry aggregated counts + `latest_episode_status` (`none|started|eligible|billable`). `getPatientTree` returns the nested hierarchy the [PatientHierarchyView component](../../frontend/components.md) renders.
`bulkSign` request: `{ action:'bulkSign', orderIds:['uuid',…], date?:'YYYY-MM-DD' }` — **`pgId` is NOT in the body**, it comes from `externalUser.pg_id`. Response `{ updatedCount, skippedCount, updated:[…], skipped:[…] }`.
Entity creates all return the created row under a type key (`{agency}`/`{pg}`/`{practitioner}`) and the Entity page optimistically prepends it before refetching.

## Invariants & gotchas
- **Only `bulkSign` requires auth** on these routes — it demands an external session whose `user_type==='pg'` AND `role==='practitioner'` (403 otherwise), and the PG scope is taken from the session, never the client body. That's the fresh-auth guarantee for signing.
- **reference-data POST is unauthenticated** (Entity page is an admin surface — see [auth model](../../business/auth-model.md) POC note). Anyone reachable can create entities.
- `createPractitioner` **requires a non-empty NPI** (`normalizeNpi(npi)` → digits) — the same NPI is later re-verified when creating a PG-practitioner external user ([auth route](./auth.md)).
- `mapPgPractitioner` writes into `physician_groups.contact_info.physician_ids[]` — the Coverage Map's practitioner-count reads that array (see [monitoring frontend](../../frontend/pages/monitoring.md) / `graph.js`).
- `?hhahId=` scoping filters by agency; the HHAH portal passes its session agency id so a partner only sees its own patients/orders.
- These routes are all **thin** — the real logic is in [repositories](../lib/repositories.md); change behavior there, not here.

## Change recipes
1. **Add an entity type or field:** add a `case` in reference-data POST + a `create…FromPayload` in [repositories](../lib/repositories.md); wire the [Entity page](../../frontend/pages/admin.md) + `workflowApi.js` client ([frontend lib](../../frontend/lib.md)).
2. **Change bulk-sign rules:** edit `bulkSignOrders` in [repositories](../lib/repositories.md) + the auth guard here; consumer is the [PG portal](../../frontend/pages/portals.md).
3. **Change patient/order list scoping or shape:** edit `listPatients`/`listOrders`/`getPatientTree` in [repositories](../lib/repositories.md).
4. **Change area-intake monitoring:** edit `listAreaIntakeStatus`/`runAreaIntakeCheck` in [repositories](../lib/repositories.md); consumers are the Triggers-era area panels + [HHAH portal](../../frontend/pages/portals.md) notification banner.

## Related
- [repositories](../lib/repositories.md) — every function these routes call
- [patient model](../../business/patient-model.md) — the unit/record/admission/episode data these reads expose
- [orders & signing](../../business/orders-and-signing.md) — order lifecycle + `bulkSignOrders`
- [auth model](../../business/auth-model.md) — why bulkSign needs a practitioner session; entity pages unauthenticated
- [db schema](../../db/schema.md) — the tables read here
- [Entity/admin frontend](../../frontend/pages/admin.md) + [portals](../../frontend/pages/portals.md) — the callers
