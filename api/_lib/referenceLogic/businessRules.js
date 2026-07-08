// Business rules — pure, dependency-free ports of the .NET 8 reference
// BusinessRequirementsService rules the POC pipeline was still missing.
//
// Source: reference/Order_Patient/Services/BusinessRequirementsService.cs
//   - CarryForwardEpisodeDiagnoses (L526-584) + IsBlankDx (L523-525)
//   - IsPatientDataComplete / IsFilled (L2484-2517, L2272-2276)
//   - EvaluateCpoMonthReadiness (L2410-2482) + helpers:
//       TryParseCpoMonth (L2329-2359), EpisodeOverlapsMonth (L2361-2371),
//       IsDiagnosisComplete (L2292-2303), Is485Doc (L390-401),
//       EffectiveDocDate (L2385-2393), IsDocSigned (L2395-),
//       ParseNullableDate (L2305-2327)
//   - GeneratePgBillable minute rules (L1132-1282) + GetMonthRange (L1284-1296)
//   - UpdatePatientStatus / UpdatePatientStatusOP (L1987-2123): PatientStatus
//       = Active when latest-episode EOE >= today else Inactive
//   - UpdateBillingStatus / UpdateBillingStatusOP filter-status tier
//       (L1300-1333, L1694-1755): Billable > Pgbillable > Eligible > null,
//       only for Active patients
//
// POC ADAPTATION (deliberate):
//   The reference operates over Cosmos-shaped WAV* DTOs with named diagnosis
//   slots (First..SixthDiagnosis) and DTO string dates. The POC persists
//   diagnoses as a jsonb array on patient_episodes.diagnosis_codes and dates as
//   Postgres `date` (the Neon driver hands them back as JS Date objects). These
//   functions therefore accept the POC row shapes and use the same dateOnly /
//   dateMs idiom already used in rcm.js (NO String(date).slice — that bug has
//   bitten this repo twice). All functions are pure ES exports with no imports.

// ── date helpers (dateOnly / dateMs idiom, matches rcm.js) ─────────────────
// Accepts Date objects (Neon driver) or 'YYYY-MM-DD...' strings, plus the
// common US MM/DD/YYYY shape the AI extraction sometimes emits.
function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const str = String(value).trim();
  const iso = str.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  // MM/DD/YYYY or M/D/YY fallback (ParseNullableDate parity).
  const m = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    const mm = String(Number(m[1])).padStart(2, '0');
    const dd = String(Number(m[2])).padStart(2, '0');
    return `${year}-${mm}-${dd}`;
  }
  return null;
}

function dateMs(value) {
  const ymd = dateOnly(value);
  if (!ymd) return null;
  const time = new Date(`${ymd}T00:00:00.000Z`).getTime();
  return Number.isNaN(time) ? null : time;
}

// Today's date (UTC) as ms — the reference compares EOE against DateTime.UtcNow.Date.
function todayMsUtc() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

// "MMMM yyyy" label ("August 2025") for a Date, matching RCMNew.CpoMonth /
// GetMonthRange. Used by pgBillableMinutes to compare a note/doc month against
// the target CPO month label.
function monthLabel(value) {
  const ymd = dateOnly(value);
  if (!ymd) return null;
  const [y, m] = ymd.split('-');
  const name = new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  });
  return `${name} ${y}`;
}

// TryParseCpoMonth — parse a CPO-month label ("August 2025", "2025-08", "8/2025")
// into a { startMs, endMs } window (endMs = last day of the month, UTC ms).
function parseCpoMonthWindow(monthKey) {
  if (!monthKey) return null;
  const trimmed = String(monthKey).trim();
  let year;
  let monthIndex; // 0-based

  // "August 2025" / "Aug 2025"
  const named = trimmed.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (named) {
    const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december'];
    const idx = monthNames.findIndex((n) => n.startsWith(named[1].toLowerCase()));
    if (idx >= 0) {
      monthIndex = idx;
      year = Number(named[2]);
    }
  }
  // "2025-08" / "2025/08"
  if (year === undefined) {
    const iso = trimmed.match(/^(\d{4})[-/](\d{1,2})$/);
    if (iso) {
      year = Number(iso[1]);
      monthIndex = Number(iso[2]) - 1;
    }
  }
  // "08/2025" / "8-2025"
  if (year === undefined) {
    const us = trimmed.match(/^(\d{1,2})[-/](\d{4})$/);
    if (us) {
      monthIndex = Number(us[1]) - 1;
      year = Number(us[2]);
    }
  }
  // Fallback: any parseable date → its month.
  if (year === undefined) {
    const ms = dateMs(trimmed);
    if (ms !== null) {
      const d = new Date(ms);
      year = d.getUTCFullYear();
      monthIndex = d.getUTCMonth();
    }
  }
  if (year === undefined || monthIndex < 0 || monthIndex > 11) return null;

  const startMs = Date.UTC(year, monthIndex, 1);
  const endMs = Date.UTC(year, monthIndex + 1, 0); // day 0 of next month = last day
  return { startMs, endMs, label: monthLabel(new Date(startMs)) };
}

// ── IsFilled / IsBlankDx (L2272-2276, L523-525) ────────────────────────────
// A value is "filled" when it is non-blank AND not the literal placeholder
// 'string' the reference DTOs emit for empty fields.
export function isFilled(value) {
  if (value === undefined || value === null) return false;
  const t = String(value).trim();
  if (!t) return false;
  return t.toLowerCase() !== 'string';
}

// A diagnosis slot is blank when empty/whitespace or the literal 'string'.
function isBlankDx(value) {
  return !isFilled(value);
}

// ── diagnosis slot access (POC jsonb array <-> named First..Sixth) ─────────
// The POC keeps diagnoses as an ordered array on patient_episodes.diagnosis_codes
// (jsonb array; occasionally a keyed object). Normalize to a length-6 slot array.
const DX_SLOTS = 6;

function episodeDxSlots(episode) {
  const codes = episode && episode.diagnosis_codes;
  let list;
  if (Array.isArray(codes)) {
    list = codes.slice();
  } else if (codes && typeof codes === 'object') {
    list = Object.values(codes);
  } else {
    list = [];
  }
  const slots = new Array(DX_SLOTS).fill(null);
  for (let i = 0; i < DX_SLOTS; i += 1) {
    slots[i] = list[i] === undefined ? null : list[i];
  }
  return slots;
}

function writeEpisodeDxSlots(episode, slots) {
  // Preserve any trailing (7th+) codes the POC array may have carried.
  const existing = Array.isArray(episode.diagnosis_codes) ? episode.diagnosis_codes : [];
  const tail = existing.slice(DX_SLOTS);
  const next = slots.map((s) => (isBlankDx(s) ? null : s)).concat(tail);
  // Trim trailing nulls so a fully-blank episode stays an empty-ish array.
  while (next.length && (next[next.length - 1] === null || next[next.length - 1] === undefined)) {
    next.pop();
  }
  episode.diagnosis_codes = next;
}

// Order episodes oldest→newest by SOE (fallback EOE). Stable, non-mutating.
function orderEpisodesBySoe(episodes) {
  return episodes
    .map((ep, i) => ({ ep, i }))
    .filter(({ ep }) => dateMs(ep.soe) !== null || dateMs(ep.eoe) !== null)
    .sort((a, b) => {
      const am = dateMs(a.ep.soe) ?? dateMs(a.ep.eoe);
      const bm = dateMs(b.ep.soe) ?? dateMs(b.ep.eoe);
      if (am !== bm) return am - bm;
      return a.i - b.i; // stable
    })
    .map(({ ep }) => ep);
}

/**
 * CarryForwardEpisodeDiagnoses (BusinessRequirementsService.cs L526-584).
 *
 * Forward then backward pass over episodes ordered by SOE (fallback EOE):
 * any blank/'string'/placeholder slot (First..Sixth) is filled from the nearest
 * non-blank neighbour — forward first (inherit from earlier episode), then
 * backward (inherit from later episode) to fill any leading gaps.
 *
 * MUTATES each episode's diagnosis_codes in place (the reference mutates the
 * WAVEpisodeResponse DTOs likewise) and returns the same array for chaining.
 *
 * @param {Array<{soe?, eoe?, diagnosis_codes?}>} episodes
 * @returns {Array} the same episodes array (mutated)
 */
export function carryForwardEpisodeDiagnoses(episodes) {
  if (!Array.isArray(episodes) || episodes.length === 0) return episodes;
  const ordered = orderEpisodesBySoe(episodes);
  if (ordered.length === 0) return episodes;

  // Materialize slots once so we can mutate then write back.
  const slotSets = ordered.map(episodeDxSlots);

  // FORWARD PASS: oldest → newest, fill blanks from the last seen non-blank value.
  const prev = new Array(DX_SLOTS).fill(null);
  for (const slots of slotSets) {
    for (let s = 0; s < DX_SLOTS; s += 1) {
      if (isBlankDx(slots[s]) && !isBlankDx(prev[s])) slots[s] = prev[s];
      if (!isBlankDx(slots[s])) prev[s] = slots[s];
    }
  }

  // BACKWARD PASS: newest → oldest, fill remaining blanks from later values.
  const next = new Array(DX_SLOTS).fill(null);
  for (let i = slotSets.length - 1; i >= 0; i -= 1) {
    const slots = slotSets[i];
    for (let s = 0; s < DX_SLOTS; s += 1) {
      if (isBlankDx(slots[s]) && !isBlankDx(next[s])) slots[s] = next[s];
      if (!isBlankDx(slots[s])) next[s] = slots[s];
    }
  }

  ordered.forEach((ep, i) => writeEpisodeDxSlots(ep, slotSets[i]));
  return episodes;
}

// ── IsPatientDataComplete (L2484-2517) ─────────────────────────────────────
// Reads first/last name, DOB, sex, city, state, zip out of the POC patient row
// (patients: name/dob/sex + personal_information.address.{city,state,zip}).
function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts[parts.length - 1] };
}

/**
 * IsPatientDataComplete (L2501-2517).
 *
 * Demographics are complete when first name, last name, DOB, sex, city, state
 * and zip are all filled (non-blank and not the literal 'string').
 *
 * @param {object} patient - POC patient row or an already-flattened shape
 *   ({fname,lname,dob,sex,city,state,zip} also accepted directly).
 * @returns {boolean}
 */
export function isPatientDataComplete(patient) {
  if (!patient) return false;

  // Accept a pre-flattened shape (used by the rcm payload.patient sub-object).
  let fname = patient.fname ?? patient.first_name ?? patient.PatientFName;
  let lname = patient.lname ?? patient.last_name ?? patient.PatientLName;
  if (fname === undefined && lname === undefined) {
    const { first, last } = splitName(patient.name);
    fname = first;
    lname = last;
  }

  const personal = patient.personal_information || {};
  const address = personal.address || patient.address || {};
  const dob = patient.dob ?? patient.DOB ?? personal.dob;
  const sex = patient.sex ?? patient.PatientSex ?? personal.sex ?? patient.gender;
  const city = patient.city ?? patient.PatientCity ?? address.city;
  const state = patient.state ?? patient.PatientState ?? address.state;
  const zip = patient.zip ?? patient.Zip ?? address.zip ?? address.postal_code;

  return isFilled(fname) && isFilled(lname) && isFilled(dob)
    && isFilled(sex) && isFilled(city) && isFilled(state) && isFilled(zip);
}

// ── EvaluateCpoMonthReadiness helpers ──────────────────────────────────────

// IsDiagnosisComplete (L2292-2303): SOC, SOE, EOE + first three diagnosis slots
// all filled. Reads the POC episode row (soc may live on the joined admission).
function isEpisodeDiagnosisComplete(episode) {
  if (!episode) return false;
  const slots = episodeDxSlots(episode);
  return isFilled(episode.soc)
    && isFilled(episode.soe)
    && isFilled(episode.eoe)
    && isFilled(slots[0]) && isFilled(slots[1]) && isFilled(slots[2]);
}

// EpisodeOverlapsMonth (L2361-2371): EOE >= monthStart && SOE <= monthEnd.
function episodeOverlapsMonth(episode, startMs, endMs) {
  const soe = dateMs(episode.soe);
  const eoe = dateMs(episode.eoe);
  if (soe === null || eoe === null) return false;
  return eoe >= startMs && soe <= endMs;
}

// Is485Doc (L390-401): document_type 485CERT/485RECERT or name/type containing '485'.
function is485Doc(order) {
  const dt = String(order.document_type || order.order_type || '').trim();
  const name = String(order.order_number || order.name || '');
  return dt.toLowerCase().includes('485') || name.toLowerCase().includes('485')
    || dt.toLowerCase().includes('plan of care');
}

// IsDocSigned (L2395-): any of the signed flags/dates on order_status.
function isDocSigned(order) {
  const s = order.order_status || {};
  return !!(
    s.SignedByPhysician_Status === true
    || s.SignedByPhysician_Status === 'true'
    || s.SignedByPhyscianDate
    || s.UploadedSignedOrderStatus === true
    || s.signed === true
    || order.signed_date
  );
}

// EffectiveDocDate (L2385-2393): signed date, else uploaded, else inflow, else
// sent-to-physician date. Reads the POC order_status jsonb.
function effectiveDocDate(order) {
  const s = order.order_status || {};
  return dateMs(s.SignedByPhyscianDate)
    ?? dateMs(order.signed_date)
    ?? dateMs(s.UploadedSignedOrderDate)
    ?? dateMs(order.order_date)
    ?? dateMs(s.SentToPhysicianDate);
}

/**
 * EvaluateCpoMonthReadiness (L2410-2482).
 *
 * A CPO month is "data complete" only when ALL hold:
 *   - the patient's demographics are complete (isPatientDataComplete), AND
 *   - at least one in-month episode has a complete diagnosis, AND
 *   - a 485 is signed on/before month-end (HasSigned485).
 *
 * @param {{ patient?, episodes?: Array, orders?: Array, cpoMonth? }} args
 *   episodes/orders scoped to the patient; cpoMonth is the target month label.
 * @returns {{ dataComplete: boolean, hasSigned485: boolean, hasPending485: boolean }}
 */
export function evaluateCpoMonthReadiness({ patient, episodes = [], orders = [], cpoMonth } = {}) {
  const window = parseCpoMonthWindow(cpoMonth);
  if (!patient || !window) return { dataComplete: false, hasSigned485: false, hasPending485: false };

  const { startMs, endMs } = window;
  const episodesInMonth = (episodes || []).filter((ep) => episodeOverlapsMonth(ep, startMs, endMs));
  if (episodesInMonth.length === 0) {
    return { dataComplete: false, hasSigned485: false, hasPending485: false };
  }

  const patientComplete = isPatientDataComplete(patient);
  const diagnosisComplete = episodesInMonth.some(isEpisodeDiagnosisComplete);

  // 485 orders whose effective date lands on/before month-end.
  const inMonthEpisodeIds = new Set(episodesInMonth.map((ep) => ep.id).filter(Boolean));
  const month485Docs = (orders || []).filter((o) => {
    if (!is485Doc(o)) return false;
    // If orders carry an episode link, restrict to in-month episodes; else keep all.
    if (o.episode_id && inMonthEpisodeIds.size && !inMonthEpisodeIds.has(o.episode_id)) return false;
    const eff = effectiveDocDate(o);
    return eff !== null && eff <= endMs;
  });

  let hasSigned485 = month485Docs.some(isDocSigned);
  const hasPending485 = month485Docs.some((o) => !isDocSigned(o));

  // Reference fallback: if no 485 docs matched but an episode already asserts a
  // valid 485 (POC: episode_status eligible/billable), honour it.
  if (!hasSigned485 && month485Docs.length === 0) {
    hasSigned485 = episodesInMonth.some(
      (ep) => ep.episode_status === 'eligible' || ep.episode_status === 'billable' || ep.status === 'eligible' || ep.status === 'billable',
    );
  }

  const dataComplete = patientComplete && diagnosisComplete && hasSigned485;
  return { dataComplete, hasSigned485, hasPending485 };
}

/**
 * pgBillableMinutes (GeneratePgBillable minute rules, L1132-1282).
 *
 * Reproduces the two GeneratePgBillable filters for a single (episode, month):
 *   (a) documents whose name/type contains '485' or 'plan' contribute 0 CPO
 *       minutes (they are skipped);
 *   (b) a CC note counts toward the month ONLY if its effective date
 *       (SentToPhysician else CreatedAt) is strictly AFTER the episode's earliest
 *       485 SentToPhysicianDate, AND only when the note's month label equals the
 *       target CPO month.
 *
 * @param {object} episode - POC episode augmented with:
 *   documents?: Array (orders/docs with document_type/order_number, order_status,
 *     cpoMinutes/CPOMinutes, DocStatus), notes?: Array (CC notes with cpoMinutes/
 *     minutes, sentToPhysicianDate/SentToPhysicianDate, createdAt/CreatedAt).
 * @param {string} cpoMonthLabel - "August 2025" style month label.
 * @returns {number} total CPO minutes for that month.
 */
export function pgBillableMinutes(episode, cpoMonthLabel) {
  if (!episode) return 0;
  const targetLabel = parseCpoMonthWindow(cpoMonthLabel)?.label
    || (cpoMonthLabel ? String(cpoMonthLabel).trim() : null);
  if (!targetLabel) return 0;

  let total = 0;
  const docs = Array.isArray(episode.documents) ? episode.documents : [];
  const notes = Array.isArray(episode.notes) ? episode.notes : [];

  // (a) Documents: skip 485/plan docs entirely; else add CPOMinutes if the doc's
  //     effective month matches AND the doc is in a countable status.
  const countableStatus = (d) => {
    const st = String(d.DocStatus || d.docStatus || '').toLowerCase();
    // POC orders rarely carry a Cosmos DocStatus; when absent, count the doc
    // (the 485/plan skip above already removes the zero-minute documents).
    if (!st) return true;
    return st === 'filed' || st === 'signed' || st === 'pgfiled';
  };
  for (const doc of docs) {
    const name = String(doc.order_number || doc.DocName || doc.name || '');
    const dtype = String(doc.document_type || doc.DocumentType || doc.order_type || '');
    const combined = `${name} ${dtype}`.toLowerCase();
    if (combined.includes('485') || combined.includes('plan')) continue; // skip, treat as zero
    if (!countableStatus(doc)) continue;
    const eff = dateMs(
      doc.DocInflowDate || (doc.order_status || {}).SentToPhysicianDate || doc.order_date,
    );
    if (eff === null) continue;
    if (monthLabel(new Date(eff)) !== targetLabel) continue;
    const min = Number(doc.CPOMinutes ?? doc.cpoMinutes ?? 0);
    if (Number.isFinite(min)) total += min;
  }

  // Earliest 485/plan-of-care SentToPhysicianDate across this episode's docs.
  let earliest485SentMs = null;
  for (const doc of docs) {
    const name = String(doc.order_number || doc.DocName || doc.name || '');
    const dtype = String(doc.document_type || doc.DocumentType || doc.order_type || '');
    const combined = `${name} ${dtype}`.toLowerCase();
    const is485OrPlan = combined.includes('485') || combined.includes('plan of care');
    if (!is485OrPlan) continue;
    const sent = dateMs((doc.order_status || {}).SentToPhysicianDate || doc.SentToPhysicianDate);
    if (sent === null) continue;
    if (earliest485SentMs === null || sent < earliest485SentMs) earliest485SentMs = sent;
  }

  // (b) Notes: effective date = SentToPhysician else CreatedAt; must be strictly
  //     after the earliest 485 sent date (if any) and land in the target month.
  for (const note of notes) {
    const eff = dateMs(note.sentToPhysicianDate || note.SentToPhysicianDate)
      ?? dateMs(note.createdAt || note.CreatedAt || note.sentDate);
    if (eff === null) continue;
    if (earliest485SentMs !== null && eff <= earliest485SentMs) continue; // sent on/before order
    if (monthLabel(new Date(eff)) !== targetLabel) continue;
    const min = Number(note.cpoMinutes ?? note.CPOmin ?? note.minutes ?? 0);
    if (Number.isFinite(min)) total += min;
  }

  return total;
}

/**
 * derivePatientStatus (UpdatePatientStatus / UpdatePatientStatusOP, L1987-2123).
 *
 * PatientStatus = 'Active' when the latest episode's EOE is on/after today (UTC),
 * else 'Inactive'. No episodes / unparsable EOE ⇒ 'Inactive'.
 *
 * @param {Array<{eoe?}>} episodes
 * @returns {'Active'|'Inactive'}
 */
export function derivePatientStatus(episodes) {
  if (!Array.isArray(episodes) || episodes.length === 0) return 'Inactive';
  let latestMs = null;
  for (const ep of episodes) {
    const ms = dateMs(ep.eoe);
    if (ms === null) continue;
    if (latestMs === null || ms > latestMs) latestMs = ms;
  }
  if (latestMs === null) return 'Inactive';
  return latestMs >= todayMsUtc() ? 'Active' : 'Inactive';
}

/**
 * deriveFilterStatus (UpdateBillingStatus / UpdateBillingStatusOP tier, L1300-1333, L1694-1755).
 *
 * FilterStatus tier: Billable > Pgbillable > Eligible > null — but ONLY for
 * Active patients (an Inactive patient always yields null, matching the
 * early-return guard in the reference).
 *
 * @param {{ isBillable?:boolean, isPgBillable?:boolean, isEligible?:boolean, patientStatus? }} args
 * @returns {'Billable'|'Pgbillable'|'Eligible'|null}
 */
export function deriveFilterStatus({ isBillable, isPgBillable, isEligible, patientStatus } = {}) {
  if (patientStatus !== 'Active') return null;
  if (isBillable) return 'Billable';
  if (isPgBillable) return 'Pgbillable';
  if (isEligible) return 'Eligible';
  return null;
}
