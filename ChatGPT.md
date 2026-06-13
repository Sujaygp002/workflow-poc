# ChatGPT Implementation Notes

## Current State

- Added a DB-backed bulk workflow (`wf7`) for HHH patient and order intake.
- Workflow definitions, runs, items, task runs, patient records, admissions, episodes, orders, practitioners, physician groups, and HHAH records are stored in Neon/Postgres.
- Task code remains in the codebase under `api/_lib/taskRegistry.js`.
- The wf7 workflow is seeded into the DB and can be visualized from the Workflows UI.
- Dummy users remain Alice (`u1`), Bob (`u2`), and Carol (`u3`).
- Human tasks are now assigned randomly across the seeded users.
- Added area-based intake orchestration for the POC:
  - Statistical Area can be `micro_statistical_area` or `metro_statistical_area`.
  - Seeded area: `Boise-Ada Metro Intake`.
  - Area links to expected HHAHs and tracks whether each HHAH uploaded within the daily 24-hour window.
  - Missing uploads create logged notification records in the DB; real email delivery can be wired later.
- Added three trigger layers:
  - Trigger 1: onboarding successful starts the ongoing area monitor.
  - Trigger 2: HHAH uploads Excel + PDF ZIP, which starts wf7.
  - Trigger 3: order document ready starts the signing follow-up workflow.
- Upload workflow processing now runs patient instances in parallel instead of stopping the whole run on the first blocked patient. A blocked patient waits on human work while other patients continue.
- wf7 no longer checks/branches on physician group or practitioner existence. PG/practitioner data can still be stored if present, but missing PG/NPI will not create a workflow task or block patient/order processing.
- Latest wf7 object model:
  - Patient Unit is the stable person identity keyed by name + DOB + MRN.
  - Patient Record is the care context keyed by Patient Unit + HHAH + PG.
  - A changed HHAH/PG creates a new Patient Record under the same Unit; unit-only changes update the existing Unit/Record.
  - Admission is resolved after SOC is present, and Episode is resolved after SOE/EOE are present.
  - Duplicate order numbers are skipped and logged; existing orders are not overwritten or deleted.

## HHH Portal

- New route: `/hhh-login`.
- Login credentials:
  - Username: `test123`
  - Password: `test123`
- After login, the HHH portal shows:
  - Bulk upload form for one `.xlsx` workbook.
  - Optional ZIP upload for order PDFs.
  - Patient browsing section.
  - Patient flow chart: patient -> admissions -> episodes -> orders.

## Upload Rules

- Excel workbook expects two sheets:
  - Sheet 1: patient/admission/episode rows.
  - Sheet 2: order rows.
- Order PDFs can be uploaded inside one ZIP file.
- PDF matching rule:
  - PDF filename without `.pdf` must match `order_number` from the order sheet.
  - Example: order number `ORD-1001` should use `ORD-1001.pdf`.
- Matched PDF metadata is stored on each workflow item as `extraction_payload.pdf`. New orders require both required order fields and a matched PDF before `order.create`; otherwise the row routes to `human.fixOrderFields`.
- HHH portal uploads are currently scoped to `Boise-Ada Metro Intake` / `Boise Home Health` so the area monitor can show received vs missing uploads.

## New API Routes

- `GET /api/orders`
  - Returns uploaded/created orders with patient, HHAH, PG, and practitioner links.
- `GET /api/reference-data`
  - Returns practitioners, physician groups, and HHAH records.
- `POST /api/reference-data/map-pg-practitioner`
  - Maps a physician group to a practitioner by updating the DB JSON link fields.
- `POST /api/workflows/bulk-upload/start`
  - Starts the DB-backed wf7 workflow from Excel and optional ZIP/PDF uploads.
  - Accepts optional `areaId`, `hhahId`, `areaName`, `areaType`, and `hhahName` to scope a run to an area/HHAH.
- `GET /api/area-intake`
  - Returns statistical areas, expected HHAHs, received/missing upload status, current check record, and notification records.
- `POST /api/area-intake`
  - Runs the simulated 24-hour area check and creates logged missing-upload notification records.
- `GET /api/workflows`
  - Returns active DB workflow definitions for visualization: area onboarding monitor, bulk upload, and document signing follow-up.
- `GET /api/workflow-runs`
  - Returns workflow run history with task runs.
- `GET /api/work-items?userId=u1`
  - Returns pending/completed human work for a dummy user.
- `POST /api/work-items/:taskRunId/complete`
  - Completes a human task and resumes workflow automation.
- `GET /api/patients`
  - Returns patients with admission/episode/order counts.
- `GET /api/patients/:id`
  - Returns patient tree data for the flow chart.

## Frontend Changes

- `/triggers` is back in FlowPOC and starts the DB-backed bulk upload trigger.
- `/triggers` now shows the three trigger concepts: onboarding successful, HHAH upload, and order document ready/signing.
- `/builder/workflows` now pulls only DB workflow definitions and no longer shows local dummy workflows.
- `/orchestrator` now shows only DB workflow runs and renders wf7 as one aggregate loop body instead of one repeated flow per patient/order row.
- `/orchestrator` now includes an Area Intake Monitor above workflow runs:
  - Shows selected statistical area.
  - Shows expected HHAHs.
  - Shows received/missing upload status.
  - Shows 24-hour check status and missing-upload notification status.
  - Shows onboarding successful as the top starter with separate upload-trigger and notification-trigger lanes.
  - Includes a POC button to simulate the 24-hour check.
- `/orchestrator` wf7 cards now show patient-parallel orchestration buckets:
  - blocked patients,
  - active AI tasks,
  - active system tasks,
  - active human tasks,
  - patients continuing.
- `/orchestrator` also shows one compact lane/card per patient with order count and current state.
- `/orchestrator` and `/builder/workflows` show condition markers as diamond decision blocks; the wf7 loop is shown with a large curved repeat arrow.
- The wf7 orchestrator diamonds now label the real branch truth: missing-date checks route YES to manual date entry, and patient/order exists checks route YES to update and NO to create.
- `/orchestrator` object lifecycle excludes HHAH from created/updated/found counts because HHAH comes from the login context.
- `/orders` shows order records, patient/reference details, and the matched order PDF.
- `/orders` and `/hhh-login` show explicit Eligible and Billable chips from the computed episode status.
- `/reference-data` shows practitioners, physician groups, HHAH records, and supports mapping PG to practitioner.
- `/worker` and `/worker/bucket/:userId` use the dummy users but show DB-assigned tasks only.
- Worker task cards show matched order PDF side-by-side with the record.
- Missing fields are highlighted and can be entered before completing the human task.
- wf7 now treats Admission and Episode as explicit objects through the date-check branches: `admission.resolve` writes/reuses Admission after SOC is ready, and `episode.resolve` writes/reuses Episode after SOE/EOE are ready.
- `wf-signing` starts after a written order has an uploaded document. It checks signing readiness, routes document fixes to a human when needed, sends to physician, waits for the 48-hour signature check, then updates signed status or logs an overdue physician email.
- Skipped duplicate orders do not start `wf-signing`; only newly written orders continue into the signing follow-up.
- `/hhh-login` is a standalone route without the builder sidebar and is not shown inside FlowPOC navigation.
- `/hhh-login` includes patient and order browsing after upload; order detail opens the matched PDF instead of JSON.

## Notes

- Environment values are currently hardcoded in `api/_lib/config.js` for personal testing.
- For real production use, move secrets back to environment variables and rotate exposed keys.
- Vercel Blob is used when `BLOB_READ_WRITE_TOKEN` is configured; otherwise uploads can still run but PDF blob storage is skipped.
- Verification notes from 2026-06-13:
  - `npm run lint` passed.
  - `npm run build` passed.
  - Migration history was later collapsed into fresh `001_core_intake.sql`; use `npm run db:reset` only when a clean destructive reset is intended, then `npm run db:seed`.
  - Area monitor DB smoke tests passed for all-upload, one-missing, and late-upload-after-notification scenarios.
  - A full 10-patient/30-order DB smoke test was started but stopped because the current per-task Neon round trips were taking too long; temporary rows were cleaned up.
