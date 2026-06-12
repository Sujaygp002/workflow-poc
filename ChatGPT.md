# ChatGPT Implementation Notes

## Current State

- Added a DB-backed bulk workflow (`wf7`) for HHH patient and order intake.
- Workflow definitions, runs, items, task runs, patient records, admissions, episodes, orders, practitioners, physician groups, and HHAH records are stored in Neon/Postgres.
- Task code remains in the codebase under `api/_lib/taskRegistry.js`.
- The wf7 workflow is seeded into the DB and can be visualized from the Workflows UI.
- Dummy users remain Alice (`u1`), Bob (`u2`), and Carol (`u3`).
- Human tasks are now assigned randomly across the seeded users.

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

## New API Routes

- `GET /api/orders`
  - Returns uploaded/created orders with patient, HHAH, PG, and practitioner links.
- `GET /api/reference-data`
  - Returns practitioners, physician groups, and HHAH records.
- `POST /api/reference-data/map-pg-practitioner`
  - Maps a physician group to a practitioner by updating the DB JSON link fields.
- `POST /api/workflows/bulk-upload/start`
  - Starts the DB-backed wf7 workflow from Excel and optional ZIP/PDF uploads.
- `GET /api/workflows`
  - Returns active DB workflow definitions for visualization.
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
- `/builder/workflows` now pulls only DB workflow definitions and no longer shows local dummy workflows.
- `/orchestrator` now shows only DB workflow runs and renders wf7 as one aggregate loop body instead of one repeated flow per patient/order row.
- `/orchestrator` and `/builder/workflows` show condition markers as diamond decision blocks; the wf7 loop is shown with a large curved repeat arrow.
- The wf7 orchestrator diamonds now label the real branch truth: missing-date checks route YES to manual date entry, and patient/order exists checks route YES to update and NO to create.
- `/orchestrator` object lifecycle excludes HHAH from created/updated/found counts because HHAH comes from the login context.
- `/orders` shows order records, patient/reference details, and the matched order PDF.
- `/orders` and `/hhh-login` show explicit Eligible and Billable chips from the computed episode status.
- `/reference-data` shows practitioners, physician groups, HHAH records, and supports mapping PG to practitioner.
- `/worker` and `/worker/bucket/:userId` use the dummy users but show DB-assigned tasks only.
- Worker task cards show matched order PDF side-by-side with the record.
- Missing fields are highlighted and can be entered before completing the human task.
- wf7 now treats Admission and Episode as explicit objects and has manual fallback tasks for missing SOC and missing SOE/EOE before admission object/episode object matching.
- `/hhh-login` is a standalone route without the builder sidebar and is not shown inside FlowPOC navigation.
- `/hhh-login` includes patient and order browsing after upload; order detail opens the matched PDF instead of JSON.

## Notes

- Environment values are currently hardcoded in `api/_lib/config.js` for personal testing.
- For real production use, move secrets back to environment variables and rotate exposed keys.
- Vercel Blob is used when `BLOB_READ_WRITE_TOKEN` is configured; otherwise uploads can still run but PDF blob storage is skipped.
