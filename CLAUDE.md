
# CLAUDE.md

Guidance for Claude Code when working in this repo. Keep the **Change Log** at the
bottom updated after every change (newest first).

## Project

**Command Center** (v2) — DB-backed workflow POC for HHH patient + order intake. A
Vite/React frontend with Vercel serverless API routes backed by Neon/Postgres, Gemini
for PDF data extraction, and Vercel Blob for PDF storage. The admin SPA ("Command
Center") hosts a no-code workflow builder, orchestrator, coverage map, and identity
admin (Employees / Entity / External Users); separate standalone surfaces are the
worker portal (`/worker`, password + TOTP 2FA) and the external HHAH/PG portals
(`/hhh-login`, `/pg-login`, username/password sessions).

- **Frontend**: Vite + React + Tailwind (`src/`); two entries: `index.html` (Command
  Center shell) and `worker.html` (worker portal).
- **API**: Vercel serverless functions (`api/`) — exactly 12 (Hobby cap); new
  capability is added as POST `action` dispatch on existing handlers.
- **DB**: Neon/Postgres (`db/migrations`); migration `003_identity_and_builder.sql`
  adds employees, external_users, auth_sessions, builder-workflow + bucket columns.
- **Auth**: dependency-free in `api/_lib/auth.js` — scrypt password hashes, TOTP
  (RFC 6238) via node `crypto`, bearer sessions hashed into `auth_sessions`.
  Employees log into `/worker` with password + 6-digit TOTP (secret shown ONCE at
  creation); external users log into the portals with username/password.
- **IMPORTANT (POC note)**: the Command Center admin pages (Employees, Entity,
  External Users, Workflow builder) are intentionally UNAUTHENTICATED POC surfaces —
  anyone who can reach the app can mint accounts. Only the worker portal and the
  external portals enforce auth.
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
| `npm run db:wipe` | TRUNCATE all data tables, keep schema (`scripts/wipe.js`) |

Verify changes with `npm run lint` + `npm run build`. The live orchestrator/API
cannot be exercised by `vite dev` alone (serverless functions need the Vercel
runtime and DB), so prefer build/lint for verification.

## Layout

- `api/_lib/` — shared server code: `config.js` (env/credentials), `db.js` (Neon
  client), `gemini.js` (PDF extraction), `blobStore.js` (PDF upload), `taskRegistry.js`
  (per-step task logic incl. `human.performActions`), `workflowEngine.js`,
  `workflowDefinition.js` (system workflow defs), `repositories.js`, plus the v2
  identity/builder seams: `auth.js` (scrypt + TOTP + sessions), `identityRepo.js`
  (employees/external users/sessions SQL), `builderCatalog.js` (trigger/action/
  condition palette), `builderCompiler.js` (graph → engine `steps` compile + validate).
- `api/<resource>/` — route handlers (auth, orders, patients, reference-data,
  work-items, workflow-runs, workflows/bulk-upload, area-intake). `api/auth/index.js`
  is the identity domain (logins, TOTP, employee + external-user CRUD, sessions).
- `src/App.jsx` — the Command Center shell. Nav: Workflow (`/builder/workflows`),
  Orchestrator, Coverage Map, Employees, Entity, External Users; footer link opens the
  Worker Portal. `/` redirects to `/builder/workflows`. `/hhh-login`, `/pg-login`,
  `/worker` render standalone (no sidebar). `src/WorkerApp.jsx` + `worker.html` are a
  second Vite entry that mounts the same `WorkerPortal`.
- `src/pages/builder/` — `WorkflowList.jsx` (definition cards, System vs Builder kind
  badges, Run/Edit/Delete for builder workflows) + `WorkflowBuilder.jsx` (vertical
  n8n-like editor: trigger picker, system/task/condition node cards, live compiled
  preview via the shared flowchart renderer).
- `src/pages/worker/` — `WorkerPortal.jsx` (password → TOTP login, Untouched |
  Processing | Done buckets, 5s poll) + `WorkerTaskDetail.jsx` (context panel + action
  checklist; legacy system-workflow tasks reuse the ported WorkBucket input panels).
- `src/pages/employees/Employees.jsx`, `src/pages/entity/Entity.jsx`,
  `src/pages/external/ExternalUsers.jsx` — identity/entity admin (unauthenticated POC
  surfaces, see Project note).
- `src/pages/hhh/HhhLogin.jsx` / `src/pages/pg/PgLogin.jsx` — external portals
  (session-scoped via `externalLogin`; HHAH upload portal, PG admin dashboard /
  practitioner Bulk Sign).
- `src/pages/orchestrator/Orchestrator.jsx` — workflow run visualization. Renders each
  run with the shared flowchart components from `WorkflowDefinitionFlow.jsx`
  (`MegaGroupFlow` for `megaGroups` definitions, `MegaTaskNode` for `megaTask`, else
  `WorkflowFlow`). Its live poll also drives `runBillingMonitor` and the builder
  `tick` action (time-interval triggers).
- `src/components/WorkflowDefinitionFlow.jsx` — the shared flowchart renderer (step
  boxes, decision diamonds, mega-task boxes, trigger-chain connectors) used by the
  Orchestrator, the Workflows page, and the builder preview.
- `src/lib/` — `workflowApi.js` (data + builder + bucket clients) and `authApi.js`
  (logins, session helpers, employee/external-user CRUD; bearer tokens in
  `sessionStorage`: `cc_worker_token`, `cc_hhah_token`, `cc_pg_token`).
- `src/pages/map/` — the Coverage Map (`/map`): `NetworkMap.jsx` (SVG graph engine) +
  `graph.js` (client-side join over the patients/orders/reference feeds).
- `public/sample-4-artifacts/` — demo upload fixtures (xlsx + unsigned/signed PDF
  ZIPs; `README.md` maps each row to its test scenario). No longer auto-preloaded by
  the HHAH portal — download/use manually.

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
  truth. See `DecisionDiamond` / `BranchArm` in `WorkflowDefinitionFlow.jsx`.
- Match surrounding Tailwind/style idiom. Actor coloring: system = sky/blue, human = pink,
  conditions = amber.

## Change Log

Newest first. Add an entry for each change made by Claude Code.

- **2026-07-11** — **CCN tail de-duplicated (single Create CCN → Submit claim) + group renamed.**
  The billing gates were an eligible/not-eligible FORK whose two arms (eligible + signature-passed)
  each carried their own make_billable → Create CCN → Submit claim tail (a/b idempotent twins) — the
  builder compiler cannot converge two differently-conditioned branch-walks on one node, so the tail
  showed twice. Fixed by making the gates LINEAR: `check_episode_eligibility` (n9, now informational)
  flows straight into check-documents → check-patient-data → check-signature; each failing gate
  branches to its own terminal (t6 outreach / t7 fill / t8 system auto-send), and the all-pass path
  (c10 signature_exists TRUE) falls through to a SINGLE `make_billable_claimable` (n10) → `Create CCN`
  (t9) → `Submit claim` (t11). Dropped c7/n10a/t9b/t11b. Behavior note: an eligible episode with
  incomplete demographics now routes to Get-and-fill-patient-data instead of billing directly (more
  correct; and the demo data mostly hits the docs-missing gate anyway, so no demo-flow change).
  Group `g-ccn-audit` renamed **"CCN, Audit & Submit Claim" → "CCN, Submit Claim"** (nodeIds [t9,t11]).
  Compiles to 22 steps; published live as def cc-1783522521545 **v3** (verified: make_billable/Create
  CCN/Submit claim each appear exactly once, twin ids gone, episode_eligible fork gone). Pure graph
  change — no code/redeploy needed.

- **2026-07-11** — **Worker task UX overhaul (per-type LHS/RHS layouts), review-failed restart,
  real Create-CCN, system auto-send-to-portal, entity edit, PG portal Patients tab, builder
  editor polish; def rewired to Create CCN → Submit claim.**
  - **Worker task layouts** (`WorkerTaskDetail.jsx` rewritten): per-task-kind layouts —
    *Extract & fill*: LHS order PDF (+ confirm-document checkbox), RHS the FULL create-patient/
    order form (`FULL_FORM_SECTIONS`, prefilled, missing fields highlighted, incl. new order
    fields CPO minutes / justification title / justification note → `order_payload.order_status`).
    *Enter admission/episode dates*: LHS order PDF, RHS date box. *Review record*: LHS the
    patient's real DB orders (`payload.patientOrders`), RHS the full patient object module
    (`payload.patientTree` → shared `PatientHierarchyView`), note + **Review passed / Review
    failed** buttons. *Get missing documents*: same agency-outreach layout as the contact task
    (graph t6 actions now call/sms/email). *Get & fill patient data*: LHS patient module with
    missing-field highlights + editor, RHS the patient's orders. *Create CCN*: LHS patient module
    (episode + existing CC notes), RHS the CCN form (note title / note text / note type
    [Preventive Care|Safety|Goals|Medications] / CPO minutes / month). Done-bucket raw
    `key: value` output chips replaced by plain-language `ActionOutcome` sentences
    (`describeActionOutput`); raw actionKey chips removed from action cards.
  - **Review failed ⇒ restart from top**: `review_record` action now takes
    `{outcome:'passed'|'failed', note}` (legacy `{approved:true}` still accepted).
    `human.performActions` surfaces `restartItem`; `completeHumanTask` calls new
    `repositories.restartItemFromTop` — resets every task row of the item to pending, clears
    `decisions` (conditions re-derive; patient/order/admission/episode existence checks are
    live-computed), stamps `extraction_payload.reviewRestarts[{at,note}]`, item back to running,
    then the automation re-walks from step 1 (idempotent writes; second pass takes order_exists
    → skip-duplicate).
  - **Create CCN is real** (`repositories.createManualCcnNote`): upserts the episode's
    `cpo_months` row for the chosen month (default: episode SOE month), appends the note to
    `reason.ccNotes` tagged `generated_by:'human'` (never physician-signed), adds the minutes to
    `cpo_min` and re-derives billable status. **Bugfix**: `updateCpoMinutes` now MERGES `reason`
    instead of replacing it (it used to clobber stored ccNotes). `PatientHierarchyView` renders a
    violet **CC Notes (CCN)** section inside each live episode (title/type/minutes/month/text +
    coordinator-vs-AI pill) and shows order-level CPO min/justification on order rows.
  - **Signature gate is now a SYSTEM step**: new catalog action `send_orders_to_physician_portal`
    → `signing.sendEpisodeOrdersToPhysician` (marks ALL unsigned episode orders
    SentToPhysicianDate/SendToPhysician_Status so they appear in the PG Bulk-Sign list; async
    gate re-evaluated by the next daily run). Graph t8 human → system.
  - **Def graph** (`docs/phase1-agency-upload.graph.json`): t5 review is the single
    review_record action; t6 = call/sms/email outreach; t8 system auto-send; **t10a/t10b (Audit
    RCM records & resolve failures) deleted** — tail is now Create CCN (t9a/b) → Submit claim
    (t11a/b) on both arms; 25 steps / 4 megaGroups. Old runs pin the old def and still complete
    against the new code (review accepts legacy approved, get_missing_documents +
    send_for_signature human actions kept in the catalog).
  - **Work-items open response**: now includes `payload.patientOrders` (new
    `listOrdersForPatient`, with matched PDF blob) and `payload.patientTree` (`getPatientTree`)
    — best-effort, absent for Done-bucket rows.
  - **Entity page edit**: pencil-edit on agency/PG/practitioner rows → inline form edit mode →
    new `reference-data` actions `updateAgency`/`updatePg`/`updatePractitioner` → new
    `updateHhahEntity`/`updatePgEntity`/`updatePractitionerEntity` (blank keeps current,
    contact_info merged so PG physician_ids survive, renames recompute normalized_name,
    23505 → 400).
  - **PG portal Patients tab implemented** (was a "coming soon" placeholder — the reason the
    coverage map showed 11 shared Nightingale↔Prima Care patients but the portal showed none;
    live check: `/api/patients?pgId=<prima>` returns exactly 11). `fetchPatients` gained pgId;
    list + `PatientHierarchyView` drilldown mirrors the HHAH portal.
  - **Builder editor polish** (`WorkflowBuilder.jsx`): collapsed one-line node rows (expand to
    edit), node up/down reordering, tinted group frames around consecutive group members,
    daily_time hour/minute/tz trigger inputs (params preserved across radio toggles), readable
    label sizes, humanized "Worker fills" hints, quiet insert pills, raw workflow ids removed
    from headers (kept as tooltips). Round-trip (graphToSeq/seqToGraph/compilePreview) untouched.
  - lint + build pass. Deployed to AWS (push to main → ECS); new def version published via the
    live `saveWorkflow` endpoint after deploy.

- **2026-07-11** — **"Objects this run" sidebar redesigned as a belongs-to ladder (winning
  mockup candidate A).** `RunObjectSidebar` in `WorkflowDefinitionFlow.jsx`: the circle-chain
  (`ObjectCircleNode` + `OBJECT_TONES`) replaced by `ObjectLadderCard` + `OBJECT_META` — one
  icon KPI card per hierarchy level (lucide `UserRound`/`ClipboardList`/`Hospital`/
  `CalendarRange`/`FileCheck`), each stair-stepped 16px under its parent and joined by a plain
  rounded CSS elbow (border-left/bottom div, no SVG, no arrowheads — structure, not process).
  Cards show a lay display label ("Patient Units", "Admissions" — row keys/logic unchanged), a
  hero total (created+updated+existed), and "N new" (emerald) / "N updated" / "N already there"
  (amber) pills. Kicker under the header: "Each item on this ladder lives inside the one above
  it." Aside widened `w-60` → `w-80` (audited safe at 1440px; no Orchestrator change needed).
  Non-patient-chain object sets fall back to flat cards (no indent/elbows/kicker). The
  "before trigger — N already exist" block is kept (now with the simplified labels).
  `runObjectStats` derivation untouched (presentation-only). Also added the design-phase
  mockup dir `2026-07-11/diagram-mockups` (vendored tailwind.js) to the ESLint global ignores.
  lint + build pass.

- **2026-07-09** — **Documentation + .env.example pass: production pipeline build fully chronicled.**
  - **CLAUDE.md**: this Change Log entry (covers Milestones A, B, C/D and the whole production
    pipeline build from PDF extraction through CCN/audit/submit, plus sim-clock and MSA map).
  - **docs/E2E-TEST-GUIDE.md**: new sections — §9 CCN/audit/submit gates & remediation walkthrough
    (pass rate, human Create CCN/Resolve audit/Submit claim, gate auto-resolve), §10 time-travel
    simulator usage (Orchestrator SimTimeControl, +1d/+1m/reset, daily-tick advance), §11 MSA map
    section (polygon backdrop, agency/PG balls seeded inside, drilldown, live toggle). Twilio env
    note added to §8 environment caveats (Call/SMS graceful skip, TWILIO_TO_OVERRIDE safety net,
    E.164 format).
  - **md/business/builder-workflows.md**: Live daily workflow block updated to reflect def v7
    (34 steps, 4 megaGroups); group names corrected (TASK-CCN, Audit & Submit Claim added);
    diagram extended through the full CCN→audit→submit tail.
  - **md/business/eligibility-billing.md**: header Sources updated (billing monitor removed note
    reinforced); "Billing monitor removed" invariant note sharpened; CCN/audit/submit described as
    now living in the builder workflow tail not a separate trigger.
  - **md/backend/lib/reference-logic.md**: updated `rework.js` `maxCycles` param (default 3; run
    audit cycle passes 5, re_audit passes 1); `runAuditCycle` helper noted as living in
    `taskRegistry.js` (not a referenceLogic module) to avoid audit↔rework circular import; CCN
    verdict logic (`runCcnService`, `ccnFailed` derivation) added to aiService.js row.
  - **md/frontend/pages/monitoring.md**: SimTimeControl widget documented (what it is, ops
    +1d/+1m/reset, businessNow/businessToday in clock.js, migration 005 app_settings); MSA polygon
    map section added (msa.js, seedInside, polygon backdrop, agency/PG seeded inside, live toggle
    isIdle guard).
  - **md/GLOBAL.md**: §1 active builder workflow updated to def v7 (34 steps, 4 megaGroups),
    SimTimeControl/clock.js/migration 005 noted in §7 conventions, MSA map note in §7.
  - **.env.example**: already correct — Twilio block already present with all four vars and the
    TWILIO_TO_OVERRIDE safety note. No changes needed.

- **2026-07-09** — **Milestone B (audit/submit): CCN service, bounded audit/rework/re-audit cycle,
  human Submit-claim gate, tail auto-resolver; saved as def v7.**
  - **New catalog** (`builderCatalog.js`): 3 system actions `run_ccn_service` → `ccn.runService`,
    `run_audit_cycle` → `audit.runCycle`, `re_audit` → `audit.reAudit`; 3 human actions
    `create_ccn_manually`, `resolve_audit_failures`, `submit_claim` (confirm-only gate; execute
    records `submitted_at` + summed amount via `recordClaimSubmission`); 2 condition pairs
    `ccn_failed`/`ccn_ok` + `audit_pass_98`/`audit_pass_below_98` (+ read-only passthrough in
    `evaluateCondition`).
  - **CCN tail appended after make_billable_claimable** (`docs/phase1-agency-upload.graph.json`,
    new group **CCN, Audit & Submit Claim**): `run_ccn_service` → `ccn_failed?` YES → human
    **Create CCN manually** (rejoins) ; then `run_audit_cycle` → `audit_pass_98?` NO → human
    **Resolve audit failures** → `re_audit` ; YES/join → human **Submit claim**. Because
    make_billable is an idempotent twin (n10a eligible arm / n10b signature-pass arm), the tail
    is instantiated TWICE (suffix a/b) — the frozen DAG compiler flags a cycle if two branch-walks
    converge on one node, and every tail step is agency-scoped + idempotent, so the duplication is
    safe. Compiles to **34 steps, 4 megaGroups**.
  - **CCN verdict** (`referenceLogic/aiService.js` new `runCcnService`): delegates to `runAiService`
    and derives `ccnFailed = hadWork && generatedNotes === 0` — the exact Gemini-dead state
    (every month lands in `failures`, 0 notes). A run with NO billable months is NOT a failure
    (`ccn_ok`), so the tail proceeds straight to the audit cycle.
  - **ONE bounded audit cycle** (`runAuditCycle` helper in `taskRegistry.js`): `auditRcm` →
    `reworkAudits` (its inner loop now bounded by a new `maxCycles` param, default 3 preserves old
    behaviour; run_audit_cycle passes 5, re_audit passes 1) → final `auditRcm`; passRate =
    passed / total, vacuous pass (1) when there are 0 records. Orchestrated in taskRegistry (not a
    referenceLogic module) to avoid the audit.js↔rework.js circular import — it is the single place
    that imports both. `audit_pass_98 = passRate >= 0.98`.
  - **Submit claim** (`repositories.recordClaimSubmission`): sums the agency's `rcm_records`
    charges, flips them to `status='submitted'`, stamps `claim_submitted`/`claim_submitted_at`/
    `claim_amount_cents` on the item. HUMAN GATE — NOTHING transmitted to any payer/clearinghouse.
  - **ASYNC RULE extended**: `GATE_REMEDIATIONS` gains `ccn_failed` (gate = CC notes now present on
    `cpo_months.reason.ccNotes`, cheap DB read) and `audit_pass_below_98` (gate = re-run bounded
    audit cycle passes ≥ 98%; audit.js/rework.js import only db.js so no cycle). The tick's
    `resolveSettledGateTasks` now also settles prior-day Create-CCN / Resolve-audit tasks whose gate
    has since passed. Create-CCN honestly stays open while Gemini is dead (notes never appear).
  - **DB save**: compiled + saved via the identical `compileGraph`+`upsertWorkflowDefinition` path
    `saveWorkflow` uses — `cc-1783522521545 v7` (34 steps, 4 megaGroups) is now the SINGLE active
    daily def; v6 deactivated (single-active daily invariant holds — exactly one active `daily_time`
    def). Verified live (throwaway run/item created + deleted; rcm status restored, never left
    mutated): all 3 tail task fns against the real DEMO-RCM agency (7 rcm_records → passRate 0.143 →
    `audit_pass_below_98`), submit_claim summed $460 + flipped statuses, standalone engine run of
    the arm-a tail sequenced n14a→(t9a skipped, ccn_ok)→n15a→(t10a active, audit<98)→n16a/t11a
    pending (human gate blocks), evaluateCondition passthrough for all 4 keys, graph round-trips.
    lint + build green; 12 api handlers unchanged.

- **2026-07-09** — **Milestone A (core): group rename, multi-signal PDF↔order match, post-model
  billing gates, generalized gate auto-resolver, twilio-wired call/sms; saved as def v6.**
  - **Group rename**: the uploaded branch's TASK group `Update Object Module` →
    **Update / Create Patient Model** (graph `groups`, compiled `megaGroups`,
    `docs/phase1-agency-upload.graph.json`, `docs/E2E-TEST-GUIDE.md`). The two `md/`
    occurrences are generic shape examples, not references to this def — left as-is.
  - **Multi-signal PDF↔order matching** (`taskRegistry.matchPdfForItem`, run inside
    `ai.extractWithPatterns`): filename match → order-number regex over the extracted PDF text
    cross-checked to the workbook order number → patient-name + order-date heuristic → else
    stamps `decisions.pdf_match_ambiguous` and OR's it into `ai_extraction_fail` so the fill
    task (which gained a `confirm_order_document` action) is routed (never guesses silently).
    `pdf_match` provenance stamped on decisions + `extraction_payload.pdfMatch`. No PDF present
    ⇒ NOT flagged ambiguous.
  - **Post-model billing gates** appended to the uploaded branch AFTER `Review record` (t5.next=n9):
    `check_episode_eligibility` → `episode_eligible?` YES → `make_billable_claimable`
    (n10a, stamps `billable_claimable`); NO → `check_documents_exist` → `documents_missing?`
    YES → human **Get missing documents** [get_missing_documents: contact_agency / rpa
    placeholder / manual EHR] ; NO → `check_patient_data_complete` → `patient_data_incomplete?`
    YES → human **Get and fill patient data** [fill_missing_fields] ; NO →
    `check_signature_exists` → `signature_exists?` NO → human **Send for signature to Physician**
    [send_for_signature: markOrderSentToPhysician — HUMAN gate, NO auto-send, reminds /pg-login] ;
    YES → `make_billable_claimable` (n10b). n10a/n10b are idempotent twins: the DAG compiler
    cannot converge two branch-walks on one node (it flags a cycle), so the eligible arm and the
    signature-pass arm each get their own make_billable step. The 5 gate system steps read the
    REAL DB rows via new `repositories.loadEpisodeGateContext` + `gateDocumentsExist` /
    `gateSignatureExists` / `gatePatientDataComplete` (businessRules.isPatientDataComplete) /
    `makeEpisodeBillableClaimable` (recomputes + persists `patients.latest_episode_status` — the
    denormalized flip site; `patient_episodes` has no status column). 8 new condition pairs +
    passthrough in `evaluateCondition`; 5 new system actions + 3 new human actions in
    `builderCatalog`.
  - **ASYNC RULE**: the remediation human tasks are branch terminals (same blocked-item pattern
    as the contact task t1 — they do not introduce new run-completion blocking). New generalized
    `repositories.resolveSettledGateTasks()` (modeled on `resolveOpenAgencyAskTaskForRun`) runs
    on every daily tick (`dailyTimeTickHandler`), re-evaluates each still-active gate remediation
    task's gate against the item's current DB rows, and completes any that now pass with note
    "Resolved by re-evaluation — the gate now passes." The next daily run re-evaluates every gate
    fresh per item.
  - **twilio wiring**: `call_agency`/`sms_agency` execute now call `api/_lib/twilio.js`
    `placeCall`/`sendSms` (Milestone C) reading the agency phone from `HHAH.contact.phone`;
    twilio is env-only + unset here so both degrade to `{sent:false,skipped:true,
    reason:'twilio_not_configured'}` (never throws), and the outcome is surfaced on the action
    output (`channel_sent`/`channel_skipped`/`channel_reason`) like email_agency's SMTP outcome.
  - **DB save**: compiled + saved via the identical `compileGraph`+`upsertWorkflowDefinition`
    path the `saveWorkflow` endpoint uses — `cc-1783522521545 v6` (22 steps, 3 megaGroups) is now
    the SINGLE active daily def; v5 deactivated. Verified live: gate helpers + task fns + the
    auto-resolver against a real episode (throwaway run created + deleted), all 5 PDF-match
    branches, twilio graceful skip, graph round-trip. lint + build green; 12 api handlers.

- **2026-07-09** — **Worker/Orchestrator feedback pass (F1–F6): contact-task context, honest SMTP
  outcome, TASK-group hierarchy, per-object run counts, wf-area-onboarding removal, "Phase 1"
  strip.**
  - **F1 — contact-agency task context**: `WorkerTaskDetail.jsx` detects agency-contact
    checklists (every action ∈ {call_agency, sms_agency, email_agency}) and swaps the
    PATIENT/ORDER missing-grid + lifecycle chips for a compact `AgencyContactSummary` (agency
    name + contact email + "No upload received today"; read-only variant says the task is
    settled).
  - **F2 — email via SMTP, surfaced honestly**: the worker UI now renders real inputs for the
    agency-outreach actions — `email_agency` gets the EmailFields panel with To prefilled from
    `references.HHAH.contact.email`, Call/Text render "coming soon" banners + confirm
    checkboxes. After completion, `WorkerPortal.handleCompleted(response)` reads
    `result.output.actionOutputs` and shows a green "email sent" notice or an amber
    "Task completed, but the email was NOT sent — SMTP failed: <reason>" (send stays
    best-effort and never blocks completion; SMTP creds are currently invalid → skip + reason).
  - **F3 — TASK container hierarchy**: `BUCKET_ITEM_SELECT` (repositories.js) selects
    `d.definition->'megaGroups'`; `api/work-items/index.js` maps the task's `step_id` into
    `group_name` on every bucket row (internal column stripped). Bucket cards + the detail
    header read "TASK-Update / Create Patient Model › Review record" / "TASK-Contact Agency to Upload
    Documents › …".
  - **F4 — per-object run counts on daily-run cards**: `runObjectStats` no longer keys off a
    workflow-id map — `objectsForRun()` derives the object rows from the run's task keys
    (patient./record./admission./episode./order.), so builder daily runs get the
    created/updated sidebar. `classifyObject('Patient Unit')` counts a successful write on an
    existing unit as *updated* (the daily flow never stamps `unit_only_changed`). Verified on
    the live 2026-07-08 run: Patient Unit/Record 14 created · 6 updated, Admission 11 created ·
    9 already exist, Episode 20 created, Order 20 created. No new taskRegistry stamps were
    needed (admission/episode/order resolve fns already stamp created-vs-exists).
  - **F5 — wf-area-onboarding removed**: definition deleted from `workflowDefinition.js`
    (`WORKFLOW_DEFINITIONS = []`; `ensureSystemDefinitions` is now a no-op seam), from
    `scripts/seed.js` (seedAreaOnboardingRun + unused imports dropped), from
    `WorkflowList.jsx` (TRIGGER_META/CHAIN_ORDER emptied) and `Orchestrator.jsx`
    (AreaIntakeSubPanel + area-runs section + area-intake fetches removed; all runs render in
    one newest-first list). **DB**: 0 runs + 1 definition row (v1) deleted — 0 remain. The
    `api/area-intake` route stays (12-handler cap; HhhLogin banner is data-driven).
  - **F6 — "Phase 1" stripped**: live DB UPDATE renamed 8 definition rows (all versions of
    cc-1783522521545 + cc-1783519722096) to `Agency Bulk Upload — Daily Intake` (name column +
    definition.name), cleaned 8 definition descriptions ("Phase 1 daily agency intake" →
    "Daily agency intake") and 1 run's `input_summary.workflowName`. Zero rows still match
    'Phase 1'. `docs/phase1-agency-upload.graph.json` name field, `docs/E2E-TEST-GUIDE.md`,
    and `docs/manual-test-kit/README.md` updated; `record-phase1-demo.mjs` run-card filter
    regex now matches "Daily Intake".
  - lint + build pass; verified in headless Chrome (worker portal contact task, Orchestrator
    sidebar, Workflow page) with the real API against live Neon.

- **2026-07-09** — **AI extraction Tier 1 now reads the REAL order PDFs (unpdf), PATTERNS tuned
  to the Nightingale document layouts.**
  - **New `api/_lib/pdfText.js`**: `extractPdfText(buffer)` — pure-JS PDF text extraction via
    `unpdf` (serverless pdf.js build, zero deps, no native bindings — `pdf-parse` v2 was tried
    first and rejected because it hard-depends on `@napi-rs/canvas`). Content-order line
    reconstruction (hasEOL + baseline breaks) so grid forms yield label\nvalue lines; visual
    Y-sort was tried and rejected (merges CMS-485 grid columns). Normalizes curly quotes/NBSP,
    keeps line structure. `unpdf@1.6.2` added to dependencies.
  - **`referenceLogic/extraction.js`**: `extractWithPatterns` Tier 1a now fetches the item's
    `extraction_payload.pdf.blobUrl` (or uses a passed `pdfBuffer`), extracts text, and runs
    PATTERNS over it BEFORE the payload-text pass (Tier 1b); extracted text is returned as
    `result.pdfText` and cached on `extraction_payload.pdfText` by the taskRegistry wrapper
    (re-runs skip the refetch). Gemini Tier 2 unchanged: only for still-missing fields, graceful
    skip on the dead key. PATTERNS tuned against the 20 real Nightingale PDFs (3 layouts:
    DynamicPDF CMS-485 grid, Post Hospital Order, Kinnser print-preview short orders) —
    alternates ADDED, test-kit patterns kept. New scoped `extractDiagnosisCodes` (codes mined
    only from Diagnosis sections, dotless "J209" → "J20.9"); `classifyOrderType` now checks the
    explicit "Order Type:" label then the document TITLE first (the real 485 attestation text
    contains "recertify" + "face-to-face", which the old whole-document scan misclassified);
    signedDate excludes clinician (RN/PT/…) digital stamps, physician "Electronically signed
    by … on <date>" wins; 485 order-date falls back to the certification-period start.
  - **`normalizers.js` `parseDate`**: explicit M/D/YYYY branch — the `new Date(slash)` local-TZ
    round trip shifted dates a day on machines east of UTC (Vercel/UTC unaffected; local shim
    runs against the live DB were at risk).
  - **New `scripts/test-pdf-extraction.mjs`**: offline harness (no DB/network) scoring
    extractPdfText+regexExtract over the 20 real PDFs (`REAL_PDF_DIR`) + the 6 test-kit PDFs
    from `docs/manual-test-kit/orders_*.zip`. Rates on the real 20: name/DOB/MRN/orderNo/
    orderDate/orderType/SOE/EOE/physician/ICD-10 100%, NPI+address 90%, agency 90%, SOC 35%,
    sex 35%, signed 15% — every miss is a genuine document absence (Post Hospital carries no
    NPI/address/agency label; short orders carry no SOC/sex; only 3 PDFs contain physician
    signature stamps). Kit: 100% except O-TK-9002's by-design "(pending admission)" dates.
  - **E2E on live DB** (throwaway script, not committed): temp run + sparse item (name only)
    carrying a re-uploaded real PDF blobUrl → `ai.extractWithPatterns` task fn → 12 blank core
    fields → `missingAfter: []`, tiersUsed `["pdf-regex"]`, all values verified against the
    document (NPI 1225033673 = the provisioned Dr. Labib), 13.5KB pdfText cached, decisions
    stamped — then run + blob deleted. lint + build pass; 12 api handlers unchanged.

- **2026-07-09** — **Removed 3 system workflows; rewired uploads to daily-run row-append;
  tick appends silent agencies; Nightingale fixtures + Riverbend/Cedar Grove teardown.**
  - **R1 — removed `wf7` (update patients objects), `wf-signing` (Send To Physician),
    `wf-billing-monitor` (Make Patients Billable)** everywhere. `workflowDefinition.js`
    now exports only `WORKFLOW_DEFINITIONS = [WF_AREA_ONBOARDING_DEFINITION]` (the 3 consts
    deleted). `api/workflow-runs/index.js`: dropped `ensureBillingWorkflow`,
    `runBillingMonitorHandler` + all its helpers; `POST {action:'runBillingMonitor'}` now
    returns 400 "Unsupported workflow-runs action." `workflowEngine.js`: deleted
    `startBulkSigningRun` + its `human.reviewRecord` hook (and now-unused imports).
    `bulk-upload/start.js`: removed the `targetWorkflows` wf7 fallback. `scripts/seed.js`:
    removed `seedDemoWorkflowRun` (its wf7 anchor). `WorkflowList.jsx` + `Orchestrator.jsx`:
    stripped the 3 ids (Orchestrator poll now calls only `tickTimeTriggers`; removed
    `runBillingMonitor` client). `repositories.js` `runBillingMonitorPass` kept as harmless
    dead code (no caller). **DB surgery** (live Neon): deleted the 1 `wf-billing-monitor`
    run (cascades) then all 3 def rows — verified 0 defs / 0 runs remain; only
    `cc-1783522521545 v5` (phase-1 builder) + `wf-area-onboarding v1` stay active.
  - **R2 — uploads now append to TODAY's daily run** (wf7's replacement). `bulk-upload/start.js`
    rewritten: for each active `daily_time` builder workflow it ensures today's daily run
    exists (creates on demand with the canonical `daily:<wfId>:<dayBucket>` sourceLabel and
    NO base items for other agencies), then appends ONE item per joined workbook row
    (patient/order payloads + `stampSessionAgency`-merged `HHAH={id,name,contact}` +
    `extraction_payload.appendKey = row:<hhahId>:<orderOrRowKey>:<dayBucket>`), auto-resolves
    the agency's open contact task, writes `uploaded_documents` anchored to the daily run
    with the uploading agency's `hhahId`, and runs the automation so rows flow n1(uploaded
    branch)..n7. `stampSessionAgency` extended to set `HHAH.id`+`HHAH.contact`;
    `insertUploadedDocument` gained an optional `hhahId` param (multi-agency daily run can't
    carry one `run.hhah_id`). JSON path (manual/Sunrise kit) reshaped into the same joined-row
    append seam. Verified live: 20 rows appended, all `agency_uploaded=true`, patient/order
    created, review tasks active in worker bucket; re-upload adds 0 items (appendKey dedupe).
  - **R3 — noon tick appends silent agencies.** `dailyTimeTickHandler` now: creates today's
    run only at/after fire time when missing; when the run already exists + running (e.g.
    upload-created early), appends ONE base item (`appendKey base:<agencyId>:<dayBucket>`) per
    active agency NOT already present (matched by `reference_payload.HHAH.id`, unioning native
    base + row items). Verified live: an upload-created run of 20 Nightingale row items → tick
    appended exactly 3 base items (Demo RCM/Sunrise/Willow, each with an active Contact-Agency
    task); second tick appended nothing; one run/day invariant held.
  - **R4 — Nightingale created, Riverbend + Cedar Grove deleted.** External generator scripts
    in `/Users/sujaygp/Desktop/data/` adapted (kept OUTSIDE the repo): `build-fixtures.mjs`
    now emits ONE set for slug `nightingale-visiting-nurses-taunton` from all 11 patients / 20
    orders (10 signed / 10 unsigned matching the PDF dirs 1:1, patient MRN on order rows, blank
    Agency Name); `provision.mjs` creates agency `Nightingale Visiting Nurses-Taunton (TEST)`
    (NPI 1881923936, email resources@ucodemint.com) + user `nightingale-test` /
    `TestAgency!2026`, uploads the 3 fixtures to `preload/nightingale-visiting-nurses-taunton/`,
    stores `contact_info.preload`, and creates the `Prima Care` PG + Dr. Labib Ossama W.
    (NPI 1225033673) practitioner mapped to it; new `delete-agencies.mjs` removes Riverbend
    (e2b1ca81) + Cedar Grove (cfa80619) — runs/users/blobs/domain rows/agency. `blobStore.js`
    gained `deleteBlobUrls` + `deleteBlobPrefix` (re-exporting `@vercel/blob` `del`/`list`).
    Verified live: Nightingale login mints; both placeholder agencies + their users + their
    3 preload blobs each deleted (blob prefix now 0); Willow / Sunrise / Demo RCM untouched.
  - lint (`eslint .`) clean; `npm run build` passes. All 12 api handlers unchanged in count.

- **2026-07-08** — **md/ docs: builder task-hierarchy (groups → megaGroups), for-each START phrasing, phase-1 parity.**
  - **`md/backend/lib/builder-compiler.md`**: added "TASK groups → megaGroups" section documenting the post-pass
    that derives `megaGroups` from `graph.groups` (validation rules, filter of condition/dangling ids, omit-when-empty),
    the compiled output shape extended with `megaGroups?`, and invariant that groups are additive/invisible to the engine.
  - **`md/frontend/pages/builder.md`**: added `graphToGroups`, `collectGroupMembers`, `clearGroupFromSeq`, `memberCounts`,
    `GroupsPanel`, `GroupControl` to the functions table; updated `seqToGraph` signature to `(seq, catalog, groups)`
    and noted `groups?` in the server graph shape; added `groupId` to node model; updated `SequenceEditor` + `TriggerCard`
    descriptions; added invariants for `previewMegaGroups`, groups round-trip symmetry, `daily_time` UI caveat, and
    `clearGroupFromSeq` on delete; added change recipe #6 for group-level validation.
  - **`md/frontend/components.md`**: updated `triggerLabel` description to document `daily_time` → "For each onboarded
    agency · check if uploaded"; updated `MegaTaskNode` and `MegaGroupFlow` descriptions to reflect flat-step
    interleaving, branch-pair detection, and paired side-by-side rendering; added invariants for flat+group interleaving,
    `MegaGroupFlow` branch detection, and `WorkflowLane` auto-selection; noted builder preview uses `WorkflowLane` when
    groups exist.
  - No code changes. All md/ edits are documentation-only.

- **2026-07-08** — **Phase-1 daily agency intake workflow: release decision, workflow shape, graph spec, and E2E verification.**
  - **Phase-1 release decision**: the new "Agency Bulk Upload — Daily Intake (Phase 1)" workflow
    (`kind='builder'`, `trigger:daily_time 12:00 America/Chicago`) is the ONLY active `daily_time`
    workflow going forward. The prior full RCM pipeline definition `cc-1783452217589` (both
    versions) is preserved in the DB but deactivated for phase 2.
  - **New active definition**: `cc-1783522521545` version 2 (kind=builder, ACTIVE).
    Compiled to **13 engine steps + 6 condition nodes (19 graph nodes)**:
    `check_agency_upload` → `agency_not_uploaded` diamond (TRUE = "Contact agency to upload"
    human task ends the branch; FALSE = rest of pipeline) → `ai_extract_with_patterns` →
    `ai_extraction_fail` diamond → `patient_exists` diamond (update vs create) →
    `admission_dates_missing` diamond → `admission.resolve` → `episode_dates_missing` diamond →
    `episode.resolve` → `order_exists` diamond (skip-duplicate vs create) → `review_record`
    human task. All 5 human tasks assigned to DEMO-RCM employee
    `b8f2826d-ade5-4384-bdfd-610a486c39a0` (`Intake Coordinator (DEMO-RCM)`).
  - **Phase-1 scope**: agencyCheck + extraction (+businessRules already wired into extraction)
    only. RCM/AI-service/audit/rework tail is OUT of phase-1 scope (phase 2).
  - **UI disclosure**: the builder's TriggerCard has no hour/minute/tz inputs for `daily_time`
    (it only renders `intervalSeconds` for `time_interval`). The trigger params
    `{type:'daily_time',hour:12,minute:0,tz:'America/Chicago'}` were set through the IDENTICAL
    `saveWorkflow` POST endpoint the UI itself uses (same id → new version 2 became the active
    def). The save path, validation, and compile are identical to a UI save; only the trigger
    params were supplied programmatically.
  - **Run test**: clicking the card's Run button created Orchestrator run
    `7f2b3cc5-19dd-401c-b901-9b9f0b9c714e` (status running, source
    `manual:cc-1783522521545:…`). Engine ran correctly: `agency.checkUploadedToday` completed,
    DEMO agency had not uploaded today → `agency_not_uploaded` branch taken → "Contact agency to
    upload the documents" human task ACTIVE, entire uploaded-branch tail correctly SKIPPED
    (`prereqsAllSkipped` guard). Run + active task + all 6 diamonds render on the Orchestrator
    page.
  - **Cleanup / single-active invariant**: deleted tester duplicate `cc-1783519722096` (all 3
    versions now inactive). Confirmed exactly ONE active phase-1 def (`cc-1783522521545` v2)
    and it is the ONLY active `daily_time` workflow. Full RCM pipeline `cc-1783452217589`
    (phase 2) left preserved + inactive (both versions).
  - **`reconcileDailyRunForUpload`** (in `api/workflows/bulk-upload/start.js`) confirmed
    generic: it iterates ALL active `daily_time` builder workflows via
    `listActiveBuilderWorkflowsByTrigger('daily_time')` — NOT hardcoded to one def id. Any
    future `daily_time` workflow automatically participates in the mid-run append seam when an
    agency uploads while the run is in flight.
  - **Graph spec**: `docs/phase1-agency-upload.graph.json` (saved definition graph); screenshots:
    `docs/phase1-agency-upload-ui.png` (Workflow list — phase-1 card with Builder badge +
    flowchart + 6 amber condition diamonds) and `docs/phase1-agency-upload-orchestrator.png`
    (the manual run with active human task).
  - **Helper scripts added**: `scripts/cdp.mjs` (reusable CDP/headless-Chrome driver),
    `scripts/build-phase1.mjs` (phase-1 build + programmatic save via same endpoint as UI).
    Both lint clean, kept for future UI-driver use.
  - **`md/` updated**: `md/business/builder-workflows.md` updated (phase-1 as the live daily
    workflow, deactivation of full RCM pipeline, reconcileDailyRunForUpload generality note);
    `md/backend/routes/workflow-runs.md` unchanged — its current invariants and mid-run append
    description already reflect the iteration-2 state correctly.
  - lint (`eslint .`) clean; `npm run build` passes. DEMO-RCM fixtures intact.

- **2026-07-08** — **Daily Agency Intake → RCM Pipeline — iteration 2: `businessRules.js` port,
  mid-run append seam, idempotency review, and known-limitation acknowledgement.**
  - **`api/_lib/referenceLogic/businessRules.js`** (new file) — pure, dependency-free port of the
    `BusinessRequirementsService.cs` rules the POC pipeline was still missing (cite: HANDOFF §1.2):
    - `isFilled` / `isPatientDataComplete` (IsPatientDataComplete / IsFilled, L2484–2517)
    - `carryForwardEpisodeDiagnoses` (CarryForwardEpisodeDiagnoses, L526–584) — propagates the most
      recent non-blank diagnosis code down through subsequent episodes in an admission chain
    - `evaluateCpoMonthReadiness` (EvaluateCpoMonthReadiness, L2410–2482) — checks episode overlap,
      485-doc signed date, diagnosis completeness, and CPO minutes to decide if a CPO month is ready
    - `pgBillableMinutes` (GeneratePgBillable minute rules, L1132–1282) — accumulates CPO minutes
      from notes/docs in a given calendar month for one episode
    - `derivePatientStatus` (UpdatePatientStatus / UpdatePatientStatusOP, L1987–2123) — Active when
      latest episode EOE >= today (UTC), else Inactive
    - `deriveFilterStatus` (UpdateBillingStatus / UpdateBillingStatusOP, L1300–1333 / L1694–1755) —
      FilterStatus tier Billable > Pgbillable > Eligible > null (Active patients only)
    - **POC adaptation**: the reference used Cosmos-shaped WAV* DTOs with named diagnosis slots
      (`FirstDiagnosis`..`SixthDiagnosis`) and string dates. The POC uses the Postgres row shape
      (`diagnosis_codes` jsonb array, Neon `Date` objects). The `dateOnly`/`dateMs` idiom is
      used throughout — no `String(date).slice` (that bug has bitten this repo twice).
    - **Not ported** (not needed in POC): `GroupDocumentsIntoEpisodes` (doc-grouping DTO walk),
      `OrganizeEpisodesIntoAdmissions` (DTO tree builder), `FillCpoDatasFromPgBillables`
      (Cosmos writeback) — the POC writes directly to Postgres rows, so the DTO-mapping layers have
      no equivalent.
    - Consumers: `aiService.js` imports `pgBillableMinutes` + `evaluateCpoMonthReadiness`; `rcm.js`
      imports `carryForwardEpisodeDiagnoses`, `evaluateCpoMonthReadiness`, `derivePatientStatus`,
      `deriveFilterStatus`, `isFilled`.
  - **Mid-run append seam** — the `appendIssuesToRun` pattern (previously only used by the billing
    monitor, Trigger 4) is now also the mechanism by which new builder-workflow `daily_time` items
    can be appended to an in-flight run. `tickHandler` in `api/workflow-runs/index.js` creates one
    run per active agency per `dayBucket`, with idempotent source label
    `daily-agency:<wfId>:<agencyId>:<dayBucket>` — re-tickling the same day is a no-op.
  - **Idempotency confirmed** — all three trigger paths are fully idempotent:
    - `time_interval`: `builder-tick:<wfId>:<bucketTs>` — at most one run per interval bucket
    - `daily_time`: `daily-agency:<wfId>:<agencyId>:<dayBucket>` — at most one item per agency per
      calendar day; the per-agency item check runs before item creation
    - `billing monitor`: `missing-docs:<episodeId>` / `signature:<episodeId>` / `cpo:<cpoMonthId>`
      — permanently deduped, re-triggered issues append to the active run, not duplicate it
  - **Known limitation carried forward (LOW / informational)**: `deriveFilterStatus` in `rcm.js`
    decides the `Pgbillable` filter-status tier using a local proxy
    (`assessment.eligible && cpo_min >= 30`) rather than running `businessRules.pgBillableMinutes`
    over the episode's doc/note set. `pgBillableMinutes` IS correctly wired in `aiService.js`
    (L547) for minute accumulation, and `cpoStatusForMonth` in `repositories.js` is the correct
    single flip site. The `filter_status:'Pgbillable'` label on the RCM payload may
    under-classify a record as Eligible when full doc/note filtering would push it over 30 min.
    POC adaptation; low business impact — the label is informational on the payload only.
  - **No new migration** — no migration 005; `businessRules.js` is a pure computation module with
    no schema changes.
  - **Test evidence**: lint + build pass. DEMO-RCM fixtures (agency id 5b62b980-e6b1-48ec-ba0b-
    34ff9df022f5, 1 patient / 2 episodes / 2 signed-485 orders, 6 rcm_records, 6 audit_records)
    verified in the live Neon DB. AI steps take skip/ok paths (GEMINI_API_KEY invalid → graceful
    Tier-2 skip). `businessRules.js` functions exercised through `rcm.js` + `aiService.js` callers
    with seeded DB data.
  - **md/ docs updated**: `md/backend/lib/reference-logic.md` extended with `businessRules.js`
    section (exports, not-ported list, callers); `md/backend/routes/workflow-runs.md` clarified
    mid-run append invariant for builder `daily_time` items.

- **2026-07-08** — **Daily Agency Intake → RCM Pipeline feature: referenceLogic modules, builder
  catalog/registry additions, migration 004, cron fire path, and compliance notes.**
  - **`daily_time` trigger** added to `TRIGGERS` in `builderCatalog.js` (`params: ['hour','minute','tz']`).
    `tickHandler` in `api/workflow-runs/index.js` already handled `time_interval`; it now also handles
    `daily_time` — iterates every active agency, creates one item per agency stamped with `dayBucket`
    (YYYY-MM-DD in the workflow's tz), fires at most once per calendar day per agency (idempotent via
    source label `daily-agency:<wfId>:<agencyId>:<dayBucket>`). Fire paths:
    (a) **Vercel cron**: `vercel.json` now declares `{ "path":"/api/workflow-runs?action=tick",
    "schedule":"0 17 * * *" }` — GET with `action=tick` param calls `tickHandler` server-side,
    no browser needed; (b) **Orchestrator poll**: `Orchestrator.jsx` 10-second `tick()` now calls
    `tickTimeTriggers()` (which hits `POST { action:'tick' }`) in addition to `runBillingMonitor`.
    Caveat documented: cron fires every day at 17:00 UTC regardless of the workflow's configured
    hour/minute (scheduling granularity is the Vercel cron schedule, not the trigger params — the
    params are a label and per-agency idempotency key only); the Orchestrator poll fallback fires
    while the tab is open.
  - **Six new system actions** (added to `ACTIONS` in `builderCatalog.js`, all wired into
    `taskRegistry.js`):
    `check_agency_upload` → `agency.checkUploadedToday` (queries `uploaded_documents` for the day
    bucket); `ai_extract_with_patterns` → `ai.extractWithPatterns` (Tier 1 regex from
    `referenceLogic/extraction.js`, Tier 2 Gemini fallback); `run_ai_service` → `ai.runService`
    (CC-note + CPO generation, `actor:'ai'`, from `referenceLogic/aiService.js`);
    `generate_rcm` → `rcm.generate` (CPT decision tree from `referenceLogic/rcm.js`);
    `run_ai_audit` → `ai.audit` (rule R1–R4 engine from `referenceLogic/audit.js`, `actor:'ai'`);
    `run_ai_rework` → `ai.rework` (auto-fix + re-audit loop from `referenceLogic/rework.js`, `actor:'ai'`).
  - **Three new human checklist actions** (added to `HUMAN_ACTIONS`):
    `call_agency` (placeholder confirm — no telephony integration yet);
    `sms_agency` (placeholder confirm — no SMS integration yet);
    `email_agency` (real `sendEmail` call using agency contact email pre-filled from
    `referencePayload.HHAH.contact.email`; used in the missing-upload branch).
  - **Three new condition pairs** (added to `CONDITIONS` + `evaluateCondition`):
    `agency_uploaded` / `agency_not_uploaded` (stamped by `agency.checkUploadedToday`);
    `ai_service_failed` / `ai_service_ok` (stamped by `ai.runService`);
    `audit_failed` / `audit_passed` (stamped by `ai.audit` + `ai.rework`).
    All six keys are listed in `evaluateCondition`'s read-only passthrough guard (their decisions
    are pre-stamped by the task; the condition evaluator does not recompute them).
  - **`api/_lib/referenceLogic/*`** — five new ES-module files ported from the .NET 8 reference
    bundle at `reference/` (cite: HANDOFF §1.1–§1.5):
    `agencyCheck.js` (upload-today check via `uploaded_documents`);
    `extraction.js` (regex Tier 1 + Gemini Tier 2 field extraction, ported from
    `NewPdfExtractionService.cs`);
    `aiService.js` (CC-note generation + CPO distribution, ported from `AIProcessingService.cs`,
    uses Gemini — NO Azure/OpenAI keys);
    `rcm.js` (CPT decision tree G0179/G0180/G0181/G0182, upserts into `rcm_records`);
    `audit.js` (rules R1–R4 audit engine, writes `audit_records`);
    `rework.js` (auto-fix loop up to 3 cycles). **HANDOFF landmine #1 respected**: no
    Azure/OpenAI endpoints or keys copied — all LLM calls go through `api/_lib/gemini.js`.
  - **Migration 004** (`db/migrations/004_rcm_pipeline.sql`): adds `rcm_records`
    (per-episode-CPO-month billing rows, UNIQUE on `(episode_id,cpo_month,cpt_code)`) and
    `audit_records` (per-rcm-record rule results, `rule_results jsonb`, `change_log jsonb`,
    `status text`). Both tables are additive/idempotent (`IF NOT EXISTS`).
  - **Compliance deviations** (deliberate, documented in module headers):
    (a) `aiService.js`: the .NET original stamped every generated CC note
    `SignedByPhysicianStatus=true`; here every note is tagged
    `data_tags.generated_by='ai_service'` and is **never** marked physician-signed — AI-generated
    notes are not physician attestations.
    (b) `audit.js`/`rework.js`: the .NET source coupled Part 1 → Part 2 via plain-text comment
    strings; here findings are **structured objects** `{ rule, code, field, message, fixable }`
    stored in `audit_records.rule_results` — rework dispatches on data, not prose parsing.
  - **E2E result**: lint + build pass. The "Daily Agency Intake" graph was created in the no-code
    **Workflow Builder UI** (saved to DB as `kind='builder'`; the compiled graph JSON is
    preserved at `docs/daily-rcm-workflow.graph.json` and a screenshot at
    `docs/daily-rcm-workflow-ui.png`). All six system actions, three human actions, and three
    condition pairs appeared in the builder palette and compiled without errors.
  - md/ tree updated: `builder-catalog.md`, `task-registry.md`, `workflow-runs.md`,
    `db/schema.md`, `frontend/pages/monitoring.md` updated; new `md/backend/lib/reference-logic.md`
    added; `md/main.md` + `md/GLOBAL.md` routing tables updated.

- **2026-07-04** — **v2 iteration 2: acceptance-feedback fixes (D1–D4 per scratchpad DESIGN.md
  "Iteration 2 addendum").**
  - **D1-API**: new `listTaskRunsForRuns(runIds)` in `repositories.js` — ONE `ANY(runIds)` query
    returning only slim renderer columns (`t.id/run_id/item_id/step_id/task_key/actor/status/
    condition/created_at` + `i.item_index/decisions`, no payload blobs). `GET /api/workflow-runs`
    now uses it (grouped by `run_id`) instead of the serial per-run `listTaskRunsForRun` loop;
    single-run endpoints keep the full query. Payload 1.72 MB → 263 KB on the QA dataset (11 runs /
    301 tasks), response ~3 min → ~3.6 s warm on the shim; flowcharts, (n) counts, backlog badges
    and RunObjectSidebar verified intact (they only consume the slim columns).
  - **D1-UI**: `Orchestrator.jsx` gained a `loaded` flag (set in `refresh()`'s `finally`) — until
    the first fetch settles the page renders pulsing skeleton StatCards + "Loading workflow runs…"
    instead of the empty state/zeroed counters; plus a `useRef` in-flight guard so 2.5 s poll ticks
    skip while a previous refresh is pending (CDP probe: max 1 concurrent GET).
  - **D2**: empty-state copy now points at the Workflow page Run button / HHAH portal
    (`/hhh-login`); the defunct "Triggers page" mention is gone.
  - **D3**: `Entity.jsx` create handlers optimistically merge the created row from the POST
    response (`body.agency|pg|practitioner`) into `data` (prepend, dedupe by id) before the slow
    background `refresh()` — a freshly created practitioner is immediately selectable in the
    PG↔Practitioner mapping picker (CDP probe passes with a brand-new unique name).
  - **D4**: `builderCatalog.js` `runHumanActions` awaits validators; `mark_order_sent.validate`
    is async and resolves the REAL order (`extraction_payload.orderId` verified via `findOrderById`,
    else `findOrder(order_number)`) — no DB row ⇒ 400 "No created order is linked to this task…",
    task stays active, run stays running; `execute` re-resolves and returns
    `{ marked:true, orderId }` (never `marked:true` on a no-op). Verified end-to-end (§8.16):
    nonexistent O-9501 → 400 + active task; real order → completed + `SendToPhysician_Status`
    stamped.
  - **Go-live (pending, ops only)**: run `npm run db:wipe` against live Neon immediately before
    announcing the URL (QA data — Bluebird/Sunrise/Summit/Valley, 21 patients, 11 runs — must not
    survive), then re-create demo employees/workflows. Deliberately NOT run in this iteration; the
    QA dataset was required for the acceptance checks above.
  - lint + build pass; §8.13–8.16 checks re-run green.

- **2026-07-03** — **E2E-1 fix: the authenticated portal agency is now authoritative for uploads;
  the Coverage Map only renders Entity-page agencies.** Previously an HHAH-portal upload stamped
  `patients.hhah_name` solely from the workbook's Agencyname column, so `/map` grew phantom balls
  ("Boise Home Health", "Treasure Valley Hospice") and an "Unknown agency" ball (null hhah_name,
  e.g. the sample-4 order-only row), and those patients were invisible on the uploader's own
  portal (`/api/patients?hhahId=` filters `agency_id`, which stayed null).
  - `api/workflows/bulk-upload/start.js`: new `stampSessionAgency` overwrites every item's
    `referencePayload.HHAH` (name + `data_tags.source='session_agency'`) with the session user's
    agency before items are created (multipart + JSON paths); `resolveAreaUploadContext` now
    loads the full agency row via new `getHhahById` so `areaContext.hhahName` is the real name.
    Result: `hhah_name` AND `agency_id` resolve to the real Entity-page agency on patients,
    admissions, and orders.
  - `api/_lib/taskRegistry.js`: new `guardSessionHhah` strips HHAH from AI-extraction and
    human data-entry reference patches when the item is session-stamped, so a PDF-extracted or
    hand-typed agency name can never reassign the upload's agency.
  - `src/pages/map/graph.js`: agency balls now come ONLY from Entity-page reference agencies;
    edges whose hhah_name doesn't match one are dropped (no more "Unknown agency"/never-created
    balls) and edge display names are canonicalized to the Entity-page spelling.
  - Verified end-to-end: db:wipe → create "Sunrise HH" + hhah user → authenticated sample-4
    upload → all 12 patient records + 15 orders stamped Sunrise HH, portal-scoped patient list
    shows all 12, and the live-rendered `/map` SVG (checked via CDP) has exactly one agency
    ball: "Sunrise HH". lint + build pass.

- **2026-07-03** — **Command Center v2: full rebuild of the app shell around a no-code
  workflow builder, real auth for worker + external portals, and identity/entity admin
  pages** (branch `v2-command-center`; design in scratchpad `v2/DESIGN.md`).
  - **Shell**: brand renamed FlowPOC → **Command Center** (sidebar + document titles).
    Nav is now Workflow / Orchestrator / Coverage Map / Employees / Entity / External
    Users + a footer "Open Worker Portal" link. `/` → `/builder/workflows`. Removed
    routes AND pages: `/triggers`, `/patients`, `/orders`, `/reference-data`,
    `/worker/bucket/:userId` (deleted `Triggers.jsx`, `Patients.jsx`, `Orders.jsx`,
    `ReferenceData.jsx`, `workbucket/UserSelect.jsx`, `workbucket/WorkBucket.jsx` —
    its input panels were ported into `WorkerTaskDetail.jsx` first). `worker.html`
    entry (`WorkerApp.jsx`) now mounts the new `WorkerPortal`.
  - **DB**: migration `003_identity_and_builder.sql` (employees, external_users,
    auth_sessions, `workflow_definitions.kind`, task-run `assigned_employee_id`/
    `opened_at`/`actions`/`action_state`) + `npm run db:wipe` (`scripts/wipe.js`).
  - **Auth** (`api/_lib/auth.js`, `api/auth/index.js`, `src/lib/authApi.js`): scrypt
    passwords, TOTP 2FA (node `crypto`, ±1 step), sha256-hashed bearer sessions.
    Worker login is two-stage (password → TOTP); external portals are single-factor.
    ALL seeded/demo credentials removed (`test123`, `SEEDED_USERS` are gone).
  - **POC caveat (intentional)**: the Command Center admin pages (Employees, Entity,
    External Users, Builder) are UNAUTHENTICATED POC surfaces — anyone reaching the
    app can mint accounts. Auth protects only `/worker` and the external portals.
  - **Builder** (`builderCatalog.js`, `builderCompiler.js`, `WorkflowBuilder.jsx`):
    graph of system/task/condition nodes compiled server-side into the existing engine
    `steps` shape (`kind='builder'` definitions; system wf7/signing/billing/area defs
    survive as `kind='system'`). Triggers: `document_upload` (HHAH upload routes to
    active builder workflows, else falls back to wf7), `manual` (`startWorkflow`), and
    `time_interval` via the `tick` action. **Caveat: time_interval triggers only fire
    while the Orchestrator poll is running (it calls `tick`) — this is NOT a real
    scheduler.**
  - **Worker buckets**: Untouched / Processing / Done derived from `workflow_task_runs`
    (`opened_at` + `assigned_employee_id`); open claims shared (NULL-assignee) system
    tasks; complete validates per-action results (400 keeps the task Processing).
  - **Portals**: HhhLogin/PgLogin rewritten on `externalLogin` (scope from the session
    user; PG admin sees a "Coming soon" dashboard, PG practitioner gets Bulk Sign);
    bulk-upload start + bulkSign now require the right external bearer token.
  - **Entity/Employees/External Users pages**: agency/PG/practitioner CRUD +
    PG↔practitioner mapping; employee creation shows the one-time TOTP secret modal.
  - lint + build pass; all 10 routes smoke-tested via the shim server + headless
    Chrome with zero console errors.

- **2026-07-03** — **Repo cleanup: removed the Java backend, dead MSA/builder code, old
  sample sets, and stray root files.** Untracked items were moved to
  `~/Desktop/poc-cleanup-backup-2026-07-03/` (not deleted) in case anything is wanted back;
  tracked removals are recoverable from git history.
  - **Java backend gone**: the uncommitted `backend/` Spring Boot port (added 2026-07-01, never
    wired to the frontend), plus its `.github/modernize/java-upgrade/` tool scaffolding and the
    Java-only `.vscode/settings.json`. Its changelog entry was dropped with it.
  - **Dead MSA/builder frontend code removed**: `src/store.js` (local demo store holding the
    MSA / Statistical Area / PG / HHS set model) and `src/pages/builder/WorkflowBuilder.jsx`
    (its only importer — not routed in `App.jsx`; `/builder/*` routes to `WorkflowList`), and
    `src/components/WorkflowFlowChart.jsx` (imported by nothing since the 2026-06-13
    Orchestrator rebuild). The DB-side statistical-area feature (area-intake API/tables,
    Trigger 1) is **kept** — it is live in Triggers/HhhLogin/Orchestrator.
  - **Sample sets pruned to the one the app uses**: removed `sample-artifacts/`,
    `sample-2-artifacts/`, `sample-3-artifacts/` + their generator scripts
    (`create-sample-hhh-artifacts.js`, `create-sample-2-hhh-artifacts.js`), the root
    `sample-4-artifacts/` duplicate (its README now lives in `public/sample-4-artifacts/`,
    the copy HhhLogin actually preloads), and the untracked `sample-HHAH1/2-artifacts` dirs +
    zips + generator (backed up).
  - **Stray files removed**: `map-coverage.html`, `map-mockup.html`, `map-network.html`,
    `map-usa-mockup.html` (standalone USA-map/coverage prototypes superseded by `/map`),
    `kickbacks.vsix`, `Patient_Order_Business_Logic.pptx`, `public/bucket-ui/` (old pre-built
    "workbucket-app" static export, referenced nowhere), `.DS_Store` files.
  - **Kept deliberately**: `.github/workflows/deploy.yml` (intentional GitHub Pages deploy from
    the initial commit; `vite.config.js` still branches on `DEPLOY_TARGET=pages`), `ChatGPT.md`,
    `docs/`, `worker.html` (second Vite entry for the worker portal).
  - CLAUDE.md Layout section refreshed (Orchestrator renderers were described pre-2026-06-13;
    `WorkflowFlowChart` references replaced with `WorkflowDefinitionFlow`). lint + build pass;
    routes + live API smoke-tested.

- **2026-06-21** — Coverage Map drilldown reshaped per Lisa's feedback: orders connect
  directly to the episode (irrespective of status), color-coded order leaves, and Current/Past
  labels.
  - **Orders hang directly off the episode.** Removed the Billed/Unbilled/Eligible drill level
    (`billBucket` kind deleted). A Current/Past episode (`epBucket`) now expands straight into one
    **Orders** ball; billed/unbilled/eligible are shown as a status **badge** under the episode
    ball (`billed N · unbilled N · eligible N`).
  - **Color-coded order leaves.** The Orders ball expands into status + type leaves, each its own
    color: Signed = green (`osigned`), Unsigned = amber (`ounsigned`), 485 = blue (`o485`), F2F =
    purple (`of2f`), Other = grey (`oother`). Replaced the old generic `metric`/`otype` leaves.
  - **Current / Past labels** replace New / Old for both admissions and episodes (balls, banners,
    legend). Legend now lists order status/type colors.
  - lint + build pass. Verified leaf counts against live data (HHAH1→PG2: 5 orders = 2 signed /
    3 unsigned, 1 485 / 1 F2F / 3 other).

- **2026-06-21** — Coverage Map: fixed "1 new admission but 0 episodes" inconsistency.
  `graph.js` classified admission age (by EOC) and episode age (by EOE) independently, so an
  admission could be "new" while its only episode was "old" — leaving the New Admission → Episodes
  drilldown empty. Now each episode's old/new age **inherits its parent admission's age** (tracked
  via `_episodeAdmission` map; fallback to own EOE only if no admission link). Removed the now-unused
  per-episode EOE date read. Verified on the demo data: HHAH1→PG2 now reads new adm 1 / new epi 1 and
  old adm 1 / old epi 1 (was new epi 0). lint + build pass.

- **2026-06-21** — Trigger 4: fixed missing CPO tasks + append-to-active-run. Two bugs kept
  the "Add 30 Min CPO" (and signature) tasks from ever appearing for a billable patient like
  Eleanor Watkins:
  - **`parseDateOnly` dropped every CPO month.** It did `String(value).slice(0,10)`, but
    Neon returns `soe`/`eoe` as Date objects, so `String(dateObj)` → `"Mon Jan 05 …"` →
    `.slice(0,10)` = `"Mon Jan 05"` → `NaN` → null. `cpoMonthDatesForEpisode` then returned
    `[]`, so no CPO month rows were ever created and the CPO billing check never ran. Fixed by
    delegating to the existing `dateOnly` helper (handles Date + string). Same class of bug as
    the 2026-06-19 `dayDiff` fix. Verified: Eleanor's billable episode now generates 3 CPO
    months and 3 "Add 30 Min CPO" issues; completing one captures minutes and flips the month
    to billable.
  - **New issues for an HHAH with an active run were silently skipped.** The active-HHAH-run
    guard dropped any issue discovered after the run was created (e.g. CPO months that only
    became checkable once an episode turned billable). Now `appendIssuesToRun` appends those
    (already-deduped) issues as fresh items to the in-flight run instead of skipping; added
    `countWorkflowItems`. Confirmed Eleanor's 3 CPO tasks append to the live HHAH1 run and go
    active. (Note: the "Email HHAH — Missing Document (3)" badge was never about Eleanor — it
    aggregates 3 *other* patients: Doris Bell missing 485, Harper Chen + Miguel Alvarez missing
    F2F. Eleanor has both 485 + F2F and is correctly billable.)
  - lint + build pass.

- **2026-06-21** — Coverage Map: fixed "undefined" episode/admission ball labels + added an
  **Eligible** episode bucket. `fmtCount(undefined)` rendered the literal string `"undefined"`
  as the big inner number (the count source — `s.newEpisodes` etc. — was sometimes absent);
  hardened `fmtCount` to coerce non-finite input to `0` and defaulted every spawn count to
  `|| 0`. Per the requirement that an episode ball can only be old/new/billed/eligible, each
  New/Old episode (`epBucket`) now expands into **Billed**, **Unbilled**, AND **Eligible**
  balls. Added `eligibleEpisodes` aggregation to `graph.js` (episode_status `eligible` OR
  `billable`). Verified against live data: HHAH1-demo-workflow→PG1 reads epi 2 / billed 1 /
  unbilled 1 / eligible 1, no undefined. lint + build pass.

- **2026-06-21** — Fixed Trigger 4 deadlock, added Trigger 3 auto-resolve, renamed demo
  HHAH/PG.
  - **Trigger 4 (billing monitor) was deadlocked by SMTP failures.** `sendEmail` (mailer.js)
    threw when the hardcoded Gmail login was rejected (`535 BadCredentials`). The billing human
    tasks (`billing.sendHhahMissingDocumentEmail` / `sendPhysicianReminder`) call `sendEmail`
    with no try/catch, so `completeHumanTask` threw → the task never completed → the item stayed
    `blocked` → the run stayed `running` → the active-HHAH-run guard then blocked ALL future
    Trigger 4 runs for that HHAH (so "tasks aren't getting created or completed"). Fix: `sendEmail`
    now wraps `transport.sendMail` in try/catch and returns `{ sent:false, skipped:true, reason }`
    instead of throwing — email is best-effort and never deadlocks a workflow. Verified: a stuck
    billing run's 3 tasks now complete and the run rolls up to `completed`, releasing the guard.
  - **Trigger 3: auto-resolve the overdue reminder when the physician signs late.** New
    `resolveOverdueSigningTasksForOrders(orderIds)` in `repositories.js` auto-completes any still
    -`active` `signing.emailPhysicianReminder` task whose item `extraction_payload.orderId` is in
    the just-signed set (with an explanatory note), settles the item, and recomputes the run
    status. Wired into `bulkSignOrders` (PG Bulk Sign) and `markOrderSignedByPhysician`. So if the
    physician signs after Trigger 3 raised the "Email Physician — Signature Overdue" task, that
    manual task disappears from the worker bucket. Verified via a forced-active reminder + sign.
  - **Renamed demo HHAH/PG**: `HHAH1/HHAH2` → `HHAH1-demo-workflow`/`HHAH2-demo-workflow` and
    `PG1/PG2` → `PG1-demo-workflow`/`PG2-demo-workflow` in the live DB (`home_health_agencies`/
    `physician_groups` name + normalized_name, plus denormalized `patients.hhah_name`/`pg_name`)
    and in `scripts/seed-map-demo.js` so a reseed stays consistent.
  - lint + build pass.

- **2026-06-20** — Coverage Map drilldown re-shaped to mirror the patient page hierarchy +
  added spring animation. The HHAH→PG patient-count drilldown now nests strictly like the
  Patient page (each level connects only to its parent): patient-count → **Admissions** →
  clickable **New Admissions** / **Old Admissions** (`admBucket`) → each opens its own scoped
  **Episodes** ball → clickable **New Episodes** / **Old Episodes** (`epBucket`) → each opens
  clickable **Billed** / **Unbilled** (`billBucket`) → each opens its own scoped **Orders** ball
  → **Signed** / **Unsigned** metrics + 485/F2F/other. So episodes hang off a specific new/old
  admission, billed/unbilled hang off a specific new/old episode, and orders hang off a specific
  billed/unbilled bucket (unique node ids carry the full path so new vs old branches never
  collide). The old/new and billed/unbilled counts still come from the existing `graph.js`
  derivation (order rows whose admission/episode end date is in the past = old; episode_status
  === 'billable' = billed). New node kinds `admBucket`/`epBucket`/`billBucket` added to
  `COLORS`/`RAD`/`countDisplay`/the expandable check + legend. Animation: nodes keep an eased
  rendered position (`rx`/`ry`) separate from the logical/drag position, driven by a
  `requestAnimationFrame` loop that springs `rx→x`/`ry→y` and scales freshly-spawned balls in
  (`appear` 0→1); links draw from `rx`/`ry` so they stay glued mid-animation, and a dragged ball
  tracks the pointer with zero lag. Engine exposes `stop()` (cancels the rAF) wired to React
  cleanup. lint + build pass.

- **2026-06-20** — Coverage Map draggable balls. Map nodes now support mouse and touch
  dragging via SVG pointer events; dragged balls stay connected because links redraw from the
  node's live coordinates, and dragged patient-count edge nodes remain manually positioned.

- **2026-06-20** — Coverage Map status-count drilldown. The HHAH→PG patient-count
  aggregate now derives old/new admission counts, old/new episode counts, billed/unbilled
  episode counts, and signed/unsigned order counts from the live patient/order payloads.
  Admissions expand to old/new admission metrics plus Episodes; Episodes expand to old/new
  and billed/unbilled metrics plus Orders; Orders expand to signed/unsigned metrics plus the
  485/F2F/other breakdown.

- **2026-06-20** — Coverage Map staged drilldown. Clicking the HHAH→PG patient-count node
  now opens only Admissions; clicking Admissions opens Episodes; clicking Episodes opens
  Orders; clicking Orders still opens the 485/F2F/other breakdown. Updated the map banner text
  to match the new click sequence.

- **2026-06-20** — Trigger 4 active-run guard. The 10-second billing monitor still evaluates
  statuses, but it now skips creating a new HHAH billing workflow while a prior
  `wf-billing-monitor` run for that same HHAH is still `running`; a new run can be created only
  after the previous HHAH run completes. Also fixed `updateRunStatus` so runs with failed items
  become `failed` instead of staying `running`, avoiding permanent active-run blocking.

- **2026-06-20** — DB-backed Worker login. `/worker` now loads worker users from
  `/api/work-items`, requires selecting a DB worker plus the existing demo credentials
  (`test123` / `test123`), stores the selected worker in `sessionStorage`, and opens that
  worker's bucket. `/worker/bucket/:userId` now reads worker identity from DB users instead of
  local `store` users and includes a sign-out path back to the worker login. `ChatGPT.md`
  updated.

- **2026-06-20** — DB-scoped HHAH/PG portal selection + HHAH-grouped billing monitor.
  HHAH and PG login pages now load selectable agencies/practices from `/api/reference-data`
  and store the selected scope in `sessionStorage`; HHAH upload, notification, patient, and
  order views use the selected HHAH id, and PG Bulk Sign is scoped to the selected PG id.
  `/api/patients` and `/api/orders` accept optional `hhahId` filters for portal-scoped reads.
  Trigger 2's standalone upload form also selects an HHAH from DB and derives area scope from
  `/api/area-intake`. Trigger 4 now groups new billing issues into one `wf-billing-monitor`
  run per HHAH, with issue-signature duplicate checks plus compatibility with old per-issue
  source labels. Orchestrator labels Trigger 4 as HHAH-by-HHAH and shows an HHAH badge on runs.
  `ChatGPT.md` updated to match the new scoped behavior. lint + build pass.

- **2026-06-20** — Live DB reset to only the Coverage-Map demo network. Ran `npm run db:reset`
  (full schema drop + re-apply of 001/002) to clear all prior data — Boise/Sunrise/Treasure
  Valley HHAHs, Maya Thompson + sample patients, Mountain View/Lakeside PGs, the statistical
  area, and all workflow runs — then re-ran `scripts/seed-map-demo.js`. DB now holds only
  HHAH1/HHAH2, PG1/PG2, Practitioner1–5, 10 patients, 30 orders. **Note:** the wipe also drops
  `workflow_definitions`, which the map seed does NOT restore, so the Workflow/Orchestrator/
  Triggers screens showed "No DB workflow definition available". Restored just the 4 definitions
  + 3 users by upserting `WORKFLOW_DEFINITIONS`/`SEEDED_USERS` via `upsertWorkflowDefinition`/
  `upsertUser` (no old patient/run data re-added). Workflow runs are NOT restored (Orchestrator
  shows no runs by design); run `npm run db:seed` if the full Boise sample + runs are wanted back.

- **2026-06-20** — Coverage Map: restyled to the light FlowPOC theme + added demo data.
  `NetworkMap.jsx` chrome now matches the rest of the app (white top bar, violet logo tile,
  slate text/borders, white search/zoom/legend on a `bg-slate-50` canvas); graph balls keep
  their color encoding but use white strokes + dark labels for the light background. Fixed
  `graph.js` practitioner-count to read `physician_groups.contact_info.physician_ids[]` (the
  real PG↔practitioner link set by `mapPgToPractitioner`), falling back to
  `practitioners.history.PG_names`. New `scripts/seed-map-demo.js` (additive, idempotent):
  seeds 2 HHAHs (HHAH1/HHAH2), 2 PGs (PG1/PG2, with 3 and 2 practitioners linked), 5
  Practitioners, 10 patients and 30 orders so every HHAH connects to both PGs and the
  per-edge counts (patients/adm/epi/orders + 485/F2F/other) populate. Verified the live join
  and rendered the light theme in headless Chrome (zero console errors). lint + build pass.

- **2026-06-20** — Added the **Coverage Map** screen (`/map`): an interactive force-directed
  "agency network" graph. Top level shows HHAH (agency) balls; clicking one zooms/fits to it
  and expands its physician-group balls (with a practitioner-count badge) plus a patient-count
  circle on each HHAH→PG line; clicking that circle expands aggregate Admission → Episode →
  Order balls, and the Order ball splits into 485 / F2F / other. Clicking an open ball again
  collapses it. SVG-based (no canvas, no graph lib), custom spring/repulsion + collision layout,
  fit-to-content camera with +/−/fit zoom controls, and a 2.5s Live poll (rebuilds only when no
  cluster is open). New files: `src/pages/map/NetworkMap.jsx` (page + imperative graph engine in
  a ref) and `src/pages/map/graph.js` (client-side join — no new API). Data via existing
  `fetchPatients`/`fetchOrders`/`fetchReferenceData`: edges aggregate patient records per
  (HHAH, PG); adm/epi counts from patient row counts; order counts + type split from the orders
  feed's `document_type`. Wired `/map` route + sidebar "Coverage Map" nav in `App.jsx`. Verified
  in headless Chrome against mocked-but-real-shaped API: initial agencies → open → drill →
  order-type split all render with zero console errors. lint + build pass. Prototype kept at
  `map-network.html`.

- **2026-06-14** — Pulled the missing-upload notification OUT of the area mega-task.
  `WF_AREA_ONBOARDING_DEFINITION.megaTask` gained `innerStepIds` (`area-s2/s3/s5/s6` stay
  inside TASK-HHAH Upload Monitor) and `outsideStepIds` (`area-s4`). `MegaTaskNode` now renders
  any `outsideStepIds` as standalone `StepNode` boxes after the mega-task, each gated by a
  `DecisionDiamond` from its condition. Flow reads:
  `START → TASK-HHAH Upload Monitor → [upload missing after 24h?] → Notification Trigger —
  Missing Upload → END`. Execution order is unchanged (visual grouping only). Reseeded.

- **2026-06-19** — Fixed Eligible/Billable always reading `started`. `dayDiff` in
  `repositories.js` built `new Date(\`${value}T00:00:00.000Z\`)`, which is `NaN` when the value
  is a `Date` object (as the Neon driver returns `order_date`/`eoe`). That silently failed the
  "F2F within 180 days of EOE" check, so `computeEpisodeAssessment` never marked any episode
  eligible (and thus never billable) through the real read path (`listPatients`, patient
  hierarchy, `/orders` + `/hhh-login` chips). `dayDiff` now delegates to the existing
  `dateMs`/`dateOnly` helpers (which already handle `Date` objects — why the 90-day archive math
  was unaffected). Also normalized `signedDateOf` output to `YYYY-MM-DD`. Verified via an
  end-to-end wf7 run against the live DB: raw-`Date` rows now compute eligible/billable
  correctly and Maya Thompson's latest record reads `eligible` (was `started`). lint + build
  pass. No schema/seed change.
  - `(n)` now counts **distinct items (instances)** a task processed (items with ≥1 ran step
    in the group), not the number of inner step-runs. The HHAH Upload Monitor reads 3 (one per
    expected HHAH) instead of 4; wf7/signing read their row/order counts. Generalises to all
    mega boxes.
  - seed: the area-onboarding run now creates **one item per expected HHAH** (Boise Home Health
    = missing → active manual email task; Sunrise + Treasure Valley = received → continue). DB
    reset + reseeded.
  - HhhLogin: login form preloads `test123` / `test123` so the user can just click Login; the
    Bulk Upload form preloads the **sample-4** artifacts (xlsx + unsigned + signed ZIPs, served
    from `public/sample-4-artifacts/`) with a "✓ filename" hint under each input.

- **2026-06-14** — Mega-task boxes now render with a `TASK-` prefix (e.g. "TASK-HHAH Upload
  Monitor", "TASK-Update Patient Object") — applied once in `MegaTaskNode` (`boxName`), so the
  box title, info popover title, and "Inside …" label all pick it up across Orchestrator +
  Workflows page. Renamed `wf7` workflow name "Bulk Upload Patient & Order" → "update patients
  objects" and its first mega-group "Updating Patient Object" → "Update Patient Object".
  Reseeded.

- **2026-06-14** — Added `sample-4-artifacts/` — a broad wf7 test set (18 patient rows /
  22 order rows / 23 joined) covering 20+ scenarios: signed vs unsigned PDFs, missing
  SOC / SOE-EOE, duplicate order, PG-change record fork, new patient, no-matched-PDF,
  multiple orders per patient, missing MRN/NPI, six diagnoses, order-only & patient-only
  rows, missing sex/address, different HHAH, future-dated order, order-date overrides, and
  same-name/different-MRN distinct units. Files: `hhh_upload_set4.xlsx`,
  `hhh_order_pdfs_unsigned_set4.zip` (14 PDFs), `hhh_order_pdfs_signed_set4.zip` (6 PDFs;
  O-1009 intentionally has no PDF), plus a `README.md` mapping each row to its scenario.
  Verified the workbook parses via `parseWorkflowWorkbook` (23 joined rows).

- **2026-06-14** — Split the single order-PDF ZIP into **two uploads: unsigned + signed**.
  Order numbers are unique, so each order's PDF lives in exactly one ZIP.
  - `multipart.js`: returns `unsignedZips` (fields `unsignedZip`/`orderZip`/`zip`…) and
    `signedZips` (`signedZip`/`signedZips`) instead of one `zips`.
  - `bulk-upload/start.js`: `pdfsFromZip(zip, signed)` tags each extracted PDF; processes both
    ZIP sets; `pdfMetadataForItem` now records `signed` on `extraction_payload.pdf`.
  - `workflowEngine.startBulkSigningRun`: when an order's matched PDF is `signed`, pre-stamps
    the signing item's `order_status` to signed so `signing.checkSignedWithin48h` resolves to
    `signed_within_48h` (no overdue email). Carries `pdf.signed` onto the signing item.
  - `workflowApi.startBulkUploadRun`: accepts `unsignedZip` + `signedZip` (keeps `orderZip` as
    a back-compat alias → unsigned). `dbWorkItemToAction` surfaces `pdf.signed`.
  - HhhLogin + Triggers upload forms: two ZIP file inputs (Unsigned / Signed). WorkBucket
    PdfPanel shows a signed/unsigned badge.
  - sample-3-artifacts: replaced `hhh_order_pdfs_set3.zip` with
    `hhh_order_pdfs_unsigned_set3.zip` (O-9101/9201/9301/9401) and
    `hhh_order_pdfs_signed_set3.zip` (O-9202/9402).

- **2026-06-14** — Hardcoded Gmail SMTP credentials as fallbacks in `config.js`
  (`SMTP_HOST/PORT/SECURE/USER/PASS/FROM`), matching the existing DB/Gemini/Blob convention,
  so the deployed app sends emails without Vercel env vars. Env vars still override. Real
  account + app password committed to public git history — rotate before any real use.
  (Verified the credentials send via Gmail SMTP.)

- **2026-06-14** — Time trigger label + real SMTP email send for the missing-upload task.
  - `wf-area-onboarding` trigger changed to `{ type: 'time_interval', intervalSeconds: 10,
    label: 'Time trigger · every 10s' }`. New `triggerLabel(trigger)` helper in
    `WorkflowDefinitionFlow.jsx`; Orchestrator + Workflows START caps now render
    "START · Time trigger · every 10s" for time triggers (and the trigger id/label otherwise).
  - **SMTP**: added `nodemailer` + `api/_lib/mailer.js` (`sendEmail`). SMTP creds are
    **env-only** (`SMTP_HOST/PORT/SECURE/USER/PASS/FROM` in `config.js`, documented in
    `.env.example`) — NOT hardcoded, unlike the test creds. When SMTP is unset the mailer
    logs the email and the workflow still completes (no-op fallback).
  - `area.sendMissingUploadNotification` now actually sends the email via `sendEmail` using the
    composer's recipient/subject/body; on send failure the task fails with the error. WorkBucket
    hides the irrelevant "N missing" badge for this email task.
  - DB reset + reseeded (new trigger shape).

- **2026-06-14** — Made **Notification Trigger — Missing Upload** (`area-s4`) a manual task.
  - `area-s4` actor `system` → `human`: a person now sends the missing-upload **email** to the
    HHAH. Its task fn (`area.sendMissingUploadNotification`) records `email_sent` + the
    `notification_sent` decision so `area-s5` proceeds.
  - `area-s5` (Record Notification Status, system) still posts the **on-page notification** to
    the HHAH login page (existing `missing_upload_notifications` mechanism via the area check),
    as before.
  - WorkBucket: new `MissingUploadEmailPanel` (To/Subject/Message + "Send email & continue")
    renders for `area.sendMissingUploadNotification` instead of the patient/order
    RecordSummary/PdfPanel. `Mail` icon added.
  - seed: the seeded area run now carries `upload_missing_after_24h: true` and a Boise Home
    Health HHAH reference, so the manual email task surfaces (area-s2 completed, area-s3
    skipped, **area-s4 active/human**, area-s5/s6 pending). DB reset + reseeded.

- **2026-06-14** — Added a per-run **object created/updated side box** and surfaced
  missing-upload **notifications on the HHAH login page**.
  - `WorkflowDefinitionFlow.jsx`: new `runObjectStats(run)` aggregates each run's task-row
    `decisions` (one vote per distinct `item_index`) into per-object created/updated/existed
    counts via `classifyObject` (mirrors the WorkBucket lifecycle rules). New `RunObjectSidebar`
    renders a created|updated grid plus a "before trigger — N already exist" summary. Object
    sets per workflow: `wf7` = Patient Unit / Patient Record / Admission / Episode / Order;
    `wf-signing` = Order Signed; `wf-area-onboarding` = Notification.
  - Orchestrator `RunCard` body is now a flex row: flowchart on the left, `RunObjectSidebar`
    on the right (stacks on narrow screens).
  - `HhhLogin.jsx`: `refreshPatients` also calls `fetchAreaIntakeStatus`, filters notifications
    to this HHAH (`Boise Home Health`), and renders a `NotificationBanner` (amber, bell icon)
    at the top of the dashboard — this is where the **Record Notification Status** step's
    missing-upload reminders appear.

- **2026-06-14** — Collapsed Trigger 2 (`wf7`) and Trigger 3 (`wf-signing`) into mega-tasks,
  matching the Trigger 1 treatment.
  - `wf7`: trigger id renamed `trigger-7` → `upload-patient-order-documents` (START cap now
    reads "upload-patient-order-documents"). Added a `megaGroups` array partitioning the 26
    steps into TWO mega-task boxes: **Updating Patient Object** (`wf7-s1`..`wf7-s16`: parse,
    AI/human extraction, upload-context, patient unit/record) and **Update Admission, Episode,
    Order** (`wf7-s24`..`wf7-s21`: admission/episode/order resolve + final review). Flow is
    now `start → Updating Patient Object → Update Admission, Episode, Order → end`.
  - `wf-signing`: added a `megaTask` descriptor; all 6 steps collapse into one **Review
    Document For Signing** box. Flow is `start → Review Document For Signing → end`.
  - `WorkflowDefinitionFlow.jsx`: `MegaTaskNode` generalised to accept explicit
    `name`/`info`/`steps` (not just whole-definition `megaTask`); `WorkflowFlow` gained a
    `steps` override; new `MegaGroupFlow` renders a `megaGroups` workflow as a vertical chain
    of mega-task boxes with connectors. Each box keeps the `(n)` inner-run count (scoped to
    the group's step ids), ⓘ info popover, and View button that expands the inner flowchart.
  - Orchestrator + Workflows page route: `megaGroups` → `MegaGroupFlow`, `megaTask` →
    `MegaTaskNode`, else `WorkflowFlow`.

- **2026-06-14** — Reframed Trigger 1 (`wf-area-onboarding`) as a single mega-task and cut the
  T1→T2 chain link.
  - Removed the **Onboarding Successful** step (`area-s1` / `area.onboardingSuccess`) and the
    `onboarding_successful` condition from the workflow definition and `taskRegistry.js`.
  - Added a `megaTask` descriptor (`id`, `name: 'HHAH Upload Monitor'`, `info`) to
    `WF_AREA_ONBOARDING_DEFINITION`. The remaining steps (`area-s2`..`area-s6`) are now the
    *inner* steps; `area-s2` preReq cleared to `[]`.
  - New `MegaTaskNode` in `WorkflowDefinitionFlow.jsx`: renders the whole area workflow as ONE
    SYS box showing the task name, an `(n)` inner-run count, an ⓘ popover ("checks every
    onboarded HHAH for uploads; notifies those who haven't"), and a **View** button that expands
    the inner sub-task flowchart (`WorkflowFlow`) in a dashed panel.
  - Orchestrator + Workflows page both render area-onboarding via `MegaTaskNode` (gated on
    `definition.megaTask`); other workflows still use `WorkflowFlow`.
  - **Cut the Trigger 1 → Trigger 2 connector.** wf7 now renders under a standalone
    "Trigger 2 · HHAH Uploads Documents — fires independently" section header instead of a
    `TriggerChainConnector`. Trigger 2 → Trigger 3 chain is unchanged.

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
