-- Migration 003 — Command Center identity, sessions, builder workflows, bucket state (ADDITIVE)

-- ── Employees (internal users; successors of seeded alice/bob/carol) ──
CREATE TABLE IF NOT EXISTS employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,                -- login identifier (lowercased at write)
  display_name text NOT NULL,
  job_role text,
  password_hash text NOT NULL,                  -- 's2$N$r$p$saltB64$hashB64' (scrypt)
  totp_secret text NOT NULL,                    -- base32, generated at creation
  totp_enabled boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── External users (HHAH / PG portal logins) ──
CREATE TABLE IF NOT EXISTS external_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,                  -- same scrypt format
  user_type text NOT NULL CHECK (user_type IN ('hhah','pg')),
  role text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','practitioner')),
  agency_id uuid REFERENCES home_health_agencies(id) ON DELETE CASCADE,  -- hhah users
  pg_id uuid REFERENCES physician_groups(id) ON DELETE CASCADE,          -- pg users
  practitioner_id uuid REFERENCES practitioners(id),                     -- pg role='practitioner'
  npi text,                                     -- entered at creation for practitioners
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_type <> 'hhah' OR agency_id IS NOT NULL),
  CHECK (user_type <> 'pg'   OR pg_id IS NOT NULL),
  CHECK (role <> 'practitioner' OR practitioner_id IS NOT NULL)
);

-- ── Sessions (bearer tokens; two-stage for worker 2FA) ──
CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,              -- sha256 hex of the bearer token
  principal_type text NOT NULL CHECK (principal_type IN ('employee','external')),
  principal_id uuid NOT NULL,
  stage text NOT NULL DEFAULT 'complete' CHECK (stage IN ('password','complete')),
  expires_at timestamptz NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_principal_idx ON auth_sessions(principal_type, principal_id);

-- ── Workflow definitions: distinguish system vs builder-authored ──
ALTER TABLE workflow_definitions
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'system',   -- 'system' | 'builder'
  ADD COLUMN IF NOT EXISTS created_by uuid;                       -- employees.id (nullable)

-- ── Task/bucket state (additive; assigned_to text FK->users stays untouched/null) ──
ALTER TABLE workflow_task_runs
  ADD COLUMN IF NOT EXISTS assigned_employee_id uuid REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS opened_at timestamptz,                 -- set on "open" => Processing
  ADD COLUMN IF NOT EXISTS actions jsonb NOT NULL DEFAULT '[]'::jsonb,       -- checklist snapshot
  ADD COLUMN IF NOT EXISTS action_state jsonb NOT NULL DEFAULT '{}'::jsonb;  -- per-action results
CREATE INDEX IF NOT EXISTS workflow_task_runs_employee_status_idx
  ON workflow_task_runs(assigned_employee_id, status);
