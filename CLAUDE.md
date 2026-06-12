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

- **2026-06-12** — Orchestrator DB bulk view (`DbBulkInstanceCard`): replaced the inline
  condition chip with real if/else **decision diamonds**. Added `DecisionDiamond` and
  `NoArm` components; reworked `row()` so a SYS step forks via a diamond (YES continues
  down, NO → human fallback box). Rows without a fallback render as a single box.
- **2026-06-12** — Hardcoded credentials as fallbacks in `api/_lib/config.js`
  (`DATABASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `BLOB_READ_WRITE_TOKEN`) for personal
  Vercel testing; wired `db.js`, `gemini.js`, `blobStore.js`, `taskRegistry.js` to read
  from `config.js`. Secrets are committed to public git history — rotate before any real use.
- **2026-06-12** — Created this CLAUDE.md.
