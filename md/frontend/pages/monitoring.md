# Monitoring Pages — Orchestrator run viewer and Coverage Map network graph
**Source:** `src/pages/orchestrator/Orchestrator.jsx`, `src/pages/map/NetworkMap.jsx`, `src/pages/map/graph.js`
**Read this when:** changing how workflow runs render (trigger grouping, run cards, stats, live polling), the client-side Trigger 4 billing-monitor loop, the Coverage Map drilldown levels/colors/counts, or the HHAH→PG graph aggregation.

## What it does
- **`/orchestrator`** (`Orchestrator.jsx`) — live view of all DB workflow runs as flowcharts. Polls `fetchWorkflowRuns()` + `fetchAreaIntakeStatus()` every 2.5s, groups runs by trigger (wf-area-onboarding → other), renders each as a `RunCard` (flowchart + object sidebar), and **drives builder time triggers itself**: the 10-second `tick()` interval calls `tickTimeTriggers()` (fires `time_interval` + `daily_time` builder workflows). This means builder `daily_time` workflows advance while the Orchestrator tab is open — the Vercel cron (`0 17 * * *` on `GET /api/workflow-runs?action=tick`) covers the server-only path. **`runBillingMonitor()` has been removed** from the poll (2026-07-09); wf7/wf-signing/wf-billing-monitor run groups are also gone.
- **`/map`** (`NetworkMap.jsx` + `graph.js`) — interactive SVG force graph: HHAH agency balls → patient-count edge ball per (HHAH, PG) → PG balls; edge drills down Admissions → Current/Past admission → Episodes → Current/Past episode → Orders → signed/unsigned + 485/F2F/other leaves. `graph.js` builds the whole model client-side by joining the existing patients/orders/reference feeds — no map-specific endpoint.

## Key functions / exports
| name | signature (params -> return) | behavior in one line | called by |
|---|---|---|---|
| `Orchestrator` (default) | `() -> JSX` | State + polling + trigger-grouped run list | route `/orchestrator` in `src/App.jsx` |
| `refresh` | `() -> Promise` | `Promise.all([fetchWorkflowRuns(), fetchAreaIntakeStatus()])` with a `refreshing.current` in-flight guard (poll ticks can't stack) | mount, 2.5s interval, after delete/check/billing |
| `handleDelete` | `(run) -> Promise` | `window.confirm` → optimistic removal from state → `deleteWorkflowRun(run.id)` → `refresh()` | RunCard trash button |
| `handleRunAreaCheck` | `(areaId) -> Promise` | `runAreaIntakeCheck({areaId, forceExpired:true})` ("Simulate 24h check") | `AreaIntakeSubPanel` |
| `RunCard` | `({run, onDelete, areas, loadingAreaId, onRunCheck}) -> JSX` | Collapsible card: header badges (status/HHAH/items/task-runs/manual), START·trigger cap, flowchart, END cap, `RunObjectSidebar` | run groups |
| `AreaIntakeSubPanel` | `({areas, loadingAreaId, onRunCheck}) -> JSX` | Per-area expected/received/missing counts + per-HHAH received chips; rendered **inside** the `wf-area-onboarding` RunCard only | `RunCard` when `isAreaOnboarding` |
| `buildGraph` | `({patients, orders, reference}) -> {hhahs, edges, practitionersByPg}` | Joins the three feeds into the map model (see Data shapes) | `NetworkMap.load` |
| `edgesForHhah` | `(graph, hhahId) -> edge[]` | Filters edges by `hhahId` (lowercased agency name) | engine `expand` for hhah nodes |
| `fmtCount` | `(n) -> string` | Coerces non-finite to 0; ≥1000 → `1.2k` | engine `countDisplay`, badges |
| `createEngine` | `(nodesG, linksG, viewG, {onBanner}) -> {setData, stop, expandByName, zoomBy, zoomFit, isIdle}` | Imperative SVG force-graph engine held in a ref; owns nodes/links/drag/layout/rAF animation | `NetworkMap` init effect |
| `NetworkMap` (default) | `() -> JSX` | Chrome (top bar, search-with-suggest, live toggle, zoom, legend) around the engine's `<svg>` | route `/map` |

## Data shapes
Run (from `fetchWorkflowRuns()`), fields this page reads:
```js
{ id, workflow_id, status: 'running'|'completed'|'failed', source_label, created_at,
  total_items, hhah_name?, input_summary?: { hhahName?, area?: { hhahName? } },
  definition: { name, trigger, megaGroups?, megaTask?, steps... },   // rendering fork
  tasks: [{ status: 'pending'|'active'|'skipped'|..., actor: 'human'|'system'|'ai', ... }] }
```
Manual backlog = tasks with `status==='active' && actor==='human'`; "task run(s)" = tasks with status not `pending`/`skipped`.
Graph model (from `buildGraph`):
```js
{ hhahs: [{ id /* lowercased name */, name, received, pgCount }],           // sorted by pgCount desc
  edges: [{ hhahId, hhahName, pg, patients, admissions, episodes, orders,
            oldAdmissions, newAdmissions, oldEpisodes, newEpisodes,
            billedEpisodes, unbilledEpisodes, eligibleEpisodes,
            signedOrders, unsignedOrders, o485, f2f, other }],
  practitionersByPg: { [pgName]: count } }
```
Engine node: `{ id, kind, label, x, y, rx, ry, appear, r, open, hidden, ref, count?, stats?, age?, breakdown?, statLabel?, el: {g, core, ring, inner, close, badge, label...} }`. Node `kind`s + drill order: `hhah` → `edge` (patient count) → `adm` → `admBucket` (Current/Past, `age:'new'|'old'`) → `epi` → `epBucket` → `order` → leaves `osigned|ounsigned|o485|of2f|oother`. Colors/radii per kind in `COLORS`/`RAD` (NetworkMap.jsx).

## Invariants & gotchas
- **Builder time triggers run from this page's browser tab**: the 10s `tick()` interval fires `tickTimeTriggers()` (time_interval + daily_time builder workflows) while Orchestrator is open, `live` is true, and the tab is visible. `tickTimeTriggers` is fire-and-forget (`.catch(()=>{})`). Closing the tab stops it. The Vercel cron covers daily_time triggers server-side even when the tab is closed. **`runBillingMonitor` is no longer called** from the poll — `wf-billing-monitor` has been deleted.
- Both poll loops skip ticks when `document.hidden`; `refresh` additionally has its own in-flight ref guard — keep both when touching polling.
- Run grouping is by hardcoded `workflow_id` list (`wf-area-onboarding`); anything else falls into "Other runs". `wf7`, `wf-signing`, and `wf-billing-monitor` sections have been removed. A new system workflow needs a new filter+section block here to get a labeled group.
- `RunCard` picks its renderer by definition shape: `megaGroups` → `MegaGroupFlow`, `megaTask` → `MegaTaskNode`, else `WorkflowFlow` — all from `src/components/WorkflowDefinitionFlow.jsx` ([components](../components.md)).
- Deleting a run keeps created patient/order records (confirm text promises this; server behavior in [workflow-runs route](../../backend/routes/workflow-runs.md)).
- **Map: agency balls come ONLY from Entity-page reference agencies.** `buildGraph` drops edges whose `hhah_name` doesn't match a reference agency (`refHhahNameByKey`) and canonicalizes the display name — workbook-invented HHAH names never spawn phantom balls.
- **Episode age inherits the parent admission's age** (`_episodeAdmission` map): admission old/new is by `order_admission_details.EOC` past/future vs today; classifying episodes by their own EOE independently caused "1 new admission, 0 episodes". Fallback: episodes with no admission link get no age bucket at all.
- Old/new, billed/unbilled/eligible, signed/unsigned counts are all derived from the **orders feed** (dedup by `admission_id`/`episode_id` Sets); patient rows only contribute `patients`/`admissions`/`episodes` base counts (`Math.max` with the id-set sizes). Precedence: one order with a past EOC marks its admission old permanently (old wins over new); one `episode_status === 'billable'` order marks the episode billed (billed wins over unbilled); eligible = status `eligible` OR `billable`.
- `dateMs` handles both `Date` objects and strings (Neon returns Dates) — same bug class as the server `dayDiff` fix; reuse it for any new date logic here.
- Engine is imperative and lives in `engineRef` so React re-renders never rebuild the simulation; live poll (2.5s) calls `setData` **only when `isIdle()`** (no hhah open) so it never yanks the user out of a drilldown. `stop()` must stay wired to the effect cleanup (cancels rAF).
- Links draw from rendered coords `rx/ry` (eased toward logical `x/y` in `tick`), not `x/y` — dragging sets both so the ball tracks the pointer lag-free. `drag.moved` > 3px sets `ignoreClick` so a drag-release doesn't toggle expand/collapse.
- `epBucket` balls always render a `billed N · unbilled N · eligible N` text badge under the ball (the billed/unbilled drill level was removed on purpose — orders hang directly off the episode).
- Node ids embed the full parent path (e.g. `epi:newAdm:adm:edge:hhah:x:pg`), so Current vs Past branches never collide; `spawn` dedupes by id and re-links if the node already exists.

## Change recipes
1. **Add a new trigger section to Orchestrator**: add a `runs.filter(r => r.workflow_id === 'wf-x')` group + a section block in the return (copy the Trigger 4 block), and add the id to the `otherRuns` exclusion list.
2. **Add a stat badge to run cards**: compute it from `run.tasks`/`run` fields inside `RunCard` and append a `<span>` pill in the header row; if it needs new data, extend the runs query in [workflow-runs route](../../backend/routes/workflow-runs.md) first.
3. **Add a drilldown level to the map**: add the kind to `COLORS` + `RAD`, a branch in the engine's `expand(n)` (use `spawn` with path-scoped ids), a case in `countDisplay`, the kind in the `expandable` list in `render`, and a legend entry in `NetworkMap`'s bottom-left legend array.
4. **Change a map count's definition**: edit the aggregation in `buildGraph` (`graph.js`) — add to the edge skeleton in `ensureEdge`, accumulate in the patients or orders loop, materialize in the final `.map()` (and delete the temp `_` Set) — then read it off `n.stats` in the engine.
5. **Change Trigger 4 cadence/trigger**: edit the 10000ms interval effect in `Orchestrator`; the guard behavior (per-HHAH active-run skip) is server-side in the engine, not here — see [eligibility & billing](../../business/eligibility-billing.md).

## Related
- [components](../components.md) — `WorkflowDefinitionFlow` renderers (`RunCard` delegates all flowchart drawing there)
- [frontend lib](../lib.md) — `workflowApi.js` fetchers these pages poll
- [workflow-runs route](../../backend/routes/workflow-runs.md) — run list/delete API contract
- [eligibility & billing](../../business/eligibility-billing.md) — episode/CPO business rules (billing monitor removed; these rules are still used by referenceLogic modules)
- [intake pipeline](../../business/intake-pipeline.md) — the trigger chain being visualized
- [data reads](../../backend/routes/data-reads.md) — patients/orders/reference feeds the map joins
