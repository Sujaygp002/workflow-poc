# Workflow-Runs Routes — list runs, manual/time triggers, billing monitor, run delete

**Source:** `api/workflow-runs/index.js`, `api/workflow-runs/[id].js`
**Read this when:** changing how the Orchestrator lists runs, the manual (Run button) or time-interval triggers, the HHAH-grouped billing monitor (Trigger 4), or run deletion.

## What it does
`/api/workflow-runs` — `GET` returns every run with its task rows attached (Orchestrator feed); `POST` dispatches three actions: `startWorkflow` (manual Run button), `tick` (time-interval triggers), `runBillingMonitor` (Trigger 4). `/api/workflow-runs/[id]` — `GET` one run + tasks, `DELETE` removes a run (cascades to items/tasks; keeps created domain records). No auth on these routes.

## Key functions / exports
| name | file | signature -> return | behavior |
|---|---|---|---|
| `handler` (index) | index.js | `(req,res)` | GET list-with-tasks / POST action switch |
| `startWorkflowHandler` | index.js | `(body{workflowId, items?, sourceLabel?}) -> {run, tasks}` | one run, `items` default `[{}]`; creates items+task-runs, runs automation, returns refreshed run | POST `startWorkflow` (201) |
| `tickHandler` | index.js | `() -> {started:[runId]}` | for each active builder `time_interval` workflow, start a run if the newest is older than `intervalSeconds`; idempotent via `builder-tick:<wfId>:<bucketTs>` | POST `tick` |
| `runBillingMonitorHandler` | index.js | `() -> {updatedEpisodes, updatedPatients, updatedCpoMonths, issues, tasks}` | runs `runBillingMonitorPass`, dedups issues by signature, groups by HHAH, one run per HHAH (or appends to an active one) | POST `runBillingMonitor` |
| `createHhahIssueRun` / `appendIssuesToRun` | index.js | `({workflow, group\|runId, issues}) -> {…}` | create a new HHAH billing run / append fresh issues to an in-flight one | `runBillingMonitorHandler` |
| `handler` ([id]) | [id].js | `(req,res)` | GET `{run:{…,tasks}}` / DELETE `{ok:true}` / 404 | Orchestrator card |

## Data shapes
`GET /api/workflow-runs` → `{ runs: [ { …workflow_runs row, tasks:[…workflow_task_runs rows] } ] }`. Tasks are fetched in ONE batched query (`listTaskRunsForRuns`) then grouped in memory — not per-run (that was the pre-fix N+1). Bucketed grouping: `tasksByRun` Map keyed by `run_id`.
`POST startWorkflow` body: `{ action:'startWorkflow', workflowId, items?:[{patientPayload,orderPayload,referencePayload,extractionPayload}], sourceLabel? }`.
`POST tick` body: `{ action:'tick' }` → `{ started:[runId] }`.
`POST runBillingMonitor` → counts + `tasks:[]` where each entry is `{created:true, runId,…}` | `{created:false, existingRunId, issueSignature}` | `{created:false, appended:true, existingRunId, itemIds}`.
Billing issue signatures: `missing-docs:<episodeId>`, `signature:<episodeId>`, `cpo:<cpoMonthId>` (dedup keys — see [eligibility & billing](../../business/eligibility-billing.md)).

## Invariants & gotchas
- **GET is the Orchestrator's heaviest call** and it polls every 2.5 s — keep the payload lean (`listTaskRunsForRuns` returns slim columns, no payload blobs) and never reintroduce the per-run N+1 loop.
- **`tick` only fires while the Orchestrator page is open** — that page's poll is what calls it. There is no server cron. Idempotency is per interval bucket, so two ticks in the same window start at most one run.
- Billing monitor is **HHAH-grouped**: all of an agency's new issues become ONE run (one item per issue). If that HHAH already has an active billing run, new issues are **appended** to it (`appendIssuesToRun`) rather than dropped — otherwise late-arriving issues (e.g. a CPO month that only became checkable once the episode turned billable) would wait for the whole run to finish.
- Each billing item runs a SINGLE step (`runnableStep` clears `preReq`/`condition`), chosen by `issue.stepId` (`billing-s2`/`s5`/`s7`).
- `startWorkflow` with no `items` still creates one empty item so system steps/conditions can evaluate (a manual run of a document-upload workflow has no rows, but its system steps still fire on `{}`).
- `DELETE` cascades via FK `ON DELETE CASCADE` to items/task-runs but leaves created patients/orders — deleting a run is history cleanup, not a domain undo.

## Change recipes
1. **Add a POST action:** add a `case` to the `switch (body.action)` in `index.js`; return via `sendJson`. Keep the 400 default.
2. **Change the Orchestrator feed shape/speed:** edit the GET branch (batching via `listTaskRunsForRuns` in [repositories](../lib/repositories.md)); the consumer is [monitoring pages](../../frontend/pages/monitoring.md).
3. **Change billing grouping/dedup:** edit `hhahGroupKey`/`groupIssue`/`findExistingBillingIssue`/`appendIssuesToRun` here + `runBillingMonitorPass` in [repositories](../lib/repositories.md); signatures live in [eligibility & billing](../../business/eligibility-billing.md).
4. **Change time-trigger cadence rules:** edit `tickHandler` (interval clamp, bucket math) + `listActiveBuilderWorkflowsByTrigger`/`findNewestRunForWorkflow` in [repositories](../lib/repositories.md).

## Related
- [eligibility & billing](../../business/eligibility-billing.md) — what `runBillingMonitorPass` computes and the issue types
- [builder workflows](../../business/builder-workflows.md) — manual + time triggers
- [workflow-engine](../lib/workflow-engine.md) — `runWorkflowAutomation` these handlers call
- [repositories](../lib/repositories.md) — run/item/billing SQL
- [workflow-definitions](../lib/workflow-definitions.md) — `WF_BILLING_MONITOR_DEFINITION` + its steps
- [monitoring frontend](../../frontend/pages/monitoring.md) — the Orchestrator that calls GET + `tick` + `runBillingMonitor`
