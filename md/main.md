# Command Center — Codebase Map (AI entry point)

**Read this file first, then hop to exactly ONE doc below, then read only the source files that doc names.** Do not read the whole tree. Each doc is self-contained: it lists its source files, contracts, invariants, and change recipes.

## System in 10 lines
Command Center is a DB-backed workflow platform for home-health (HHH) patient + order intake.
- **Stack:** Vite + React + Tailwind SPA (`src/`), Vercel serverless functions (`api/`), Neon/Postgres over the serverless HTTP driver (`db/migrations`), Google Gemini (PDF field extraction), Vercel Blob (PDFs), nodemailer (best-effort email).
- **Four surfaces:** Command Center admin SPA (Workflow builder, Orchestrator, Coverage Map, Employees, Entity, External Users) · Worker portal `/worker` (username + password login, three task buckets) · HHAH portal `/hhh-login` (upload) · PG portal `/pg-login` (admin dashboard / practitioner Bulk Sign). All four use single-factor password authentication.
- **Core loop:** an HHAH uploads documents → a workflow run starts (one item per row) → system steps run automatically, conditions branch, human **tasks** land in the assigned employee's **Untouched** bucket → the employee opens (Processing) and completes (Done, server-validated) → orders get sent → a PG practitioner bulk-signs.
- **Workflows are user-built** in a no-code builder (trigger + system actions + if/else conditions + employee-assigned tasks-of-actions), stored as editable JSON and compiled to the engine's `steps[]`.

## Routing table — "I want to change…" → read this ONE doc
| I want to change… | Read this doc | Primary source files |
|---|---|---|
| How an upload becomes a run / items / tasks | [business/intake-pipeline](business/intake-pipeline.md) | `api/workflows/bulk-upload/start.js`, `api/_lib/workflowEngine.js` |
| What counts as "the same patient"; create vs reuse patient/admission/episode; PG-change fork | [business/patient-model](business/patient-model.md) | `api/_lib/normalizers.js`, `api/_lib/repositories.js` |
| Order create/dedup, mark sent, mark signed, bulk sign, wf-signing | [business/orders-and-signing](business/orders-and-signing.md) | `api/_lib/repositories.js`, `api/_lib/workflowEngine.js` |
| Eligible/billable logic, CPO months, billing monitor (Trigger 4) | [business/eligibility-billing](business/eligibility-billing.md) | `api/_lib/repositories.js`, `api/workflow-runs/index.js` |
| Builder graph JSON, triggers, bucket lifecycle, validation-retry semantics | [business/builder-workflows](business/builder-workflows.md) | `api/_lib/builderCatalog.js`, `api/_lib/builderCompiler.js` |
| Who can log in where, login policy, roles, portal scoping | [business/auth-model](business/auth-model.md) | `api/_lib/auth.js`, `api/auth/index.js` |
| Add/modify a **system action** (a computer step) | [backend/lib/builder-catalog](backend/lib/builder-catalog.md) | `api/_lib/builderCatalog.js`, `api/_lib/taskRegistry.js` |
| Add/modify a **human action** (checklist item) or its validation | [backend/lib/builder-catalog](backend/lib/builder-catalog.md) + [backend/lib/task-registry](backend/lib/task-registry.md) | `api/_lib/builderCatalog.js`, `api/_lib/taskRegistry.js` |
| Add/modify a **condition** (yes/no question) | [backend/lib/builder-catalog](backend/lib/builder-catalog.md) + [backend/lib/task-registry](backend/lib/task-registry.md) | `api/_lib/builderCatalog.js`, `api/_lib/taskRegistry.js` |
| How the builder graph compiles to engine steps / branch+join | [backend/lib/builder-compiler](backend/lib/builder-compiler.md) | `api/_lib/builderCompiler.js` |
| The engine loop, task activation, `completeHumanTask`, retry | [backend/lib/workflow-engine](backend/lib/workflow-engine.md) | `api/_lib/workflowEngine.js` |
| A wf7 / wf-signing / billing / area system workflow definition | [backend/lib/workflow-definitions](backend/lib/workflow-definitions.md) | `api/_lib/workflowDefinition.js` |
| Any SQL / repository function | [backend/lib/repositories](backend/lib/repositories.md) | `api/_lib/repositories.js` |
| Password hashing, TOTP, sessions, adding an auth guard | [backend/lib/auth](backend/lib/auth.md) | `api/_lib/auth.js` |
| Employee / external-user / session SQL | [backend/lib/identity-repo](backend/lib/identity-repo.md) | `api/_lib/identityRepo.js` |
| Config/env, Neon client, HTTP helpers, email, Gemini, blob, multipart, normalizers, excelParser | [backend/lib/utils](backend/lib/utils.md) | `api/_lib/{config,db,http,mailer,gemini,blobStore,multipart,normalizers,excelParser}.js` |
| The Daily Agency Intake → RCM Pipeline modules (agency upload check, extraction, CC-note/CPO service, RCM billing records, audit R1–R4, rework; `businessRules.js` pure utility library from BusinessRequirementsService.cs) | [backend/lib/reference-logic](backend/lib/reference-logic.md) | `api/_lib/referenceLogic/{agencyCheck,extraction,aiService,rcm,audit,rework,businessRules}.js` |
| The login / employee / external-user API (`/api/auth`) | [backend/routes/auth](backend/routes/auth.md) | `api/auth/index.js` |
| Save/list/delete builder workflows, the builder palette (`catalog`) | [backend/routes/workflows](backend/routes/workflows.md) | `api/workflows/index.js` |
| List runs (Orchestrator feed), manual/time triggers, billing monitor, delete run | [backend/routes/workflow-runs](backend/routes/workflow-runs.md) | `api/workflow-runs/index.js`, `[id].js` |
| Worker buckets, open a task, complete a task | [backend/routes/work-items](backend/routes/work-items.md) | `api/work-items/index.js`, `[taskRunId]/complete.js` |
| The upload endpoint (auth, multipart, target workflows) | [backend/routes/bulk-upload](backend/routes/bulk-upload.md) | `api/workflows/bulk-upload/start.js` |
| Patients/orders/entities/area reads, entity creation, PG-practitioner map, bulk sign | [backend/routes/data-reads](backend/routes/data-reads.md) | `api/patients/*`, `api/orders/index.js`, `api/reference-data/index.js`, `api/area-intake/index.js` |
| Add a page/route, sidebar nav, the worker entry, deploy routing | [frontend/app-shell](frontend/app-shell.md) | `src/App.jsx`, `src/WorkerApp.jsx`, entries, `vite.config.js`, `vercel.json` |
| A client API call contract (data/builder/bucket/auth) | [frontend/lib](frontend/lib.md) | `src/lib/workflowApi.js`, `src/lib/authApi.js`, `src/lib/dateFormat.js` |
| The flowchart renderer, patient tree, record card, Badge/Modal | [frontend/components](frontend/components.md) | `src/components/*.jsx` |
| The workflow builder UI or the workflow list | [frontend/pages/builder](frontend/pages/builder.md) | `src/pages/builder/WorkflowBuilder.jsx`, `WorkflowList.jsx` |
| The worker portal UI (login, buckets, task detail) | [frontend/pages/worker](frontend/pages/worker.md) | `src/pages/worker/WorkerPortal.jsx`, `WorkerTaskDetail.jsx` |
| Employees / Entity / External Users pages | [frontend/pages/admin](frontend/pages/admin.md) | `src/pages/employees/`, `entity/`, `external/` |
| The `/hhh-login` or `/pg-login` portal UI | [frontend/pages/portals](frontend/pages/portals.md) | `src/pages/hhh/HhhLogin.jsx`, `src/pages/pg/PgLogin.jsx` |
| The Orchestrator or the Coverage Map | [frontend/pages/monitoring](frontend/pages/monitoring.md) | `src/pages/orchestrator/Orchestrator.jsx`, `src/pages/map/` |
| A table, column, foreign key, or write a migration | [db/schema](db/schema.md) | `db/migrations/001_core_intake.sql`, `002_cpo_billing_monitor.sql`, `003_identity_and_builder.sql` |
| npm scripts, DB scripts, deploy, env/credentials, the 12-function cap | [ops/scripts-and-deploy](ops/scripts-and-deploy.md) | `package.json`, `scripts/*.js`, `vite.config.js`, `vercel.json`, `api/_lib/config.js` |

## The tree
```
md/
├── main.md                         ← you are here (router)
├── business/                       ← the WHAT + WHY (product rules → code)
│   ├── intake-pipeline.md          upload → parse → run → tasks → signing chain
│   ├── patient-model.md            unit/record identity, admission/episode reuse, PG fork
│   ├── orders-and-signing.md       order lifecycle, dedup, sent→signed, bulk sign
│   ├── eligibility-billing.md      eligible/billable, CPO months, billing monitor
│   ├── builder-workflows.md        graph JSON, triggers, buckets, validation-retry
│   └── auth-model.md               employees vs external users, 2FA, sessions, scoping
├── backend/
│   ├── lib/                        ← the engine + primitives
│   │   ├── auth.md · identity-repo.md · builder-catalog.md · builder-compiler.md
│   │   ├── task-registry.md · workflow-engine.md · workflow-definitions.md
│   │   ├── repositories.md · utils.md · reference-logic.md
│   └── routes/                     ← the HTTP surface (12 serverless functions)
│       ├── auth.md · workflows.md · workflow-runs.md · work-items.md
│       ├── bulk-upload.md · data-reads.md
├── frontend/
│   ├── app-shell.md · lib.md · components.md
│   └── pages/                      builder.md · worker.md · admin.md · portals.md · monitoring.md
├── db/schema.md                    every table + relationship
└── ops/scripts-and-deploy.md       scripts, deploy, env
```

## Rules for AI sessions
1. **Route, don't read everything.** Find your intent in the table above → open ONE doc → read only the source files it names. That is the whole point of this tree — minimal tokens per change.
2. **Business vs mechanics:** `business/*` explains rules + points at code; `backend/*`/`frontend/*` give exact contracts. For a behavior change, read the business doc; for a signature/SQL change, read the specific lib/route/page doc.
3. **12-serverless-function cap (Vercel Hobby):** `api/` is at exactly 12 files. Add capability as a POST `action` on an existing handler, NOT a new `api/*` file. See [ops](ops/scripts-and-deploy.md).
4. **Migrations are additive & idempotent** (`CREATE/ALTER … IF NOT EXISTS`) so deployed code survives the migrate→deploy gap. Never drop/rename core tables. See [db/schema](db/schema.md).
5. **Dates:** Neon returns `Date` objects — always coerce via `parseDate`/`dateOnly` ([utils](backend/lib/utils.md)); never string-slice a date.
6. **Identity/dedup keys** (`patientKey`/`unitKey`/`recordContextKey` in `normalizers.js`) must match the DB `*_key` UNIQUE columns — changing one reshapes joins + dedup everywhere.
7. **After you change code:** update the CLAUDE.md Change Log (newest first — project rule) AND edit the ONE md doc whose area you changed so this tree stays true.
8. **Line numbers rot — these docs reference file paths + function names.** If a function moved, grep for its name; don't trust a stale line number anywhere.

## Also see
- `CLAUDE.md` (repo root) — conventions + dated Change Log of past changes. CLAUDE.md is a supplement (project conventions + history), not a competing second source of truth — this `md/` tree is the authoritative documentation source.
- `ChatGPT.md` (repo root) — **legacy/stale**; references removed test123 credentials and dummy users that no longer exist. Superseded by this `md/` tree. Do not rely on it.
- [GLOBAL.md](GLOBAL.md) — single-file distillation of the entire `md/` tree; use it for a full-system overview without reading every doc.
- The user guide PDF / demo video document the product for humans; this tree documents the code for AI.
