-- Migration 002 — CPO billing monitor and status snapshots

ALTER TABLE patient_episodes
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'started',
  ADD COLUMN IF NOT EXISTS status_reason jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS latest_episode_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS latest_episode_status_reason jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS cpo_months (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL REFERENCES patient_episodes(id) ON DELETE CASCADE,
  cpo_month date NOT NULL,
  cpo_min integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'not_billable',
  reason jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (episode_id, cpo_month)
);

CREATE INDEX IF NOT EXISTS cpo_months_episode_id_idx ON cpo_months(episode_id);
CREATE INDEX IF NOT EXISTS cpo_months_status_idx ON cpo_months(status);
