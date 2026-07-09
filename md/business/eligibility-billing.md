# Eligibility & Billing — how episodes become eligible/billable, CPO months, and the post-model billing pipeline
**Source:** `api/_lib/repositories.js` (Episode/CPO status + billing-monitor sections + gate helpers), `api/_lib/taskRegistry.js` (`billing.*` legacy tasks; new post-model gate task fns), `api/_lib/referenceLogic/rcm.js` + `audit.js` + `rework.js` + `aiService.js` (CCN/RCM/audit tail), `src/pages/orchestrator/Orchestrator.jsx` (live poll)
**Read this when:** changing eligibility/billability rules, CPO month logic, the post-model billing gates (documents/signature/data), the CCN/audit/submit-claim tail, or debugging why an episode reads `started`/`eligible`/`billable` or why a gate task did/didn't appear.

> **Billing monitor removed (2026-07-09):** `wf-billing-monitor` (`WF_BILLING_MONITOR_DEFINITION`, `runBillingMonitorHandler`, `runBillingMonitorPass`) no longer runs. The Orchestrator no longer polls `runBillingMonitor`. The eligibility/CPO business-logic functions (`computeEpisodeAssessment`, `cpoMonthDatesForEpisode`, etc.) remain in `repositories.js` and are used by the builder workflow's gate steps (`loadEpisodeGateContext`, `gateDocumentsExist`, `gateSignatureExists`, `makeEpisodeBillableClaimable`). `runBillingMonitorPass` is dead code.

## What it does
Every episode gets a computed status: **`started` → `eligible` → `billable`**. Eligible = the episode has a 485 order AND an admission-level F2F whose `order_date` falls within 180 days before the episode's EOE (signatures irrelevant). Billable = eligible AND every order attached to the episode is signed. On top of billable episodes, each calendar month spanned by SOE→EOE is a **CPO month** that becomes billable only when ≥30 CPO minutes are captured.

The post-review billing pipeline now lives entirely inside the **Agency Bulk Upload — Daily Intake** builder workflow (TASK-Post-Model Billing Gates + TASK-CCN, Audit & Submit Claim), not a separate trigger run. After the `review_record` human step, the workflow:
1. Checks episode eligibility → routes to `make_billable_claimable` directly if eligible, or through document/data/signature remediation gates if not.
2. Once billable, runs the CCN service (Gemini CC-note generation) → audit cycle (R1–R4, ≤5 rework cycles) → human Submit-claim gate.
Remediation tasks (Get missing documents, Get and fill patient data, Send for signature, Create CCN manually, Resolve audit failures) are async gates: the daily tick's `resolveSettledGateTasks()` auto-resolves them when their underlying condition now passes.

## Business rules → code
| Rule | Implementation |
|---|---|
| Episode with zero orders is always `started` | `computeEpisodeAssessment` early-return (`repositories.js`) |
| Eligible = has 485 + valid F2F | `has485` = any episode order whose doc type contains `485`; `validF2f` = any **admission** order whose doc type contains `f2f`/`face` with `0 <= dayDiff(order_date, episode.eoe) <= 180` |
| An unsigned F2F/485 still counts toward eligibility | eligibility never calls `isOrderSigned` |
| Billable = eligible + all episode orders signed | `unsignedOrderNumbers.length === 0` over episode orders via `isOrderSigned` |
| CPO month exists for each month in SOE..EOE | `cpoMonthDatesForEpisode` → `INSERT ... ON CONFLICT (episode_id, cpo_month) DO NOTHING` in `runBillingMonitorPass` |
| CPO month billable = episode billable + `cpo_min >= 30` | `cpoStatusForMonth` → status `billable`/`not_billable` |
| Patient card shows latest episode status | `runBillingMonitorPass` rolls the newest episode (`ORDER BY e.soe DESC NULLS LAST, e.created_at DESC`) into `patients.latest_episode_status` + `_reason` |
| One billing run per HHAH; late-found issues join the in-flight run | `runBillingMonitorHandler`: `findActiveWorkflowRunForHhah` → `appendIssuesToRun`, else `createHhahIssueRun` |
| An issue is raised once, ever | signature dedup via `findWorkflowItemByIssueSignature` (`extraction_payload->>'issueSignature'`) — matches items of ANY status, so completed issues never re-fire unless the run is deleted |

## Key functions / exports
| name | signature | behavior | called by |
|---|---|---|---|
| `computeEpisodeAssessment` | `(episode, episodeOrders, admissionOrders=episodeOrders) -> {status, eligible, billable, reason}` | The single source of truth for started/eligible/billable | `computeEpisodeStatus`, `buildEpisodeEntry` (patient tree/list reads), `runBillingMonitorPass` |
| `computeEpisodeStatus` | `(orders, episode, admissionOrders) -> string` | Status-only wrapper | legacy read paths |
| `isOrderSigned` | `(order) -> bool` | True on any of `SignedByPhysician_Status` (bool/'true'), `SignedByPhyscianDate` (sic), or legacy `signed`/`order_signed_date`/`signedDate`/`signed_date` | assessment, `decorateOrder`, monitor reminder collection |
| `runBillingMonitorPass` | `() -> {updatedEpisodes, updatedPatients, updatedCpoMonths, issues:{missingDocuments, physicianReminders, cpoMinutes}}` | Loads newest ≤500 episodes (+agency), orders by `episode_id OR admission_id`; writes `patient_episodes.status/status_reason`, creates+restatuses `cpo_months`, rolls up `patients.latest_episode_status`, collects issues | `runBillingMonitorHandler` |
| `cpoMonthDatesForEpisode` | `(episode) -> ['YYYY-MM-01',...]` | Month-start dates covering SOE..EOE; `[]` if either date missing or `eoe <= soe`; EOE landing exactly on the 1st excludes that month | `runBillingMonitorPass` |
| `cpoStatusForMonth` | `(cpoMonth, episodeStatus) -> {status, reason}` | `billable` iff episode status is `billable` and `cpo_min >= 30` | monitor pass, `updateCpoMinutes` |
| `updateCpoMinutes` | `({cpoMonthId, cpoMin=30}) -> cpo_months row` | Sets minutes + recomputes status against the episode's CURRENT stored status | `billing.addCpoMinutes` task |
| `findWorkflowItemByIssueSignature` | `(workflowId, sig) -> item∪null` | Newest item whose `extraction_payload.issueSignature` matches — the dedup gate | handler |
| `findActiveWorkflowRunForHhah` | `(workflowId, hhahId, hhahName) -> run∪null` | Newest `running` run matched by `hhah_id`, else `input_summary.hhahName`, else the Unknown-HHAH bucket | handler |
| `runBillingMonitorHandler` | `() -> {updatedEpisodes, updatedPatients, updatedCpoMonths, issues:{counts}, tasks:[...]}` | Dedup → group by HHAH → append-or-create runs; each issue = 1 item + 1 step (condition/preReq stripped by `runnableStep`) | `POST /api/workflow-runs {action:'runBillingMonitor'}` |

## Data shapes
Issue signatures (dedup keys): `missing-docs:<episodeId>`, `signature:<episodeId>`, `cpo:<cpoMonthId>`. Legacy per-issue source labels (`billing-monitor:missing-docs:<id>` etc.) are still checked as a fallback in `findExistingBillingIssue`.

Item payloads created by the handler (step per issue type — `billing-s2` / `billing-s5` / `billing-s7`):
```js
// referencePayload (all types)
{ HHAH: { id, name, contact_info } }
// extractionPayload
{ issueType: 'missing-docs', issueSignature, episodeId, admissionId, eligible:false,
  missingDocuments:['485 cert/recert','valid F2F'], reason:{...assessment.reason} }
{ issueType: 'signature', issueSignature, episodeId, admissionId, eligible:true,
  billable:false, unsignedOrderNumbers:[...] }        // + orderPayload with the first unsigned order
{ issueType: 'cpo', issueSignature, episodeId, cpoMonthId, cpoMonth, cpoMin,
  eligible:true, billable:true, cpoMonthBillable:false }
```
`assessment.reason` (stored to `patient_episodes.status_reason` and `patients.latest_episode_status_reason`):
```js
{ has485, hasF2f, f2fWithin180DaysOfEoe, f2fOrderNumber, episodeEoe,
  allEpisodeOrdersSigned, unsignedOrderNumbers:[...] }
```
Run: `sourceLabel = billing-monitor:hhah:<sanitized id|name>:<ISO ts>`, `hhah_id` set, `input_summary = { trigger:'billing-monitor', groupedBy:'hhah', hhahId, hhahName, issueCount, issueTypes }`.

## Invariants & gotchas
- **Date values from Neon are `Date` objects, not strings.** `dayDiff` and `parseDateOnly` MUST route through `dateOnly`/`dateMs` (`repositories.js`) — naive `String(value).slice(0,10)` produced `NaN` twice historically (killed eligibility, then killed all CPO months). Any new date math here must use those helpers.
- **`SignedByPhyscianDate` is intentionally misspelled** — it matches what `markOrderSignedByPhysician`/`bulkSignOrders` write into `order_status`. Keep reader and writers consistent; don't "fix" one side.
- F2F is searched in **admission** orders (third arg), not episode orders — an F2F can hang at the admission with no `episode_id`. Callers passing only episode orders silently narrow eligibility.
- The monitor's system check steps (`billing-s1/s3/s4/s6`) are **never instantiated** by Trigger 4 — the pass already decided; items get exactly one human step via `runnableStep` (which strips `preReq`/`condition` so the engine runs it unconditionally). The `eligible/billable/cpoMonthBillable` flags in `extractionPayload` exist so the `billing.check*` tasks would agree if the full definition ever ran.
- **Cadence is frontend-driven**: Orchestrator (`Orchestrator.jsx`) POSTs `runBillingMonitor` every 10 s while Live and the tab is visible. The definition's `trigger.intervalSeconds: 10` is a label; nothing server-side ticks Trigger 4. Closing the Orchestrator stops the monitor.
- Email tasks (`billing.sendHhahMissingDocumentEmail`, `billing.sendPhysicianReminder`) are **best-effort**: `sendEmail` (`mailer.js`) never throws — it returns `{sent:false, skipped:true, reason}` on missing SMTP/recipient/error. A throwing mail path previously deadlocked whole HHAH runs (item stuck `blocked` → run stuck `running` → active-run guard blocked all future runs).
- `billing.addCpoMinutes` clamps to `Math.max(30, ...)` — you cannot record <30 minutes through the task; `updateCpoMinutes` recomputes status against the episode's stored status at that moment.
- Dedup is permanent per signature: a `cpo:<id>` or `missing-docs:<id>` issue that was ever itemized (even completed) never re-raises. Deleting the run (cascade) is the only reset.
- The pass **UPDATEs every scanned episode row** (`updated_at = now()`) each tick, which also keeps them at the top of the `LIMIT 500` newest-first window.
- CPO months exist even for non-billable episodes (rows are created for any episode with valid SOE<EOE) — they just stay `not_billable`; issues only fire while `assessment.billable` is true.

## Change recipes
1. **Change the F2F window (180 days):** edit the `days <= 180` check in `computeEpisodeAssessment` (`repositories.js`); update the `reason.f2fWithin180DaysOfEoe` key name if you rename it (it's read by UI status chips and stored in `status_reason`), plus the condition prose in `WF_BILLING_MONITOR_DEFINITION.conditions`.
2. **Change the CPO minimum (30 min):** three places must agree — `cpoStatusForMonth` (`hasMinutes`), the issue check `Number(updated.cpo_min||0) < 30` in `runBillingMonitorPass`, and the clamp in `billing.addCpoMinutes` (`taskRegistry.js`).
3. **Add a new billing issue type:** collect it in `runBillingMonitorPass` (push to `result.issues.<new>`); in `runBillingMonitorHandler` add a loop with a unique `issueSignature` prefix + `stepId`, calling `groupIssue`; add the human step to `WF_BILLING_MONITOR_DEFINITION.steps` + its `megaTask.innerStepIds`; implement the task fn in `taskRegistry.js`. `ensureSystemDefinitions()` runs on every monitor call, so the definition self-updates.
4. **Change monitor cadence:** edit the `setInterval(tick, 10000)` in the Trigger-4 effect in `Orchestrator.jsx`; update `trigger.intervalSeconds`/`label` in `WF_BILLING_MONITOR_DEFINITION` so the START cap text matches.
5. **Change what counts as "signed":** edit `isOrderSigned` AND the JSON written by `markOrderSignedByPhysician`/`bulkSignOrders` (`repositories.js`) together; also mirror in `listPgUnsignedOrders`' SQL predicates (`order_status->>'SignedByPhysician_Status'`).

## Related
- [orders-and-signing](orders-and-signing.md) — sent/signed status writes this doc's `isOrderSigned` reads
- [patient-model](patient-model.md) — admission/episode structure the assessment walks
- [intake-pipeline](intake-pipeline.md) — how episodes/orders get created upstream
- [repositories](../backend/lib/repositories.md) — full repo function reference
- [workflow-runs route](../backend/routes/workflow-runs.md) — the `runBillingMonitor` HTTP contract
- [monitoring pages](../frontend/pages/monitoring.md) — Orchestrator poll that drives Trigger 4
