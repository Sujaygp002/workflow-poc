# Workflow Engine — per-item automation loop, human-task completion, wf7→signing chain

**Source:** `api/_lib/workflowEngine.js`
**Read this when:** changing step scheduling/ordering, item/run status rollup, how human tasks block or resume items, the validation-retry (400) behavior, or the trigger that spawns the bulk signing run after review.

## What it does

Drives a workflow run item-by-item: for each item it walks the pending task rows in step order, gates each on prerequisites + its `condition` (via `evaluateCondition`), executes system/AI tasks from `taskRegistry` immediately, and parks human tasks as `active` (blocking the item). `completeHumanTask` applies a worker's submission and resumes the whole run. After every wf7 review completion it checks whether the entire run is reviewed and, if so, launches exactly one `wf-signing` bulk run for the run's written orders.

## Key functions / exports

| name | signature (params -> return) | behavior in one line | called by |
|---|---|---|---|
| `runItemAutomation` | `({definition, itemId, context}) -> Promise<void>` | Loop: run every runnable pending task for one item until nothing changes, then roll up item status | `runWorkflowAutomation`; bulk-upload start |
| `runWorkflowAutomation` | `({runId, definition, context, concurrency=10}) -> Promise<void>` | Runs `runItemAutomation` over all non-completed/non-failed items in batches of `concurrency`, then `updateRunStatus(runId)` | `api/workflows/bulk-upload/start.js`, `completeHumanTask`, billing monitor |
| `completeHumanTask` | `({taskRunId, notes, payload, definition}) -> Promise<{task, result}>` | Executes the human task fn with the worker payload, completes/fails it, resumes the run, and may fire the signing chain | `api/work-items/[taskRunId]/complete.js` |
| `startBulkSigningRun` (module-private) | `(wf7RunId) -> Promise<runId\|null>` | Creates ONE idempotent `wf-signing` run with one item per unique written (non-skipped) order, then runs its automation | `completeHumanTask` (review trigger) |
| `prereqsSatisfied` (internal) | `(step, taskMap) -> boolean` | Every `step.preReq` step's task is `completed` **or `skipped`** | scheduling loop |
| `runLimited` (internal) | `(items, limit, fn) -> Promise<void>` | Sequential batches of `limit`, `Promise.all` within a batch | `runWorkflowAutomation` |

## The scheduling loop (`runItemAutomation`)

Per iteration (repeats while anything changed):

1. Re-read the item; stop if missing or already `completed`.
2. Scan the item's task rows **in creation order** (= definition `steps` order); pick the first `pending` task whose step exists and whose prereqs are all `completed/skipped`.
3. Re-fetch the item fresh, then `evaluateCondition(step.condition, freshItem)`:
   - false → task `skipped` with `output: {condition, skipped:true}`; restart loop.
4. `actor === 'human'` → task `active` with `output: taskDisplayPayload(freshItem)` (the worker-UI snapshot); **assignee is left untouched** (builder-set `assigned_employee_id` or NULL = shared "Untouched" bucket); restart loop (the item will end up `blocked`).
5. System/AI → task `active`, then run `taskRegistry[step.taskKey]({item: freshItem, step, task, context})`:
   - fn missing → task + item `failed`, **return** immediately.
   - `result.waiting` → task stays `active` with output; restart loop.
   - `result.ok === false` → task `failed`, item `failed` with `errorMessage`, **return**.
   - else → task `completed` with `output`/`errorMessage`; restart loop.

**Final item rollup:** all tasks terminal (`completed/skipped/failed`) and every non-skipped one `completed` → item `completed`; else any `active` human task → `blocked`; else `running`. (An item with a failed task keeps whatever status the failure path set — `failed`.)

## `completeHumanTask` flow

1. Load task; must exist and be `active` (else throws).
2. Find `step` in `definition.steps` + fn in `taskRegistry` by `task.task_key` (throws if either missing).
3. Run `fn({item, step, task, payload})`.
4. **Validation-retry rule:** `result.retry === true` → throw `Error` with `.status = 400` and `.details.actionErrors` — the task stays `active` (still "Processing"), nothing is marked failed. Used by `human.performActions` (builder checklists).
5. Otherwise: item → `running`, task → `completed`/`failed` (with `notes`, `output`), `ok:false` also fails the item; then `runWorkflowAutomation` over the **whole run** (resumes every item, recomputes run status).
6. If `task.task_key === 'human.reviewRecord'` and it succeeded: when **every** item in the run is `completed` **or** has `extraction_payload.orderSkipped`, call `startBulkSigningRun(runId)`.

## `startBulkSigningRun` (the T2 → T3 chain)

- Requires an active `wf-signing` workflow (`getActiveWorkflow`); idempotent via source label `signing-bulk:<wf7RunId>` (`findWorkflowRunBySourceLabel` — second call returns null, no duplicate run).
- Eligible items: skip `extraction_payload.orderSkipped`; dedupe on `extraction_payload.orderId`; skip items with no orderId. Zero eligible → no run.
- Creates the run with `inputSummary: {sourceRunId, trigger:'review_completed', orderCount}`, then per order one item carrying the source payloads plus:

```js
extractionPayload: {
  sourceRunId, sourceItemId, orderId, orderNumber,
  pdf: { fileName, blobUrl, blobPath, signed }   // from the wf7 item's matched PDF
}
```

- **Signed-ZIP pre-stamp:** if the matched PDF was `signed`, the item's `order_payload.order_status` gets `SignedByPhysician_Status: true` (+ a `SignedByPhyscianDate` defaulting to today) so `signing.checkSigned` resolves signed and no overdue-reminder task spawns.
- Creates task rows from `signingWorkflow.definition.steps` (`createTaskRunsForItem`) and immediately runs automation with `concurrency = eligible.length`.

## Invariants & gotchas

- **Skipped counts as satisfied prereq** — this is how mutually-exclusive branches merge (e.g. `wf7-s31` preReq `[s24, s25]` works whether the human date-fill ran or was skipped). Breaking this breaks every branch join.
- The loop restarts from the top after **every** state change (single `break` per pass), so earlier-listed steps are always re-considered before later ones; step order in the definition is effectively priority order.
- Conditions are evaluated against a **fresh item read**, not the loop's cached copy — decisions stamped by the previous task in the same pass are visible.
- `result.waiting` leaves a system task `active` forever — nothing in this file re-runs an active system task; it needs an external nudge (no current registry fn returns `waiting`; treat as a reserved hook).
- One `ok:false` system task fails the **item** and aborts its loop, but other items in the run continue (batched independently); `updateRunStatus` maps failed items to a `failed` run.
- `completeHumanTask` resumes the **entire run**, not just the completed item's — cheap way to unstick siblings, but means a single completion can trigger many DB reads.
- The signing chain fires only from `human.reviewRecord` completions; if the last blocking item finishes via any other path the chain won't fire until the next review completion in that run.
- Duplicate-skipped orders count as "reviewed" for the all-reviewed check but are excluded from the signing run itself.
- `startBulkSigningRun` is not exported — the only entry is the review-completion hook.
- Human-task activation snapshots `taskDisplayPayload` into `output` **at activation time**; later payload edits don't refresh it until the task completes.

## Change recipes

1. **Chain a new follow-up workflow off a human step:** in `completeHumanTask`, after the existing `human.reviewRecord` block, add a `task.task_key === '<key>'` check that verifies run-wide readiness and calls a new `startBulkXRun(runId)` modeled on `startBulkSigningRun` (idempotent source label + `getActiveWorkflow` + `createWorkflowItem`/`createTaskRunsForItem` + `runWorkflowAutomation`).
2. **Change item/run status semantics:** edit the rollup block at the end of `runItemAutomation`; run-level mapping lives in `updateRunStatus` in `repositories.js` — change both or the Orchestrator shows inconsistent states.
3. **Change default concurrency:** callers pass `concurrency` into `runWorkflowAutomation`; the default 10 and the `Math.max(1, ...)` clamp live in that function.
4. **Add data available to system tasks at run time:** thread it through the `context` param of `runWorkflowAutomation` → `runItemAutomation` → `fn({..., context})` (this is how bulk-upload passes parsed PDFs: `context.pdfs` / `context.pdfsByOrderNumber`).
5. **Change what pre-stamps signed orders in signing runs:** edit the `isSigned` block in `startBulkSigningRun`; keep `signing.checkSigned` in [task registry](./task-registry.md) consistent (it also checks the persisted order row).

## Related

- [task registry](./task-registry.md) — the fns this engine invokes + result contract
- [workflow definitions](./workflow-definitions.md) — steps/preReq/conditions the scheduler walks
- [repositories](./repositories.md) — item/task/run CRUD, `updateRunStatus`
- [bulk-upload route](../routes/bulk-upload.md) — creates wf7 runs and first calls the engine
- [work-items route](../routes/work-items.md) — the HTTP path into `completeHumanTask` (incl. 400 actionErrors)
- [intake pipeline](../../business/intake-pipeline.md) — end-to-end upload → review → signing story
