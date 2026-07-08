# Workflow Definitions — the four seeded system workflows (step graphs as JS objects)

**Source:** `api/_lib/workflowDefinition.js`
**Read this when:** adding/removing/rewiring a step in any system workflow, changing a trigger, renaming steps for the flowchart UI, editing mega-task grouping, or figuring out which `taskKey`/`condition` a step id maps to.

## What it does

Exports the four built-in workflow definitions as plain objects — `WF_AREA_ONBOARDING_DEFINITION` (Trigger 1), `WF7_DEFINITION` (Trigger 2), `WF_SIGNING_DEFINITION` (Trigger 3), `WF_BILLING_MONITOR_DEFINITION` (Trigger 4) — plus the `WORKFLOW_DEFINITIONS` array. These are **seeded into the DB** (`workflow_definitions` via `scripts/seed.js`); the engine reads the DB copy (`getActiveWorkflow`), so edits here require a reseed to take effect. Each definition is both the execution graph (steps/preReq/condition/taskKey) and the flowchart source (names, descriptions, megaTask/megaGroups).

## Key functions / exports

| name | signature (params -> return) | behavior in one line | called by |
|---|---|---|---|
| `WF_AREA_ONBOARDING_DEFINITION` | const object | Trigger 1: area upload monitor, 5 steps (`area-s2..s6`), 10s time trigger | seed; Orchestrator/Workflows renderers |
| `WF7_DEFINITION` | const object | Trigger 2: bulk patient+order intake loop, 26 steps in 5 phases | seed; bulk-upload start; engine |
| `WF_SIGNING_DEFINITION` | const object | Trigger 3: send-to-physician + 48h signature check, 6 steps (`sign-s1..s6`) | seed; `startBulkSigningRun` |
| `WF_BILLING_MONITOR_DEFINITION` | const object | Trigger 4: eligibility/billability/CPO monitor, 7 steps (`billing-s1..s7`), 10s time trigger | seed; billing monitor run creator |
| `WORKFLOW_DEFINITIONS` | `[the four above]` | Seed list (order = trigger order T1..T4) | `scripts/seed.js` / definition upsert |

## Data shapes

```js
// Definition
{ id, name, description,
  trigger: { id, type: 'time_interval'|'file_upload'|'order_document_ready',
             intervalSeconds?, label?, inputs? },
  loop?: { over, until },                      // wf7 only, descriptive
  conditions: { [conditionName]: 'human-readable meaning' },  // docs/UI ONLY
  megaTask?: { id, name, info, innerStepIds?, outsideStepIds? },  // 1-box flowchart collapse
  megaGroups?: [{ id, name, info, stepIds: [] }],                 // multi-box collapse (wf7)
  steps: [Step] }

// Step
{ id: 'wf7-s10', actor: 'system'|'ai'|'human', taskKey: 'patient.resolve',
  name, description, condition?: 'patient_exists', preReq: ['wf7-s12'] }
```

Semantics: `taskKey` → implementation in [task registry](./task-registry.md); `condition` gates the step (false ⇒ skipped); `preReq` step-tasks must be `completed/skipped` first (skipped counts — that's how exclusive branches re-merge); execution order within ties = array order (see [workflow engine](./workflow-engine.md)).

## The four workflows

**T1 `wf-area-onboarding` — "Area Onboarding & Daily Upload Monitor"** (`time_interval` 10s). `area-s2` monitor → branches: `area-s3` (cond `upload_received_within_24h`, continue) / `area-s4` **human** email HHAH (cond `upload_missing_after_24h`, `area.sendMissingUploadNotification`) → `area-s5` record notification (cond `notification_sent`, posts the HHAH-login banner) → `area-s6` wait (preReq s2+s3+s5). `megaTask` collapses `innerStepIds` [s2,s3,s5,s6] into one "HHAH Upload Monitor" box; `outsideStepIds` [s4] renders standalone behind a decision diamond.

**T2 `wf7` — "update patients objects"** (`file_upload`: xlsx + PDFs; loops per patient_order_row). Five phases:
- *Intake:* `wf7-s1` parse → `s2` required-fields check → `s3` **AI** extract (cond `excel_row_incomplete`) → `s4` human validate (cond `ai_extraction_success`) / `s5` human fill (cond `ai_extraction_fail`) → `s12` confirm upload context (preReq s2,s4,s5).
- *Patient:* `s10` patient.resolve → NO: `s14` create Unit+Record (`patient_not_exists`); YES: `s11` record.checkChanges (`patient_exists`) → con1 `s30` new Record (`record_context_changed`) / con2 `s13` update Unit (`unit_only_changed`) → `s15` retry (`patient_write_fail`, preReq s13,s14,s30) → `s16` human fix (`patient_retry_fail`).
- *Admission:* `s24` check SOC → `s25` human add dates (`admission_dates_missing`) → `s31` admission.resolve (preReq s24,s25).
- *Episode:* `s26` check SOE/EOE → `s27` human add dates (`episode_dates_missing`) → `s32` episode.resolve (preReq s26,s27).
- *Order + review:* `s17` skip duplicate (`order_exists`) / `s28` check fields (`order_not_exists`) → `s29` human fix fields (`order_fields_missing`) → `s18` create (`order_not_exists`, preReq s28,s29) → `s19` retry (`order_write_fail`, preReq s17,s18) → `s20` human fix (`order_retry_fail`) → `s21` **human review** (preReq s17,s18,s19,s20) — completing it for the last item fires the T3 bulk signing run.
- `megaGroups`: `wf7-g1` "Update Patient Object" [s1,s2,s3,s4,s5,s12,s10,s14,s11,s30,s13,s15,s16]; `wf7-g2` "Update Admission, Episode, Order" [s24,s25,s31,s26,s27,s32,s17,s28,s29,s18,s19,s20,s21].

**T3 `wf-signing` — "Send To Physician"** (`order_document_ready`; runs are created by `startBulkSigningRun`, one per wf7 run). `sign-s1` readiness → `s2` human fix (`document_not_ready_for_signing`) → `s3` send to physician (`document_ready_for_signing`, preReq s1,s2) → `s4` check signed → `s5` mark signed (`physician_signed`) / `s6` **human** overdue reminder email (`physician_signature_missing`). Single `megaTask` "Send Orders To Physician" (no innerStepIds ⇒ collapses all steps).

**T4 `wf-billing-monitor` — "Make Patients Billable"** (`time_interval` 10s; one run per HHAH, items created per issue by the billing monitor). `billing-s1` eligible? → NO: `s2` human email HHAH missing 485/F2F (`patient_not_eligible`); YES: `s3` billable? (`patient_eligible`) → NO: `s4` signature-missing check (`patient_not_billable`) → `s5` human email physician (`physician_signature_missing`); YES: `s6` CPO month billable? (`patient_billable`) → `s7` human add ≥30 CPO min (`cpo_month_not_billable`). `megaTask` with `innerStepIds` = all seven.

## Invariants & gotchas

- **The `conditions` map is documentation/UI only.** Runtime truth lives in `evaluateCondition` (task-registry) + pre-stamped `item.decisions`; adding a name here without an evaluator/stamp makes the step silently skip (unknown conditions ⇒ false).
- **Edits need a reseed** (`npm run db:seed`) — the engine executes the DB row, not this module. Existing runs keep the workflow version they started with.
- **wf7 step ids are intentionally non-contiguous** (`wf7-s22`/`s23` retired; s30–s32 added later). Never renumber: the Orchestrator's `DbBulkInstanceCard` maps visible steps by id in `row(...)` calls, and `megaGroups.stepIds` must list every step or it vanishes from the flowchart.
- Branch merges rely on **skipped-counts-as-done** prereqs: exclusive branches (s13/s14/s30; s17/s18; s3 vs nothing) all appear in the join step's `preReq`. Omitting one branch id from a join deadlocks items that took that branch.
- `wf7-s18` carries condition `order_not_exists` *again* (not `order_fields_ready`) — the fields gate is enforced by s28/s29 ordering, while the condition re-checks for orders created concurrently.
- T3/T4 gating decisions (`physician_signed`, `patient_eligible`, `cpo_month_billable`, …) are stamped from `extraction_payload` inputs by their `billing.*`/`signing.*` check tasks — the run **creator** must supply those inputs (see [eligibility & billing](../../business/eligibility-billing.md)).
- `megaTask`/`megaGroups` are pure presentation (consumed by `WorkflowDefinitionFlow.jsx`): `megaGroups` ⇒ chained boxes, `megaTask.innerStepIds` ⇒ one box + `outsideStepIds` standalone, bare `megaTask` ⇒ everything in one box. They never affect execution.
- Trigger `type`/`intervalSeconds`/`label` are also presentation + trigger-scheduler hints; the START cap renders `label` for time triggers, else the trigger id.
- **The Java `backend/` directory has been deleted.** System workflow definitions live **only** in `api/_lib/workflowDefinition.js` — there is no `backend/src/main/resources/workflows/*.json` to keep in sync.

## Change recipes

1. **Add a step to wf7:** append a Step object (new unused id, e.g. `wf7-s33`) with `taskKey` implemented in `taskRegistry`; add its id to the join-successor's `preReq` and to the right `megaGroups[].stepIds`; add any new condition to `conditions` + an evaluator (see task-registry recipe 2); reseed; update `row(...)` in `src/pages/orchestrator/Orchestrator.jsx` if it should show in the DB bulk view.
2. **Retire a step:** delete it from `steps` + its `megaGroups`/`innerStepIds` entry, move its id out of successors' `preReq` (rewire to its own prereqs); do **not** reuse the id later; reseed.
3. **Change a trigger cadence/label:** edit `trigger.intervalSeconds` + `label`; reseed; the actual polling loop lives with the trigger runner (see [scripts & deploy](../../ops/scripts-and-deploy.md)), not here.
4. **Add a whole new system workflow:** create `WF_X_DEFINITION` with unique `id`, append to `WORKFLOW_DEFINITIONS`, implement every `taskKey` in `taskRegistry`, build a run-creation path (route or monitor that creates run/items/task-rows then calls `runWorkflowAutomation`), reseed.
5. **Regroup the flowchart boxes:** edit `megaGroups`/`megaTask` only (ids must reference existing steps); no engine impact; reseed so the UI (which reads the DB definition) picks it up.

## Related

- [task registry](./task-registry.md) — implementations behind every `taskKey`, condition evaluation
- [workflow engine](./workflow-engine.md) — how steps/preReq/conditions are scheduled
- [intake pipeline](../../business/intake-pipeline.md) — T1→T2→T3 business narrative
- [eligibility & billing](../../business/eligibility-billing.md) — T4 inputs (eligible/billable/CPO) and per-HHAH runs
- [components](../../frontend/components.md) — `WorkflowDefinitionFlow.jsx` rendering of megaTask/megaGroups/triggers
- [bulk-upload route](../routes/bulk-upload.md) — where wf7 runs are created from uploads
