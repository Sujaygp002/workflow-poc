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
