-- Migration 004 — RCM pipeline: generated billing records + audit records
--
-- Owned by the RCM miner (per the "Daily Agency Intake -> RCM Pipeline" plan).
-- rcm_records is written by api/_lib/referenceLogic/rcm.js (generateRcm);
-- audit_records is written/read by the audit + rework subsystems.

CREATE TABLE IF NOT EXISTS rcm_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid,
  patient_id uuid,
  episode_id uuid,
  cpo_month text,
  cpt_code text,
  amount_cents int,
  status text DEFAULT 'generated',
  payload jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- Idempotent upsert key: one RCM line per (episode, CPO month, CPT code).
-- Mirrors the .NET RCM1Service composite id "{patient}_{cpt}_{cpoMonth}", but
-- keyed on episode (the billing unit here) so re-runs replace instead of dup.
CREATE UNIQUE INDEX IF NOT EXISTS rcm_records_episode_month_cpt_idx
  ON rcm_records (episode_id, cpo_month, cpt_code);

CREATE INDEX IF NOT EXISTS rcm_records_agency_id_idx ON rcm_records (agency_id);
CREATE INDEX IF NOT EXISTS rcm_records_patient_id_idx ON rcm_records (patient_id);

CREATE TABLE IF NOT EXISTS audit_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rcm_record_id uuid REFERENCES rcm_records(id) ON DELETE CASCADE,
  agency_id uuid,
  status text DEFAULT 'pending',
  rule_results jsonb DEFAULT '[]',
  change_log jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_records_rcm_record_id_idx ON audit_records (rcm_record_id);
CREATE INDEX IF NOT EXISTS audit_records_agency_id_idx ON audit_records (agency_id);
