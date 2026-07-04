# Repositories — all Postgres reads/writes for domain + workflow runtime data
**Source:** `api/_lib/repositories.js` (helpers: `api/_lib/db.js`, `api/_lib/normalizers.js`)
**Read this when:** changing any SQL, dedup/upsert key, episode eligibility/billable logic, worker buckets, order signing state, CPO months, area intake checks, or the patient→admission→episode→order hierarchy payloads.

## What it does
Single data-access module (no ORM) over Neon/Postgres via the `@neondatabase/serverless` tagged-template client (`getSql()` in `api/_lib/db.js`; `jsonParam()` JSON-stringifies for `::jsonb` params, `null→{}`). Organized by domain: workflow definitions, users, workflow runtime (runs/items/task-runs/buckets), reference data (HHAH/PG/practitioner), patient object writes (unit/record/admission/episode/order bundles), episode status computation, hierarchy reads, order signing, CPO/billing monitor, and area intake. Also holds the pure business functions `isOrderSigned` / `computeEpisodeAssessment` used by the engine and routes. Employees/external users/sessions live in `api/_lib/identityRepo.js`, not here.

## Key functions / exports
### Workflow definitions & users
| name | signature | behavior | called by |
|---|---|---|---|
| `getActiveWorkflow` | `(id) -> row\|null` | newest active version with `definition` jsonb | engine, routes |
| `listActiveWorkflowDefinitions` | `() -> rows` | all active defs, newest-updated first | `api/workflows/index.js` |
| `upsertWorkflowDefinition` | `(definition, version=1, {kind='system', createdBy}) -> row` | INSERT ON CONFLICT `(id,version)`, sets `active=true` | seed, builder save |
| `getWorkflowMaxVersion` | `(id) -> int` | max version (0 if none) | builder versioning |
| `deactivateWorkflowDefinition` | `(id, {keepVersion}) -> count` | `active=false` for all (or all-but-keepVersion) versions | builder save/delete |
| `listActiveBuilderWorkflowsByTrigger` | `(triggerType) -> rows` | active `kind='builder'` defs where `definition.trigger.type` matches | bulk-upload start |
| `ensureSystemDefinitions` | `() -> void` | re-upserts the 4 system defs from `workflowDefinition.js` if missing | routes bootstrap |
| `upsertUser` / `listUsers` | `(user)->row` / `()->rows` | legacy `users` worker pool upsert/list | seed, work-items |

### Workflow runtime (runs / items / task runs / buckets)
| name | signature | behavior | called by |
|---|---|---|---|
| `createWorkflowRun` | `({workflowId, workflowVersion, sourceLabel, totalItems, inputSummary, areaId, hhahId}) -> row` | insert run (status default `running`) | engine, bulk-upload |
| `createWorkflowItem` | `({runId, itemIndex, patientPayload, orderPayload, referencePayload, extractionPayload}) -> row` | insert item; derives `patient_key`/`order_key` via `patientKey()`/order_number | engine |
| `createTaskRunsForItem` | `({runId, itemId, steps}) -> rows` | one task row per step, `ON CONFLICT (item_id, step_id) DO NOTHING`; stores step as `input`, `step.actions`, `step.assigneeEmployeeId` | engine |
| `insertUploadedDocument` | `({runId, fileName, contentType, sizeBytes, blobUrl, blobPath}) -> row` | insert PDF metadata; copies `hhah_id` from the run | bulk-upload |
| `getRunWithDefinition` | `(runId) -> row\|null` | run joined to its exact def version | engine |
| `findWorkflowRunBySourceLabel` | `(workflowId, sourceLabel) -> row\|null` | newest run with that label (idempotency key) | engine, seed |
| `findWorkflowItemByIssueSignature` | `(workflowId, sig) -> row\|null` | dedup lookup on `extraction_payload->>'issueSignature'` | billing monitor |
| `findActiveWorkflowRunForHhah` | `(workflowId, hhahId?, hhahName?) -> row\|null` | `running` run matched by `hhah_id`, else `input_summary->>'hhahName'`, else "Unknown HHAH" fallback | Trigger-4 active-run guard |
| `deleteWorkflowRun` | `(runId) -> bool` | delete run; items/tasks/docs/extractions CASCADE; domain records kept | `api/workflow-runs/[id].js` |
| `getRunItems` / `countWorkflowItems` / `getItem` / `getItemTasks` / `getTaskRun` | id -> rows/row | plain scoped reads | engine, routes |
| `listWorkflowRuns` | `() -> rows` | last 100 runs + def + area/HHAH names | Orchestrator API |
| `listTaskRunsForRun` / `listTaskRunsForRuns` | `(runId)`/`(runIds[])` | task rows joined to item payloads/`decisions` | Orchestrator API |
| `listActiveWorkItems` / `listCompletedWorkItems` | `(userId)` | legacy `assigned_to` worker feeds; active feed LATERAL-joins the matching PDF (`pdf_file_name`/`pdf_blob_url`) | `api/work-items` |
| `updateTask` | `(taskId, patch) -> row` | partial update; camelCase patch keys (`assignedTo`, `actionState`, `openedAt`, `errorMessage`, …); `undefined` = keep current | engine, complete route |
| `updateItem` | `(itemId, patch) -> row` | partial update of payloads/`decisions`/status | engine |
| `updateRunStatus` | `(runId) -> row` | recompute from item counts: all completed → `completed`, any failed → `failed`, else `running` | engine, signing resolve |
| `listEmployeeBucketItems` | `(employeeId) -> {untouched, processing, done}` | human tasks: untouched = active+`opened_at IS NULL`+(mine or unassigned); processing = active+opened+mine; done = completed+mine (limit 100) | worker portal |
| `openTaskRun` | `({taskRunId, employeeId}) -> {task}\|{error,status}` | claim + stamp `opened_at` (COALESCE — idempotent); 404 missing / 409 not active / 403 claimed by other | worker portal |
| `findNewestRunForWorkflow` | `(workflowId) -> row\|null` | newest run any status | engine |
| `insertAiExtraction` | `({itemId, documentId, model, status, inputSummary, outputData, errorMessage}) -> row` | audit row for a Gemini call | taskRegistry |

### Reference data (HHAH / PG / practitioner)
| name | signature | behavior | called by |
|---|---|---|---|
| `findPractitionerByNpi` / `findPgByName` / `findHhahByName` / `getHhahById` | lookup -> row\|null | keyed on `npi_digits` (digits only) / `normalized_name` | bundles, taskRegistry |
| `createPractitionerFromPayload` / `createPgFromPayload` / `createHhahFromPayload` | `(referencePayload) -> row` | upsert on `npi_digits` / `normalized_name`; jsonb columns merged additively (`existing \|\| EXCLUDED`) | taskRegistry |
| `listReferenceData` | `() -> {practitioners, physicianGroups, hhahs}` | 3 parallel lists (limit 250) | `api/reference-data` |
| `mapPgToPractitioner` | `({pgId, practitionerId}) -> {pg, practitioner}` | appends id to `pg.contact_info.physician_ids[]` and `{id,name}` to `practitioner.history.PG_names[]` | reference-data route; Coverage Map reads these |

### Patient object writes (the wf7 bundles)
| name | signature | behavior | called by |
|---|---|---|---|
| `findPatientUnit` / `findPatient` | `(patientPayload[, referencePayload])` | unit by `unit_key`; record by `record_context_key` (needs reference payload) | taskRegistry |
| `findAdmission` / `findEpisode` | `(patientId, soc)` / `(admissionId, soe, eoe)` | `IS NOT DISTINCT FROM` date match (NULL==NULL) | bundles, taskRegistry |
| `findOrder` / `findOrderById` | `(orderNumber)` / `(orderId)` | by unique `order_number` / id | bundles, signing |
| `writePatientUnit` | `(patientPayload) -> unit row` | upsert on `unit_key` | `writePatientBundle` |
| `linkPatientToPg` / `linkPatientToPractitioner` | `(patientId, id, role?/relationship?)` | insert-ignore direct link rows | bundles |
| `writePatientBundle` | `(item) -> {unit, patient}` | unit upsert, then patient RECORD upsert on `record_context_key`; resolves `agency_id`/`pg_id` by name lookups; writes direct links | taskRegistry `patient.*` |
| `writeAdmissionBundle` | `(item, patientId) -> {admission, existed}` | upsert on `(patient_id, soc, eoc)`; throws if no patientId | taskRegistry `admission.resolve` |
| `writeEpisodeBundle` | `(item, admissionId) -> {episode, existed}` | upsert on `(admission_id, soe, eoe)`; throws if no admissionId | taskRegistry `episode.resolve` |
| `writeOrderBundle` | `(item, patientBundle) -> {order, skipped}` | if `order_number` exists → return existing with `skipped:true` (never overwrite); else insert (`ON CONFLICT DO NOTHING` double-guard) + link billing provider/PG to patient | taskRegistry `order.create` |

### Episode status & hierarchy reads
| name | signature | behavior | called by |
|---|---|---|---|
| `isOrderSigned` | `(order) -> bool` | true on `order_status.SignedByPhysician_Status` (bool or `'true'`) or `SignedByPhyscianDate` (typo intentional) or legacy `signed`/`order_signed_date`/`signedDate`/`order.signed_date` | everywhere |
| `computeEpisodeAssessment` | `(episode, episodeOrders, admissionOrders=episodeOrders) -> {status, eligible, billable, reason}` | eligible = 485 among episode orders + F2F among **admission** orders with `order_date` 0–180 days before `episode.eoe`; billable = eligible + all episode orders signed; no orders → `started` | reads, billing monitor |
| `computeEpisodeStatus` | `(orders, episode, admissionOrders) -> 'started'\|'eligible'\|'billable'` | status-only wrapper | listPatients/listOrders |
| `listPatients` | `({hhahId?}) -> rows` | records + unit-COALESCEd identity + counts; then live-computes `latest_episode_status` for the latest episode (by `soe DESC`) overriding the stored column | `api/patients` |
| `listPatientUnits` | `() -> rows` | units + counts; **`id` is remapped to the current patient RECORD id** (unit id in `unit_id`/`patient_unit_id`) | `api/patients?view=units` |
| `getPatientTree` | `(patientId) -> tree` | full hierarchy: unit, all sibling records, admissions/episodes/orders/cpoMonths + `buildUnitHierarchy` archive derivation (90-day gap rule) + per-episode computed status; orders carry matched PDF via filename LATERAL join | patient detail route |
| `listOrders` | `({hhahId?}) -> rows` | orders + patient/agency/PG/provider names + episode `soe/eoe` + PDF match + computed `episode_status` per row | `api/orders` |

### Order signing & CPO / billing monitor / area intake
| name | signature | behavior | called by |
|---|---|---|---|
| `markOrderSentToPhysician` | `(orderId, date=today) -> row` | merges `{SentToPhysicianDate, SendToPhysician_Status:true}` into `order_status` | signing tasks |
| `markOrderSignedByPhysician` | `(orderId, date=today) -> row` | merges `{SignedByPhyscianDate, SignedByPhysician_Status:true}`; then auto-resolves overdue reminder tasks | signing tasks |
| `resolveOverdueSigningTasksForOrders` | `(orderIds[], date) -> {resolved: taskIds}` | completes still-active `signing.emailPhysicianReminder` tasks whose item `extraction_payload->>'orderId'` matches; settles items; recomputes run statuses | sign paths |
| `listPgUnsignedOrders` | `(pgId?) -> rows` | sent-to-physician AND not-signed orders (jsonb boolean casts) + PDF match | PG portal |
| `bulkSignOrders` | `({orderIds, pgId?, date}) -> {updated, skipped}` | signs only rows that are sent+unsigned (and PG-scoped); `skipped` = ids not updated; auto-resolves reminders | PG Bulk Sign |
| `updateCpoMinutes` | `({cpoMonthId, cpoMin=30}) -> row` | sets minutes + recomputes month status (billable needs episode `billable` AND `cpo_min>=30`) | CPO human task |
| `runBillingMonitorPass` | `() -> {updatedEpisodes, updatedPatients, updatedCpoMonths, issues}` | Trigger 4 core: recompute every episode's status/status_reason, create missing `cpo_months` rows from SOE→EOE, restatus months, roll latest status up to `patients.latest_episode_status`; collects `issues.{missingDocuments, physicianReminders, cpoMinutes}` | workflowEngine billing monitor |
| `upsertStatisticalArea` / `linkHhahToArea` / `findStatisticalAreaByName` | upserts on `(name, area_type)` / `(area_id, hhah_id)` | Trigger-1 config | seed, area-intake |
| `listAreaIntakeStatus` | `({checkDate?}) -> areas[]` | per-area members with received/missing flags (a "received" = a workflow_run created that day with matching area+hhah), today's check row, notifications | `api/area-intake` |
| `runAreaIntakeCheck` | `({areaId, checkDate?, now?, forceExpired?}) -> {check, expected, received, missing, notifications}` | upserts `area_intake_checks` on `(area_id, check_date)`; status complete/monitoring/`missing_uploads` (window = date 00:00Z + max member window hours); on missing_uploads upserts one notification per missing HHAH on `(area_check_id, hhah_id)` | area-intake route, taskRegistry |

## Data shapes
```js
// order_status jsonb contract (merged, never replaced):
{ SentToPhysicianDate: 'YYYY-MM-DD', SendToPhysician_Status: true,
  SignedByPhyscianDate: 'YYYY-MM-DD', SignedByPhysician_Status: true }  // "Physcian" typo is the contract

// computeEpisodeAssessment(...).reason:
{ has485, hasF2f, f2fWithin180DaysOfEoe, f2fOrderNumber, episodeEoe,
  allEpisodeOrdersSigned, unsignedOrderNumbers: ['O-…'] }

// decorateOrder adds to every order row surfaced by reads:
{ signed: bool, signed_status: 'signed'|'unsigned', signed_date: 'YYYY-MM-DD'|null, archive_reason }

// getPatientTree top-level keys:
{ patient, admissions:[{...adm, episodes:[{...ep, orders, cpoMonths, status, status_reason}], orders}],
  ordersWithoutEpisode, unit, unitHierarchy, current_patient_record, patient_record_archive,
  admission_archive, prior_admissions_not_archived, latest_admission, episode_archive,
  latest_episode, order_archive, signed_orders, unsigned_orders }

// runBillingMonitorPass().issues:
{ missingDocuments: [{episode, missingDocuments:['485 cert/recert','valid F2F'], hhah, reason}],
  physicianReminders: [{episode, hhah, unsignedOrderNumbers, orders}],
  cpoMinutes: [{episode, cpoMonth, hhah}] }   // hhah = {id, name, contact_info}
```
Dedup keys (from `normalizers.js`): `unit_key` = `normalizeName(name)|lower(DOB)|normalizeName(MRN)`; `record_context_key` = `unit_key|normalizeName(HHAH)|normalizeName(PG)` (raw names, not DB ids).

## Invariants & gotchas
- **Neon returns `date` columns as JS `Date` objects.** All date math must go through `dateOnly`/`dateMs`/`daysBetween`/`parseDateOnly` (all handle Date + string). `String(dateObj).slice(0,10)` produced two real bugs (eligibility check, CPO month generation) — never reintroduce it.
- **`SignedByPhyscianDate` is intentionally misspelled** — it is the stored field contract. `isOrderSigned`/`signedDateOf` also read four legacy field names; keep back-compat when adding new ones.
- **jsonb upserts merge additively** (`existing || EXCLUDED`) for contact_info/history/raw_data/personal_information/etc. — keys are never deleted by re-upload; scalar columns use `COALESCE(EXCLUDED.x, existing.x)` so blanks don't clobber.
- **Duplicate orders are skipped, never overwritten**: `writeOrderBundle` pre-checks `findOrder` and also uses `ON CONFLICT (order_number) DO NOTHING`; callers must branch on `{skipped:true}`.
- **One active definition version per id** (`workflow_definitions_one_active` partial unique index): call `deactivateWorkflowDefinition(id)` before upserting a new active version or the insert fails.
- `updateRunStatus` leaves runs with `blocked` items as `running` — a never-completed human task keeps Trigger 4's active-run guard (`findActiveWorkflowRunForHhah`) blocking new runs for that HHAH.
- `findAdmission`/`findEpisode` use `IS NOT DISTINCT FROM` so NULL SOC/SOE/EOE rows are findable; the UNIQUE constraints they mirror treat NULLs as distinct, though — two NULL-date inserts can bypass `(patient_id, soc, eoc)` uniqueness at the SQL level (upserts go through find-first, so in practice reuse wins).
- **PDF↔order matching is by filename**: `lower(file_name minus '.pdf') = lower(order_number)` LATERAL joins in `listActiveWorkItems`, `getPatientTree`, `listOrders`, `listPgUnsignedOrders`. Rename a PDF and the link breaks.
- Archive rule: an older admission/patient-record archives only when the next one starts ≥ `ADMISSION_ARCHIVE_GAP_DAYS` (90) after the older `eoc`; missing dates → not archived with an explanatory `reason`.
- `listPatientUnits` remaps `id` to the current RECORD id so the UI can link straight to a patient page — don't "fix" it to the unit id.
- `updateTask`/`updateItem` patches: `undefined` keeps the current value; explicit `null` clears nullable columns; `status`/json fields use `??` so `null` also keeps.
- CPO months span `monthStart(soe)` through the EOE month inclusive — unless EOE is the 1st, which excludes that terminal month. Month `billable` requires episode `billable` AND `cpo_min >= 30`.
- The bucket queries use `sql.query(text, [params])` with `$1` placeholders (shared `BUCKET_ITEM_SELECT` string); everything else uses the tagged-template client. Buckets only surface `actor='human'` tasks.

## Change recipes
1. **Add a new signed-status field**: extend `isOrderSigned` and `signedDateOf` (repositories.js); writes happen in `markOrderSignedByPhysician`/`bulkSignOrders` (merge into `order_status`). No schema change — it's jsonb.
2. **Change the F2F eligibility window (180 days)**: edit `computeEpisodeAssessment` (`days <= 180`); update `reason.f2fWithin180DaysOfEoe` naming and any UI copy reading it ([eligibility-billing](../../business/eligibility-billing.md)).
3. **Add a column to a domain table**: new migration in `db/migrations/` ([schema](../../db/schema.md)), then add it to the matching `write*Bundle`/`create*FromPayload` INSERT **and** its `ON CONFLICT DO UPDATE SET` (pick `COALESCE` vs `||` merge), then to the read queries that should surface it (`listPatients`/`getPatientTree`/`listOrders`).
4. **Change worker-bucket semantics**: edit `BUCKET_ITEM_SELECT` + the three WHERE clauses in `listEmployeeBucketItems`; `openTaskRun` controls the Untouched→Processing transition; completion flows through `updateTask` from the work-items route ([work-items](../routes/work-items.md)).
5. **Change the admission archive gap**: edit `ADMISSION_ARCHIVE_GAP_DAYS` and the `archive_rule.description` string in `buildUnitHierarchy`; both admission-level (`archiveDecisionForAdmission`) and record-level (`patientRecordArchiveDecision`) use it.

## Related
- [db schema](../../db/schema.md) — the tables/keys these queries hit
- [patient model](../../business/patient-model.md) — unit/record/admission/episode key semantics
- [orders & signing](../../business/orders-and-signing.md) — order lifecycle these functions implement
- [eligibility & billing](../../business/eligibility-billing.md) — business rules behind `computeEpisodeAssessment`/CPO
- [workflow engine](workflow-engine.md) / [task registry](task-registry.md) — main callers of the runtime + bundle functions
- [identity repo](identity-repo.md) — employees/external users/sessions (NOT in this file)
- [utils](utils.md) — `db.js` client, `normalizers.js` key builders
