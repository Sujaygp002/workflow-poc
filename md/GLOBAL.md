# Command Center — GLOBAL Reference (single-file distillation of the md/ tree)

> **What this file is:** the entire `md/` documentation tree compressed into one self-contained
> reference. Read this to understand the whole system; use the **Routing table** (§8) to jump to
> the ONE detailed doc for the area you're changing. Every claim here was verified against the
> code. If this file and the code ever disagree, **the code wins** — fix the doc.

---

## 1. What this system is

**Command Center** is a DB-backed workflow POC for home-health (HHH) patient + order intake.
An HHAH (home health agency) uploads an Excel workbook + order PDFs → a workflow run starts
(one item per row) → system/AI steps run automatically, conditions branch, human tasks land in
employee buckets → orders get sent to physicians → a PG (physician group) practitioner
bulk-signs them → a billing monitor raises eligibility/CPO issues.

**Stack:** Vite + React + Tailwind SPA (`src/`) · Vercel serverless functions (`api/`) ·
Neon/Postgres over the serverless HTTP driver (`db/migrations`) · Google Gemini (PDF field
extraction) · Vercel Blob (PDF storage, optional) · nodemailer (best-effort email, never throws).

**Four surfaces** (all logins are single-factor username+password):

| Surface | Path | Auth |
|---|---|---|
| Command Center admin SPA (Builder, Orchestrator, Coverage Map, Employees, Entity, External Users) | `/` | **NONE — intentionally unauthenticated POC surface** |
| Worker portal (three task buckets) | `/worker` | employee session (`cc_worker_token`) |
| HHAH portal (bulk upload, scoped patient/order views) | `/hhh-login` | external session, `user_type='hhah'` (`cc_hhah_token`) |
| PG portal (admin = Coming-soon dashboard; practitioner = Bulk Sign) | `/pg-login` | external session, `user_type='pg'` (`cc_pg_token`) |

**Deploy story:** GitHub repo `Sujaygp002/workflow-poc`, auto-deploys `main` to Vercel (Hobby
plan). DB is Neon. `vite.config.js` also supports a GitHub Pages target (`DEPLOY_TARGET=pages`
switches `base` to `/workflow-poc/`). `npm run dev` serves the frontend only — `/api/*` needs
the Vercel runtime + DB, so verify backend changes with `npm run lint` + `npm run build` and
the deployed app.

**The four seeded system workflows (triggers T1–T4):**
- **T1 `wf-area-onboarding`** — HHAH upload monitor (time_interval label, 10s).
- **T2 `wf7`** — the intake pipeline: 26 steps, 5 phases (Intake → Patient → Admission → Episode → Order + Review). Fired by HHAH upload.
- **T3 `wf-signing`** — signing follow-up; ONE run per wf7 run, created only after every row is reviewed.
- **T4 `wf-billing-monitor`** — eligibility/CPO issue monitor; one run per HHAH, driven by the Orchestrator poll (see §7 caveats).

**Builder workflow (user-created, not seeded):**
- **Daily Agency Intake → RCM Pipeline** — `daily_time` trigger; one item per active agency per day; chain: `check_agency_upload` → [not uploaded: human outreach (call/sms/email)] → [uploaded: `ai_extract_with_patterns` → `run_ai_service` → `generate_rcm` → `run_ai_audit` → [audit failed: `run_ai_rework`]]; saved to DB as `kind='builder'` via the no-code builder UI. Graph preserved at `docs/daily-rcm-workflow.graph.json`.

---

## 2. Architecture in one screen

```
index.html ──► App (admin SPA, sidebar)          src/pages/{builder,orchestrator,map,
worker.html ─► WorkerApp (standalone portal)       employees,entity,external,hhh,pg,worker}
      │                                          src/lib/workflowApi.js + authApi.js
      ▼            (ALL /api/* fetches go through these two libs — pages never fetch directly)
api/  — EXACTLY 12 serverless functions (Vercel Hobby cap; new capability = a new
        POST `action` dispatched on an EXISTING handler, never a new api/ file):
  auth/index.js                    logins, employee + external-user CRUD, session echo
  workflows/index.js               saveWorkflow / deleteWorkflow / catalog (builder palette)
  workflows/bulk-upload/start.js   the ONE ingestion endpoint (multipart or JSON)
  workflow-runs/index.js           list runs · startWorkflow / tick / runBillingMonitor
  workflow-runs/[id].js            single run detail · DELETE run
  work-items/index.js              worker buckets · open (claim) a task
  work-items/[taskRunId]/complete.js  complete a human task (validation-retry aware)
  patients/index.js · patients/[id].js · orders/index.js · reference-data/index.js
  area-intake/index.js             area/HHAH upload-status feed
api/_lib/  — shared server code (no ORM, no framework):
  config.js (env + hardcoded fallbacks) · db.js (Neon client) · http.js (httpError/handleError)
  auth.js (scrypt, sessions; TOTP helpers legacy/unused) · identityRepo.js (identity SQL)
  repositories.js (ALL domain SQL + business logic) · normalizers.js (identity/dedup keys)
  excelParser.js (workbook → joined rows) · multipart.js · mailer.js · gemini.js · blobStore.js
  workflowDefinition.js (4 system defs) · workflowEngine.js (the engine)
  taskRegistry.js (taskKey → fn; condition evaluation) · builderCatalog.js · builderCompiler.js
  referenceLogic/  — agencyCheck.js · extraction.js · aiService.js · rcm.js · audit.js · rework.js
                    · businessRules.js (pure utility library: isFilled, isPatientDataComplete,
                      carryForwardEpisodeDiagnoses, evaluateCpoMonthReadiness, pgBillableMinutes,
                      derivePatientStatus, deriveFilterStatus — ported from
                      BusinessRequirementsService.cs HANDOFF §1.2; no taskKey, no DB access)
                    (Daily Agency Intake → RCM Pipeline; ported from reference/ HANDOFF §1.1–§1.5;
                     NO Azure/OpenAI keys — all LLM via gemini.js)
db/migrations/  — 001_core_intake.sql · 002_cpo_billing_monitor.sql · 003_identity_and_builder.sql
                  004_rcm_pipeline.sql (rcm_records + audit_records)
```

**DB shape (migration 001 = full core model, 002 = CPO/billing snapshots, 003 = identity + builder):**
domain: `patient_units` → `patients` (records) → `patient_admissions` → `patient_episodes` →
`orders`, plus `home_health_agencies`, `physician_groups`, `practitioners`, CPO month rows,
area-intake tables. Engine runtime: `workflow_definitions` → `workflow_runs` →
`workflow_items` → `workflow_task_runs`. Identity: `employees`, `external_users`,
`auth_sessions`. Migrations must stay **additive & idempotent** (`CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`); `db:wipe` TRUNCATEs data but preserves schema + `schema_migrations`;
`db:reset` drops and recreates the schema.

---

## 3. The workflow engine

Runtime hierarchy: **`workflow_runs` → `workflow_items` (one per upload row / issue) →
`workflow_task_runs` (one per step per item)**. The engine executes the **DB row** of a
definition, not the JS constant — after editing `workflowDefinition.js`, run `npm run db:seed`.

- A step becomes runnable when **`prereqsSatisfied`** (every preReq step is `completed` **OR
  `skipped`** — skipped-counts-as-done) AND its condition passes.
- **`evaluateCondition(condition, item)`**: `null` → true; a cached `item.decisions[condition]`
  flag wins; otherwise it lazily evaluates and **persists** the decision (re-running the check
  task is the only way to flip a cached decision); an **unknown condition → false** and the step
  is silently skipped. Skipped steps are terminal — they never revive.
- **System/AI steps** execute immediately via `taskRegistry[step.taskKey]` — an async fn
  `({item, step, task, context, payload}) → {ok, output?, error?, retry?, waiting?}`.
  `ok:false` fails the item and aborts its loop. **Human steps** flip to `active` and mark the
  item `blocked` until an employee completes them.
- **`completeHumanTask`**: if the handler returns `retry:true`, it throws HTTP 400 with
  `actionErrors` and the task **stays active** — the validation-retry rule. Human checklist
  actions are **all-or-nothing**: every action's `validate` must pass before any `execute` runs.
- Items run **concurrently and independently** (`runWorkflowAutomation`, batches of 10), then
  the run status rolls up. Both branches of an exclusive fork must appear in the join step's
  preReq list, or items taking the skipped branch **deadlock**.
- `startWorkflow` with zero items still creates one empty item so system steps can evaluate.
- **T3 chaining:** `startBulkSigningRun` fires only inside `completeHumanTask` for
  `task_key='human.reviewRecord'`, only when every item in the wf7 run is completed or has
  `orderSkipped`; idempotent via source label `signing-bulk:<wf7RunId>`. One signing item per
  distinct non-duplicate order; if the order's PDF came from the **signed ZIP**, the signing
  item's `order_status` is pre-stamped signed so the overdue-reminder branch is skipped.
  **A failed item blocks T3 permanently for that run.**
- **AI never fails an item:** `ai.extractMissingDataFromPdf` always returns `ok:true` — AI
  failure is the `ai_extraction_fail` **branch**, not a failure. `mergeDeep` drops
  undefined/null/'' patch values, so no AI or human patch can blank an existing field.
  `guardSessionHhah` strips HHAH from AI/human patches when the upload was session-stamped.
- 13 dotted-path `REQUIRED_FIELDS` (5 patient, 4 date incl. `HHAH.name`, 3 order) drive
  row_complete/incomplete and the AI extraction prompt.

**Deletion semantics:** `DELETE /api/workflow-runs/[id]` cascades to items/task-runs via FK but
**leaves created domain records (patients, orders) intact**.

---

## 4. The no-code builder

Builder workflows are a visual graph — **one trigger + system-action / task(-of-human-actions) /
condition nodes** — stored as editable JSON and **compiled server-side** (`builderCompiler.js`)
into the exact same engine `steps[]` shape system workflows use.

- `validateGraph(graph) → string[]` (empty = valid); `compileGraph` throws `httpError(400)` on an
  invalid graph. Unknown actionKey/conditionKey/kind are validation errors; the valid-key source
  of truth is `builderCatalog.js`.
- A **condition node emits no step**: it stamps condition/negation onto branch-head steps and
  merges branch tails into the join step's preReq. `join` defaults to the stop node when absent;
  a top-level branch with no join ends as `null`.
- **Palette** (`builderCatalog()` strips server-only `taskKey/validate/execute` before sending):
  3 triggers · 13 system actions (only `ai_extract_pdf_fields` is actor `'ai'`) · 9 human
  checklist actions (each with server-side validate + optional async execute) · 18 condition
  keys (9 negation pairs — each must also be handled by `taskRegistry.evaluateCondition` or it
  evaluates false at runtime).
- **Triggers:**
  - `document_upload` — an HHAH upload routes to **every** active builder workflow with this
    trigger; falls back to system wf7 only if none are active. Multiple active document_upload
    workflows are allowed (the UI warns; the server does not block).
  - `manual` — the Run button (`startWorkflow`).
  - `time_interval` — compiles (min 5s enforced at validate AND clamped at run time), and the
    `tick` action exists on `/api/workflow-runs`… **but nothing in the app calls it** (see §7).
- **Versioning:** re-saving creates version N+1 as the single active version (deactivate-then-
  upsert, ordered around the `workflow_definitions_one_active` unique constraint); old versions
  are retained for pinned runs. Delete is a builder-only **soft delete** (active=false). System
  workflows (`kind !== 'builder'`) 400 on both save and delete, and `ensureSystemDefinitions()`
  re-upserts any missing system definition on every `GET /api/workflows`.
- **Client side:** `WorkflowBuilder.jsx` edits a nested sequence model; `seqToGraph`/`graphToSeq`
  must stay symmetric. `compilePreview` is a client-side mirror for live preview only — **not
  authoritative**; after save, the server's compiled `steps` replaces it.

**Worker buckets** (derived from `workflow_task_runs`, all filtered `actor='human'`):
**Untouched** = active + `opened_at IS NULL` + (assigned to me OR unassigned) ·
**Processing** = active + opened + mine · **Done** = completed + mine. Opening claims the task
(sets `opened_at` + `assigned_employee_id` atomically, idempotent, one-way); completing an
unclaimed task auto-claims it; completing someone else's task → 403; a validation failure →
400 `{actionErrors}` and the task stays in Processing.

---

## 5. Business rules

### Patient identity: Unit vs Record
- A **Patient UNIT** is the human: identified by `unit_key` = name+DOB+MRN. Same three values =
  same person regardless of agency or PG. (`unitKey === patientKey` by definition.)
- A **Patient RECORD** is the care context: Unit + HHAH + PG, keyed by `record_context_key`.
  **A different HHAH or PG forks a new Record under the same Unit.**
- **Canonical key formulas live ONLY in [backend/lib/utils.md](backend/lib/utils.md)**
  (from `api/_lib/normalizers.js`) — do not restate them anywhere, cross-reference.
- Hierarchy: Patient Unit → Patient Record(s) → Admission(s) → Episode(s) → Order(s); the
  workflow decides create-vs-reuse at each level. `evaluateRecordChanges`:
  `record_context_changed=true` = unit exists but no record for this context (fork a record);
  `unit_only_changed=true` = record found (update unit); unit doesn't exist → neither branch.
- `patients.latest_episode_status` is a denormalized cache; source of truth is
  `patient_episodes.status`.

### Dedup
- Admissions: `UNIQUE(patient_id, soc, eoc)`; Episodes: `UNIQUE(admission_id, soe, eoe)` —
  end-dates are part of the key.
- Orders are unique by `order_number`; `writeOrderBundle` returns `{skipped:true}` on conflict —
  **duplicate = skip, never overwrite**.

### Intake (T2, wf7)
One HHAH-portal upload = one run per target workflow (system wf7 or active builder
document_upload workflows). `stampSessionAgency` overwrites every item's `referencePayload.HHAH`
with the **session user's agency** — the workbook agency column is always overridden and cannot
be reassigned downstream. PDFs match orders by filename `<order_number>.pdf`; unsigned and
signed ZIPs are separate uploads, and the `signed` flag travels with the item into the signing
run. An order needs both fields-ready AND a matched PDF before `order.create`; missing fields
route to `human.fixOrderFields`.

### Signing (T3)
Sent → signed is a two-step lifecycle: `markOrderSentToPhysician`, then
`markOrderSignedByPhysician` / `bulkSignOrders`. Bulk sign is PG-practitioner-scoped: `pgId`
comes from the **session**, never the request body; only orders marked sent AND unsigned appear
in `listPgUnsignedOrders`. Known asymmetry: `send_email_to_physician` stamps sent-to-physician
only when `extraction_payload.orderId` exists, while `mark_order_sent` also falls back to
`order_number` — an email action on an item without a prior Create-order step sends mail but
never stamps the order.

### Eligibility & billing (T4)
Episode status ladder **started → eligible → billable**:
- **eligible** = episode has a 485 order + an admission-level F2F whose `order_date` is 0–180
  days before the episode EOE (signatures irrelevant);
- **billable** = eligible + **all** episode orders signed (`computeEpisodeAssessment`).
- A **CPO month** row exists for every calendar month in SOE..EOE (even non-billable episodes);
  it becomes billable only when the episode is billable AND `cpo_min >= 30`.
- The billing monitor runs **one run per HHAH**; new issues for an HHAH with an active run are
  **appended** (`appendIssuesToRun`), not new runs. Issue dedup is permanent per signature
  (`missing-docs:<episodeId>`, `signature:<episodeId>`, `cpo:<cpoMonthId>`) — a completed issue
  never re-raises unless the run is deleted.
- **Cadence is frontend-driven**: the Orchestrator POSTs `runBillingMonitor` every 10s while
  Live and the tab is visible. The definition's `intervalSeconds:10` is a **label only** —
  nothing server-side ticks T4.

### Dates (load-bearing)
Neon returns dates as `Date` objects. All date math must go through `parseDate` / `dateOnly` /
`dateMs` — naive `String(value).slice(0,10)` produces `NaN` and has historically silently broken
eligibility and CPO month generation. Never string-slice a date.

---

## 6. Auth model

- **Worker login is SINGLE-FACTOR** (username + password). `workerLogin` returns
  `{token, employee}` and mints a `'complete'`-stage session immediately — there is **no TOTP
  step and no `workerTotp` action**. TOTP helpers in `api/_lib/auth.js` (`generateTotpSecret`,
  `verifyTotp`, `otpauthUrl`, …) are **legacy and unused at login**; `generateTotpSecret` is
  still called by `createEmployee` only to satisfy the NOT NULL `employees.totp_secret` column,
  and the secret is never returned to the caller nor verified anywhere.
- **External login** is single-factor and type-gated: `externalLogin` with `user_type='hhah'`
  (HHAH portal) or `'pg'` (PG portal). PG users have two roles: `admin` (placeholder dashboard)
  and `practitioner` (Bulk Sign; creation requires an NPI matching an existing practitioner —
  the server re-verifies, the client-side NPI filter is UX only).
- **Portal scope comes from the session, never the client**: uploads are stamped with the
  authenticated agency; bulk sign uses the session's `pgId`. Wrong-portal logins are actively
  discarded (LoginPanel stores the token, then calls `logout(scope)` to kill the session).
- **Sessions:** raw bearer tokens are never stored — only sha256 hashes in
  `auth_sessions.token_hash`. `requireSession` demands `stage='complete'`, 401s inactive
  principals even with a valid unexpired token, and lazily sweeps expired rows on every call
  (no cron). `auth_sessions.principal_id` has no FK — deleting a principal orphans sessions,
  which then 401 on the principal fetch. Tokens live in `sessionStorage` under per-surface keys
  `cc_worker_token` / `cc_hhah_token` / `cc_pg_token` (both external portals can coexist).
- **Only three route surfaces enforce auth:** the two work-items routes
  (`requireSession({type:'employee'})`), bulk-upload/start (external hhah session), and
  `bulkSign` on `/api/orders` (external pg + role practitioner). Everything else — admin CRUD in
  `/api/auth`, `/api/workflows`, `/api/workflow-runs`, reference-data writes, patient/order
  reads — is **intentionally unauthenticated** (POC): anyone who can reach the app can mint
  accounts. The only password rule in the system: `hashPassword` throws 400 for passwords under
  8 chars. Username normalization (`trim().toLowerCase()`) is applied symmetrically at create
  and lookup — any new lookup path must do the same.

---

## 7. Conventions & gotchas

- **Hardcoded credential fallbacks:** every credential in `api/_lib/config.js` is
  `process.env.X || '<literal>'` — live secrets are in public git history and **must be rotated
  before real use**. Vercel env vars override. Do not move secrets without asking.
- **12-function cap:** `api/` is at exactly 12 serverless files (Vercel Hobby). New capability =
  a POST `action` on an existing handler, never a new file.
- **`tick` now has two callers:** (a) the Orchestrator 10s poll calls `tickTimeTriggers()` (POST
  `{action:'tick'}`) alongside `runBillingMonitor`, so `time_interval` and `daily_time` builder
  workflows fire while the tab is open; (b) a Vercel cron (`GET /api/workflow-runs?action=tick`,
  schedule `0 17 * * *`) covers the server-only path daily. The previous caveat ("nothing calls
  tick") is resolved. T4 (`runBillingMonitor`) still only fires while the Orchestrator tab is open.
- **wf7 stepId quirks:** step ids are intentionally non-contiguous (`wf7-s22`/`s23` retired;
  `s30`–`s32` added later). **Never renumber ids** — they're referenced everywhere.
- **`order_status` misspelling:** the jsonb key `SignedByPhyscianDate` is misspelled in data —
  match it exactly; do not fix without a migration.
- **Flowchart actor colors** (must be matched by any new node type): system = sky, AI = violet,
  human = pink, conditions = amber. `WorkflowDefinitionFlow.jsx` is the SINGLE shared renderer
  (Orchestrator, Workflow list, builder preview); `megaTask`/`megaGroups` are pure presentation
  with zero engine effect, and `megaGroups[].stepIds` must list EVERY step id in the group or
  steps silently vanish from the chart.
- **Frontend fetch discipline:** all `/api/*` calls go through `workflowApi.js`/`authApi.js`.
  The error contract is load-bearing: `error.actionErrors` (complete 400), `error.messages`
  (saveWorkflow validation), `error.status` (401 handling). Several exports
  (`tickTimeTriggers`, `fetchWorkItems`, `dbRunToInstance`, …) currently have no callers.
- **Two Vite entries** (`index.html`, `worker.html`); a new HTML entry must be registered in
  `vite.config.js` `rollupOptions.input` AND `vercel.json` rewrites. AppShell hides the sidebar
  for `/hhh-login`, `/pg-login`, `/worker`. Dev-only quirk: vite dev has no rewrites, so
  `/worker` renders via App's inline route locally; on Vercel the rewrite loads `worker.html`.
- **bulk-upload `bodyParser` is disabled** (`export const config`) — required for multipart
  streaming; do not remove.
- **Run-list feed is batched:** `GET /api/workflow-runs` uses one `listTaskRunsForRuns` query
  (slim columns, no payload blobs) grouped in memory — keep it that way (was a 3-minute N+1).
- **Coverage Map:** agency balls come ONLY from Entity-page reference agencies; edges whose
  `hhah_name` has no reference match are dropped. PG↔practitioner mapping lives in
  `physician_groups.contact_info.physician_ids[]`.
- **After any code change:** update the CLAUDE.md Change Log (newest first) AND the ONE `md/`
  doc whose area changed. Docs reference file paths + function names, never line numbers.

---

## 8. Routing table — topic → the ONE detailed doc

| Topic | Doc |
|---|---|
| Upload → run → items → tasks → signing chain (the pipeline story) | [business/intake-pipeline.md](business/intake-pipeline.md) |
| Unit/Record identity, admission/episode reuse, PG-change fork | [business/patient-model.md](business/patient-model.md) |
| Order lifecycle, dedup, sent→signed, bulk sign | [business/orders-and-signing.md](business/orders-and-signing.md) |
| Eligible/billable, CPO months, billing monitor (T4) | [business/eligibility-billing.md](business/eligibility-billing.md) |
| Builder graph JSON, triggers, bucket lifecycle, validation-retry | [business/builder-workflows.md](business/builder-workflows.md) |
| Who can log in where, roles, portal scoping (policy view) | [business/auth-model.md](business/auth-model.md) |
| Password hashing, sessions, auth guards, (legacy) TOTP helpers | [backend/lib/auth.md](backend/lib/auth.md) |
| Employee / external-user / session SQL | [backend/lib/identity-repo.md](backend/lib/identity-repo.md) |
| Trigger/action/condition palette; add a system or human action | [backend/lib/builder-catalog.md](backend/lib/builder-catalog.md) |
| Graph → engine steps compilation, branch/join rules | [backend/lib/builder-compiler.md](backend/lib/builder-compiler.md) |
| taskKey handlers, evaluateCondition, REQUIRED_FIELDS, mergeDeep | [backend/lib/task-registry.md](backend/lib/task-registry.md) |
| Engine loop, task activation, completeHumanTask, bulk-signing chain | [backend/lib/workflow-engine.md](backend/lib/workflow-engine.md) |
| The four system workflow definitions (wf7 steps, megaGroups) | [backend/lib/workflow-definitions.md](backend/lib/workflow-definitions.md) |
| Any domain SQL / repository function | [backend/lib/repositories.md](backend/lib/repositories.md) |
| Config, Neon client, http helpers, mailer, Gemini, blob, multipart, normalizers (**canonical key formulas**), excelParser | [backend/lib/utils.md](backend/lib/utils.md) |
| Daily Agency Intake → RCM Pipeline modules (agency upload check, AI extraction, CC-note/CPO AI service, RCM CPT billing records, audit R1–R4, rework auto-fix; `businessRules.js` pure utility library ported from BusinessRequirementsService.cs) | [backend/lib/reference-logic.md](backend/lib/reference-logic.md) |
| `/api/auth` route (logins, identity CRUD, session echo) | [backend/routes/auth.md](backend/routes/auth.md) |
| `/api/workflows` route (save/delete/catalog) | [backend/routes/workflows.md](backend/routes/workflows.md) |
| `/api/workflow-runs` routes (feed, startWorkflow/tick/runBillingMonitor, delete) | [backend/routes/workflow-runs.md](backend/routes/workflow-runs.md) |
| `/api/work-items` routes (buckets, open, complete) | [backend/routes/work-items.md](backend/routes/work-items.md) |
| The upload endpoint (auth, multipart, target workflows) | [backend/routes/bulk-upload.md](backend/routes/bulk-upload.md) |
| Patients/orders/reference-data/area reads, entity creation, bulk sign | [backend/routes/data-reads.md](backend/routes/data-reads.md) |
| Entries, routing, sidebar, worker entry, vercel.json rewrites | [frontend/app-shell.md](frontend/app-shell.md) |
| Client API contracts, token storage, error contract | [frontend/lib.md](frontend/lib.md) |
| Shared flowchart renderer + shared components | [frontend/components.md](frontend/components.md) |
| Workflow builder UI + workflow list | [frontend/pages/builder.md](frontend/pages/builder.md) |
| Worker portal UI (login, buckets, task detail) | [frontend/pages/worker.md](frontend/pages/worker.md) |
| Employees / Entity / External Users admin pages | [frontend/pages/admin.md](frontend/pages/admin.md) |
| HHAH + PG portal UIs | [frontend/pages/portals.md](frontend/pages/portals.md) |
| Orchestrator + Coverage Map | [frontend/pages/monitoring.md](frontend/pages/monitoring.md) |
| Every table, column, FK; writing a migration | [db/schema.md](db/schema.md) |
| npm/DB scripts, deploy, env/credentials, the 12-function cap | [ops/scripts-and-deploy.md](ops/scripts-and-deploy.md) |

Entry point / router for AI sessions: [main.md](main.md) — route to ONE doc, read only the
source files it names.

---

## 9. Also see

- **`CLAUDE.md`** (repo root) — authoritative for repo **Layout**, **Conventions**, and the
  dated **Change Log** (newest first; add an entry for every change). **This GLOBAL.md must not
  drift from CLAUDE.md** — if they conflict on layout/conventions, CLAUDE.md wins and this file
  gets fixed. (Note: CLAUDE.md's older prose still mentions worker TOTP 2FA; the code — and
  §6 above — is single-factor.)
- **`ChatGPT.md`** (repo root) — **legacy/stale**, references removed credentials and dummy
  users; superseded by the `md/` tree + CLAUDE.md. Do not rely on it.
- The user guide PDF / demo video document the product for humans; `md/` documents the code
  for AI.
