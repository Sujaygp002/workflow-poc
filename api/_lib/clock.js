// Business clock — the single source of "now" for business-meaningful date math
// (daily-tick fire time + day bucket, CPO month derivation, eligibility / F2F
// windows, area-intake "today", signature dates). Real wall-clock timestamps
// (created_at, audit change-log stamps, session expiry, blob paths) do NOT go
// through here — only dates a demo needs to time-travel.
//
// A signed millisecond offset (`sim_offset_ms`) is persisted in app_settings and
// added on top of Date.now(). +1 day / +1 month advance it; reset clears it. The
// offset is read through a ~5s in-process cache so the hot path (every tick /
// eligibility read) does not hit the DB on every call.
import { getSql, jsonParam } from './db.js';

const SETTINGS_KEY = 'sim_offset_ms';
const CACHE_TTL_MS = 5000;
const DEFAULT_TZ = 'America/Chicago';

let cachedOffsetMs = 0;
let cachedAt = 0;

// Read the persisted sim offset (ms), cached ~5s. Never throws — if the DB /
// app_settings table is unavailable it degrades to the last known (or zero)
// offset so business reads keep working on real time.
export async function getSimOffsetMs() {
  const now = Date.now();
  if (now - cachedAt < CACHE_TTL_MS) return cachedOffsetMs;
  try {
    const sql = getSql();
    const rows = await sql`SELECT value FROM app_settings WHERE key = ${SETTINGS_KEY} LIMIT 1`;
    const ms = Number(rows[0]?.value?.ms);
    cachedOffsetMs = Number.isFinite(ms) ? ms : 0;
  } catch {
    // leave cachedOffsetMs at its last value (0 on cold start)
  }
  cachedAt = now;
  return cachedOffsetMs;
}

async function setSimOffsetMs(ms) {
  const sql = getSql();
  const value = { ms: Math.trunc(ms) };
  await sql`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (${SETTINGS_KEY}, ${await jsonParam(value)}::jsonb, now())
    ON CONFLICT (key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
  cachedOffsetMs = value.ms;
  cachedAt = Date.now();
  return cachedOffsetMs;
}

// Business "now" as a Date: wall clock + persisted sim offset.
export async function businessNow() {
  const offset = await getSimOffsetMs();
  return new Date(Date.now() + offset);
}

// Wall-clock parts of business-now in a tz (via Intl) — the day bucket + hour /
// minute used by the daily tick. Mirrors the old dailyBucket.nowPartsInTz shape
// but anchored on the (possibly simulated) business date.
export async function businessNowPartsInTz(tz = DEFAULT_TZ) {
  const date = await businessNow();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return {
    dayBucket: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(hour),
    minute: Number(get('minute')),
  };
}

// Business "today" as YYYY-MM-DD in a tz.
export async function businessToday(tz = DEFAULT_TZ) {
  const { dayBucket } = await businessNowPartsInTz(tz);
  return dayBucket;
}

// Business "today" (UTC) as an epoch-ms at 00:00 — for EOE >= today comparisons
// that the reference logic does in UTC. Mirrors businessRules.todayMsUtc but on
// the simulated business date.
export async function businessTodayMsUtc() {
  const d = await businessNow();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Advance the sim offset by ~1 calendar month (30 days). A true calendar month
// would need an anchor date; +30d is sufficient for the demo's month-rollover
// (a June CPO bucket rolls into July) and stays a pure ms offset.
function addMonthMs(offsetMs) {
  const base = new Date(Date.now() + offsetMs);
  const advanced = new Date(Date.UTC(
    base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(),
    base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(),
  ));
  return offsetMs + (advanced.getTime() - base.getTime());
}

// Apply a simulate-time op and return the resulting business-clock state.
//   op '+1d' | '+1m' | 'reset'
export async function applySimTimeOp(op) {
  const current = await getSimOffsetMs();
  let next;
  if (op === 'reset') next = 0;
  else if (op === '+1d') next = current + DAY_MS;
  else if (op === '+1m') next = addMonthMs(current);
  else {
    const err = new Error(`Unsupported simulateTime op '${op}'. Use '+1d', '+1m', or 'reset'.`);
    err.status = 400;
    throw err;
  }
  await setSimOffsetMs(next);
  return simTimeState(next);
}

// The current business-clock state for the admin GET / after an op.
export async function getSimTimeState() {
  return simTimeState(await getSimOffsetMs());
}

function simTimeState(offsetMs) {
  const businessDate = new Date(Date.now() + offsetMs);
  return {
    offsetMs,
    offsetDays: Math.round(offsetMs / DAY_MS),
    simulated: offsetMs !== 0,
    realNow: new Date().toISOString(),
    businessNow: businessDate.toISOString(),
    tz: DEFAULT_TZ,
  };
}
