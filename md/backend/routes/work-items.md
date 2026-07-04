# Work-Items Routes — worker buckets (GET), open a task, complete a task

**Source:** `api/work-items/index.js`, `api/work-items/[taskRunId]/complete.js`
**Read this when:** changing what an employee sees in their buckets, how opening a task claims it (Untouched→Processing), or how completing a task validates and advances the run.

## What it does
`/api/work-items` — `GET` (employee bearer) returns the signed-in employee's three buckets (`untouched`/`processing`/`done`); `POST {action:'open', taskRunId}` claims the task, sets `opened_at`, moves it to Processing, and returns the full task detail + action checklist + patient/order/PDF context. `/api/work-items/[taskRunId]/complete` — `POST` (employee bearer) runs `completeHumanTask`; on success the task→Done and the run advances, on validation failure it 400s and the task stays active/Processing. Both routes are guarded by `requireSession(req, {type:'employee'})`.

## Key functions / exports
| name | file | signature -> return | behavior |
|---|---|---|---|
| `handler` (index) | index.js | `(req,res)` | GET buckets / POST open; both require employee session |
| `taskActions` | index.js | `(task) -> actions[]` | returns `task.actions` or a single implicit `{actionKey:'legacy', taskKey:task.task_key}` for system-workflow tasks (exported) |
| `handler` (complete) | complete.js | `(req,res)` | requires employee session; 403 if claimed by another; auto-claims unclaimed; calls `completeHumanTask` |

## Data shapes
`GET /api/work-items` (bearer) →
```js
{ employee: { id, username, displayName },
  untouched: [ bucketRow ], processing: [ bucketRow ], done: [ bucketRow ] }
// bucketRow = a workflow_task_runs row + { actions:[…] }  (actions defaulted for legacy tasks)
```
Bucket rules (see [builder workflows](../../business/builder-workflows.md)) via `listEmployeeBucketItems(employeeId)`:
- **Untouched:** `status='active' AND opened_at IS NULL AND (assigned_employee_id = me OR IS NULL)`
- **Processing:** `status='active' AND opened_at NOT NULL AND assigned_employee_id = me`
- **Done:** `status='completed' AND assigned_employee_id = me`

`POST {action:'open', taskRunId}` → `{ task, actions:[…], actionState:{}, payload: taskDisplayPayload(item), pdf: item.extraction_payload.pdf|null }`. `openTaskRun` sets `opened_at=now()` and claims (`assigned_employee_id=me`) if it was NULL; returns `{error,status}` on a guard failure (already completed/opened by another).

`POST /complete` body: `{ runId?, notes?, payload:{ actionResults:{ [actionId]: {…} } } }` →
- success `200 { task, result }`; failure `400 { error:'Validation failed', actionErrors:{ [actionId]: msg } }` (task stays active/Processing).

## Invariants & gotchas
- **Opening a task IS the API call the product describes** — `POST open` is what claims + stamps `opened_at`. A shared (unassigned) system task gets claimed on open, so it disappears from every other employee's Untouched list. Idempotent.
- **Completion validates every action server-side** in `human.performActions` ([task-registry](../lib/task-registry.md)); a `{retry:true}` result makes `completeHumanTask` throw a 400 and **keep the task active with `opened_at` intact** — so it stays in Processing, not failed. Non-retry failures follow the old failed-task path.
- `complete.js` auto-claims an **unclaimed** task on completion (so it lands in the completer's Done); a task claimed by a *different* employee returns 403.
- The `runId` in the complete body is optional — it falls back to `task.run_id`; it exists so the frontend can pass the run it already has.
- `taskActions` is the single place the legacy-vs-builder action shape is reconciled — both the GET buckets and the open-detail use it, so worker UI never special-cases system tasks.
- These are the ONLY routes that require an **employee** session (`requireSession {type:'employee'}`); everything the worker portal calls carries `cc_worker_token`.

## Change recipes
1. **Change bucket membership rules:** edit `listEmployeeBucketItems` in [repositories](../lib/repositories.md) (the SQL predicates above); the route just maps rows.
2. **Change what the task-detail returns on open:** edit the `POST open` branch here + `taskDisplayPayload` in [task-registry](../lib/task-registry.md); consumer is [worker page](../../frontend/pages/worker.md).
3. **Change validation/complete behavior:** edit `human.performActions` in [task-registry](../lib/task-registry.md) and the retry rule in `completeHumanTask` ([workflow-engine](../lib/workflow-engine.md)); the 400 shape is surfaced by [utils `handleError`](../lib/utils.md).
4. **Change claim/authorization rules:** edit `openTaskRun` (repositories) + the 403/auto-claim logic in `complete.js`.

## Related
- [builder workflows](../../business/builder-workflows.md) — bucket lifecycle + validation-retry rules
- [task-registry](../lib/task-registry.md) — `human.performActions`, `taskDisplayPayload`, per-action validate/execute
- [workflow-engine](../lib/workflow-engine.md) — `completeHumanTask` retry semantics
- [auth](../lib/auth.md) — `requireSession({type:'employee'})`
- [repositories](../lib/repositories.md) — `listEmployeeBucketItems`, `openTaskRun`, `getItem`, `getTaskRun`, `updateTask`
- [worker frontend](../../frontend/pages/worker.md) — the caller
