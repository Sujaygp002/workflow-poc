# Workflow-Runs Routes — list runs, manual/time triggers, run delete

**Source:** `api/workflow-runs/index.js`, `api/workflow-runs/[id].js`
**Read this when:** changing how the Orchestrator lists runs, the manual (Run button) or time-interval triggers, or run deletion.

> **Removed (2026-07-09):** `runBillingMonitorHandler` and all billing-monitor helpers (`createHhahIssueRun`, `appendIssuesToRun`, `ensureBillingWorkflow`, etc.) have been deleted. `POST {action:'runBillingMonitor'}` now returns 400 "Unsupported workflow-runs action." The billing-monitor run-grouping and issue-append seam described in older docs no longer exist here.

## What it does
`/api/workflow-runs` — `GET` returns every run with its task rows attached (Orchestrator feed); `POST` dispatches two actions: `startWorkflow` (manual Run button), `tick` (time-interval and daily-time triggers). `/api/workflow-runs/[id]` — `GET` one run + tasks, `DELETE` removes a run (cascades to items/tasks; keeps created domain records). No auth on these routes.

## Key functions / exports
| name | file | signature -> return | behavior |
|---|---|---|---|
| `handler` (index) | index.js | `(req,res)` | GET list-with-tasks / POST action switch |
| `startWorkflowHandler` | index.js | `(body{workflowId, items?, sourceLabel?}) -> {run, tasks}` | one run, `items` default `[{}]`; creates items+task-runs, runs automation, returns refreshed run | POST `startWorkflow` (201) |
| `tickHandler` | index.js | `() -> {started:[runId]}` | handles both `time_interval` and `daily_time` triggers: for `time_interval` starts a run if the newest is older than `intervalSeconds` (idempotent via `builder-tick:<wfId>:<bucketTs>`); for `daily_time` iterates active agencies and (a) creates today's run if missing (at/after fire time) or (b) when run already exists, appends ONE base item per agency not yet present (`appendKey base:<agencyId>:<dayBucket>`), idempotent via `daily-agency:<wfId>:<agencyId>:<dayBucket>` | POST `tick` OR GET `?action=tick` (Vercel cron) |
| `handler` ([id]) | [id].js | `(req,res)` | GET `{run:{…,tasks}}` / DELETE `{ok:true}` / 404 | Orchestrator card |

## Data shapes
`GET /api/workflow-runs` → `{ runs: [ { …workflow_runs row, tasks:[…workflow_task_runs rows] } ] }`. Tasks are fetched in ONE batched query (`listTaskRunsForRuns`) then grouped in memory — not per-run (that was the pre-fix N+1). Bucketed grouping: `tasksByRun` Map keyed by `run_id`.
`POST startWorkflow` body: `{ action:'startWorkflow', workflowId, items?:[{patientPayload,orderPayload,referencePayload,extractionPayload}], sourceLabel? }`.
`POST tick` body: `{ action:'tick' }` → `{ started:[runId] }`. Also callable as `GET /api/workflow-runs?action=tick` (used by the Vercel cron declared in `vercel.json`: `{ "path":"/api/workflow-runs?action=tick", "schedule":"0 17 * * *" }`). `tick` has TWO real callers: the Orchestrator frontend poll (POST, browser) and the daily cron (GET, Vercel infra).

## Invariants & gotchas
- **GET is the Orchestrator's heaviest call** and it polls every 2.5 s — keep the payload lean (`listTaskRunsForRuns` returns slim columns, no payload blobs) and never reintroduce the per-run N+1 loop.
- **`tick` handles both trigger types.** `time_interval`: start a run when none exist or the newest is older than `intervalSeconds`. `daily_time`: if no run exists for today's bucket (at/after fire time), create one with no base items (individual agency contact tasks will be appended); if a run already exists (created earlier by an upload), append any missing base items for agencies not yet represented. Idempotency per bucket/agency ensures two concurrent ticks are safe.
- **The `daily_time` tick and the upload `reconcileDailyRunForUpload` cooperate on ONE shared run per day.** Uploads append row-level items early; the noon tick appends base contact-check items for any agency that hasn't uploaded yet. `appendKey` deduplication (`base:<agencyId>:<dayBucket>` vs `row:<hhahId>:<key>:<dayBucket>`) prevents double-appending regardless of order.
- `startWorkflow` with no `items` still creates one empty item so system steps/conditions can evaluate (a manual run of a document-upload workflow has no rows, but its system steps still fire on `{}`).
- `DELETE` cascades via FK `ON DELETE CASCADE` to items/task-runs but leaves created patients/orders — deleting a run is history cleanup, not a domain undo.
- **`runBillingMonitor` is gone.** `POST {action:'runBillingMonitor'}` returns 400. `repositories.js` `runBillingMonitorPass` is harmless dead code (no caller).

## Change recipes
1. **Add a POST action:** add a `case` to the `switch (body.action)` in `index.js`; return via `sendJson`. Keep the 400 default.
2. **Change the Orchestrator feed shape/speed:** edit the GET branch (batching via `listTaskRunsForRuns` in [repositories](../lib/repositories.md)); the consumer is [monitoring pages](../../frontend/pages/monitoring.md).
3. **Change time-trigger cadence rules:** edit `tickHandler` (interval clamp, bucket math) + `listActiveBuilderWorkflowsByTrigger`/`findNewestRunForWorkflow` in [repositories](../lib/repositories.md).

## Related
- [builder workflows](../../business/builder-workflows.md) — manual + time triggers + daily_time append seam
- [workflow-engine](../lib/workflow-engine.md) — `runWorkflowAutomation` these handlers call
- [repositories](../lib/repositories.md) — run/item SQL
- [workflow-definitions](../lib/workflow-definitions.md) — the one remaining system def
- [monitoring frontend](../../frontend/pages/monitoring.md) — the Orchestrator poll calls GET + `tickTimeTriggers` (POST `{action:'tick'}`) on every 10s cycle; the Vercel cron covers the server-only path daily
