# Intake Pipeline — HHAH upload → Excel/PDF parse → wf7 run → tasks → bulk signing run

**Source:** `api/workflows/bulk-upload/start.js`, `api/_lib/excelParser.js`, `api/_lib/workflowEngine.js`, `api/_lib/taskRegistry.js` (`evaluateCondition`, wf7 tasks), `api/_lib/workflowDefinition.js` (`WF7_DEFINITION`, `WF_SIGNING_DEFINITION`), `api/_lib/blobStore.js`, `api/_lib/repositories.js` (run/item/task CRUD)
**Read this when:** changing how uploads become runs, how items/tasks execute or block, how PDFs match orders, when the signing run fires, or which workflow an upload targets.

## What it does — the business rules
1. **Only a signed-in HHAH portal user can upload**, and that session's agency is authoritative: it is stamped over whatever the workbook's Agencyname column said, for every row, and no downstream AI/human edit may reassign it.
2. **One upload = one run per target workflow.** If any active builder workflow declares a `document_upload` trigger, the upload starts a run of EACH builder workflow; otherwise it falls back to the system `wf7` intake workflow.
3. **The workbook drives the batch**: Sheet1 = patient rows, Sheet2 = order rows, joined by name+DOB+MRN. Each order row becomes one work item (a patient can appear in several items); patient rows with no order also become items. Order-row SOC/EOC/SOE/EOE override the patient row's.
4. **PDFs match orders by filename**: `<order_number>.pdf` (case-insensitive). PDFs arrive in an unsigned ZIP and a signed ZIP; each order's PDF lives in exactly one, and the `signed` flag follows the item into signing.
5. **Items execute concurrently and independently**; an item stops only for an active human task (item → `blocked`) or a hard failure (item → `failed`). Steps whose condition is false are skipped, not failed.
6. **Trigger 3 chains off review**: when the human Review step has passed for EVERY item in a wf7 run, exactly ONE `wf-signing` run starts, with one item per distinct written (non-duplicate) order. Idempotent per wf7 run.

## Key functions / exports
| name | signature (params -> return) | behavior | called by |
|---|---|---|---|
| `handler` (start.js default) | `(req,res) -> 201 {run,tasks,runs,inputSummary}` | POST only; requires hhah session; multipart or JSON mode | `POST /api/workflows/bulk-upload/start` |
| `targetWorkflows` (start.js) | `() -> workflow rows` | active builder `document_upload` workflows, else active `wf7`; calls `ensureSystemDefinitions()` first | `startFromMultipart`/`startFromJson` |
| `stampSessionAgency` (start.js) | `(referencePayload, areaContext) -> ref` | forces `HHAH.name` + `data_tags{source:'session_agency', match_key:'hhah_id:<id>'}` onto every item | item creation loops |
| `parseWorkflowWorkbook` (excelParser.js) | `(filePath) -> {patientRows, orderRows, joined, summary}` | header-alias mapping, Excel-serial date parsing, order→patient join by `patientKeyFromParts` | `startFromMultipart` |
| `pdfsFromZip` (start.js) | `(zipFile, signed) -> [{buffer, originalFilename, sourceZip, signed}]` | extracts `.pdf` entries; tags each with the ZIP's signed flag | `startFromMultipart` |
| `registerRunDocuments` (start.js) | `({run, pdfs, zipPdfs}) -> uploadedPdfs` | uploads to Vercel Blob (`uploadPdfBufferToBlob`, skips gracefully w/o token) + `insertUploadedDocument` row per PDF | `startRunForWorkflow` |
| `pdfMetadataForItem` (start.js) | `(item, pdfsByOrderNumber) -> {fileName, blobUrl, blobPath, documentId, sourceZip, signed}` | matched via `orderNumberFromPdfName`; `{}` when no match | item creation |
| `startRunForWorkflow` (start.js) | `({workflow, parsed, areaContext, sourceLabel, pdfs, zipPdfs}) -> {run, tasks}` | createWorkflowRun → register PDFs → one item + full task-run set per joined row → `runWorkflowAutomation` | `startFromMultipart` |
| `runWorkflowAutomation` (workflowEngine.js) | `({runId, definition, context, concurrency=10}) -> void` | runs `runItemAutomation` over non-terminal items in batches of `concurrency`, then `updateRunStatus` | upload start, `completeHumanTask`, seeds |
| `runItemAutomation` (workflowEngine.js) | `({definition, itemId, context}) -> void` | the per-item loop: pick first `pending` task with satisfied preReqs, evaluate condition (skip if false), activate human tasks (and stop), execute system/ai task fns | `runWorkflowAutomation` |
| `evaluateCondition` (taskRegistry.js) | `(condition, item) -> bool` | cached `item.decisions[condition]` wins; else lazily evaluates patient/record/order/date conditions and persists the decision | `runItemAutomation` |
| `completeHumanTask` (workflowEngine.js) | `({taskRunId, notes, payload, definition}) -> {task, result}` | runs the human task fn with `payload`, marks completed/failed, resumes automation for the whole run; `{retry:true}` results throw a 400 and keep the task active | `api/work-items/[taskRunId]/complete.js` |
| `startBulkSigningRun` (workflowEngine.js) | `(wf7RunId) -> signingRunId \| null` | one `wf-signing` run per wf7 run (sourceLabel `signing-bulk:<runId>`), one item per deduped `extraction_payload.orderId`, skipped-duplicate items excluded; signed-ZIP orders get `order_status` pre-stamped signed | `completeHumanTask` after last review |
| `createTaskRunsForItem` (repositories.js) | `({runId, itemId, steps}) -> rows` | one `workflow_task_runs` row per definition step; `ON CONFLICT (item_id, step_id) DO NOTHING` | run starts |

## Data shapes
Work item (`workflow_items` row) — the unit everything operates on:
```js
{ run_id, item_index, patient_key,          // patientKey(patientPayload) = name|dob|mrn normalized
  order_key,                                 // order_number or null
  patient_payload: { patient_info:{name,sex,DOB}, personal_information:{address:{street}},
                     insurance_details, admission_details:{HHAH,PG,MRN,SOC,EOC,SOE,EOE,diagnosis_codes} },
  order_payload:   { order_info:{order_number,order_type,order_date},
                     order_status:{SignedByPhyscianDate,SignedByPhysician_Status,...}, order_admission_details },
  reference_payload: { practitioner:{NPI,...}, PG:{name,...}, HHAH:{name, data_tags:{source:'session_agency'}} },
  extraction_payload: { sourceRows:{patient,order}, pdf:{fileName,blobUrl,blobPath,documentId,sourceZip,signed},
                        ai?, patientBundle:{unitId,patientId,admissionId,episodeId}, orderId?, orderSkipped? },
  decisions: { excel_row_complete, ai_extraction_success, patient_exists, order_exists, ... },  // condition cache
  status: 'pending'|'running'|'blocked'|'completed'|'failed' }
```
Task run statuses: `pending → active → completed | skipped | failed`. Run status (`updateRunStatus`): `completed` when all items completed, `failed` if any item failed, else `running`.
Signing item `extraction_payload`: `{ sourceRunId, sourceItemId, orderId, orderNumber, pdf:{fileName,blobUrl,blobPath,signed} }`.

## Invariants & gotchas
- **Skipped is terminal.** A condition that evaluates false skips the task permanently; later data changes never revive it. Conversely `evaluateCondition` returns the **cached decision** if `item.decisions[condition]` is set — re-running a check task is the only way to flip it.
- **Engine ordering**: each loop pass picks the FIRST pending task (in `created_at, step_id` order = definition order) whose preReqs are all `completed|skipped`, then restarts. A human activation `break`s and leaves the item `blocked`; an item completes only when every non-skipped task is `completed`.
- **`context.pdfs` (in-memory buffers) exists only during the initial upload call.** `completeHumanTask` resumes with no context, so `ai.extractMissingDataFromPdf` gets `pdfBuffer:null` on resumed items — Gemini then works from the current payloads only.
- **wf7 step IDs are non-contiguous** (`wf7-s22`/`s23` retired) and `megaGroups.stepIds` must list every step or the flowchart drops it.
- The signing chain fires inside `completeHumanTask` ONLY for `task_key === 'human.reviewRecord'` and only when every item is `completed` or `extraction_payload.orderSkipped` — a failed item blocks Trigger 3 forever for that run.
- Builder workflows **replace** (not join) wf7 when any active `document_upload` builder workflow exists; the response's top-level `run`/`tasks` are the FIRST workflow's.
- JSON mode (`startFromJson`) skips PDFs/blob entirely — items get `extractionPayload` verbatim from the caller.
- `firstField` exists because multipart fields arrive as arrays.
- `ensureSystemDefinitions` only inserts a definition when NO active version exists — editing `workflowDefinition.js` does nothing to a live DB until you re-seed (`npm run db:seed`).

## Change recipes
1. **Add a required Excel column**: add header aliases to `PATIENT_HEADERS`/`ORDER_HEADERS` and wire it in `makePatientPayload`/`makeOrderPayload` (`api/_lib/excelParser.js`); if the row must gate on it, add a getter to `REQUIRED_FIELDS` in `taskRegistry.js` (drives `row.checkCompleteness` + AI extraction's `missingFields`).
2. **Add/modify a wf7 step**: edit `WF7_DEFINITION.steps` (id, `preReq`, optional `condition`) + the `conditions` map + the owning `megaGroups[].stepIds` in `api/_lib/workflowDefinition.js`; implement the `taskKey` in `taskRegistry.js` (and `evaluateCondition` if the condition is lazily computed); then re-seed so the DB definition updates.
3. **Change when/what the signing run includes**: edit `startBulkSigningRun` (eligibility filter, dedup, pre-stamp) and/or the `allReviewed` predicate in `completeHumanTask`, both in `api/_lib/workflowEngine.js`.
4. **Route uploads to a new trigger type**: `targetWorkflows` in `start.js` + `listActiveBuilderWorkflowsByTrigger` in `repositories.js` (matches `definition->'trigger'->>'type'`).
5. **Change PDF↔order matching**: `orderNumberFromPdfName`/`withPdfOrderKey` in `blobStore.js`, `pdfMetadataForItem` in `start.js`, and `findPdfForOrder`/`orderHasMatchedPdf` in `taskRegistry.js` — all four must agree.

## Related
- [patient model](patient-model.md) — what the patient-phase steps write
- [orders & signing](orders-and-signing.md) — order duplicate policy, wf-signing behavior
- [eligibility & billing](eligibility-billing.md) — Trigger 4 consumes what this pipeline writes
- [builder workflows](builder-workflows.md) — builder `document_upload` runs from the same endpoint
- [workflow engine internals](../backend/lib/workflow-engine.md) — engine contracts
- [task registry](../backend/lib/task-registry.md) — every taskKey implementation
- [bulk-upload route](../backend/routes/bulk-upload.md) — HTTP contract
