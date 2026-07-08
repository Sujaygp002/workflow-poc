# Database Schema — every table, column, relationship (Neon/Postgres)

**Source:** `db/migrations/001_core_intake.sql`, `db/migrations/002_cpo_billing_monitor.sql`, `db/migrations/003_identity_and_builder.sql`, `db/migrations/004_rcm_pipeline.sql`
**Read this when:** adding/changing a table or column, understanding a foreign key, or writing a migration. Migrations are ADDITIVE and applied idempotently by `scripts/migrate.js` (`npm run db:migrate`).

## The object model (hierarchy)
```
patient_units (identity: name|DOB|MRN)
  └─ patients (Patient Record: unit|HHAH|PG)
       └─ patient_admissions (by SOC/EOC)
            └─ patient_episodes (by SOE/EOE)  ──► cpo_months (by month)
                 └─ orders (by order_number)
```
Reference: `home_health_agencies`, `physician_groups`, `practitioners` + link tables `patient_physician_groups`, `patient_practitioners`.
Workflow runtime: `workflow_definitions` → `workflow_runs` → `workflow_items` → `workflow_task_runs`; plus `uploaded_documents`, `ai_extractions`.
Identity (v2): `employees`, `external_users`, `auth_sessions`.
Area monitor (Trigger 1): `statistical_areas`, `statistical_area_hhahs`, `area_intake_checks`, `missing_upload_notifications`.

## Tables & key columns
| Table | PK | Identity / UNIQUE | Notable FKs | Notes |
|---|---|---|---|---|
| `patient_units` | id (uuid) | `unit_key` UNIQUE | — | stable person; `name,dob,mrn,sex,personal_information,insurance_details,family` |
| `patients` | id | `record_context_key` UNIQUE | `unit_id`→units, `agency_id`→hhah, `pg_id`→pg | Patient Record; `hhah_name,pg_name,admission_details`, `latest_episode_status`(+reason) [002] |
| `patient_admissions` | id | UNIQUE`(patient_id,soc,eoc)` | `patient_id`, `agency_id`, `pg_id`, `care_provider_id`→practitioners | |
| `patient_episodes` | id | UNIQUE`(admission_id,soe,eoe)` | `admission_id` | `diagnosis_codes[]`; `status`(started/eligible/billable…)+`status_reason` [002] |
| `orders` | id | `order_number` UNIQUE | `patient_id,admission_id,episode_id,agency_id,pg_id,billing_provider_id,supervising_provider_id` | `order_status` jsonb (sent/signed flags), `document_type` |
| `cpo_months` [002] | id | UNIQUE`(episode_id,cpo_month)` | `episode_id` | `cpo_min`, `status`(not_billable/billable), `reason` |
| `home_health_agencies` | id | `normalized_name` UNIQUE | — | `contact_info` jsonb |
| `physician_groups` | id | `normalized_name` UNIQUE | — | `contact_info.physician_ids[]` = mapped practitioners |
| `practitioners` | id | `npi_digits` UNIQUE | — | `physician_name`, `history` jsonb (`PG_names`) |
| `patient_physician_groups` | id | UNIQUE`(patient_id,pg_id)` | patient, pg | direct 0..* link |
| `patient_practitioners` | id | UNIQUE`(patient_id,practitioner_id)` | patient, practitioner | direct 0..* link |
| `workflow_definitions` | (id,version) | partial UNIQUE`(id) WHERE active` | — | `definition` jsonb; `kind`('system'/'builder') + `created_by` [003] |
| `workflow_runs` | id | — | `(workflow_id,workflow_version)`→definitions, `area_id`, `hhah_id` | `status`, `total_items`, `input_summary` |
| `workflow_items` | id | UNIQUE`(run_id,item_index)` | `run_id` | `patient_key,order_key`, the four payload jsonbs, `decisions` (condition cache), `status` |
| `workflow_task_runs` | id | UNIQUE`(item_id,step_id)` | `run_id,item_id`, `assigned_to`→users, `assigned_employee_id`→employees [003] | `status,condition,input,output`; `opened_at`,`actions`,`action_state` [003] |
| `uploaded_documents` | id | — | `run_id`, `hhah_id` | `blob_url/blob_path` |
| `ai_extractions` | id | — | `item_id`, `document_id`→uploaded_documents | Gemini output |
| `employees` [003] | id | `username` UNIQUE | — | `password_hash`(scrypt), `totp_secret`(generated at creation, **unused by login — legacy**), `totp_enabled`, `display_name`, `job_role`, `active` |
| `external_users` [003] | id | `username` UNIQUE | `agency_id`,`pg_id`,`practitioner_id` | `user_type`,`role`,`npi`; CHECKs below |
| `auth_sessions` [003] | id | `token_hash` UNIQUE | — | `principal_type/id`, `stage`, `expires_at`, `meta` |
| `statistical_areas` | id | UNIQUE`(name,area_type)` | — | Trigger-1 area |
| `statistical_area_hhahs` | id | UNIQUE`(area_id,hhah_id)` | area, hhah | expected upload window |
| `area_intake_checks` | id | UNIQUE`(area_id,check_date)` | area | monitoring status |
| `missing_upload_notifications` | id | UNIQUE`(area_check_id,hhah_id)` | area_check, area, hhah | queued/sent/failed |
| `rcm_records` [004] | id (uuid) | UNIQUE `(episode_id, cpo_month, cpt_code)` | `agency_id`, `patient_id`, `episode_id` | `cpt_code` (G0179/G0180/G0181/G0182), `amount_cents`, `status` (generated/…), `payload` jsonb; indexes on `agency_id`, `patient_id`; written by `referenceLogic/rcm.js` |
| `audit_records` [004] | id (uuid) | — | `rcm_record_id`→rcm_records (CASCADE) | `agency_id`, `status` (pending/rework/done/sent), `rule_results` jsonb (structured findings `[{rule,code,field,message,fixable}]`), `change_log` jsonb; written/updated by `referenceLogic/audit.js` + `rework.js`; indexed on `rcm_record_id`, `agency_id` |
| `users` | id (text) | — | — | legacy dummy worker pool; `workflow_task_runs.assigned_to` FK; superseded by `employees` |
| `schema_migrations` | id (text) | — | — | applied-migration ledger |

## Constraints worth knowing
- `workflow_definitions_one_active`: partial UNIQUE index on `(id) WHERE active` → **at most one active version per workflow id** (drives `saveWorkflow`'s deactivate-then-upsert).
- `external_users` CHECKs: `user_type='hhah'⇒agency_id NOT NULL`; `user_type='pg'⇒pg_id NOT NULL`; `role='practitioner'⇒practitioner_id NOT NULL`.
- `workflow_task_runs UNIQUE(item_id,step_id)` → `createTaskRunsForItem` uses `ON CONFLICT DO NOTHING` (safe re-runs).
- Cascade deletes flow down the hierarchy (unit→record→admission→episode→order via `ON DELETE CASCADE`) and run→items→task-runs; deleting a run does NOT delete created patients/orders.

## Migration layering
- **001** = the whole core model in one file (units/records/admissions/episodes/orders, reference, workflow runtime, area monitor, `users`).
- **002** = CPO + status snapshots (adds `patient_episodes.status`, `patients.latest_episode_status`, `cpo_months`).
- **003** = v2 identity + builder (adds `employees`, `external_users`, `auth_sessions`; `workflow_definitions.kind/created_by`; `workflow_task_runs.assigned_employee_id/opened_at/actions/action_state`).
- **004** = RCM pipeline (adds `rcm_records` + `audit_records`; both `IF NOT EXISTS`; owned by `api/_lib/referenceLogic/rcm.js` + `audit.js` + `rework.js`).

## Invariants & gotchas
- **Migrations must stay additive** (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) so deployed code keeps working between `db:migrate` and code deploy. Never drop/rename core tables in a new migration.
- The v2 bucket columns are on `workflow_task_runs` — the legacy `assigned_to`(→`users`) column stays NULL; the active assignment is `assigned_employee_id`(→`employees`). Two FKs, different eras.
- Date columns come back from Neon as JS `Date` objects — always coerce via `parseDate`/`dateOnly` (see [utils](../backend/lib/utils.md)); never string-slice.
- jsonb-heavy design: order status, decisions, payloads, contact_info are all jsonb — filter with `->>`/`->` in SQL, and remember jsonb defaults (`'{}'`,`'[]'`).
- `npm run db:wipe` TRUNCATEs data tables but keeps the schema + `schema_migrations`; system workflow definitions re-upsert on demand (`ensureSystemDefinitions`).

## Change recipes
1. **Add a table/column:** create `db/migrations/00N_*.sql` with `IF NOT EXISTS` DDL; run `npm run db:migrate`. Add reads/writes in [repositories](../backend/lib/repositories.md); document here.
2. **Add a workflow-runtime field:** most live on `workflow_items` (payloads/decisions) or `workflow_task_runs` (actions/state) — extend via migration 003-style `ADD COLUMN IF NOT EXISTS`, then `createTaskRunsForItem`/`createWorkflowItem` in [repositories](../backend/lib/repositories.md).
3. **Change identity/dedup keys:** the `*_key` UNIQUE columns here must agree with `normalizers.js` — see [patient model](../business/patient-model.md).

## Related
- [patient model](../business/patient-model.md) — the identity/reuse rules these constraints enforce
- [orders & signing](../business/orders-and-signing.md) — `orders.order_status` semantics
- [eligibility & billing](../business/eligibility-billing.md) — `patient_episodes.status`, `cpo_months`
- [auth model](../business/auth-model.md) — `employees`/`external_users`/`auth_sessions` CHECKs
- [repositories](../backend/lib/repositories.md) — the SQL over these tables
- [ops & deploy](../ops/scripts-and-deploy.md) — `db:migrate`/`db:wipe`
