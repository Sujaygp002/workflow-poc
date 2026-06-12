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
- The `wf7` workflow steps are referenced by stepId (`wf7-s1`..`wf7-s21`, plus base
  ids like `wf7-p1`). The DB bulk renderer maps these explicitly in `row(...)` calls.
- Condition/branch logic: a step's `conditionExpr` gates it (e.g. `practitioner_not_exists`,
  `ai_extraction_fail`). Human fallback steps hang off the NO branch of the SYS step.
- **Flowchart conditions render as if/else decision diamonds**: a rotated-square diamond
  holds the condition, with YES (down, main flow) and NO (right, to human box) exits.
  See `DecisionDiamond` / `NoArm` in `Orchestrator.jsx`.
- Match surrounding Tailwind/style idiom. Actor coloring: system = sky/blue, human = pink,
  conditions = amber.

## Change Log

Newest first. Add an entry for each change made by Claude Code.

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
  - Workflow: PG missing now **blocks the row → human review** (`human.reviewMissingPg`,
    `pg_missing_blocks_patient`), no longer auto-creates; `reference_records_ready` gates
    on PG. Added `objectLifecycle()` for the lifecycle view.
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
