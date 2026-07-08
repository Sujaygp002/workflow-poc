// AI Extraction (HANDOFF section 1.5) — ported from the .NET8 NewPdfExtract engine.
//
// Source ported/mined from:
//   reference/Order_Patient/NewPdfExtract/Services/NewPdfExtractionService.cs
//     - RegexExtract + the ~60 Rx* regex extractors (patient/physician/order/date/ICD/signature)
//     - the cost-tier pipeline (Tier 1 regex -> Tier 2/3 GPT, gated by GetMissingCoreFields)
//     - Validate() / PostValidateExtraction() / CleanDiagnosisCodes / NormalizeSignature
//     - IsValidIcdCode, ValidateDateFormat, NPI/ICD-10 format checks
//
// Adapted to the POC: the .NET engine did PdfPig text extraction + Tesseract OCR + Azure
// OpenAI GPT-3.5/GPT-4o-mini. Here Tier 1 is regex over whatever text the item already
// carries (workbook payload fields, any prior extraction text), and Tier 2 is Gemini via
// the existing gemini.extractMissingDataFromPdf (ONLY for fields regex could not fill).
// No hardcoded external API keys of any kind (HANDOFF landmine #1).

import { extractMissingDataFromPdf } from '../gemini.js';
import { GEMINI_MODEL } from '../config.js';
import { cleanString, hasValue, normalizeNpi, parseDate } from '../normalizers.js';

// ── PATTERNS ──────────────────────────────────────────────────────────────
// A practical subset (~20) of the .NET NewPdfExtractionService regex extractors,
// as named JS patterns. Each is a RegExp with a capturing group for the value
// (or the whole match for the list/flag patterns). Exported for reuse by audit.
export const PATTERNS = {
  // Patient
  patientName: [
    /Patient(?:'s)?\s*Name\s*and\s*Address[:\s]*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,3})\s+(?:\(|\d)/i,
    /Patient(?:'s)?\s*Name[:\s]+(?!and\s)([A-Z][A-Za-z]+(?:,?\s+[A-Z]\.?)?\s+[A-Z][A-Za-z]+)/i,
    /\(M0040\)\s*Name\s*([A-Za-z]+(?:\s+(?:Jr|Sr|II|III|IV))?,\s*[A-Za-z]+(?:\s+[A-Za-z]\.?)?)/i,
    /Patient:\s*([A-Za-z]+(?:\s+(?:Jr|Sr|II|III|IV))?,\s*[A-Za-z]+(?:\s+[A-Za-z]\.?)?)/i,
  ],
  patientDOB: [
    /(?:Patient's\s*)?Date\s*of\s*Birth[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /DOB[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
  ],
  patientSex: [/(?:Sex|Gender)[:\s]*(Male|Female|M|F)\b/i],
  patientAddress: [
    /Patient(?:'s)?\s*Address[:\s]*(\d+\s+[A-Za-z0-9\s,#\-.]+?[A-Za-z\s]+,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)/i,
    /(\d+\s+[A-Z\s]+(?:LANE|STREET|ST|ROAD|RD|DRIVE|DR|AVE|AVENUE|BLVD|WAY|CT|COURT|PL|PLACE|CIR|CIRCLE)[A-Z\s]+,\s*[A-Z]{2}\s+\d{5})/i,
  ],
  mrn: [
    /Medical\s*Record\s*No\.?[:\s]*(\d{3,9})(?=\D|$)/i,
    /MR(?:N|#)[:\s#]*(\d{3,9})(?=\D|$)/i,
    /Patient\s*(?:Account|ID)\s*(?:Number|No\.?)?[:\s#]*(\d{3,9})(?=\D|$)/i,
  ],

  // Order
  orderNumber: [
    /Order\s*Number[:\s#]*(\d{6,10})(?=\D|$)/i,
    /Plan\s*of\s*Care\s*\((\d{6,10})\)/i,
    /Plan\s*ID[:\s]*(\d{6,10})(?=\D|$)/i,
  ],
  orderDate: [
    /Order\s*Date[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /Date\s*(?:of\s*)?Order(?:ed)?[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /Plan\s*of\s*Care\s*Date[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
  ],

  // Episode / admission dates
  startOfCare: [
    /Start\s*of\s*Care[:\s]*(?:Date)?[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /SOC\s*(?:Date)?[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /(?:Admission|Care\s*Start)\s*Date[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
  ],
  // Certification period → SOE (group 1) + EOE (group 2)
  certificationPeriod: [
    /Certification\s*Period[:\s]*(?:From)?[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:[-–—]|To|Through|Thru)[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /Effective\s*from[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})[\s\S]*?Effective\s*to[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:[-–—]|to|through|thru)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
  ],

  // Physician
  physicianName: [
    /Attending\s+Physician[:\s]*([A-Z][A-Za-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][A-Za-z]+),?\s*(?:MD|DO|M\.D\.|D\.O\.)?/i,
    /Certif(?:ying|ied|\.)\s*Physician[:\s]*([A-Z][A-Za-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][A-Za-z]+),?\s*(?:MD|DO|M\.D\.|D\.O\.)?/i,
    /Ordering\s+Physician[:\s]*([A-Z][A-Za-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][A-Za-z]+),?\s*(?:MD|DO|M\.D\.|D\.O\.)?/i,
    /Physician:\s*Dr\.?\s+([A-Z][A-Za-z]+(?:\s+(?:Jr|Sr|II|III|IV))?,\s*[A-Za-z]+(?:\s+[A-Za-z]\.?)?)/i,
    /([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+),?\s*(?:MD|DO|M\.D\.|D\.O\.)/i,
  ],
  // NPI — always 10 digits
  npi: [
    /Physician(?:'s)?\s*NPI[:\s#]*(\d{10})/i,
    /(?:Attending|Ordering|Primary|Certifying)\s*Physician[\s\S]*?NPI[:\s#]*(\d{10})/i,
    /NPI\s*(?:Number|No|#)[:\s#]*(\d{10})/i,
    /NPI[:\s]*(\d{10})/i,
  ],

  // Agency (HHAH)
  agencyName: [
    /Branch\s*Name\s*(?:and\s*Address)?[:\s]*([A-Za-z\s]+(?:Home\s*Health|Healthcare|Health\s*Services|Nursing|Care|Hospice)(?:\s+[A-Za-z]+)?)/i,
    /(?:HHAH|HHA|Home\s*Health\s*Agency)[:\s]+([A-Za-z\s]+?)(?:\d|\n|$)/i,
  ],

  // ICD-10 codes (global — use with matchAll)
  icd10: /\b([A-Z]\d{2}(?:\.\d{1,4})?)\b/gi,

  // Signature
  signedDate: [
    /Digitally\s+Signed\s+by[:\s][\s\S]*?Date[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /Date\s*Signed[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /Signature\s*Date[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /Signed\s*(?:on)?[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /Date\s*of\s*Signature[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /e[-]?Signed[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
  ],
};

// Validation patterns (ported from Validate()).
export const VALIDATION = {
  npi: /^\d{10}$/,
  icd10: /^[A-Z]\d{2}(\.\d{1,4})?$/i,
};

// ── validation helpers (ported) ─────────────────────────────────────────────

const ICD_FALSE_POSITIVES = new Set([
  'PDF', 'NOT', 'THE', 'FOR', 'AND', 'ARE', 'WAS', 'HAS', 'HAD', 'HIS', 'HER',
  'ALL', 'BUT', 'CAN', 'DID', 'HIM', 'HOW', 'ITS', 'LET', 'MAY', 'NEW', 'NOW',
  'OLD', 'OUR', 'OUT', 'OWN', 'SAY', 'SHE', 'TOO', 'USE', 'WAY', 'WHO', 'BOY',
  'DAY', 'GET', 'MAN', 'ONE', 'RUN', 'TWO', 'FAX', 'TEL', 'DOB', 'DOC', 'DOS',
  'SOC', 'POC', 'PRN',
]);

// IsValidIcdCode — reject 3-char abbreviations that look like ICD codes.
function isValidIcdCode(code) {
  const upper = String(code).toUpperCase();
  if (ICD_FALSE_POSITIVES.has(upper.slice(0, 3)) && upper.length === 3) return false;
  return VALIDATION.icd10.test(upper);
}

// CleanOneCode + CleanDiagnosisCodes: normalize to A00 / A00.0000 shape, dedupe.
function cleanDiagnosisCodes(codes) {
  const out = [];
  const seen = new Set();
  for (const raw of codes || []) {
    const cleaned = cleanString(raw);
    if (!cleaned || ['-', '_', '--', 'N/A', 'NA'].includes(cleaned.toUpperCase())) continue;
    const m = cleaned.match(/^([A-Z]\d{2}(?:\.\d{1,4})?)/i);
    if (!m) continue;
    const code = m[1].toUpperCase();
    if (!isValidIcdCode(code)) continue;
    if (!seen.has(code)) { seen.add(code); out.push(code); }
  }
  return out;
}

// RxSignatureType — digital / physical / none classification (ported subset).
function classifySignatureType(text) {
  const lower = text.toLowerCase();
  if (
    lower.includes('digitally signed') || lower.includes('electronically signed') ||
    lower.includes('e-signed') || lower.includes('digital signature') ||
    lower.includes('e-signature') || lower.includes('electronic signature') ||
    lower.includes('authenticated by') || lower.includes('verified by')
  ) return 'digital';
  if (/\/s\/\s*[A-Z]/i.test(text)) return 'digital';
  if (/Signed\s+by\s+(?:Dr\.?\s+)?[A-Z][a-z]+\s+[A-Z][a-z]+\s+on\s+\d/i.test(text)) return 'digital';
  if (lower.includes('date/time stamp') || lower.includes('timestamp') || lower.includes('auto-signed')) return 'digital';
  if (lower.includes('signature on file')) return 'physical';
  if (/Physician(?:'s)?\s*Signature[:\s]+[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+/i.test(text)) return 'physical';
  if (lower.includes('signature') && lower.includes('date')) return 'none';
  return null;
}

// Heuristic order-type classifier (the .NET engine got OrderType from GPT only).
function classifyOrderType(text) {
  const lower = text.toLowerCase();
  if (/recert|re-cert|recertification/.test(lower)) return 'RECERT';
  if (/face[\s-]*to[\s-]*face|\bf2f\b/.test(lower)) return 'F2F';
  if (/cms[\s-]*485|plan\s*of\s*care|\b485\b/.test(lower)) return '485';
  if (/certification/.test(lower)) return 'CERT';
  return null;
}

// ── first-match helper ───────────────────────────────────────────────────
function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return cleanString(m[1]);
  }
  return null;
}

// ── Tier 1: regex extraction over available text ───────────────────────────
// Returns a flat {patient, order, diagnosisCodes, signature} shape.
function regexExtract(text) {
  const t = text || '';
  const cert = (() => {
    for (const re of PATTERNS.certificationPeriod) {
      const m = t.match(re);
      if (m && m[1] && m[2]) return { soe: cleanString(m[1]), eoe: cleanString(m[2]) };
    }
    return { soe: null, eoe: null };
  })();

  const icdCodes = cleanDiagnosisCodes(
    [...t.matchAll(PATTERNS.icd10)].map((m) => m[1])
  );

  return {
    patientName: firstMatch(t, PATTERNS.patientName),
    patientDOB: firstMatch(t, PATTERNS.patientDOB),
    patientSex: firstMatch(t, PATTERNS.patientSex),
    patientAddress: firstMatch(t, PATTERNS.patientAddress),
    mrn: firstMatch(t, PATTERNS.mrn),
    orderNumber: firstMatch(t, PATTERNS.orderNumber),
    orderDate: firstMatch(t, PATTERNS.orderDate),
    orderType: classifyOrderType(t),
    startOfCare: firstMatch(t, PATTERNS.startOfCare),
    startOfEpisode: cert.soe,
    endOfEpisode: cert.eoe,
    physicianName: firstMatch(t, PATTERNS.physicianName),
    npi: firstMatch(t, PATTERNS.npi),
    agencyName: firstMatch(t, PATTERNS.agencyName),
    diagnosisCodes: icdCodes,
    signedDate: firstMatch(t, PATTERNS.signedDate),
    signatureType: classifySignatureType(t),
  };
}

// Build the "any available text" corpus from the item payloads + prior extraction.
// The POC has no PdfPig; we mine whatever text the workbook / prior AI runs left.
function gatherText(item) {
  const parts = [];
  const push = (v) => { if (hasValue(v)) parts.push(cleanString(v)); };
  const ep = item.extraction_payload || {};
  // Prior extraction / raw text if a previous tier stored any.
  push(ep.rawText);
  push(ep.text);
  if (ep.ai) push(safeStringify(ep.ai));
  // Workbook source rows are the primary structured text source in the POC.
  if (ep.sourceRows) push(safeStringify(ep.sourceRows));
  return parts.join('\n');
}

function safeStringify(v) {
  try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return ''; }
}

// ── missing-core detection (GetMissingCoreFields, mapped to POC fields) ──────
// Reads the item payloads the same way taskRegistry.missingFields does so the
// tier gate reflects what is ACTUALLY still missing on the item after regex.
function missingCore(merged) {
  const missing = [];
  const p = merged.patient || {};
  const o = merged.order || {};
  if (!hasValue(p.name)) missing.push('patientName');
  if (!hasValue(p.DOB)) missing.push('patientDOB');
  if (!hasValue(p.MRN)) missing.push('MRN');
  if (!hasValue(p.sex)) missing.push('sex');
  if (!hasValue(p.address)) missing.push('address');
  if (!hasValue(p.SOC)) missing.push('startOfCare');
  if (!hasValue(p.SOE)) missing.push('startOfEpisode');
  if (!hasValue(p.EOE)) missing.push('endOfEpisode');
  if (!Array.isArray(p.diagnosis_codes) || p.diagnosis_codes.length === 0) missing.push('diagnosisCodes');
  if (!hasValue(o.order_number)) missing.push('orderNumber');
  if (!hasValue(o.order_type)) missing.push('orderType');
  if (!hasValue(o.order_date)) missing.push('orderDate');
  if (!hasValue(o.NPI)) missing.push('NPI');
  return missing;
}

// Seed the merge shape from what the item already carries (so regex only fills gaps).
function currentFields(item) {
  const p = item.patient_payload || {};
  const o = item.order_payload || {};
  return {
    patient: {
      name: p.patient_info?.name || null,
      sex: p.patient_info?.sex || null,
      DOB: p.patient_info?.DOB || null,
      MRN: p.admission_details?.MRN || null,
      address: p.personal_information?.address?.street || null,
      SOC: p.admission_details?.SOC || null,
      EOC: p.admission_details?.EOC || null,
      SOE: p.admission_details?.SOE || null,
      EOE: p.admission_details?.EOE || null,
      diagnosis_codes: Array.isArray(p.admission_details?.diagnosis_codes)
        ? p.admission_details.diagnosis_codes : [],
    },
    order: {
      order_number: o.order_info?.order_number || null,
      order_type: o.order_info?.order_type || null,
      order_date: o.order_info?.order_date || null,
      signed_date: o.order_status?.SignedByPhyscianDate || null,
      NPI: o.order_admission_details?.billing_provider?.NPI || null,
    },
  };
}

// Apply Tier-1 regex results onto the merge shape (only filling blanks).
function applyRegex(merged, rx) {
  const p = merged.patient;
  const o = merged.order;
  const fill = (obj, key, val) => { if (!hasValue(obj[key]) && hasValue(val)) obj[key] = val; };

  fill(p, 'name', rx.patientName);
  fill(p, 'sex', rx.patientSex);
  fill(p, 'DOB', rx.patientDOB);
  fill(p, 'MRN', rx.mrn);
  fill(p, 'address', rx.patientAddress);
  fill(p, 'SOC', rx.startOfCare);
  fill(p, 'SOE', rx.startOfEpisode);
  fill(p, 'EOE', rx.endOfEpisode);
  if ((!p.diagnosis_codes || p.diagnosis_codes.length === 0) && rx.diagnosisCodes?.length) {
    p.diagnosis_codes = rx.diagnosisCodes;
  }
  fill(o, 'order_number', rx.orderNumber);
  fill(o, 'order_type', rx.orderType);
  fill(o, 'order_date', rx.orderDate);
  fill(o, 'signed_date', rx.signedDate);
  fill(o, 'NPI', rx.npi ? normalizeNpi(rx.npi) : null);
}

// Apply Gemini (Tier 2) results — only for fields still blank.
function applyGemini(merged, data) {
  const gp = data?.patient || {};
  const go = data?.order || {};
  const p = merged.patient;
  const o = merged.order;
  const fill = (obj, key, val) => { if (!hasValue(obj[key]) && hasValue(val)) obj[key] = val; };

  fill(p, 'name', gp.name);
  fill(p, 'sex', gp.sex);
  fill(p, 'DOB', gp.DOB);
  fill(p, 'MRN', gp.MRN);
  fill(p, 'address', gp.address);
  fill(p, 'SOC', gp.SOC);
  fill(p, 'EOC', gp.EOC);
  fill(p, 'SOE', gp.SOE);
  fill(p, 'EOE', gp.EOE);
  if ((!p.diagnosis_codes || p.diagnosis_codes.length === 0) && Array.isArray(gp.diagnosis_codes)) {
    p.diagnosis_codes = cleanDiagnosisCodes(gp.diagnosis_codes);
  }
  fill(o, 'order_number', go.order_number);
  fill(o, 'order_type', go.order_type);
  fill(o, 'order_date', go.order_date);
  fill(o, 'signed_date', go.signed_date);
  fill(o, 'NPI', go.NPI ? normalizeNpi(go.NPI) : null);
}

// ── validation / normalization (ported from Validate + PostValidate) ────────
function validateAndNormalize(merged) {
  const errors = [];
  const p = merged.patient;
  const o = merged.order;

  // Date normalize → YYYY-MM-DD
  for (const key of ['DOB', 'SOC', 'EOC', 'SOE', 'EOE']) {
    if (hasValue(p[key])) p[key] = parseDate(p[key]) || p[key];
  }
  for (const key of ['order_date', 'signed_date']) {
    if (hasValue(o[key])) o[key] = parseDate(o[key]) || o[key];
  }

  // NPI must be 10 digits (else clear + flag).
  if (hasValue(o.NPI)) {
    const npi = normalizeNpi(o.NPI);
    if (VALIDATION.npi.test(npi)) { o.NPI = npi; }
    else { errors.push({ field: 'NPI', message: `NPI '${o.NPI}' is not 10 digits` }); o.NPI = null; }
  }

  // ICD-10 format regex — keep only valid, dedupe.
  if (Array.isArray(p.diagnosis_codes)) {
    const before = p.diagnosis_codes;
    p.diagnosis_codes = cleanDiagnosisCodes(before);
    for (const c of before) {
      if (!VALIDATION.icd10.test(cleanString(c))) {
        errors.push({ field: 'diagnosis_codes', message: `diagnosisCode '${c}' invalid` });
      }
    }
  }

  // OrderNumber == NPI confusion guard (PostValidateExtraction).
  if (hasValue(o.order_number) && o.order_number === o.NPI) {
    errors.push({ field: 'order_number', message: 'order_number equals NPI — cleared' });
    o.order_number = null;
  }
  // MRN == order_number confusion guard.
  if (hasValue(p.MRN) && p.MRN === o.order_number) {
    errors.push({ field: 'MRN', message: 'MRN equals order_number — cleared' });
    p.MRN = null;
  }

  // Episode length sanity (58–92 days) — advisory only.
  const soe = parseDate(p.SOE);
  const eoe = parseDate(p.EOE);
  if (soe && eoe) {
    const days = Math.round((new Date(eoe) - new Date(soe)) / 86400000);
    if (days < 58 || days > 92) {
      errors.push({ field: 'episode', message: `Episode is ${days} days (expected 58-92)` });
    }
  }

  return errors;
}

// ── the merge shape taskRegistry.ai.extractMissingDataFromPdf expects ────────
// Mirrors the {patient, order, PG, HHAH, practitioner} contract so the caller can
// mergeDeep it into item payloads exactly like the Gemini path does.
function toMergeShape(merged) {
  const p = merged.patient;
  const o = merged.order;
  return {
    patient: {
      name: p.name,
      sex: p.sex,
      DOB: p.DOB,
      MRN: p.MRN,
      address: p.address,
      SOC: p.SOC,
      EOC: p.EOC,
      SOE: p.SOE,
      EOE: p.EOE,
      diagnosis_codes: p.diagnosis_codes,
    },
    order: {
      order_number: o.order_number,
      order_type: o.order_type,
      order_date: o.order_date,
      signed_date: o.signed_date,
      NPI: o.NPI,
    },
  };
}

/**
 * extractWithPatterns — the cost-tiered extraction pipeline for one workflow item.
 *
 * Tier 1: regex over any available text (workbook payload fields, prior extraction
 *         text) — free, instant. Fills only blank fields.
 * Tier 2: Gemini (extractMissingDataFromPdf) ONLY when core fields are still missing
 *         AND a pdfBuffer is available — fills only the fields regex could not.
 * Then:   validation (date → YYYY-MM-DD, NPI 10 digits, ICD-10 format regex).
 *
 * @param {{ item: object, pdfBuffer?: Buffer|null }} args
 * @returns {Promise<{ ok, data, tiersUsed, missingAfter, model, validationErrors }>}
 *   `data` is shaped {patient, order, PG?, HHAH?, practitioner?} so the caller can
 *   mergeDeep it into the item payloads exactly like ai.extractMissingDataFromPdf.
 */
export async function extractWithPatterns({ item, pdfBuffer = null }) {
  const tiersUsed = [];
  const merged = currentFields(item);

  // ── Tier 1: regex ──
  const text = gatherText(item);
  if (hasValue(text)) {
    const rx = regexExtract(text);
    applyRegex(merged, rx);
    tiersUsed.push('regex');
  }

  let model = 'none';
  let missing = missingCore(merged);

  // ── Tier 2: Gemini (only for still-missing core fields, only with a PDF) ──
  if (missing.length > 0 && pdfBuffer) {
    try {
      const result = await extractMissingDataFromPdf({
        pdfBuffer,
        missingFields: missing,
        currentPayload: {
          patient: item.patient_payload,
          order: item.order_payload,
          references: item.reference_payload,
        },
      });
      if (result.ok) {
        applyGemini(merged, result.data);
        model = result.model || GEMINI_MODEL;
        tiersUsed.push('gemini');
      } else {
        // skipped (no key / no pdf) — surface but do not fail the tier pipeline.
        model = result.model || GEMINI_MODEL;
      }
    } catch {
      // Gemini failure is non-fatal — regex results stand; missingAfter reflects it.
      model = GEMINI_MODEL;
    }
  }

  // ── Validation / normalization ──
  const validationErrors = validateAndNormalize(merged);
  const missingAfter = missingCore(merged);

  return {
    ok: missingAfter.length === 0,
    data: toMergeShape(merged),
    tiersUsed,
    missingAfter,
    model,
    validationErrors,
  };
}
