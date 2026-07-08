// AI Auditor — rule-based compliance/QA engine over rcm_records.
//
// Ported from the .NET8 reference AuditorService (HANDOFF §1.3):
//   reference/Order_Patient/Services/AuditorService.cs
//     - Part 1 rules (~242-1133): CheckDataCompleteness (R1), Check485DocumentDatesAsync (R2),
//       CheckPdfExtractionAsync (R3), CheckCCNotesAsync (R4) + ValidateNoteTextByType,
//       ContainsDatePatterns, ContainsPharmaceuticalContent, ContainsGibberishPatterns,
//       CheckForDuplicateCCNotes, CalculateTextSimilarity.
//     - Fuzzy matchers (~2990-3573): FuzzyNameMatch, FuzzyAddressMatch, DateMatch,
//       NormalizedMatch, NormalizeDiagnosis/CleanDiagnosisCode/IsValidIcdCode.
//   reference/Order_Patient/Models/Auditor.cs (AuditStatus pending/rework/done/sent).
//
// DELIBERATE DEVIATION (HANDOFF landmine): findings are STRUCTURED objects
//   { rule, code, field, message, fixable } stored in audit_records.rule_results —
//   the source coupled Part1->Part2 via magic comment strings; here rework.js parses data.
//
// Scope: item/agency-scoped. auditRcm({ item }) audits every rcm_record for the item's
// agency and cpo month (extraction_payload.dayBucket) against R1-R4, writes/updates one
// audit_records row per rcm_record, and returns pass/fail ids so the engine can gate on
// the audit_failed condition.

import { getSql } from '../db.js';

// ── Rule 1: required RCMNew fields (explicit list, NOT reflection) ─────────────
// Ported from AuditorService.Rule1RequiredFields. Mapped onto the POC rcm_records
// payload shape (payload.patient / payload.episode / payload.providers).
const R1_REQUIRED_FIELDS = [
  ['PatientName', (r) => r.patient?.name],
  ['DOB', (r) => r.patient?.dob],
  ['Gender', (r) => r.patient?.sex],
  ['PatientAddress', (r) => r.patient?.address],
  ['PatientState', (r) => r.patient?.state],
  ['Zip', (r) => r.patient?.zip],
  ['InsuranceCompanyName', (r) => r.patient?.insurance_company],
  ['FirstDiagnosis', (r) => r.diagnoses?.[0]],
  ['SecondDiagnosis', (r) => r.diagnoses?.[1]],
  ['ThirdDiagnosis', (r) => r.diagnoses?.[2]],
  ['StartOfCare', (r) => r.episode?.soc],
  ['StartofEpisode', (r) => r.episode?.soe],
  ['EndofEpisode', (r) => r.episode?.eoe],
  ['BillingProvider', (r) => r.providers?.billing_name],
  ['BillingProviderNPI', (r) => r.providers?.billing_npi],
  ['SupervisingProvider', (r) => r.providers?.supervising_name],
  ['SupervisingProviderNPI', (r) => r.providers?.supervising_npi],
  ['Agency', (r) => r.agency?.name],
  ['AgencyNPI', (r) => r.agency?.npi],
];

const DIAGNOSIS_PLACEHOLDERS = new Set(['-', '_', '--', '---', 'n/a', 'na']);

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function isDiagnosisPlaceholder(value) {
  if (isBlank(value)) return true;
  return DIAGNOSIS_PLACEHOLDERS.has(String(value).trim().toLowerCase());
}

// CleanDiagnosisCode — strip description text after the ICD-10 code.
function cleanDiagnosisCode(rawCode) {
  if (isBlank(rawCode)) return '';
  const trimmed = String(rawCode).trim();
  if (isDiagnosisPlaceholder(trimmed)) return '';
  const match = trimmed.match(/^([A-Z]\d{2}(?:\.[A-Z0-9]{1,4})?)/i);
  return match ? match[1].toUpperCase() : trimmed;
}

function isValidIcdCode(code) {
  if (isBlank(code)) return false;
  const cleaned = cleanDiagnosisCode(code);
  if (!cleaned) return false;
  return /^[A-Z]\d{2}(\.[A-Z0-9]{1,4})?$/i.test(cleaned);
}

function normalizeDiagnosis(dx) {
  if (isBlank(dx)) return '';
  return cleanDiagnosisCode(dx).replace(/[.\s-]/g, '').toUpperCase().trim();
}

// ── Date helpers (port of ParseDate / DateMatch) ──────────────────────────────
function parseDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  // ISO / most common formats parse directly.
  let d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  // MM/DD/YYYY or M/D/YY fallback.
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    d = new Date(year, Number(m[1]) - 1, Number(m[2]));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function dayOf(date) {
  return Math.floor(date.getTime() / 86400000);
}

function dateMatch(a, b) {
  const da = parseDate(a);
  const db = parseDate(b);
  if (!da || !db) return false;
  return dayOf(da) === dayOf(db);
}

// ── Fuzzy matchers (ported ~2990-3573) ────────────────────────────────────────
function normalizedMatch(a, b) {
  if (isBlank(a) || isBlank(b)) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

const NAME_SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);

function fuzzyNameMatch(rcmName, pdfName) {
  if (isBlank(rcmName) || isBlank(pdfName)) return false;
  const a = String(rcmName).trim().toUpperCase();
  const b = String(pdfName).trim().toUpperCase();
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aWords = a.split(/[\s,.]+/).filter((w) => w && !NAME_SUFFIXES.has(w));
  const bWords = b.split(/[\s,.]+/).filter((w) => w && !NAME_SUFFIXES.has(w));
  const matching = aWords.filter((w) => bWords.includes(w)).length;
  return matching >= 1 && matching >= Math.floor(Math.min(aWords.length, bWords.length) / 2);
}

const STREET_WORDS = new Set([
  'ST', 'STREET', 'AVE', 'AVENUE', 'DR', 'DRIVE', 'RD', 'ROAD', 'LN', 'LANE',
  'CT', 'COURT', 'BLVD', 'BOULEVARD', 'PL', 'PLACE', 'CIR', 'CIRCLE',
]);

function fuzzyAddressMatch(rcmAddr, pdfAddr) {
  if (isBlank(rcmAddr) || isBlank(pdfAddr)) return false;
  const a = String(rcmAddr).trim().toUpperCase();
  const b = String(pdfAddr).trim().toUpperCase();
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aWords = a.split(/[\s,.]+/).filter(Boolean);
  const bWords = b.split(/[\s,.]+/).filter(Boolean);
  const isNum = (w) => /^\d+$/.test(w) && w.length >= 3;
  const aNums = aWords.filter(isNum);
  const bNums = bWords.filter(isNum);
  if (aNums.some((n) => bNums.includes(n))) {
    const aStreet = aWords.filter((w) => !/^\d+$/.test(w) && !STREET_WORDS.has(w) && w.length > 2);
    const bStreet = bWords.filter((w) => !/^\d+$/.test(w) && !STREET_WORDS.has(w) && w.length > 2);
    if (aStreet.some((w) => bStreet.includes(w))) return true;
  }
  return false;
}

// Jaccard token-overlap similarity (port of CalculateTextSimilarity).
function calculateTextSimilarity(text1, text2) {
  const tokens = (t) => new Set(
    String(t).split(/[\s.,;:\n\r\t]+/).filter((w) => w.length > 2),
  );
  const words1 = tokens(text1);
  const words2 = tokens(text2);
  if (words1.size === 0 || words2.size === 0) return 0;
  let intersection = 0;
  for (const w of words1) if (words2.has(w)) intersection += 1;
  const union = new Set([...words1, ...words2]).size;
  return intersection / union;
}

// ── CC-note heuristics (ported from ValidateNoteTextByType + helpers) ──────────
const NO_DATE_NOTE_TYPES = ['medications', 'goals', 'preventive care', 'safety'];

const MED_KEYWORDS = [
  'mg', 'mcg', 'ml', 'tablet', 'pill', 'capsule', 'dose', 'dosage',
  'daily', 'twice', 'once', 'tid', 'bid', 'qid', 'prn',
  'oral', 'topical', 'injection', 'inhaler', 'patch',
  'aspirin', 'tylenol', 'ibuprofen', 'metformin', 'lisinopril',
  'amlodipine', 'metoprolol', 'omeprazole', 'gabapentin', 'losartan',
  'atorvastatin', 'levothyroxine', 'hydrocodone', 'azithromycin',
  'amoxicillin', 'insulin', 'warfarin', 'prednisone', 'tramadol',
];

const DATE_PATTERNS = [
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\b\d{1,2}-\d{1,2}-\d{2,4}\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/i,
];

function containsDatePatterns(text) {
  if (isBlank(text)) return false;
  return DATE_PATTERNS.some((p) => p.test(text));
}

function containsPharmaceuticalContent(text) {
  if (isBlank(text)) return false;
  const lower = String(text).toLowerCase();
  return MED_KEYWORDS.some((kw) => lower.includes(kw));
}

function containsGibberishPatterns(text) {
  if (isBlank(text)) return false;
  const s = String(text);
  if (/(.)\1{5,}/.test(s)) return true;
  const special = (s.match(/[^\p{L}\p{N}\s]/gu) || []).length;
  return special / s.length > 0.3;
}

// Demographic fields owned by the single-sourced isPatientDataComplete verdict
// (BusinessRequirementsService.IsPatientDataComplete): name, DOB, sex, address,
// state, zip. When rcm.data_complete === true we trust that verdict and skip the
// per-field MISSING checks for these (they were validated upstream); provider,
// diagnosis, and episode-date fields are still checked here.
const R1_DEMOGRAPHIC_FIELDS = new Set([
  'PatientName', 'DOB', 'Gender', 'PatientAddress', 'PatientState', 'Zip',
]);

// ── Rule 1: field completeness + ICD validity ─────────────────────────────────
function checkDataCompleteness(rcm) {
  const findings = [];

  // R2 single-sourcing (AC12): rcm.data_complete is the businessRules
  // isPatientDataComplete verdict computed in rcm.generate. When it is a real
  // boolean, it is authoritative for the demographic slice — true suppresses the
  // demographic MISSING findings; false/undefined falls back to field-by-field.
  const demographicsVerdict = typeof rcm.dataComplete === 'boolean' ? rcm.dataComplete : null;

  for (const [fieldName, getter] of R1_REQUIRED_FIELDS) {
    if (demographicsVerdict === true && R1_DEMOGRAPHIC_FIELDS.has(fieldName)) continue;
    if (isBlank(getter(rcm))) {
      findings.push({
        rule: 'R1', code: 'MISSING_FIELD', field: fieldName,
        message: `Missing: ${fieldName}`, fixable: true,
      });
    }
  }

  const diagnoses = Array.isArray(rcm.diagnoses) ? rcm.diagnoses : [];
  const diagLabels = ['FirstDiagnosis', 'SecondDiagnosis', 'ThirdDiagnosis', 'FourthDiagnosis', 'FifthDiagnosis', 'SixthDiagnosis'];
  for (let i = 0; i < diagLabels.length; i += 1) {
    const value = diagnoses[i];
    if (!isBlank(value) && !isDiagnosisPlaceholder(value) && !isValidIcdCode(value)) {
      findings.push({
        rule: 'R1', code: 'INVALID_ICD', field: diagLabels[i],
        message: `Invalid ICD code in ${diagLabels[i]}: '${value}'`, fixable: true,
      });
    }
  }

  // Diagnosis ordering: no gaps before a filled slot.
  let foundGap = false;
  for (let i = 0; i < diagLabels.length; i += 1) {
    if (isBlank(diagnoses[i])) {
      foundGap = true;
    } else if (foundGap) {
      findings.push({
        rule: 'R1', code: 'DIAGNOSIS_ORDERING', field: diagLabels[i],
        message: `Diagnosis ordering issue: ${diagLabels[i]} has value '${diagnoses[i]}' but earlier slots are empty`,
        fixable: true,
      });
      break;
    }
  }

  return findings;
}

// ── Rule 2: 485 date logic SOC<=SOE<=EOE and episode length 58-92 days ─────────
function check485Dates(rcm) {
  const findings = [];
  const soc = parseDate(rcm.episode?.soc);
  const soe = parseDate(rcm.episode?.soe);
  const eoe = parseDate(rcm.episode?.eoe);

  if (soc && soe && dayOf(soc) > dayOf(soe)) {
    findings.push({
      rule: 'R2', code: 'SOC_AFTER_SOE', field: 'StartOfCare',
      message: `SOC (${rcm.episode.soc}) is after SOE (${rcm.episode.soe})`, fixable: true,
    });
  }
  if (soe && eoe && dayOf(soe) > dayOf(eoe)) {
    findings.push({
      rule: 'R2', code: 'SOE_AFTER_EOE', field: 'StartofEpisode',
      message: `SOE (${rcm.episode.soe}) is after EOE (${rcm.episode.eoe})`, fixable: true,
    });
  }
  if (soe && eoe) {
    const episodeDays = dayOf(eoe) - dayOf(soe);
    if (episodeDays < 58 || episodeDays > 92) {
      findings.push({
        rule: 'R2', code: 'EPISODE_LENGTH', field: 'EndofEpisode',
        message: `Episode length is ${episodeDays} days (SOE: ${rcm.episode.soe}, EOE: ${rcm.episode.eoe}). Expected 58-92 days.`,
        fixable: true,
      });
    }
  }
  return findings;
}

// ── Rule 3: fuzzy-compare RCM/patient fields vs extraction payload ─────────────
// Compares the rcm_record's stored values against the item's AI-extracted 485 data
// (item.extraction_payload). ~0.8-threshold fuzzy matchers, per HANDOFF spec.
function checkExtractionConsistency(rcm, extraction) {
  const findings = [];
  if (!extraction) return findings;

  const p = extraction.patient || {};

  if (!isBlank(p.name) && !fuzzyNameMatch(rcm.patient?.name, p.name)) {
    findings.push({
      rule: 'R3', code: 'NAME_MISMATCH', field: 'PatientName',
      message: `Patient Name mismatch - RCM: '${rcm.patient?.name ?? ''}', PDF: '${p.name}'`,
      fixable: false,
    });
  }
  if (!isBlank(p.DOB) && !dateMatch(rcm.patient?.dob, p.DOB)) {
    findings.push({
      rule: 'R3', code: 'DOB_MISMATCH', field: 'DOB',
      message: `DOB mismatch - RCM: '${rcm.patient?.dob ?? ''}', PDF: '${p.DOB}'`,
      fixable: false,
    });
  }
  if (!isBlank(p.address) && !fuzzyAddressMatch(rcm.patient?.address, p.address)) {
    findings.push({
      rule: 'R3', code: 'ADDRESS_MISMATCH', field: 'PatientAddress',
      message: `Address mismatch - RCM: '${rcm.patient?.address ?? ''}', PDF: '${p.address}'`,
      fixable: false,
    });
  }
  if (!isBlank(p.state) && !normalizedMatch(rcm.patient?.state, p.state)) {
    findings.push({
      rule: 'R3', code: 'STATE_MISMATCH', field: 'PatientState',
      message: `State mismatch - RCM: '${rcm.patient?.state ?? ''}', PDF: '${p.state}'`,
      fixable: false,
    });
  }
  if (!isBlank(p.zip) && !normalizedMatch(rcm.patient?.zip, p.zip)) {
    findings.push({
      rule: 'R3', code: 'ZIP_MISMATCH', field: 'Zip',
      message: `Zip mismatch - RCM: '${rcm.patient?.zip ?? ''}', PDF: '${p.zip}'`,
      fixable: false,
    });
  }
  if (!isBlank(p.SOC) && !dateMatch(rcm.episode?.soc, p.SOC)) {
    findings.push({
      rule: 'R3', code: 'SOC_MISMATCH', field: 'StartOfCare',
      message: `SOC mismatch - RCM: '${rcm.episode?.soc ?? ''}', PDF: '${p.SOC}'`,
      fixable: true,
    });
  }
  if (!isBlank(p.SOE) && !dateMatch(rcm.episode?.soe, p.SOE)) {
    findings.push({
      rule: 'R3', code: 'SOE_MISMATCH', field: 'StartofEpisode',
      message: `SOE mismatch - RCM: '${rcm.episode?.soe ?? ''}', PDF: '${p.SOE}'`,
      fixable: true,
    });
  }
  if (!isBlank(p.EOE) && !dateMatch(rcm.episode?.eoe, p.EOE)) {
    findings.push({
      rule: 'R3', code: 'EOE_MISMATCH', field: 'EndofEpisode',
      message: `EOE mismatch - RCM: '${rcm.episode?.eoe ?? ''}', PDF: '${p.EOE}'`,
      fixable: true,
    });
  }

  // Diagnosis codes: RCM is authoritative; each RCM code must appear in PDF.
  const rcmDiagnoses = (Array.isArray(rcm.diagnoses) ? rcm.diagnoses : [])
    .map(normalizeDiagnosis).filter(Boolean);
  const pdfDiagnoses = (Array.isArray(p.diagnosis_codes) ? p.diagnosis_codes : [])
    .map(normalizeDiagnosis).filter(Boolean);
  if (rcmDiagnoses.length > 0 && pdfDiagnoses.length > 0) {
    for (const rcmDx of rcmDiagnoses) {
      if (!pdfDiagnoses.includes(rcmDx)) {
        findings.push({
          rule: 'R3', code: 'DIAGNOSIS_MISMATCH', field: 'Diagnosis',
          message: `RCM Diagnosis '${rcmDx}' not found in PDF (PDF has: ${pdfDiagnoses.slice(0, 10).join(', ')})`,
          fixable: true,
        });
      }
    }
  }

  return findings;
}

// ── Rule 4: CC-note validation ────────────────────────────────────────────────
// CC notes are carried on the rcm_record payload (payload.ccNotes[]) — produced by
// the AI Service miner and tagged data_tags.generated_by='ai_service'. Only applies
// when Line1CPT is a CPO-supervision code (G0181/G0182). 30-min CPO target.
function checkCcNotes(rcm) {
  const findings = [];
  const cpt = String(rcm.cptCode || rcm.line1Cpt || '').trim().toUpperCase();
  const requiresCcNotes = cpt === 'G0181' || cpt === 'G0182';
  if (!requiresCcNotes) return findings;

  const notes = Array.isArray(rcm.ccNotes) ? rcm.ccNotes : [];
  if (notes.length === 0) {
    findings.push({
      rule: 'R4', code: 'NO_CCNOTES', field: 'ccNotes',
      message: 'No CCNotes found for patient (required for G0181/G0182)', fixable: true,
    });
    return findings;
  }

  notes.forEach((note, idx) => {
    const noteId = note.id || note.noteWavId || `note#${idx}`;
    const noteType = String(note.noteType || '').toLowerCase();
    const noteText = note.noteText || '';

    if (isBlank(noteText) || String(noteText).length < 20) {
      findings.push({
        rule: 'R4', code: 'NOTE_TOO_SHORT', field: `ccNotes[${idx}].noteText`,
        message: `${noteId}: Note text is too short or empty`, fixable: true,
      });
    }
    if (noteType && !isBlank(noteText)) {
      if (NO_DATE_NOTE_TYPES.some((t) => noteType.includes(t)) && containsDatePatterns(noteText)) {
        findings.push({
          rule: 'R4', code: 'NOTE_HAS_DATE', field: `ccNotes[${idx}].noteText`,
          message: `${noteId} (${note.noteType}): Note should not contain dates`, fixable: true,
        });
      }
      if (noteType.includes('medication') && !containsPharmaceuticalContent(noteText)) {
        findings.push({
          rule: 'R4', code: 'MED_NOTE_NO_MEDS', field: `ccNotes[${idx}].noteText`,
          message: `${noteId} (${note.noteType}): Medications note should contain medication names/dosages`,
          fixable: true,
        });
      }
      if (containsGibberishPatterns(noteText)) {
        findings.push({
          rule: 'R4', code: 'NOTE_GIBBERISH', field: `ccNotes[${idx}].noteText`,
          message: `${noteId}: Note appears to contain invalid/gibberish content`, fixable: true,
        });
      }
    }
  });

  // Duplicate / high-similarity detection (port of CheckForDuplicateCCNotes).
  for (let i = 0; i < notes.length - 1; i += 1) {
    for (let j = i + 1; j < notes.length; j += 1) {
      const t1 = String(notes[i].noteText || '').trim().toLowerCase();
      const t2 = String(notes[j].noteText || '').trim().toLowerCase();
      const id1 = notes[i].id || notes[i].noteWavId || `note#${i}`;
      const id2 = notes[j].id || notes[j].noteWavId || `note#${j}`;
      if (!t1 || !t2) continue;
      if (t1 === t2) {
        findings.push({
          rule: 'R4', code: 'DUPLICATE_NOTE', field: `ccNotes[${j}].noteText`,
          message: `Duplicate NoteText: ${id1} and ${id2} have identical content`, fixable: true,
        });
        continue;
      }
      const sim = calculateTextSimilarity(t1, t2);
      if (sim > 0.85) {
        findings.push({
          rule: 'R4', code: 'SIMILAR_NOTE', field: `ccNotes[${j}].noteText`,
          message: `Similar CCNotes (${Math.round(sim * 100)}% match): ${id1} and ${id2}`, fixable: true,
        });
      }
    }
  }

  // 30-minute CPO target for G0181/G0182.
  const totalMinutes = notes.reduce((sum, n) => sum + (Number(n.minutes) || 0), 0);
  if (totalMinutes < 30) {
    findings.push({
      rule: 'R4', code: 'CPO_UNDER_TARGET', field: 'ccNotes',
      message: `CPO minutes total ${totalMinutes} (target 30 for ${cpt})`, fixable: true,
    });
  }

  return findings;
}

// Normalize a stored rcm_records row (payload jsonb + columns) into the shape the
// rule functions expect.
function normalizeRcmRow(row) {
  const payload = row.payload || {};
  return {
    id: row.id,
    cptCode: row.cpt_code || payload.cptCode || payload.line1Cpt,
    line1Cpt: payload.line1Cpt,
    patient: payload.patient || {},
    episode: payload.episode || {},
    agency: payload.agency || {},
    providers: payload.providers || {},
    diagnoses: payload.diagnoses || (payload.episode?.diagnosis_codes) || [],
    ccNotes: payload.ccNotes || [],
    // R2 verdicts surfaced by rcm.generate (businessRules ports): the
    // single-sourced demographics completeness (AC12) + the CPO-month readiness
    // tuple (AC10) so the audit can honour them instead of re-deriving.
    dataComplete: payload.data_complete,
    cpoMonthReadiness: payload.cpo_month_readiness,
    patientStatus: payload.patient_status,
    filterStatus: payload.filter_status,
  };
}

/**
 * Audit every rcm_record for the workflow item's agency + cpo month against R1-R4.
 * Writes/updates one audit_records row per rcm_record and returns pass/fail ids.
 *
 * @param {{ item: object }} args — item is the workflow_item row (reference_payload.HHAH,
 *   extraction_payload.dayBucket, extraction_payload with AI-extracted 485 data).
 * @returns {Promise<{ ok: boolean, passed: string[], failed: Array<{auditRecordId, rcmRecordId, findings}> }>}
 */
export async function auditRcm({ item }) {
  const sql = getSql();
  const agencyId = item?.reference_payload?.HHAH?.id || null;
  const extraction = item?.extraction_payload || null;

  if (!agencyId) {
    return { ok: false, passed: [], failed: [], error: 'No agency id on workflow item' };
  }

  // Audit every rcm_record for the item's agency. (An earlier revision scoped by
  // cpo_month = extraction_payload.dayBucket, but rcm_records.cpo_month holds a
  // human-readable "Month YYYY" label written by rcm.generateRcm, never the
  // YYYY-MM-DD day bucket — so that filter matched nothing and audited zero rows.
  // The daily run regenerates the agency's RCM records each firing, so agency
  // scope is the correct unit here.)
  const rcmRows = await sql`
    SELECT id, agency_id, patient_id, episode_id, cpo_month, cpt_code, amount_cents, status, payload
    FROM rcm_records
    WHERE agency_id = ${agencyId}`;

  const passed = [];
  const failed = [];

  for (const row of rcmRows) {
    const rcm = normalizeRcmRow(row);
    const findings = [
      ...checkDataCompleteness(rcm),
      ...check485Dates(rcm),
      ...checkExtractionConsistency(rcm, extraction),
      ...checkCcNotes(rcm),
    ];

    const status = findings.length === 0 ? 'done' : 'rework';
    const ruleResults = JSON.stringify(findings);

    // Upsert one audit_records row per rcm_record (idempotent per re-audit cycle).
    const existing = await sql`
      SELECT id FROM audit_records WHERE rcm_record_id = ${row.id} LIMIT 1`;

    let auditRecordId;
    if (existing.length > 0) {
      auditRecordId = existing[0].id;
      await sql`
        UPDATE audit_records
        SET status = ${status}, rule_results = ${ruleResults}::jsonb, updated_at = now()
        WHERE id = ${auditRecordId}`;
    } else {
      const inserted = await sql`
        INSERT INTO audit_records (rcm_record_id, agency_id, status, rule_results)
        VALUES (${row.id}, ${agencyId}, ${status}, ${ruleResults}::jsonb)
        RETURNING id`;
      auditRecordId = inserted[0].id;
    }

    if (findings.length === 0) {
      passed.push(row.id);
    } else {
      failed.push({ auditRecordId, rcmRecordId: row.id, findings });
    }
  }

  return { ok: true, passed, failed };
}

// Exported for reuse by rework.js (auto-fix re-audit) and testing.
export {
  checkDataCompleteness,
  check485Dates,
  checkExtractionConsistency,
  checkCcNotes,
  normalizeRcmRow,
  parseDate,
  cleanDiagnosisCode,
  isValidIcdCode,
  calculateTextSimilarity,
};
