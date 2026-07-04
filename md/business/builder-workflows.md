# Builder Workflows — custom workflows composed from a fixed palette, compiled to engine steps

**Source:** `api/_lib/builderCatalog.js`, `api/_lib/builderCompiler.js`, `api/workflows/index.js`, `api/workflow-runs/index.js` (manual + tick triggers), `api/workflows/bulk-upload/start.js` (document_upload trigger), `api/_lib/taskRegistry.js` (`human.performActions`), `api/_lib/workflowEngine.js` (`completeHumanTask` retry rule), `api/_lib/repositories.js` (definition versioning, buckets), `api/work-items/index.js`
**Read this when:** adding/changing a palette action or condition, changing how builder graphs compile or validate, changing trigger routing, changing worker bucket semantics, or debugging "why did my custom workflow task stay active after submit".

## What it does
Employees compose custom workflows in a visual builder from a **fixed palette** — triggers, system actions, human checklist actions, and if/else conditions. Every palette entry maps to code that already exists (taskRegistry keys, repository functions, the mailer); the builder never runs arbitrary logic. Saving compiles the editable graph into the exact `steps[]` shape the existing workflow engine executes, so builder runs and system runs (wf7, wf-signing, …) go through one engine. Human steps become employee-assigned checklists surfaced in the worker portal's Untouched/Processing/Done buckets, with server-side validation that keeps the task active on bad input instead of failing it.

## Business rules → implementing code
| # | Rule | Code |
|---|------|------|
| 1 | Palette-only composition: system actions map to taskRegistry keys, human actions to validated checklist specs, conditions to keys `evaluateCondition` already handles | `ACTIONS` / `HUMAN_ACTIONS` / `CONDITIONS` / `TRIGGERS` in `builderCatalog.js`; palette served by `api/workflows/index.js` action `catalog` (plus active employees for assignment) |
| 2 | A save must pass validation: known trigger (time_interval ≥ 5s), known actions/conditions, every task node assigned to an existing **active** employee, no cycles, entry reachable | `validateGraph` in `builderCompiler.js` (async — checks assignee via `identityRepo.getEmployee`) |
| 3 | If/else compiles without a "condition step": the true-branch head step gets `condition: key`, the false-branch head gets the declared `negation`, and the join step's preReq is both branch tails (engine counts `skipped` as satisfying preReqs, so the untaken branch never blocks) | `compileChain`/`compileGraph` in `builderCompiler.js`; negations declared per-condition in `CONDITIONS`; `prereqsSatisfied` in `workflowEngine.js` |
| 4 | Versioning: re-saving the same id creates version N+1 and makes it the **single** active version; older versions stay for runs pinned to them | `saveWorkflow` in `api/workflows/index.js` → `getWorkflowMaxVersion` + `deactivateWorkflowDefinition(id, { keepVersion })` + `upsertWorkflowDefinition(def, version, { kind: 'builder' })` |
| 5 | System workflows are read-only in the builder: cannot be edited (save with a system id → 400) or deleted; builder delete is a soft delete (deactivate all versions) | `saveWorkflow` kind check + `deleteWorkflow` in `api/workflows/index.js` |
| 6 | Trigger `document_upload`: an HHAH portal upload starts a run of **each** active builder workflow declaring it (one item per parsed workbook row); only if none exist does it fall back to system wf7 | `targetWorkflows` in `api/workflows/bulk-upload/start.js` → `listActiveBuilderWorkflowsByTrigger('document_upload')` |
| 7 | Trigger `manual`: the Run button starts a run with one empty item (so system steps/conditions still evaluate) unless items are posted | `startWorkflowHandler` in `api/workflow-runs/index.js` (action `startWorkflow`) |
| 8 | Trigger `time_interval`: a poller posts `{action:'tick'}`; each interval workflow starts a run only when the newest run is older than the interval, idempotent via source label `builder-tick:<wfId>:<bucketTs>` | `tickHandler` in `api/workflow-runs/index.js` |
| 9 | Human task = checklist: the compiled step carries `taskKey:'human.performActions'`, the action list, and `assigneeEmployeeId`; task rows persist `actions` + `assigned_employee_id`; the engine never re-assigns (NULL assignee = shared, used by system workflows) | `compileChain` (task branch); `createTaskRunsForItem` in `repositories.js`; human branch of `runItemAutomation` in `workflowEngine.js` |
| 10 | Buckets: **Untouched** = active, unopened, mine-or-unassigned; **Processing** = active, opened, mine; **Done** = completed, mine. Opening a task claims it (`assigned_employee_id` + `opened_at`); completing an unclaimed shared task claims it implicitly | `listEmployeeBucketItems` / `openTaskRun` in `repositories.js`; `api/work-items/index.js`; claim-on-complete in `api/work-items/[taskRunId]/complete.js` |
| 11 | Validation-retry: submitting a checklist validates **every** action server-side first; any failure returns HTTP 400 `{ error, actionErrors }` and the task **stays active/Processing** — nothing is marked failed, no side effect runs. Only when all validate do the actions' `execute()` side effects run (send email, merge dates, stamp order sent, add CPO minutes) | `runHumanActions` in `builderCatalog.js`; `human.performActions` in `taskRegistry.js` returns `{ retry: true, actionErrors }`; `completeHumanTask` in `workflowEngine.js` converts that to a 400 without touching task status |

## Data shapes
Builder graph (source of truth, stored on the definition so it stays editable):
```js
{ entry: 'n1', nodes: [
  { id:'n1', kind:'system', name:'Check patient', actionKey:'resolve_patient', next:'c1' },
  { id:'c1', kind:'condition', conditionKey:'patient_exists', ifTrue:'n2', ifFalse:'n3', join:'n4' },
  { id:'n3', kind:'task', name:'Fix row', assigneeEmployeeId:'emp-1', next:null,
    actions:[{ id:'a1', actionKey:'fill_missing_fields', params:{} }] },
] }
```
Saved definition row (`workflow_definitions`, `kind='builder'`):
```js
{ id:'cc-1720…', name, description, builder:true, trigger:{ type:'document_upload' },
  graph:{ entry, nodes }, steps:[…compiled…], conditions:{ patient_exists:'…', patient_not_exists:'…' } }
```
Checklist completion request (`POST /api/work-items/[taskRunId]/complete`):
```js
{ payload: { actionResults: { a1: { to:'dr@x.com', subject:'…', body:'…', confirmed:true } } } }
// failure → 400 { error:'Action validation failed', actionErrors:{ a1:'A valid recipient email is required' } }
```

## Invariants & gotchas
- **Adding a condition to the palette is a two-file change**: the key AND its negation must both exist in `CONDITIONS` *and* be evaluable by `taskRegistry.evaluateCondition` (which checks `item.decisions` first, then computes). A key only in the catalog silently evaluates false → the step always skips.
- **A step carries at most one `condition`** — a condition node placed as the *first* node inside another condition's branch loses the outer gate (the inner branch heads get only the inner key). Keep at least one action/task node between nested conditions.
- Validation-retry (`retry:true`) is distinct from failure (`ok:false`): retry keeps the task active; `ok:false` marks task + item `failed`. `human.performActions` only ever retries on validation errors, but an `execute()` throw propagates as an unhandled error — the task also stays active, yet any *earlier* action's side effect (an email) already ran and will re-run on resubmit.
- `document_upload` starts a run of **every** matching builder workflow — two active builder intake workflows means duplicate patient/order writes per upload row.
- Tick idempotency is per interval bucket; deploys with multiple concurrent tick callers are safe (`findWorkflowRunBySourceLabel` check), but shortening `intervalSeconds` changes the bucket math, not existing runs.
- Deleting a builder workflow deactivates all versions but existing runs keep working: runs pin `workflow_version` and `getRunWithDefinition` joins on it.

## Change recipes
1. **Add a system action to the palette**: add the entry to `ACTIONS` in `api/_lib/builderCatalog.js` with a `taskKey` that already exists in `taskRegistry` (add the task fn there first if new); nothing else — compiler and catalog endpoint pick it up.
2. **Add a human checklist action**: add a spec to `HUMAN_ACTIONS` (key, label, `inputs[]`, `validate`, optional `execute`); then add a matching input form case in the worker portal task detail (see [worker pages](../frontend/pages/worker.md)).
3. **Add a condition**: add key + negation entries to `CONDITIONS` **and** a branch in `evaluateCondition` in `api/_lib/taskRegistry.js` that computes/reads it (prefer stamping `item.decisions` so it memoizes).
4. **Add a trigger type**: add to `TRIGGERS` in `builderCatalog.js`, extend the `validateGraph` trigger check in `builderCompiler.js`, then implement the firing path (a new handler action in `api/workflow-runs/index.js` or routing in `bulk-upload/start.js`).
5. **Change bucket semantics**: edit the three queries in `listEmployeeBucketItems` and the claim rules in `openTaskRun` (`api/_lib/repositories.js`), plus the claim-on-complete block in `api/work-items/[taskRunId]/complete.js`.

## Related
- [builder catalog](../backend/lib/builder-catalog.md) — palette + action validate/execute contracts
- [builder compiler](../backend/lib/builder-compiler.md) — graph→steps compilation details
- [workflows route](../backend/routes/workflows.md) — save/delete/catalog endpoint
- [workflow engine](../backend/lib/workflow-engine.md) — step execution, retry rule
- [work-items routes](../backend/routes/work-items.md) — buckets, open, complete
- [builder pages](../frontend/pages/builder.md) — the graph editor UI
- [intake pipeline](./intake-pipeline.md) — document_upload trigger context
