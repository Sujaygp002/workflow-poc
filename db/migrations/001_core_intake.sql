-- Migration 001 — Core HHAH Intake (fresh single schema)
-- Replaces the old 001/002/003 lineage. This is the single source of truth for
-- the restructured object model:
--
--   patient_units  (stable identity: name | DOB | MRN)
--     └─ patients  (Patient Record / care context: unit | HHAH | PG)
--          └─ patient_admissions  (by Start of Care)
--               └─ patient_episodes  (by SOE / EOE)
--                    └─ orders  (by order_number, attached to its episode)
--
-- A NEW Patient Record is created when the HHAH or PG changes for the same Unit;
-- otherwise the existing Record is reused. Orders are de-duplicated by
-- order_number and SKIPPED (never overwritten) when already present.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ── Users (dummy worker pool) ───────────────────────────────
CREATE TABLE users (
  id text PRIMARY KEY,
  name text NOT NULL,
  job_role text,
  access_level text,
  username text,
  contact_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Workflow definitions ────────────────────────────────────
CREATE TABLE workflow_definitions (
  id text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  name text NOT NULL,
  description text,
  definition jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

CREATE UNIQUE INDEX workflow_definitions_one_active
  ON workflow_definitions (id)
  WHERE active;

-- ── Reference data ──────────────────────────────────────────
CREATE TABLE physician_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  normalized_name text NOT NULL UNIQUE,
  npi text,
  type text,
  contact_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE home_health_agencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  normalized_name text NOT NULL UNIQUE,
  npi text,
  type text,
  type_of_service text,
  contact_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE practitioners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  npi_digits text NOT NULL UNIQUE,
  physician_name text,
  speciality text,
  contact_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  history jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Patient Unit: stable identity (name | DOB | MRN) ────────
CREATE TABLE patient_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_key text NOT NULL UNIQUE,           -- normalizeName(name)|lower(DOB)|normalizeName(MRN)
  name text NOT NULL,
  dob date,
  mrn text,
  sex text,
  personal_information jsonb NOT NULL DEFAULT '{}'::jsonb,
  insurance_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  family jsonb NOT NULL DEFAULT '{}'::jsonb,
  blood_group text,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Patient Record: care context for a Unit under a given HHAH + PG ──
-- record_context_key = unit_key | normalizeName(HHAH) | normalizeName(PG).
-- A new Record is created when HHAH or PG changes; same context reuses it.
CREATE TABLE patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL REFERENCES patient_units(id) ON DELETE CASCADE,
  record_context_key text NOT NULL UNIQUE,
  hhah_name text,
  pg_name text,
  agency_id uuid REFERENCES home_health_agencies(id),
  pg_id uuid REFERENCES physician_groups(id),
  name text NOT NULL,
  dob date,
  mrn text,
  sex text,
  age integer,
  personal_information jsonb NOT NULL DEFAULT '{}'::jsonb,
  insurance_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  admission_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX patients_unit_id_idx ON patients(unit_id);

-- ── Patient <-> Physician Group (direct, 0..* both sides) ──
CREATE TABLE patient_physician_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  pg_id uuid NOT NULL REFERENCES physician_groups(id) ON DELETE CASCADE,
  role text,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, pg_id)
);

CREATE INDEX patient_physician_groups_patient_idx ON patient_physician_groups(patient_id);

-- ── Patient <-> Practitioner (direct, 0..many) ──
CREATE TABLE patient_practitioners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  practitioner_id uuid NOT NULL REFERENCES practitioners(id) ON DELETE CASCADE,
  relationship text,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, practitioner_id)
);

CREATE INDEX patient_practitioners_patient_idx ON patient_practitioners(patient_id);

-- ── Admission: identified by patient + Start of Care ──
CREATE TABLE patient_admissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  soc date,
  eoc date,
  agency_id uuid REFERENCES home_health_agencies(id),
  pg_id uuid REFERENCES physician_groups(id),
  care_provider_id uuid REFERENCES practitioners(id),
  mrn text,
  ehr_record_number text,
  ehr_account_number text,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, soc, eoc)
);

CREATE INDEX patient_admissions_patient_id_idx ON patient_admissions(patient_id);

-- ── Episode: identified within an admission by SOE / EOE ──
CREATE TABLE patient_episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id uuid NOT NULL REFERENCES patient_admissions(id) ON DELETE CASCADE,
  soe date,
  eoe date,
  diagnosis_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (admission_id, soe, eoe)
);

CREATE INDEX patient_episodes_admission_id_idx ON patient_episodes(admission_id);

-- ── Order: de-duplicated by order_number, attached to its episode ──
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  order_type text,
  document_type text,
  order_date date,
  patient_id uuid REFERENCES patients(id),
  admission_id uuid REFERENCES patient_admissions(id),
  episode_id uuid REFERENCES patient_episodes(id),
  agency_id uuid REFERENCES home_health_agencies(id),
  pg_id uuid REFERENCES physician_groups(id),
  billing_provider_id uuid REFERENCES practitioners(id),
  supervising_provider_id uuid REFERENCES practitioners(id),
  order_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  order_admission_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_patient_id_idx ON orders(patient_id);
CREATE INDEX orders_episode_id_idx ON orders(episode_id);

-- ── Statistical areas (Trigger 1 monitor) ──────────────────
CREATE TABLE statistical_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  area_type text NOT NULL CHECK (area_type IN ('micro_statistical_area', 'metro_statistical_area')),
  state text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, area_type)
);

CREATE TABLE statistical_area_hhahs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_id uuid NOT NULL REFERENCES statistical_areas(id) ON DELETE CASCADE,
  hhah_id uuid NOT NULL REFERENCES home_health_agencies(id) ON DELETE CASCADE,
  expected_daily_upload_time time,
  upload_window_hours int NOT NULL DEFAULT 24,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (area_id, hhah_id)
);

CREATE INDEX statistical_area_hhahs_area_idx ON statistical_area_hhahs(area_id);

CREATE TABLE area_intake_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_id uuid NOT NULL REFERENCES statistical_areas(id) ON DELETE CASCADE,
  check_date date NOT NULL DEFAULT CURRENT_DATE,
  window_started_at timestamptz NOT NULL,
  window_ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'monitoring' CHECK (status IN ('monitoring', 'complete', 'missing_uploads')),
  expected_count int NOT NULL DEFAULT 0,
  received_count int NOT NULL DEFAULT 0,
  missing_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (area_id, check_date)
);

CREATE INDEX area_intake_checks_area_date_idx ON area_intake_checks(area_id, check_date);

CREATE TABLE missing_upload_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_check_id uuid NOT NULL REFERENCES area_intake_checks(id) ON DELETE CASCADE,
  area_id uuid NOT NULL REFERENCES statistical_areas(id) ON DELETE CASCADE,
  hhah_id uuid NOT NULL REFERENCES home_health_agencies(id) ON DELETE CASCADE,
  notification_type text NOT NULL DEFAULT 'email',
  recipient text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  message text NOT NULL DEFAULT '',
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (area_check_id, hhah_id)
);

CREATE INDEX missing_upload_notifications_check_idx ON missing_upload_notifications(area_check_id);

-- ── Workflow runtime ────────────────────────────────────────
CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id text NOT NULL,
  workflow_version integer NOT NULL DEFAULT 1,
  source_label text,
  status text NOT NULL DEFAULT 'running',
  total_items integer NOT NULL DEFAULT 0,
  completed_items integer NOT NULL DEFAULT 0,
  input_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  area_id uuid REFERENCES statistical_areas(id),
  hhah_id uuid REFERENCES home_health_agencies(id),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workflow_id, workflow_version)
    REFERENCES workflow_definitions(id, version)
);

CREATE INDEX workflow_runs_area_idx ON workflow_runs(area_id);

CREATE TABLE workflow_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  item_index integer NOT NULL,
  status text NOT NULL DEFAULT 'running',
  patient_key text NOT NULL,
  order_key text,
  patient_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  order_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  reference_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  extraction_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  decisions jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, item_index)
);

CREATE INDEX workflow_items_run_id_idx ON workflow_items(run_id);

CREATE TABLE workflow_task_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES workflow_items(id) ON DELETE CASCADE,
  step_id text NOT NULL,
  task_key text NOT NULL,
  actor text NOT NULL,
  name text NOT NULL,
  description text,
  condition text,
  status text NOT NULL DEFAULT 'pending',
  assigned_to text REFERENCES users(id),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, step_id)
);

CREATE INDEX workflow_task_runs_run_id_idx ON workflow_task_runs(run_id);
CREATE INDEX workflow_task_runs_assigned_status_idx ON workflow_task_runs(assigned_to, status);

CREATE TABLE uploaded_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  content_type text,
  size_bytes integer,
  blob_url text,
  blob_path text,
  hhah_id uuid REFERENCES home_health_agencies(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES workflow_items(id) ON DELETE CASCADE,
  document_id uuid REFERENCES uploaded_documents(id),
  provider text NOT NULL DEFAULT 'gemini',
  model text,
  status text NOT NULL DEFAULT 'pending',
  prompt_version text NOT NULL DEFAULT 'wf7-v1',
  input_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
