// Shared daily-time bucket helper. The daily_time trigger (tick handler) and the
// bulk-upload reconciliation (start.js) MUST derive the same YYYY-MM-DD dayBucket
// from wall-clock time in the trigger tz so both target the identical run source
// label `daily:<wfId>:<dayBucket>` — otherwise an upload near the America/Chicago
// midnight boundary would look for a run under a different bucket than the tick
// created. Single-sourced here to guarantee they agree.
import { businessNowPartsInTz } from './clock.js';

const DEFAULT_TZ = 'America/Chicago';

// Current wall-clock parts in a tz (via Intl) — used to compute both the
// YYYY-MM-DD day bucket and whether the daily fire time has passed. Never uses
// String(date).slice — the parts come straight from Intl, not a Date string.
//
// SIM: anchored on the BUSINESS clock (wall clock + persisted sim offset) so a
// time-travel demo advances the day bucket and the fire-time check together.
// Now async because the sim offset is read (cached ~5s) from app_settings.
export async function nowPartsInTz(tz = DEFAULT_TZ) {
  return businessNowPartsInTz(tz);
}

// The exact sourceLabel the daily tick stamps for a workflow on a given day.
export function dailySourceLabel(workflowId, dayBucket) {
  return `daily:${workflowId}:${dayBucket}`;
}
