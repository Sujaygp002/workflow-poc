# CLAUDE.md

Guidance for Claude Code when working in this repo. Keep the **Change Log** at the
bottom updated after every change (newest first).

## Project

DB-backed bulk workflow POC for HHH patient + order intake. A Vite/React frontend
with Vercel serverless API routes backed by Neon/Postgres, Gemini for PDF data
extraction, and Vercel Blob for PDF storage.

- **Frontend**: Vite + React + Tailwind (`src/`)
- **API**: Vercel serverless functions (`api/`)
- **DB**: Neon/Postgres (`db/migrations`, `db/seed`)
- **AI**: Google Gemini (`@google/genai`) for extracting missing fields from order PDFs
- **Storage**: Vercel Blob for order PDFs (optional — skips gracefully if no token)
- Deployed on Vercel, auto-deploys from `main` on GitHub repo `Sujaygp002/workflow-poc`.

## Commands

| Command | What |
|---------|------|
| `npm run dev` | Vite dev server (frontend only — `/api/*` needs Vercel runtime + DB) |
| `npm run build` | Production build (run this to verify changes compile) |
| `npm run lint` | ESLint over the repo |
| `npm run db:migrate` | Apply Neon migrations (`scripts/migrate.js`) |
| `npm run db:seed` | Seed DB incl. the `wf7` workflow (`scripts/seed.js`) |

Verify changes with `npm run lint` + `npm run build`. The live orchestrator/API
cannot be exercised by `vite dev` alone (serverless functions need the Vercel
runtime and DB), so prefer build/lint for verification.

## Layout

- `api/_lib/` — shared server code: `config.js` (env/credentials), `db.js` (Neon
  client), `gemini.js` (PDF extraction), `blobStore.js` (PDF upload), `taskRegistry.js`
  (per-step task logic), `workflowEngine.js`, `workflowDefinition.js`, `repositories.js`.
- `api/<resource>/` — route handlers (orders, patients, reference-data, work-items,
  workflow-runs, workflows/bulk-upload).
- `src/pages/orchestrator/Orchestrator.jsx` — workflow run visualization. Has THREE
  renderers: `BulkInstanceCard` (legacy local bulk), `DbBulkInstanceCard` (DB wf7 loop —
  the main view), and `InstanceCard` (generic, uses `WorkflowFlowChart`).
- `src/components/WorkflowFlowChart.jsx` — generic flow renderer used by the builder
  and the generic instance view.

## Conventions

- **Credentials are hardcoded** in `api/_lib/config.js` as fallbacks (`X = process.env.X || '<literal>'`)
  for personal testing. Env vars still override. Do NOT move secrets elsewhere without
  asking. For real production these must move to env vars and the keys rotated.
- The `wf7` workflow steps are referenced by stepId. IDs are intentionally
  non-contiguous (`wf7-s1`..`wf7-s27`; `wf7-s22`/`wf7-s23` were retired). The DB
  bulk renderer maps the visible steps explicitly in `row(...)` calls.
- Condition/branch logic: a step's `conditionExpr` gates it (e.g. `ai_extraction_fail`,
  `admission_dates_missing`). Side branches are not always NO/human: derive the branch label
  from the branch task's condition. For example, `admission_dates_missing` means YES goes
  to manual dates, while `patient_exists` means YES goes to Update Patient and NO goes to
  Create Patient.
- **Flowchart conditions render as if/else decision diamonds**: a rotated-square diamond
  holds the condition, with the down and right exits labelled according to the actual branch
  truth. See `DecisionDiamond` / `BranchArm` in `Orchestrator.jsx`.
- Match surrounding Tailwind/style idiom. Actor coloring: system = sky/blue, human = pink,
  conditions = amber.

## Change Log

Newest first. Add an entry for each change made by Claude Code.

- **2026-06-13** — Workflows page updated to use the same flowchart renderer as the Orchestrator.
  Extracted shared components (`ACTOR`, `actorOf`, `stepStats`, `DecisionDiamond`, `StepInfo`,
  `StepNode`, `Connector`, `WorkflowFlow`, `TriggerChainConnector`) into new
  `src/components/WorkflowDefinitionFlow.jsx`. Orchestrator now imports from there instead of
  defining them inline. `WorkflowList.jsx` rebuilt: dropped the old `WorkflowFlowChart`/
  `nodesFromWorkflow` adapter; now renders each workflow with the same decision-diamond flowchart
  and the T1 → T2 → T3 trigger chain connectors. Each card shows a Trigger N badge, workflow id,
  step count, trigger type, and the full step flowchart with START/END caps.

- **2026-06-13** — Wired three-workflow trigger chain in Orchestrator; area-onboarding now a live run.
  - Added `area-s6` ("Wait for HHAH to Upload (24h limit)") as the final step of `wf-area-onboarding`,
    with preReqs `[area-s2, area-s3, area-s5]` — the step that bridges to Trigger 2.
  - Added all `area.*` task implementations to `taskRegistry.js`; added area condition handling
    (`onboarding_successful`, `upload_received_within_24h`, `upload_missing_after_24h`,
    `notification_sent`) to `evaluateCondition`.
  - `seed.js` now creates a `wf-area-onboarding` workflow run (source label
    `area-onboarding:boise-ada-metro-intake`, idempotent) and runs its automation so it
    appears in the Orchestrator as a live running run, not a static panel.
  - Orchestrator rebuilt: removed `AreaIntakePanel` (static); replaced with `AreaIntakeSubPanel`
    embedded inside the `wf-area-onboarding` run card (area monitor data shows inside Trigger 1
    run). Added `TriggerChainConnector` (violet pill: "after end → Trigger N · Name") between
    groups. Runs are now rendered in chain order: `wf-area-onboarding` (T1) →
    `TriggerChainConnector(2, "HHAH Uploads Documents")` → `wf7` runs (T2) →
    `TriggerChainConnector(3, "Document Signing Follow-up")` → `wf-signing` runs (T3).
  DB reset + reseed applied.

- **2026-06-13** — Fixed Document Signing Follow-up trigger timing and bulk structure.
  Previously `startSigningRunsForWrittenOrders` was called immediately after `runWorkflowAutomation`
  in `start.js`, launching N separate `wf-signing` runs (one per order) before the
  `human.reviewRecord` step even ran. Fixed:
  - Removed `startSigningRunsForWrittenOrders` from `start.js` entirely.
  - Added `startBulkSigningRun(wf7RunId)` to `workflowEngine.js`: creates **one** `wf-signing`
    run (source label `signing-bulk:<runId>`, idempotent) with one item per written
    non-duplicate order, mirroring how wf7 is a bulk run.
  - The trigger fires inside `completeHumanTask` only when `task_key === 'human.reviewRecord'`
    AND all items in the wf7 run are completed/skipped — i.e. after every row has been reviewed.
  - Patient Unit + Patient Record are both created in `patient.create` (`wf7-s14`) via
    `writePatientBundle`, which calls `writePatientUnit` first then inserts/upserts the
    Patient Record pointing at the unit. Step name already says "Create Patient Unit + Record".

- **2026-06-13** — DB reset (full wipe via `npm run db:reset` + `npm run db:seed`) and
  created `sample-3-artifacts/` with 4 targeted wf7 test scenarios:
  - **Carla Nguyen** (MRN-910) — SOC blank → exercises `human.fillAdmissionDates` branch.
  - **David Park** (MRN-920) — full happy path with 2 orders (O-9201, O-9202).
  - **Fatima Hassan** (MRN-930) — order O-9301 submitted twice → exercises `order.skipDuplicate`.
  - **Grace Kim** (MRN-940) — same unit (name+DOB+MRN), two rows with different PG
    ("Cascades Physician Group" then "Pacific Northwest Partners") → exercises `record.create`
    PG-change fork (new Patient Record under same Patient Unit).
  Files: `hhh_upload_set3.xlsx` (Sheet1 = 5 patient rows, Sheet2 = 7 order rows) +
  `hhh_order_pdfs_set3.zip` (6 PDFs: O-9101, O-9201, O-9202, O-9301, O-9401, O-9402).

- **2026-06-13** — Fixed wf7 execution gaps before push/deploy verification.
  Patient write now commits only the Patient Unit + Patient Record; `admission.resolve`
  writes/reuses the Admission after admission-date checks, and `episode.resolve`
  writes/reuses the Episode after episode-date checks. Upload rows now store matched
  PDF metadata (`extraction_payload.pdf`) so `order.checkFields` really validates
  the order-number/PDF match instead of inferring readiness from `order_key`. Skipped
  duplicate orders no longer start signing follow-up runs, same-run duplicate order
  inserts are conflict-safe, and signing follow-up startup is deduped/concurrent.
  Record-change branches now stay false unless the original Patient Unit exists.
  WorkBucket lifecycle now distinguishes a newly created Patient Record from a
  unit-only update.

- **2026-06-13** — Reordered wf7 to match `complex.drawio.svg` object sequence (26 steps).
  The flow is now **Patient (Unit+Record) → Admission → Episode → Order → Review**,
  with date checks folded INTO the admission/episode phases instead of running upfront.
  - Patient phase: `patient.resolve` (`wf7-s10`, "Check If Patient Exists" by Unit =
    name+DOB+MRN). NO → `patient.create` (`wf7-s14`, create Unit + Record). YES →
    `record.checkChanges` (`wf7-s11`) sub-decision: **con1** `record_context_changed`
    (HHAH/PG/practitioner changed) → `record.create` (`wf7-s30`, new Record under same
    Unit); **con2** `unit_only_changed` → `patient.update` (`wf7-s13`, update Unit).
  - Admission phase: `dates.checkAdmission` → `human.fillAdmissionDates` →
    `admission.resolve` (`wf7-s31`, reuse-by-SOC or create).
  - Episode phase: `dates.checkEpisode` → `human.fillEpisodeDates` → `episode.resolve`
    (`wf7-s32`, reuse/update-by-SOE/EOE or create-in-admission).
  - Order phase unchanged in shape: order-exists → `order.skipDuplicate` (skip+log, per
    earlier decision — NOT delete-the-row); else `order.checkFields` → `human.fixOrderFields`
    → `order.create`. Review step renamed to "Review Patient → Admission → Episode → Orders".
  - taskRegistry: `evaluatePatientExistence` now keys `patient_exists` on the **Unit**
    (the person), not the record; added `evaluateRecordChanges` for con1/con2. New
    conditions `record_context_changed` / `unit_only_changed`. `patient.create`,
    `record.create`, `patient.update` all call `runPatientWrite` (the bundle writes
    unit+record+admission+episode atomically; the resolve steps surface found-vs-created).
    Re-seeded wf7. (Verified end-to-end: unit→record→admission→episode created in order,
    PG change forks a new record under the same unit, duplicate order skipped.)

- **2026-06-13** — Builder/Orchestrator flowchart: task name no longer truncates (wider
  box, wraps); added an ⓘ info popover (id, actor, taskKey, description, "runs when"
  condition) to both `WorkflowFlowChart.jsx` StepBox and the new `Orchestrator.jsx`
  StepNode; wired `description` through `nodesFromWorkflow`/`nodesFromInstance`.

- **2026-06-13** — Clean-slate restructure of the object model + workflow + orchestrator.
  - **DB reset**: collapsed migrations 001/002/003 into a single fresh `001_core_intake.sql`.
    Added `npm run db:reset` (`scripts/migrate.js --reset` drops & recreates the public
    schema). Wiped Neon and re-migrated/seeded from scratch.
  - **Object model change**: `patient_units` is now keyed by `unit_key` (name|DOB|MRN, the
    stable identity). `patients` (the Patient **Record**) is now keyed by
    `record_context_key = unit_key | normalizeName(HHAH) | normalizeName(PG)` and carries
    `unit_id`, `hhah_name`, `pg_name`, `agency_id`, `pg_id`. A NEW patient record is created
    when the HHAH or PG changes for the same Unit; same context reuses the record. (Verified
    end-to-end: same context reuses, PG change forks a new record under the same Unit.)
  - **Order duplicate policy**: `writeOrderBundle` now SKIPS an order whose `order_number`
    already exists (returns `{order, skipped:true}`, existing order untouched) instead of
    ON CONFLICT DO UPDATE overwriting. Decision flag `order_skipped_duplicate`.
  - **wf7 reshaped** (23 steps): added `unit.resolve` (`wf7-s10`, Check/Create Patient Unit)
    and `record.resolve` (`wf7-s11`, Check/Create Patient Record) before patient write;
    renamed patient steps to Update/Create Patient **Record**; order-exists now routes to
    `order.skipDuplicate` (`wf7-s17`); the new-order path gained `order.checkFields`
    (`wf7-s28`, requires order fields + matched PDF) and `human.fixOrderFields` (`wf7-s29`)
    before `order.create`. New conditions: `unit_exists/unit_not_exists`,
    `order_fields_ready/order_fields_missing`. Trigger 3 (`wf-signing`) is live (seeded).
  - **`normalizers.js`**: added `unitKey()` and `recordContextKey(patient, reference)`.
  - **Orchestrator UI rebuilt** (`Orchestrator.jsx`): replaced the three legacy card
    renderers with one clean top-down flowchart per run (drawio-style: SYS/AI/HUMAN task
    boxes, amber rotated-square decision diamonds with YES/else arms). Each task node shows
    `(n)` = times the task ran, and human tasks show a pink `N to do` manual-backlog badge
    for stuck active tasks; the run header shows a run-level "manual to do" count. Dropped the
    `store`/`WorkflowFlowChart`/`dbRunToInstance` dependencies from this view.
  - **WorkBucket lifecycle strip** now shows Patient Unit / Patient Record / Admission /
    Episode / Order, with an `order = skipped` state for duplicates.

- **2026-06-13** — Added the revised three-trigger workflow shape. New DB workflow
  definitions: `wf-area-onboarding` starts from onboarding success and monitors daily HHAH
  uploads; `wf-signing` starts after order document readiness and handles readiness review,
  physician send, 48-hour signature check, signed-status update, and overdue email logging.
  wf7 no longer branches on PG/practitioner existence or creates/reviews those records;
  upload processing now confirms only HHAH/upload context before patient/order writes.

- **2026-06-13** — Added area-based intake orchestration. New migration
  `003_area_intake.sql` adds statistical areas, area-HHAH mappings, area intake checks,
  missing-upload notifications, and area/HHAH links on workflow runs/uploads. Seed now
  creates `Boise-Ada Metro Intake` with three expected HHAHs. Added `/api/area-intake`
  for status + simulated 24-hour checks. Upload starts accept area/HHAH scope.

- **2026-06-13** — Changed wf7 automation to process patient/order items concurrently
  instead of serially breaking on the first blocked item. Item status becomes `blocked`
  only for active human work; completing a human task resumes that item. Orchestrator now
  shows area intake status plus patient-parallel lanes and aggregate buckets for blocked
  patients, active AI/system/human tasks, and continuing patients. Trigger + HHH upload
  default to `Boise-Ada Metro Intake` / `Boise Home Health`.

- **2026-06-12** — Removed the duplicate visual Admission/Episode object boxes from wf7.
  `wf7-s22`/`wf7-s23` are no longer in the seeded workflow definition; admission/episode
  found-vs-created decisions are recorded during patient write, and the orchestrator now
  shows the admission-date and episode-date branches in that single object position before
  order create/update. Re-seeded wf7.

- **2026-06-12** — Fixed wf7 orchestrator branch semantics. Side branches now use the
  actual YES/NO truth value and actor instead of assuming every branch is `NO -> human`.
  Patient/order create-vs-update rows now render as decisions before the action
  (`patient_exists`: YES update, NO create; `order_exists`: YES update, NO create), and
  admission/episode readiness chips are hidden from the single object rows to avoid
  presenting them as extra if/else branches.

- **2026-06-12** — Renamed Admission/Episode display language to **Admission Object** and
  **Episode Object** across wf7 step names/descriptions, object lifecycle summaries, worker
  lifecycle strips, and the HHH patient flow.

- **2026-06-12** — Added explicit date fallbacks and eligibility visibility. wf7 now checks
  admission dates (`wf7-s24`) and episode dates (`wf7-s26`) before patient/admission writes;
  missing SOC routes to **Manually Add Admission Dates** (`wf7-s25`) and missing SOE/EOE
  routes to **Manually Add Episode Dates** (`wf7-s27`). Removed HHAH from object lifecycle
  summaries. Surfaced computed Eligible/Billable chips on HHH patient/order views and the
  standalone Orders view.

- **2026-06-12** — Reworked Admission/Episode steps + added live orchestrator. (1) wf7-s22/s23
  are now **Admission — reuse or create** / **Episode — reuse or create** (`admission.resolve`/
  `episode.resolve`): `findAdmission`(patient+SOC) and `findEpisode`(admission+SOE/EOE) detect
  pre-existence so the lifecycle shows found-vs-created. (2) Orchestrator now **live-polls every
  2.5s** (Live/Paused toggle, pauses when tab hidden, last-updated stamp) instead of manual
  refresh only. (3) Added a right-hand **Objects created/updated** panel aggregating lifecycle
  per object across all rows. Re-seeded wf7.

- **2026-06-12** — Added explicit **Create / Confirm Admission** (wf7-s22) and **Create / Confirm Episode** (wf7-s23) steps between patient write and order, so Admission and Episode appear as distinct workflow + lifecycle objects (flow: Patient → Admission → Episode → Order). New `admission.confirm`/`episode.confirm` tasks + `admission_ready`/`episode_ready` decisions (the bundle still writes them atomically; these confirm/surface them). Re-seeded wf7 (21 steps).

- **2026-06-12** — Removed the **Check HHAH** step (wf7-s10) and `refs.checkHhahByName` too. HHAH always comes from the login context, so neither check nor create is needed in the workflow. Rewired wf7-s12 preReq to the PG check/review; updated the Orchestrator row. Re-seeded wf7 (now 19 steps).

- **2026-06-12** — Removed the "Create HHAH" human task (wf7-s11) and `human.createHhah`. HHAH is always present via the HHAH login context, so it never needs manual creation. Kept Check HHAH; rewired wf7-s12 preReq; cleaned WorkBucket/Triggers/Orchestrator refs. Re-seeded wf7.

- **2026-06-12** — Implemented Lisa's data-model & workflow changes:
  - Migration `002_patient_unit_and_links.sql`: `patient_units` (stable base layer) +
    `patients.unit_id`; `patient_physician_groups` and `patient_practitioners` direct
    many-to-many links (0..* both sides, independent of admission); `orders.document_type`.
    Applied to Neon.
  - `repositories.js`: `writePatientUnit`, `linkPatientToPg`, `linkPatientToPractitioner`;
    `writePatientBundle`/`writeOrderBundle` now write the unit + direct links; episode
    reuse-or-create by SOE/EOE was already keyed; `computeEpisodeStatus` (eligible =
    485 + active F2F within 6mo of F2F order_date; billable = all orders signed);
    `getPatientTree`/`listPatients` surface `latest_episode_status`.
  - Workflow at that time: PG missing blocked the row for human review; later revised on
    2026-06-13 to remove PG/practitioner workflow gates entirely.
  - UI: `HhhLogin` shows episode + patient latest eligible/billable status; `WorkBucket`
    record card shows an object-lifecycle strip (found/missing/created/updated/in-review).

- **2026-06-12** — Render the AI extraction step as **AI** (not SYS). Added AI as a
  first-class actor in `StepNode` (violet tone + "AI" badge) and `WorkflowFlowChart`'s
  `StepBox`; added an `ActorBadge` helper for the "currently at" footer; split the legend
  into system / AI / human. The `wf7-s3` step already carried `actor:'ai'` in the DB —
  the renderers were collapsing it into SYS.
- **2026-06-12** — Added `docs/data-model.md`: the actual DB schema as the source of
  truth, with the corrected entity relationships and a list of class/object-diagram
  mismatches (Practice, Archived Admission, Patient UNIT, Insurance/Ancillaries don't
  exist in the DB).
- **2026-06-12** — Restored delete for workflow runs end-to-end. Added `DELETE
  /api/workflow-runs/[id]` (handler + `deleteWorkflowRun` repo fn — cascades to items/
  task runs, keeps created domain records), `deleteWorkflowRun` client in `workflowApi.js`,
  a Trash button on `DbBulkInstanceCard`, and wired the previously no-op `onDelete` stubs
  in `Orchestrator.jsx` to a real `handleDelete` (confirm + optimistic remove + refresh).
- **2026-06-12** — Orchestrator DB bulk view (`DbBulkInstanceCard`): replaced the inline
  condition chip with real if/else **decision diamonds**. Added `DecisionDiamond` and
  `NoArm` components; reworked `row()` so a SYS step forks via a diamond (YES continues
  down, NO → human fallback box). Rows without a fallback render as a single box.
- **2026-06-12** — Hardcoded credentials as fallbacks in `api/_lib/config.js`
  (`DATABASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `BLOB_READ_WRITE_TOKEN`) for personal
  Vercel testing; wired `db.js`, `gemini.js`, `blobStore.js`, `taskRegistry.js` to read
  from `config.js`. Secrets are committed to public git history — rotate before any real use.
- **2026-06-12** — Created this CLAUDE.md.
