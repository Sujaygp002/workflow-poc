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
- Added four trigger layers:
  - Trigger 1: onboarding successful starts the ongoing area monitor.
  - Trigger 2: HHAH uploads Excel + PDF ZIP, which starts wf7.
  - Trigger 3: Send To Physician sends ready unsigned orders to the PG signing bucket.
  - Trigger 4: Make Patients Billable runs every 10 seconds from Orchestrator while Live is enabled.
- Upload workflow processing now runs patient instances in parallel instead of stopping the whole run on the first blocked patient. A blocked patient waits on human work while other patients continue.
- wf7 no longer checks/branches on physician group or practitioner existence. PG/practitioner data can still be stored if present, but missing PG/NPI will not create a workflow task or block patient/order processing.
- Latest wf7 object model:
  - Patient Unit is the stable person identity keyed by name + DOB + MRN.
  - Patient Record is the care context keyed by Patient Unit + HHAH + PG.
  - A changed HHAH/PG creates a new Patient Record under the same Unit; unit-only changes update the existing Unit/Record.
  - Admission is resolved after SOC is present, and Episode is resolved after SOE/EOE are present.
  - Duplicate order numbers are skipped and logged; existing orders are not overwritten or deleted.
- Patient Unit is now treated as the source of truth for identity fields. Patient reads prefer `patient_units.name/dob/mrn/sex`; duplicate identity columns on `patients` are deprecated compatibility fields.
- Patient archive display is computed at read time, not persisted:
  - Patient Unit -> Patient Record -> Admission Archive + Latest Admission -> Episode Archive + Latest Episode -> Order Archive + Signed/Unsigned Orders.
  - Older admissions archive only when the next newer admission exists and `nextAdmission.SOC - oldAdmission.EOC >= 90 days`.
  - Archived admissions cascade all child episodes and orders into archive.
  - Inside the latest admission, the latest episode stays current; earlier episodes and their orders show in archive.
  - Latest episode orders split into signed and unsigned using `order_status.SignedByPhysician_Status === true` plus legacy-compatible signed reads.
  - UI dates render as `MM/DD/YYYY`.
  - Archived orders are displayed inside their archived episode cards; duplicate standalone archive-order sections are hidden.
  - Prior admissions that do not meet the archive gap rule are not shown in the Patient hierarchy UI.
- Seed data now includes demo Patient Unit `Maya Thompson / MRN-DEMO-ARCHIVE-001`:
  - two Patient Records under the same Patient Unit,
  - one archived Patient Record,
  - one archived admission,
  - one prior admission that does not archive because the next SOC gap is under 90 days,
  - one latest admission,
  - one episode archive,
  - one latest episode,
  - archived, signed, and unsigned orders.
- CPO Month is now a module under Episode:
  - Table: `cpo_months`.
  - Fields: `episode_id`, `cpo_month`, `cpo_min`, `status`, `reason`.
  - CPO month is billable when its episode is billable and `cpo_min >= 30`.
- Episode status rules:
  - Eligible: episode has a 485 cert/recert order and the admission has an F2F order within 180 days of episode EOE.
  - Billable: eligible and all episode orders are signed.
  - Patient status follows the latest episode status.

## HHH Portal

- New route: `/hhh-login`.
- Login credentials:
  - Username: `test123`
  - Password: `test123`
- After login, the HHH portal shows:
  - DB-backed Home Health agency selection from existing HHAH reference records.
  - Bulk upload form for one `.xlsx` workbook.
  - Unsigned and signed ZIP upload fields for order PDFs.
  - Patient browsing section.
  - Patient flow chart: patient -> admissions -> episodes -> orders.
  - Patients, orders, upload scope, and missing-upload notifications filtered to the selected HHAH.

## PG Portal

- New route: `/pg-login`.
- Login credentials:
  - Username: `test123`
  - Password: `test123`
- Screens:
  - Dashboard: placeholder / coming soon.
  - DB-backed physician group selection from existing PG reference records.
  - Bulk Sign: lists orders sent to physician and not yet signed for the selected PG.
- Bulk Sign writes only:
  - `order_status.SignedByPhyscianDate = YYYY-MM-DD`
  - `order_status.SignedByPhysician_Status = true`
- Trigger 3 Send To Physician writes only:
  - `order_status.SentToPhysicianDate = YYYY-MM-DD`
  - `order_status.SendToPhysician_Status = true`

## Upload Rules

- Excel workbook expects two sheets:
  - Sheet 1: patient/admission/episode rows.
  - Sheet 2: order rows.
- Order PDFs can be uploaded inside one ZIP file.
- PDF matching rule:
  - PDF filename without `.pdf` must match `order_number` from the order sheet.
  - Example: order number `ORD-1001` should use `ORD-1001.pdf`.
- Matched PDF metadata is stored on each workflow item as `extraction_payload.pdf`. New orders require both required order fields and a matched PDF before `order.create`; otherwise the row routes to `human.fixOrderFields`.
- HHH portal and Trigger 2 uploads use the selected DB-backed HHAH. When that HHAH is linked to an area, the upload sends the DB `areaId` as scope so the area monitor can show received vs missing uploads.

## New API Routes

- `GET /api/orders`
  - Returns uploaded/created orders with patient, HHAH, PG, and practitioner links.
- `GET /api/orders?hhahId=<id>`
  - Returns uploaded/created orders scoped to one HHAH.
- `GET /api/orders?pgUnsigned=1&pgId=<id>`
  - Returns PG orders that were sent to physician and are not signed.
- `POST /api/orders` with `{ "action": "bulkSign" }`
  - Bulk signs selected PG orders.
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
- `POST /api/workflow-runs` with `{ "action": "runBillingMonitor" }`
  - Runs Trigger 4 billing monitor, recomputes statuses, creates missing CPO months, and creates manual tasks for missing signatures or CPO minutes.
- `GET /api/work-items?userId=u1`
  - Returns pending/completed human work for a dummy user.
- `POST /api/work-items/:taskRunId/complete`
  - Completes a human task and resumes workflow automation.
- `GET /api/patients`
  - Returns patients with admission/episode/order counts.
- `GET /api/patients?hhahId=<id>`
  - Returns patient records scoped to one HHAH.
- `GET /api/patients?view=units`
  - Returns Patient Unit summaries for the Admin Patients hierarchy page.
- `GET /api/patients/:id`
  - Returns patient tree data plus `unitHierarchy` with current/archive patient record, admission, episode, and order buckets.

## Frontend Changes

- `/triggers` is back in FlowPOC and starts the DB-backed bulk upload trigger.
- `/triggers` now shows a cleaned four-trigger overview and the Trigger 2 bulk-upload form. Internal condition flags were removed from this screen.
- `/builder/workflows` now pulls only DB workflow definitions and no longer shows local dummy workflows.
- `/builder/workflows` shows Trigger 4 under independent monitors, not as `END -> Trigger 4` after the Trigger 2/3 chain.
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
- `/patients` shows the Admin Patient Unit hierarchy with admission-based archive buckets.
- `/hhh-login` reuses the same Patient Unit hierarchy component inside the patient detail panel.
- `/reference-data` shows practitioners, physician groups, HHAH records, and supports mapping PG to practitioner.
- `/worker` and `/worker/bucket/:userId` use DB-backed worker users and show DB-assigned tasks only.
- `/worker` now loads worker users from the DB, requires selecting a worker plus `test123` / `test123`, stores the selected worker in session storage, and opens `/worker/bucket/:userId` for that DB worker.
- `/worker/bucket/:userId` reads worker identity from the DB users endpoint rather than local browser store.
- Worker task cards show matched order PDF side-by-side with the record.
- Missing fields are highlighted and can be entered before completing the human task.
- wf7 now treats Admission and Episode as explicit objects through the date-check branches: `admission.resolve` writes/reuses Admission after SOC is ready, and `episode.resolve` writes/reuses Episode after SOE/EOE are ready.
- `wf-signing` starts after a written order has an uploaded document. It checks signing readiness, routes document fixes to a human when needed, sends to physician, immediately checks whether the physician signed, then either updates signed status automatically or creates a manual `Email Physician — Signature Overdue` task. There is no 48-hour wait in Trigger 3.
- `wf-billing-monitor` displays as one mega task: `Make Patients Billable`.
  - Trigger 4 groups new billing-monitor tasks HHAH by HHAH: one run per HHAH with patient/episode/CPO issues as items inside that run.
  - System: Check If Patient Is Eligible.
  - If not eligible: manual `Email HHAH — Missing Document` task using SMTP.
  - If eligible: system Check If Patient Is Billable.
  - If not billable due to signature: manual `Email Physician/PG To Sign` task using SMTP.
  - If CPO month is not billable: manual `Add 30 Min CPO` task.
- Skipped duplicate orders do not start `wf-signing`; only newly written orders continue into the signing follow-up.
- `/hhh-login` is a standalone route without the builder sidebar and is not shown inside FlowPOC navigation.
- `/hhh-login` includes patient and order browsing after upload; order detail opens the matched PDF instead of JSON.
- `/pg-login` is also a standalone route without the builder sidebar.
- Work Bucket supports Trigger 4 manual tasks:
  - physician signature reminder email,
  - CPO minutes capture with a minimum of 30 minutes.

## Notes

- Use production URL: `https://workflow-poc-tawny.vercel.app`.
- Environment values are currently hardcoded in `api/_lib/config.js` for personal testing.
- For real production use, move secrets back to environment variables and rotate exposed keys.
- Vercel Blob is used when `BLOB_READ_WRITE_TOKEN` is configured; otherwise uploads can still run but PDF blob storage is skipped.
- Verification notes from 2026-06-13:
  - `npm run lint` passed.
  - `npm run build` passed.
  - Migration history was later collapsed into fresh `001_core_intake.sql`; use `npm run db:reset` only when a clean destructive reset is intended, then `npm run db:seed`.
  - Area monitor DB smoke tests passed for all-upload, one-missing, and late-upload-after-notification scenarios.
  - A full 10-patient/30-order DB smoke test was started but stopped because the current per-task Neon round trips were taking too long; temporary rows were cleaned up.
- Verification notes from 2026-06-20:
  - `npm run lint` passed.
  - `npm run build` passed.
  - Scoped portal/API paths no longer contain hardcoded `Boise Home Health` or `Lakeside Family Practice` behavior.
  - Worker login DB-user update: `npm run lint` passed and `npm run build` passed.
