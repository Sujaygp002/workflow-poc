-- Migration 002 — Lisa review changes
-- 1. Patient Unit: stable base layer split from the changing Patient record.
-- 2. Patient <-> Physician Group: direct many-to-many (0..* both sides).
-- 3. Patient <-> Practitioner: direct, 0..many.
-- Additive and non-destructive: existing patients keep working; a unit is
-- backfilled per existing patient.

-- ── Patient Unit (stable identity / insurance / family) ──
CREATE TABLE IF NOT EXISTS patient_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_patient_key text NOT NULL UNIQUE,
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

-- Link the changing Patient record to its stable Unit.
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES patient_units(id);

-- Backfill: create one unit per existing patient, then point the patient at it.
INSERT INTO patient_units (
  normalized_patient_key, name, dob, mrn, sex, personal_information, insurance_details, raw_data
)
SELECT
  p.normalized_patient_key, p.name, p.dob, p.mrn, p.sex,
  p.personal_information, p.insurance_details, p.raw_data
FROM patients p
ON CONFLICT (normalized_patient_key) DO NOTHING;

UPDATE patients p
SET unit_id = u.id
FROM patient_units u
WHERE u.normalized_patient_key = p.normalized_patient_key
  AND p.unit_id IS NULL;

-- ── Patient <-> Physician Group (direct, 0..* both sides) ──
CREATE TABLE IF NOT EXISTS patient_physician_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  pg_id uuid NOT NULL REFERENCES physician_groups(id) ON DELETE CASCADE,
  role text,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, pg_id)
);

CREATE INDEX IF NOT EXISTS patient_physician_groups_patient_idx
  ON patient_physician_groups(patient_id);
CREATE INDEX IF NOT EXISTS patient_physician_groups_pg_idx
  ON patient_physician_groups(pg_id);

-- ── Patient <-> Practitioner (direct, 0..many) ──
CREATE TABLE IF NOT EXISTS patient_practitioners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  practitioner_id uuid NOT NULL REFERENCES practitioners(id) ON DELETE CASCADE,
  relationship text,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, practitioner_id)
);

CREATE INDEX IF NOT EXISTS patient_practitioners_patient_idx
  ON patient_practitioners(patient_id);
CREATE INDEX IF NOT EXISTS patient_practitioners_practitioner_idx
  ON patient_practitioners(practitioner_id);

-- ── Orders: track document type for 485 / F2F eligibility logic ──
-- order_status JSONB already holds signed/date info; add a typed column so
-- episode status can be computed without parsing the blob.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS document_type text;
