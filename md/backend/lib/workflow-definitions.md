# Workflow Definitions — seeded system workflows (step graphs as JS objects)

**Source:** `api/_lib/workflowDefinition.js`
**Read this when:** adding/removing/rewiring a step in any remaining system workflow, changing a trigger, renaming steps for the flowchart UI, editing mega-task grouping, or figuring out which `taskKey`/`condition` a step id maps to.

## What it does

Exports the **one remaining** built-in workflow definition — `WF_AREA_ONBOARDING_DEFINITION` (Trigger 1) — plus the `WORKFLOW_DEFINITIONS` array containing only that entry. These are **seeded into the DB** (`workflow_definitions` via `scripts/seed.js`); the engine reads the DB copy (`getActiveWorkflow`), so edits here require a reseed to take effect. Each definition is both the execution graph (steps/preReq/condition/taskKey) and the flowchart source (names, descriptions, megaTask/megaGroups).

> **Removed (2026-07-09):** `WF7_DEFINITION` ("update patients objects", Trigger 2), `WF_SIGNING_DEFINITION` ("Send To Physician", Trigger 3), and `WF_BILLING_MONITOR_DEFINITION` ("Make Patients Billable", Trigger 4) have been **deleted** from both `workflowDefinition.js` and the live Neon DB. `WORKFLOW_DEFINITIONS` now exports `[WF_AREA_ONBOARDING_DEFINITION]` only. The phase-1 builder workflow (`cc-1783522521545`) and the `wf-area-onboarding` system workflow are the only active definitions. All three removed definitions have been deleted from the DB (cascade-deleted their runs and task-runs).

## Key functions / exports

| name | signature (params -> return) | behavior in one line | called by |
|---|---|---|---|
| `WF_AREA_ONBOARDING_DEFINITION` | const object | Trigger 1: area upload monitor, 5 steps (`area-s2..s6`), 10s time trigger | seed; Orchestrator/Workflows renderers |
| `WORKFLOW_DEFINITIONS` | `[WF_AREA_ONBOARDING_DEFINITION]` | Seed list (one entry) | `scripts/seed.js` / definition upsert |

## Data shapes

```js
// Definition
{ id, name, description,
  trigger: { id, type: 'time_interval'|'file_upload'|'order_document_ready',
             intervalSeconds?, label?, inputs? },
  conditions: { [conditionName]: 'human-readable meaning' },  // docs/UI ONLY
  megaTask?: { id, name, info, innerStepIds?, outsideStepIds? },  // 1-box flowchart collapse
  megaGroups?: [{ id, name, info, stepIds: [] }],                 // multi-box collapse
  steps: [Step] }

// Step
{ id: 'area-s2', actor: 'system'|'ai'|'human', taskKey: 'area.checkUpload',
  name, description, condition?: 'upload_received_within_24h', preReq: [] }
```

Semantics: `taskKey` → implementation in [task registry](./task-registry.md); `condition` gates the step (false ⇒ skipped); `preReq` step-tasks must be `completed/skipped` first (skipped counts — that's how exclusive branches re-merge); execution order within ties = array order (see [workflow engine](./workflow-engine.md)).

## The active system workflow

**T1 `wf-area-onboarding` — "Area Onboarding & Daily Upload Monitor"** (`time_interval` 10s). `area-s2` monitor → branches: `area-s3` (cond `upload_received_within_24h`, continue) / `area-s4` **human** email HHAH (cond `upload_missing_after_24h`, `area.sendMissingUploadNotification`) → `area-s5` record notification (cond `notification_sent`, posts the HHAH-login banner) → `area-s6` wait (preReq s2+s3+s5). `megaTask` collapses `innerStepIds` [s2,s3,s5,s6] into one "HHAH Upload Monitor" box; `outsideStepIds` [s4] renders standalone behind a decision diamond.

## Invariants & gotchas

- **The `conditions` map is documentation/UI only.** Runtime truth lives in `evaluateCondition` (task-registry) + pre-stamped `item.decisions`; adding a name here without an evaluator/stamp makes the step silently skip (unknown conditions ⇒ false).
- **Edits need a reseed** (`npm run db:seed`) — the engine executes the DB row, not this module. Existing runs keep the workflow version they started with.
- `megaTask`/`megaGroups` are pure presentation (consumed by `WorkflowDefinitionFlow.jsx`): `megaGroups` ⇒ chained boxes, `megaTask.innerStepIds` ⇒ one box + `outsideStepIds` standalone, bare `megaTask` ⇒ everything in one box. They never affect execution.
- Trigger `type`/`intervalSeconds`/`label` are also presentation + trigger-scheduler hints; the START cap renders `label` for time triggers, else the trigger id.
- **The Java `backend/` directory has been deleted.** System workflow definitions live **only** in `api/_lib/workflowDefinition.js` — there is no `backend/src/main/resources/workflows/*.json` to keep in sync.
- **wf7/wf-signing/wf-billing-monitor are gone.** Do not re-add them. The phase-1 builder workflow (`cc-1783522521545`) replaces wf7+wf-signing for the intake pipeline; `runBillingMonitor` has been removed from the route (400 "Unsupported workflow-runs action" if called). `repositories.js` `runBillingMonitorPass` is harmless dead code with no caller.

## Change recipes

1. **Add a step to the area onboarding workflow:** append a Step object (new unused id, e.g. `area-s7`) with `taskKey` implemented in `taskRegistry`; add its id to the join-successor's `preReq` and to `megaTask.innerStepIds` if appropriate; add any new condition to `conditions` + an evaluator; reseed.
2. **Retire a step:** delete it from `steps` + its `megaTask`/`innerStepIds` entry, move its id out of successors' `preReq`; do **not** reuse the id later; reseed.
3. **Change a trigger cadence/label:** edit `trigger.intervalSeconds` + `label`; reseed; the actual polling loop lives with the trigger runner (see [scripts & deploy](../../ops/scripts-and-deploy.md)), not here.
4. **Add a whole new system workflow:** create `WF_X_DEFINITION` with unique `id`, append to `WORKFLOW_DEFINITIONS`, implement every `taskKey` in `taskRegistry`, build a run-creation path (route or monitor that creates run/items/task-rows then calls `runWorkflowAutomation`), reseed.
5. **Regroup the flowchart boxes:** edit `megaGroups`/`megaTask` only (ids must reference existing steps); no engine impact; reseed so the UI (which reads the DB definition) picks it up.

## Related

- [task registry](./task-registry.md) — implementations behind every `taskKey`, condition evaluation
- [workflow engine](./workflow-engine.md) — how steps/preReq/conditions are scheduled
- [components](../../frontend/components.md) — `WorkflowDefinitionFlow.jsx` rendering of megaTask/megaGroups/triggers
- [builder workflows](../../business/builder-workflows.md) — the phase-1 builder workflow that replaced wf7
