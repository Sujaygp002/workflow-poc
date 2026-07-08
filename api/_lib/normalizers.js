export function cleanString(value) {
  return String(value ?? '').trim();
}

export function blankToNull(value) {
  const cleaned = cleanString(value);
  return cleaned ? cleaned : null;
}

export function normalizeName(value) {
  return cleanString(value).toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeNpi(value) {
  return cleanString(value).replace(/\D/g, '');
}

export function patientKeyFromParts(name, dob, mrn) {
  return [normalizeName(name), cleanString(dob).toLowerCase(), normalizeName(mrn)].join('|');
}

export function patientKey(patient) {
  return patientKeyFromParts(patient?.patient_info?.name, patient?.patient_info?.DOB, patient?.admission_details?.MRN);
}

// Patient UNIT identity (stable): name | DOB | MRN. Same composite the workflow
// uses to detect the same person regardless of HHAH/PG.
export function unitKey(patient) {
  return patientKey(patient);
}

// Patient RECORD context: a new Record is created when the HHAH or PG changes
// for the same Unit. Keyed on raw text values so it works even when no DB PG row
// exists yet. record_context_key = unit_key | normalizeName(HHAH) | normalizeName(PG).
export function recordContextKey(patient, reference) {
  return [unitKey(patient), normalizeName(reference?.HHAH?.name), normalizeName(reference?.PG?.name)].join('|');
}

export function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    excelEpoch.setUTCDate(excelEpoch.getUTCDate() + value);
    return excelEpoch.toISOString().slice(0, 10);
  }
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  // US slash dates (M/D/YYYY, the order-PDF format) are converted directly:
  // `new Date('06/20/2026')` parses as LOCAL midnight, so the toISOString()
  // round-trip below shifts them a day on any machine east of UTC.
  const slash = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    const year = slash[3].length <= 2 ? 2000 + Number(slash[3]) : Number(slash[3]);
    const mm = String(slash[1]).padStart(2, '0');
    const dd = String(slash[2]).padStart(2, '0');
    return `${year}-${mm}-${dd}`;
  }
  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return cleaned;
}

export function hasValue(value) {
  return cleanString(value) !== '';
}

export function safeJson(value, fallback = {}) {
  return value == null ? fallback : value;
}
