CREATE TABLE IF NOT EXISTS statistical_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  area_type text NOT NULL CHECK (area_type IN ('micro_statistical_area', 'metro_statistical_area')),
  state text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, area_type)
);

CREATE TABLE IF NOT EXISTS statistical_area_hhahs (
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

CREATE TABLE IF NOT EXISTS area_intake_checks (
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

CREATE TABLE IF NOT EXISTS missing_upload_notifications (
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

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS area_id uuid REFERENCES statistical_areas(id),
  ADD COLUMN IF NOT EXISTS hhah_id uuid REFERENCES home_health_agencies(id);

ALTER TABLE uploaded_documents
  ADD COLUMN IF NOT EXISTS hhah_id uuid REFERENCES home_health_agencies(id);

CREATE INDEX IF NOT EXISTS statistical_area_hhahs_area_idx ON statistical_area_hhahs(area_id);
CREATE INDEX IF NOT EXISTS area_intake_checks_area_date_idx ON area_intake_checks(area_id, check_date);
CREATE INDEX IF NOT EXISTS missing_upload_notifications_check_idx ON missing_upload_notifications(area_check_id);
CREATE INDEX IF NOT EXISTS workflow_runs_area_idx ON workflow_runs(area_id);
