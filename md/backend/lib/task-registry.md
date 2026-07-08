# Task Registry — per-step task implementations + condition evaluator

**Source:** `api/_lib/taskRegistry.js`
**Read this when:** changing what any workflow step actually *does*, adding/renaming a `taskKey`, adding a branch condition, changing required-field lists, debugging why a decision diamond took the wrong branch, or changing the object-lifecycle strip shown to workers.

## What it does

Maps every step `taskKey` (from the workflow definitions and builder-compiled steps) to an async implementation, and evaluates step `condition` strings against an item's `decisions` map. Task fns read/patch the workflow item's four JSON payloads (`patient_payload`, `order_payload`, `reference_payload`, `extraction_payload`), stamp boolean decision flags that later conditions branch on, and call domain writers in `repositories.js`. Also exports the worker-facing display payload and the Patient/Admission/Episode/Order lifecycle derivation.

## Key functions / exports

| name | signature (params -> return) | behavior in one line | called by |
|---|---|---|---|
| `taskRegistry` | `{ [taskKey]: async ({item, step, task, context, payload}) -> result }` | The task implementations; result contract below | `workflowEngine.runItemAutomation`, `workflowEngine.completeHumanTask` |
| `evaluateCondition` | `(condition, item) -> Promise<boolean>` | `null` condition ⇒ true; known `item.decisions[condition]` wins; else lazily computes + persists the decision pair; unknown conditions ⇒ false | `workflowEngine.runItemAutomation` (step gating) |
| `objectLifecycle` | `(item) -> {unit, patient, admission, episode, order}` | Derives `found/created/updated/skipped/missing/in-review/pending` per object from decision flags | `taskDisplayPayload`, WorkBucket lifecycle strip |
| `taskDisplayPayload` | `(item) -> {patient, order, references, extraction, decisions, objectLifecycle, missingFields, practitionerNpi, pgName, hhahName}` | Snapshot stored as a human task's `output` when it activates (what the worker UI renders) | `workflowEngine` on human-task activation |
| `mergeDeep` (internal) | `(target, source) -> object` | Deep merge that **ignores** `undefined/null/''` source values (patches can never blank a field) | every payload-patching task |
| `guardSessionHhah` (internal) | `(item, referencesPatch) -> patch` | Deletes `HHAH` from any AI/human references patch when `reference_payload.HHAH.data_tags.source === 'session_agency'` | `ai.extractMissingDataFromPdf`, `human.validateExtractedData`, `human.fillMissingData` |
| `missingFields` (internal) | `(item) -> string[]` | Dotted paths of `REQUIRED_FIELDS` (13 patient/reference/order fields) missing from the item | completeness check, AI extraction input |

**Task result contract:** `{ ok: boolean, output?: any, error?: string, retry?: true, actionErrors?: {}, waiting?: true }`. `ok:false` fails the task **and the item**; `retry:true` (only `human.performActions`) keeps the task active and surfaces a 400; `waiting:true` keeps the task active without completing.

## Task keys (grouped)

| taskKey | what it does / decisions stamped |
|---|---|
| `excel.parseWorkbook` | No-op passthrough; echoes `patient_key`/`order_key`/`sourceRows` |
| `row.checkCompleteness` | `excel_row_complete/_incomplete` from `REQUIRED_FIELDS` |
| `ai.extractMissingDataFromPdf` | Gemini over the matched PDF (`findPdfForOrder`: filename minus `.pdf`, lowercased == `order_number`; falls back to first PDF if no order number); merges patient/order/reference patches (HHAH guarded); logs to `insertAiExtraction`; stamps `ai_extraction_success/_fail`. **Always returns ok:true** — failure routes to the human branch, never fails the item |
| `refs.confirmUploadContext` | Stamps `upload_context_ready: true` |
| `dates.checkAdmission` / `dates.checkEpisode` | Stamp all four of `admission_dates_ready/_missing` (SOC present) and `episode_dates_ready/_missing` (SOE+EOE present) |
| `patient.resolve` | `findPatientUnit` (name+DOB+MRN) + `findPatient` (unit+HHAH+PG); stamps `patient_exists/_not_exists`, `unit_exists/_not_exists`, `record_exists` |
| `record.checkChanges` | Patient exists: stamps `record_context_changed` (con1, no record for this HHAH/PG) vs `unit_only_changed` (con2) |
| `patient.create` / `record.create` / `patient.update` | All three call `runPatientWrite(item,false)` → `writePatientBundle`; stamps `patient_write_success/_fail` + `record_created/_updated`; saves `extraction_payload.patientBundle.{unitId,patientId}` |
| `patient.retryWrite` | `runPatientWrite(item,true)` → `patient_retry_success/_fail` |
| `admission.resolve` | `writeAdmissionBundle(item, patientId)` (match by patient+SOC); stamps `admission_ready/_exists/_created`; saves `patientBundle.admissionId`; `ok` false if no admission id |
| `episode.resolve` | `writeEpisodeBundle(item, admissionId)` (match by SOE/EOE in admission); stamps `episode_ready/_exists/_created`; saves `patientBundle.episodeId` |
| `order.checkFields` | `order_fields_ready/_missing` = 3 order fields present AND matched PDF present (`extraction_payload.pdf.fileName|blobUrl` or legacy `pdfBlobUrl`) |
| `order.skipDuplicate` | Duplicate order number: writes **nothing**, stamps `order_skipped_duplicate:true`, saves existing `orderId` + `orderSkipped:true` |
| `order.create` / `order.retryWrite` | `runOrderWrite` → `writeOrderBundle(item, patientBundle)`; stamps `order_write_success/_fail` (or retry pair) + `order_skipped_duplicate`; saves `extraction_payload.orderId/orderSkipped` |
| `human.validateExtractedData` / `human.fillMissingData` | Merge worker payload `{patient, order, references}` (HHAH guarded), stamp payloads `confidence:'confirmed', validated_by:'human'` (only if `data_tags` already exists), set `human_data_validated` |
| `human.fillAdmissionDates` / `human.fillEpisodeDates` | Merge patient patch, mirror SOC/EOC/SOE/EOE into `order_payload.order_admission_details`, restamp all date decisions; `ok` = the relevant `*_dates_ready` (still-missing dates keep the task failed-loop) |
| `human.fixOrderFields` | Merge `payload.order` + `payload.pdf`; `ok` = fields+PDF now ready |
| `human.fixPatientWrite` / `human.fixOrderWrite` | Merge patch then rerun the write as retry |
| `human.reviewRecord` | Marks the **item** `completed` + `record_reviewed`; completion of this task is the wf7→signing trigger point (see [workflow engine](./workflow-engine.md)) |
| `human.performActions` | Builder checklist: validates each catalog action via `runHumanActions` (builderCatalog); any error ⇒ `{ok:false, retry:true, actionErrors}` (task stays active, API 400); success persists `actionState` on the task |
| `signing.reviewReadiness` / `signing.fixDocument` | `document_ready_for_signing/_not_ready...` = order number + PDF blobUrl present |
| `signing.sendToPhysician` | `markOrderSentToPhysician(orderId, today)`, patches `order_status.SentToPhysicianDate/SendToPhysician_Status`, stamps `signing_sent_to_physician` + `signing_sent_at` |
| `signing.checkSigned` | Signed if item `order_status` **or** persisted order (`findOrderById`) says signed; stamps `physician_signed/_signature_missing` + `signed_within_48h`/`signing_overdue` |
| `signing.updateOrderSigned` | `markOrderSignedByPhysician` with existing `SignedByPhyscianDate` or today; stamps `signing_status_updated` |
| `signing.emailPhysicianReminder` | Human: `sendEmail` to practitioner email (payload override wins); stamps `physician_reminder_email_sent` |
| `billing.checkPatientEligible` / `.checkPatientBillable` / `.checkSignatureMissing` / `.checkCpoMonthBillable` | **Read pre-stamped inputs** from `extraction_payload` (`eligible`, `billable`, `unsignedOrderNumbers`, `cpoMonthBillable`) set by the billing-monitor run creator; copy them into the decision pairs the billing steps branch on |
| `billing.sendHhahMissingDocumentEmail` / `.sendPhysicianReminder` | Human emails (HHAH contact / practitioner); text built from `extraction_payload.missingDocuments` / `unsignedOrderNumbers` |
| `billing.addCpoMinutes` | `updateCpoMinutes({cpoMonthId, cpoMin})` with `cpoMin = max(30, payload.cpoMin)`; `ok:false` if `extraction_payload.cpoMonthId` missing |
| `area.monitorExpectedUploads` / `.continueUploadWorkflow` / `.recordNotificationStatus` / `.waitForHhahUpload` | No-op markers for the area monitor flow |
| `area.sendMissingUploadNotification` | Human: emails the HHAH (wraps `sendEmail` in try/catch → `ok:false` on throw); stamps `notification_sent` which gates `area-s5` |
| `agency.checkUploadedToday` | Queries `uploaded_documents` for the item's agency + `dayBucket` (`extraction_payload.dayBucket`); stamps `agency_uploaded`/`agency_not_uploaded`. If no `agencyId` resolves from the item, returns `agency_not_uploaded` with `error:'no_agency_on_item'` |
| `ai.extractWithPatterns` | Tier 1 regex over workbook payload fields (`referenceLogic/extraction.js`), Tier 2 Gemini fallback for unfilled fields; stamps `ai_extraction_success`/`ai_extraction_fail` |
| `ai.runService` | CC-note generation + CPO minute distribution (`referenceLogic/aiService.js`); stamps `ai_service_failed`/`ai_service_ok`; **compliance: notes tagged `data_tags.generated_by='ai_service'`, never physician-signed** |
| `rcm.generate` | CPT decision tree (G0179/G0180/G0181/G0182) over the item's eligible episodes; upserts `rcm_records` idempotently (referenceLogic/rcm.js) |
| `ai.audit` | Runs rules R1–R4 over every `rcm_record` for the item's agency; writes/updates `audit_records` rows; stamps `audit_failed`/`audit_passed` |
| `ai.rework` | Auto-fix + re-audit loop (up to 3 cycles) consuming structured `audit_records.rule_results`; re-stamps `audit_failed`/`audit_passed` |

## Data shapes

```js
// evaluateCondition writes decision PAIRS onto item.decisions, e.g.
{ excel_row_complete: true, excel_row_incomplete: false,
  patient_exists: true, unit_exists: true, record_exists: false,
  record_context_changed: true, unit_only_changed: false,
  admission_dates_ready: true, admission_dates_missing: false, /* + episode pair */
  order_exists: false, order_not_exists: true,
  order_fields_ready: true, order_fields_missing: false }

// extraction_payload accumulated across a wf7 item:
{ sourceRows: {...}, pdf: { fileName, blobUrl, blobPath, signed }, ai: {...},
  patientBundle: { unitId, patientId, admissionId, episodeId },
  orderId, orderSkipped: false }

// billing-monitor item inputs (pre-stamped at run creation, NOT computed here):
{ eligible: bool, billable: bool, missingDocuments: [], unsignedOrderNumbers: [],
  cpoMonthBillable: bool, cpoMonthId }
```

## Invariants & gotchas

- **`evaluateCondition` memoizes via `item.decisions`** — if a flag is already set (even stale), the lazy evaluators never re-run. Conditions with no evaluator branch and no stamped flag return **false** (the step is silently skipped).
- Signing/billing gate conditions (`document_ready_for_signing`, `physician_signed`, `patient_eligible`, `cpo_month_billable`, …) are **read-only** in `evaluateCondition` — they must be stamped by a prior task or the run creator.
- `mergeDeep` drops `undefined/null/''` — no AI or human patch can clear a value, only fill or replace it.
- The session HHAH is authoritative: `guardSessionHhah` strips `HHAH` from every downstream references patch when `data_tags.source === 'session_agency'`.
- `ai.extractMissingDataFromPdf` returns `ok:true` on every path (including thrown errors) — AI failure is a *branch* (`ai_extraction_fail` → `human.fillMissingData`), never an item failure.
- Duplicate orders are **skipped, never overwritten or deleted** (`order.skipDuplicate` + `writeOrderBundle` skip semantics) — see [orders and signing](../../business/orders-and-signing.md).
- `patient_exists` means the **Unit** (person, name+DOB+MRN) exists — not the Record. Record context (Unit+HHAH+PG) drives con1/con2 separately.
- `human.fill*Dates` returns `ok` = readiness, so submitting still-missing dates fails the task/item rather than looping; they also mirror dates into `order_payload.order_admission_details`.
- `confidenceConfirmed` only stamps `validated_by/confidence` if the payload already has `data_tags`.
- Date fields arrive as **JS Date objects** from Neon in persisted rows — never `String(value).slice(0,10)` them (past bugs in `dayDiff`/`parseDateOnly`; helpers live in `repositories.js`).
- `objectLifecycle` reports `unit: 'created'` off `unit_not_exists` (set before the write) — it reflects intent, not write success.

## Change recipes

1. **Add a required Excel field:** add a `['dotted.path', getter]` row to `REQUIRED_FIELDS`; it then drives `excel_row_incomplete` → AI extraction; if Gemini can extract it, map the patch field inside `ai.extractMissingDataFromPdf`'s `mergeDeep` blocks and extend the prompt in `api/_lib/gemini.js`.
2. **Add a new condition:** define its evaluator branch in `evaluateCondition` (compute + `setDecisions` + `updateItem`), document it in the workflow's `conditions` map in `workflowDefinition.js`, and reference it as a step `condition`. If the input comes from a run creator, stamp `extraction_payload`/`decisions` at item creation instead and just add a read-only branch.
3. **Add a new system task:** add `'domain.verb': async ({item, context}) => ({ok, output})` to `taskRegistry`, stamp any decisions downstream steps branch on, add a step with that `taskKey` in `workflowDefinition.js`, then reseed (`npm run db:seed`).
4. **Add a new human task:** same as (3) with `actor:'human'`; the fn receives `payload` from `completeHumanTask` — merge with `mergeDeep`, return `ok` reflecting whether the fix succeeded; add a worker panel keyed by `task_key` in the worker pages.
5. **Change what workers see for an active task:** edit `taskDisplayPayload` (activation snapshot) or `objectLifecycle` (the lifecycle strip states).

## Related

- [workflow engine](./workflow-engine.md) — how/when these fns are invoked, result handling
- [workflow definitions](./workflow-definitions.md) — which step uses which taskKey/condition
- [repositories](./repositories.md) — the find/write bundle fns tasks call
- [builder catalog](./builder-catalog.md) — `runHumanActions` behind `human.performActions`
- [utils](./utils.md) — `gemini.js`, `mailer.js`, `normalizers.js` helpers used here
- [eligibility & billing](../../business/eligibility-billing.md) — where billing inputs are computed
- [patient model](../../business/patient-model.md) — Unit vs Record, con1/con2 fork
- [reference logic](./reference-logic.md) — the five referenceLogic modules imported by the new RCM task keys
