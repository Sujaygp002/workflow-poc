// Shared daily-time bucket helper. The daily_time trigger (tick handler) and the
// bulk-upload reconciliation (start.js) MUST derive the same YYYY-MM-DD dayBucket
// from wall-clock time in the trigger tz so both target the identical run source
// label `daily:<wfId>:<dayBucket>` — otherwise an upload near the America/Chicago
// midnight boundary would look for a run under a different bucket than the tick
// created. Single-sourced here to guarantee they agree.
const DEFAULT_TZ = 'America/Chicago';

// Current wall-clock parts in a tz (via Intl) — used to compute both the
// YYYY-MM-DD day bucket and whether the daily fire time has passed. Never uses
// String(date).slice — the parts come straight from Intl, not a Date string.
export function nowPartsInTz(tz = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return {
    dayBucket: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(hour),
    minute: Number(get('minute')),
  };
}

// The exact sourceLabel the daily tick stamps for a workflow on a given day.
export function dailySourceLabel(workflowId, dayBucket) {
  return `daily:${workflowId}:${dayBucket}`;
}
