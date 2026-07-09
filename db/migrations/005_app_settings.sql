-- Migration 005 — app_settings: a tiny generic key/value (jsonb) store.
--
-- Owned by the simulator (Milestone D). Its only consumer today is the business
-- clock (api/_lib/clock.js), which persists sim_offset_ms — a signed millisecond
-- offset applied on top of wall-clock time so a demo can "time-travel" the
-- business date forward (+1 day / +1 month) or reset to real time. Additive and
-- idempotent; carries no patient data.

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
