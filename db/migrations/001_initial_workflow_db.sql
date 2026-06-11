CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  name text NOT NULL,
  job_role text,
  access_level text,
  username text,
  contact_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_definitions (
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

CREATE UNIQUE INDEX IF NOT EXISTS workflow_definitions_one_active
  ON workflow_definitions (id)
  WHERE active;

CREATE TABLE IF NOT EXISTS physician_groups (
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

CREATE TABLE IF NOT EXISTS home_health_agencies (
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

CREATE TABLE IF NOT EXISTS practitioners (
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

CREATE TABLE IF NOT EXISTS patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_patient_key text NOT NULL UNIQUE,
  name text NOT NULL,
  dob date,
  mrn text NOT NULL,
  sex text,
  age integer,
  personal_information jsonb NOT NULL DEFAULT '{}'::jsonb,
  insurance_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  admission_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS patient_admissions (
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

CREATE TABLE IF NOT EXISTS patient_episodes (
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

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  order_type text,
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

CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id text NOT NULL,
  workflow_version integer NOT NULL DEFAULT 1,
  source_label text,
  status text NOT NULL DEFAULT 'running',
  total_items integer NOT NULL DEFAULT 0,
  completed_items integer NOT NULL DEFAULT 0,
  input_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workflow_id, workflow_version)
    REFERENCES workflow_definitions(id, version)
);

CREATE TABLE IF NOT EXISTS workflow_items (
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

CREATE TABLE IF NOT EXISTS workflow_task_runs (
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

CREATE TABLE IF NOT EXISTS uploaded_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  content_type text,
  size_bytes integer,
  blob_url text,
  blob_path text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_extractions (
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

CREATE INDEX IF NOT EXISTS workflow_items_run_id_idx ON workflow_items(run_id);
CREATE INDEX IF NOT EXISTS workflow_task_runs_run_id_idx ON workflow_task_runs(run_id);
CREATE INDEX IF NOT EXISTS workflow_task_runs_assigned_status_idx ON workflow_task_runs(assigned_to, status);
CREATE INDEX IF NOT EXISTS patient_admissions_patient_id_idx ON patient_admissions(patient_id);
CREATE INDEX IF NOT EXISTS patient_episodes_admission_id_idx ON patient_episodes(admission_id);
CREATE INDEX IF NOT EXISTS orders_patient_id_idx ON orders(patient_id);
