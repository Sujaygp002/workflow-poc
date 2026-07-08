# Frontend lib — client API contracts (workflowApi, authApi, dateFormat)

**Source:** `src/lib/workflowApi.js`, `src/lib/authApi.js`, `src/lib/dateFormat.js`
**Read this when:** adding/changing any frontend↔API call, changing auth token handling or which surface a token belongs to, changing error contracts pages rely on (`error.status`, `error.actionErrors`, `error.messages`), or reshaping the DB-row → UI adapters.

## What it does
All `fetch` calls to `/api/*` live here — pages never call `fetch` directly. `authApi.js` stores bearer tokens in `sessionStorage` under per-surface keys (`worker`/`hhah`/`pg`), exposes `authHeaders(kind)` used by protected calls, and wraps every `/api/auth` action. `workflowApi.js` wraps every other endpoint plus three pure adapters that reshape DB rows for the UI. Every wrapper parses JSON defensively (`res.json().catch(() => ({}))`) and throws `Error(body.error || fallback)` on non-OK.

## Key functions / exports — authApi.js
| name | signature | behavior | called by |
|---|---|---|---|
| `getAuthToken` / `setAuthToken` / `clearAuthToken` | `(kind[, token]) -> string\|void` | sessionStorage under `TOKEN_KEYS = { worker: 'cc_worker_token', hhah: 'cc_hhah_token', pg: 'cc_pg_token' }`; try/catch-safe | portals, WorkerPortal |
| `authHeaders` | `(kind) -> {Authorization?} ` | `{ Authorization: 'Bearer <token>' }` or `{}` when no token | workflowApi, getSession, logout |
| `workerLogin` | `({username, password}) -> {token, employee,...}` | POST `/api/auth` `{action:'workerLogin'}`; single-factor — on success stores the worker token immediately | WorkerPortal |
| `externalLogin` | `({username, password, kind}) -> {token,...}` | POST `{action:'externalLogin'}`; stores token under `kind` (`'hhah'` or `'pg'`) if given | HhhLogin, PgLogin |
| `logout` | `(kind) -> {ok:true}` | POST `{action:'logout'}` with that kind's auth header; ALWAYS clears the local token (finally) | portals, WorkerPortal |
| `getSession` | `(kind) -> session` | GET `/api/auth?session=1` with auth header; throws `error.status` on 401 | portals (restore on mount) |
| `createEmployee` / `listEmployees` / `updateEmployee` | POST `/api/auth` actions `createEmployee`/`listEmployees`/`updateEmployee` | admin CRUD; `listEmployees` returns `result.employees \|\| []` | Employees page |
| `createExternalUser` / `listExternalUsers` / `updateExternalUser` | POST actions on `/api/auth` | external-user CRUD; list returns `result.users \|\| []` | ExternalUsers page |

All `postAuth` errors carry `error.status = res.status`.

## Key functions / exports — workflowApi.js
| name | endpoint & method | behavior | called by |
|---|---|---|---|
| `startBulkUploadRun` | POST `/api/workflows/bulk-upload/start` (multipart, `authHeaders('hhah')`) | FormData: `workbook`, repeated `pdfs`, `unsignedZip` (or legacy `orderZip` alias), `signedZip`, `sourceLabel`, `areaId/hhahId/areaName/areaType/hhahName` | HhhLogin |
| `fetchAreaIntakeStatus` | GET `/api/area-intake` | → `body.areas \|\| []` | HhhLogin, Orchestrator |
| `runAreaIntakeCheck` | POST `/api/area-intake` | `{areaId, checkDate, now, forceExpired}` | Orchestrator |
| `fetchWorkflowRuns` | GET `/api/workflow-runs` | → `body.runs \|\| []` | Orchestrator |
| `deleteWorkflowRun` | DELETE `/api/workflow-runs/:id` | cascades run items/task-runs server-side | Orchestrator |
| `fetchWorkflowDefinitions` | GET `/api/workflows` | → `body.workflows \|\| []` (DB rows, use `dbWorkflowToWorkflow`) | WorkflowList |
| `fetchPatients` / `fetchOrders` | GET `/api/patients` / `/api/orders` (`?hhahId=` optional) | portal-scoped reads | HhhLogin, NetworkMap |
| `fetchPatientUnits` | GET `/api/patients?view=units` | → `body.units` — **currently unused by any page** | — |
| `fetchPgUnsignedOrders` | GET `/api/orders?pgUnsigned=1[&pgId=]` | unsigned orders for PG bulk sign | PgLogin |
| `bulkSignPgOrders` | POST `/api/orders` `{action:'bulkSign', orderIds, pgId, date}` + `authHeaders('pg')` | PG bulk sign | PgLogin |
| `runBillingMonitor` | POST `/api/workflow-runs` `{action:'runBillingMonitor'}` | Trigger-4 pass; **this is the only action the Orchestrator poll calls** — `tickTimeTriggers` (`tick`) is NOT called by the poll | Orchestrator |
| `fetchPatientTree` | GET `/api/patients/:id` | full unit hierarchy (fed to PatientHierarchyView) | HhhLogin |
| `fetchReferenceData` | GET `/api/reference-data` | agencies/PGs/practitioners | Entity, ExternalUsers, NetworkMap |
| `createAgency`/`createPg`/`createPractitioner`/`mapPgToPractitioner` | POST `/api/reference-data` `{action, ...}` | via private `postReferenceData` | Entity |
| `saveWorkflow` | POST `/api/workflows` `{action:'saveWorkflow', id, name, description, trigger, graph}` | on failure throws with `error.status` AND `error.messages` (validation list) | WorkflowBuilder |
| `deleteWorkflow` | POST `/api/workflows` `{action:'deleteWorkflow', id}` | | WorkflowList |
| `fetchBuilderCatalog` | POST `/api/workflows` `{action:'catalog'}` | task/trigger/condition catalog for the builder palette | WorkflowBuilder |
| `startWorkflow` | POST `/api/workflow-runs` `{action:'startWorkflow', workflowId, items?, sourceLabel?}` | manual run launch | WorkflowList |
| `tickTimeTriggers` | POST `/api/workflow-runs` `{action:'tick'}` | fires due time triggers — **not called by the Orchestrator poll or any page**; builder `time_interval` workflows need an external caller to hit this endpoint | — |
| `fetchMyBuckets` | GET `/api/work-items` + `authHeaders('worker')` | bearer-scoped buckets; throws with `error.status` (401 → re-login) | WorkerPortal |
| `openWorkItem` | POST `/api/work-items` `{action:'open', taskRunId}` + worker auth | claims/opens a task | WorkerPortal |
| `fetchWorkItems(userId)` / `fetchWorkUsers()` | GET `/api/work-items[?userId=]` (no auth header) | legacy unauthenticated reads — **currently unused** | — |
| `completeDbWorkItem` | POST `/api/work-items/:taskRunId/complete` `{runId, notes, payload}` + worker auth | on 400 throws with `error.actionErrors` (per-action validation map; task stays active/Processing) | WorkerTaskDetail |

## Data shapes (adapters)
```js
dbWorkflowToWorkflow(row) // DB workflow row -> builder/list shape
// spreads row.definition; forces id/name/description; dbBacked:true; version;
// per step: type ('conditional' when actor==='condition'), PreReq (array preReq or 'none'),
//           conditionExpr (step.condition || step.conditionExpr || '')

dbRunToInstance(run)      // run row (+run.tasks) -> legacy instance shape — currently unused
// { id, workflowId, workflowName, launchedAt, status, areaId/areaName/areaType,
//   hhahId/hhahName, inputSummary, dbBacked:true, taskInstances:[{ stepId, taskName,
//   actor, taskKind, conditionExpr, status, patientIndex:item_index,
//   patientRecord/orderRecord/referencePayload/decisions, actionInstances:[...] }] }

dbWorkItemToAction(item)  // work-item row -> action card shape — currently unused
// dbPayload: { patient, order, references, extraction, decisions,
//   missingFields: item.output?.missingFields || [],
//   pdf: { fileName: item.pdf_file_name || extraction_payload.pdf.fileName,
//          url: item.pdf_blob_url || extraction_payload.pdf.blobUrl,
//          signed: extraction_payload.pdf.signed === true } }
```
`dateFormat.js`: `formatUiDate(value, fallback='Missing') -> 'MM/DD/YYYY'` and `formatUiDateTime -> 'MM/DD/YYYY h:mm AM'`; invalid dates return `String(value)`, falsy returns the fallback.

## Invariants & gotchas
- **Tokens are sessionStorage, per-surface.** Worker/HHAH/PG sessions coexist in one tab but die with the tab. `workerLogin` is single-factor and stores `cc_worker_token` directly on success — there is no `workerTotp` step.
- **Error contract is load-bearing:** WorkerTaskDetail reads `error.actionErrors` (400 = validation, task stays active); WorkflowBuilder reads `error.messages`; WorkerPortal reads `error.status === 401` to force re-login. Keep these fields when refactoring.
- `startBulkUploadRun` intentionally does NOT set `Content-Type` (browser sets the multipart boundary); it merges only `authHeaders('hhah')`.
- `orderZip` is a back-compat alias for `unsignedZip` — first non-null wins.
- Unauthenticated wrappers (`fetchWorkflowRuns`, `fetchPatients`, ...) send no auth header today; if the API tightens auth, this file is the single choke point.
- `dbRunToInstance`, `dbWorkItemToAction`, `fetchWorkItems`, `fetchWorkUsers`, `fetchPatientUnits`, `tickTimeTriggers` are exported but have no callers (leftovers from the pre-portal WorkBucket UI). Safe to reuse or delete — verify with grep first.

## Change recipes
1. **Add a new API call:** add a wrapper here (mirror the `res.json().catch` + `throw Error(body.error || ...)` pattern), attach `authHeaders(kind)` if the route is protected, then import it in the page. Never `fetch` from a page.
2. **Add a new authed surface (4th token kind):** add the key to `TOKEN_KEYS` in `authApi.js`; all helpers pick it up automatically.
3. **Change the complete-task payload:** edit `completeDbWorkItem` and the server handler together (see [work-items route](../backend/routes/work-items.md)); preserve the 400/`actionErrors` contract used by WorkerTaskDetail.
4. **Add a builder save validation field:** extend `saveWorkflow`'s body and keep `error.messages` populated from `body.messages` — WorkflowBuilder renders them inline.

## Related
- [backend/routes/work-items](../backend/routes/work-items.md) — server side of buckets/open/complete.
- [backend/routes/auth](../backend/routes/auth.md) — every `postAuth` action's handler.
- [backend/routes/workflow-runs](../backend/routes/workflow-runs.md) — startWorkflow/tick/runBillingMonitor/delete.
- [pages/worker](pages/worker.md) & [pages/portals](pages/portals.md) — main consumers of the auth flow.
- [business/auth-model](../business/auth-model.md) — token/session semantics behind these calls.
