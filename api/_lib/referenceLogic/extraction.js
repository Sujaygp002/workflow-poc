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
// OpenAI GPT-3.5/GPT-4o-mini. Here Tier 1 runs the regexes over REAL PDF text — the
// order PDF referenced by extraction_payload.pdf.blobUrl is fetched and read with
// pdfText.extractPdfText (unpdf, pure JS) — then over whatever text the item already
// carries (workbook payload fields, any prior extraction text). Tier 2 is Gemini via
// the existing gemini.extractMissingDataFromPdf (ONLY for fields regex could not fill;
// skips gracefully when the key is dead). No hardcoded external API keys (landmine #1).

import { extractMissingDataFromPdf } from '../gemini.js';
import { GEMINI_MODEL } from '../config.js';
import { extractPdfText } from '../pdfText.js';
import { cleanString, hasValue, normalizeNpi, parseDate } from '../normalizers.js';

// ── PATTERNS ──────────────────────────────────────────────────────────────
// A practical subset (~20) of the .NET NewPdfExtractionService regex extractors,
// as named JS patterns. Each is a RegExp with a capturing group for the value
// (or the whole match for the list/flag patterns). Exported for reuse by audit.
//
// Tuned against the REAL Nightingale order PDFs (three layouts, all verified
// against extracted text): (A) DynamicPDF "Home Health Certification and Plan of
// Care" — grid form, label on one line / value on the next ("Medical Record No.\n
// MA210921015803"); (B) "Post Hospital Order" — "Conlan, Thomas (MA...)" header
// block with "DOB:" / "Episode:" lines; (C) Kinnser print-preview short orders
// ("Frequency Order: 06/30/2026", "Patient: Last, First (MRN)", "Physician: NAME
// MD", "NPI: ..."). The original CMS-485 test-kit patterns are KEPT — alternates
// were added, none removed.
export const PATTERNS = {
  // Patient
  patientName: [
    // Layout A: "Patient's Name and Address" label, "Last, First" on the next line.
    /Patient(?:'s)?\s*Name\s*and\s*Address[:\s]*\n([A-Z][A-Za-z' -]+,\s*[A-Za-z][A-Za-z .'-]*?)\s*\n/,
    /Patient(?:'s)?\s*Name\s*and\s*Address[:\s]*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,3})\s+(?:\(|\d)/i,
    /Patient(?:'s)?\s*Name[:\s]+(?!and\s)([A-Z][A-Za-z]+(?:,?\s+[A-Z]\.?)?\s+[A-Z][A-Za-z]+)/i,
    /\(M0040\)\s*Name\s*([A-Za-z]+(?:\s+(?:Jr|Sr|II|III|IV))?,\s*[A-Za-z]+(?:\s+[A-Za-z]\.?)?)/i,
    // Layout C: "Patient: Furtado Rezendes, Maria (MA220404115103)" — multi-word
    // last names, optional middle initial, MRN in parens.
    /Patient[:\s]+([A-Z][A-Za-z' -]+,\s*[A-Za-z][A-Za-z .'-]*?)\s*(?:\(|\n)/,
    /Patient:\s*([A-Za-z]+(?:\s+(?:Jr|Sr|II|III|IV))?,\s*[A-Za-z]+(?:\s+[A-Za-z]\.?)?)/i,
    // Layout B: unlabeled "Conlan, Thomas (MA250404064204)" header line.
    /^([A-Z][A-Za-z' -]+,\s*[A-Za-z][A-Za-z .'-]*?)\s*\(\s*[A-Z]{1,3}\d{6,}\s*\)/m,
  ],
  patientDOB: [
    /(?:Patient's\s*)?Date\s*of\s*Birth[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /DOB[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
  ],
  patientSex: [/(?:Sex|Gender)[:\s]*(Male|Female|M|F)\b/i],
  patientAddress: [
    /Patient(?:'s)?\s*Address[:\s]*(\d+\s+[A-Za-z0-9\s,#\-.]+?[A-Za-z\s]+,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)/i,
    // Layout A: street + "City, ST zip" on the two lines after the patient name
    // (newlines are joined into ", " by regexExtract).
    /Patient(?:'s)?\s*Name\s*and\s*Address[:\s]*\n[^\n]+\n(\d+[^\n]+\n[^\n]*?[A-Z]{2}\s*\d{5}(?:-\d{4})?)/i,
    // Layout C: "Address: 333 Wood St HIC#: ..." then "Fall River MA 02721 Phone: ...".
    /Address[:\s]+(\d+[^\n]*?)\s*(?:HIC#|Phone|Fax)[^\n]*\n([A-Za-z .'-]+[A-Z]{2}\s+\d{5}(?:-\d{4})?)/,
    /(\d+\s+[A-Z\s]+(?:LANE|STREET|ST|ROAD|RD|DRIVE|DR|AVE|AVENUE|BLVD|WAY|CT|COURT|PL|PLACE|CIR|CIRCLE)[A-Z\s]+,\s*[A-Z]{2}\s+\d{5})/i,
  ],
  mrn: [
    /Medical\s*Record\s*No\.?[:\s]*(\d{3,9})(?=\D|$)/i,
    // Layout A: alphanumeric MRN ("MA210921015803") on the line after the label.
    /Medical\s*Record\s*No\.?[:\s]*([A-Z]{1,4}\d{6,18})\b/i,
    // Layouts B/C: MRN in parens after the patient name ("(MA220404115103)").
    /\(\s*([A-Z]{1,3}\d{6,16})\s*\)/,
    /MR(?:N|#)[:\s#]*(\d{3,9})(?=\D|$)/i,
    /Patient\s*(?:Account|ID)\s*(?:Number|No\.?)?[:\s#]*(\d{3,9})(?=\D|$)/i,
  ],

  // Order
  orderNumber: [
    /Order\s*Number[:\s#]*(\d{6,10})(?=\D|$)/i,
    // Layouts B/C: "Order #1429555528" / "Post Hospital Order #1428144291".
    /Order\s*#\s*(\d{6,12})(?=\D|$)/i,
    /Plan\s*of\s*Care\s*\((\d{6,10})\)/i,
    /Plan\s*ID[:\s]*(\d{6,10})(?=\D|$)/i,
  ],
  orderDate: [
    /Order\s*Date[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    // Layout C title lines: "Frequency [Change|Discontinue] Order: 07/02/2026",
    // "Physician Order: 06/27/2026 22:29", "PRN Order: 07/02/2026".
    /(?:Physician|Frequency(?:\s+Change|\s+Discontinue)?|PRN|Telephone|Verbal|Supplemental)\s+Order[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /Date\s*(?:of\s*)?Order(?:ed)?[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /Plan\s*of\s*Care\s*Date[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    // Layout A fallback: the CMS-485 carries no explicit order date — use the
    // certification-period start (the plan-of-care effective date). LAST on
    // purpose so any labeled order date wins.
    /Certification\s*Period[:\s]*\n?\s*From[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
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
    // Layouts B/C: "Episode: 06/20/2026 - 08/18/2026".
    /Episode[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:[-–—]|to|through|thru)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /Effective\s*from[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})[\s\S]*?Effective\s*to[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:[-–—]|to|through|thru)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
  ],

  // Physician
  physicianName: [
    /Attending\s+Physician[:\s]*([A-Z][A-Za-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][A-Za-z]+),?\s*(?:MD|DO|M\.D\.|D\.O\.)?/i,
    /Certif(?:ying|ied|\.)\s*Physician[:\s]*([A-Z][A-Za-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][A-Za-z]+),?\s*(?:MD|DO|M\.D\.|D\.O\.)?/i,
    /Ordering\s+Physician[:\s]*([A-Z][A-Za-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][A-Za-z]+),?\s*(?:MD|DO|M\.D\.|D\.O\.)?/i,
    // Layout A: physician label, then "MENDES, MANUELA MD" on the next line
    // (credential suffix stripped). "Primary Physician" is tried FIRST so the
    // name pairs with the NPI the npi patterns extract (both sit in the
    // certification block); "Associate Physician" is the page-1 fallback.
    /Primary\s+Physician[:\s]*\n([A-Z][A-Za-z' -]+,[A-Za-z .' -]+?)(?:\s*,?\s*(?:M\.?D\.?|D\.?O\.?|N\.?P\.?|P\.?A\.?))?\s*\n/,
    /(?:Associate|Attending|Certifying|Ordering)\s+Physician[:\s]*\n([A-Z][A-Za-z' -]+,[A-Za-z .' -]+?)(?:\s*,?\s*(?:M\.?D\.?|D\.?O\.?|N\.?P\.?|P\.?A\.?))?\s*\n/,
    // Layout B: "Physician's Name:" then "STEPHEN BUTLER MD" on the next line.
    /Physician'?s?\s*Name[:\s]*\n?\s*([A-Z][A-Za-z .,'-]+?)\s*(?:,?\s+(?:M\.?D\.?|D\.?O\.?|N\.?P\.?|P\.?A\.?))?\s*\n/,
    // Layout C: "Physician: BIANCA THORPE DO" / "Physician: Joseph Spirito".
    /Physician[:\s]+([A-Z][A-Za-z .,'-]+?)\s*(?:,?\s+(?:M\.?D\.?|D\.?O\.?|N\.?P\.?|P\.?A\.?))?\s*\n/,
    /Physician:\s*Dr\.?\s+([A-Z][A-Za-z]+(?:\s+(?:Jr|Sr|II|III|IV))?,\s*[A-Za-z]+(?:\s+[A-Za-z]\.?)?)/i,
    /([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+),?\s*(?:MD|DO|M\.D\.|D\.O\.)/i,
  ],
  // NPI — always 10 digits ("NPI\n1033476627" in layout A, "NPI: ..." in C; the
  // Post Hospital layout carries NO physician NPI at all).
  npi: [
    /Physician(?:'s)?\s*NPI[:\s#]*(\d{10})/i,
    /(?:Attending|Ordering|Primary|Certifying)\s*Physician[\s\S]*?NPI[:\s#]*(\d{10})/i,
    /NPI\s*(?:Number|No|#)[:\s#]*(\d{10})/i,
    /NPI[:\s]*(\d{10})/i,
  ],

  // Agency (HHAH)
  agencyName: [
    // Single-line only ([A-Za-z ] not [A-Za-z\s]) — real PDF text has newlines,
    // and the greedy any-whitespace class swallowed the next label line.
    /Branch\s*Name\s*(?:and\s*Address)?[:\s]*([A-Za-z ]+(?:Home\s*Health|Healthcare|Health\s*Services|Nursing|Care|Hospice)(?: [A-Za-z]+)?)/i,
    // Layout A: "Branch Name and Address" label, agency name on the next line.
    /Branch\s*Name\s*(?:and\s*Address)?[:\s]*\n([A-Z][A-Za-z0-9 .,&'-]+?)\s*\n/,
    // Layout C: agency block directly under the "Date Received:" line — must be
    // followed by a street line (digits) so section headings can't match.
    /Date\s*Received[:\s]*\n([A-Z][A-Za-z0-9 .,&'-]+?)\s*\n\d+\s/i,
    // Colon required + single-line capture: the loose [:\s]+ form matched "hha"
    // inside real order narrative text ("Order Details: hha\nPRN Orders").
    /(?:HHAH|HHA|Home\s*Health\s*Agency):\s*([A-Za-z][A-Za-z .,&'-]*?)\s*(?:\(|\d|\n|$)/i,
  ],

  // ICD-10 codes (global fallback — use with matchAll). The scoped
  // diagnosis-section scan in extractDiagnosisCodes runs first.
  icd10: /\b([A-Z]\d{2}(?:\.\d{1,4})?)\b/gi,

  // Signature
  signedDate: [
    // Real signed orders carry a physician e-sign stamp:
    // "Electronically signed by Dr. Spirito, Joseph A. on 6/29/2026".
    /Electronically\s+signed\s+by[^\n]*?\s+on\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    // "Digitally Signed by" — EXCLUDING clinician (RN/PT/OT/…) verbal-order
    // stamps, which every real order carries whether or not the physician signed.
    /Digitally\s+Signed\s+by[:\s](?![^\n]*,\s*(?:RN|LPN|LVN|PT|PTA|OT|OTA|COTA|ST|SLP|MSW|RPT|RD|HHA)\b)[\s\S]*?Date[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /Date\s*Signed[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /Signature\s*Date[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /Signed\s*Date[:\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
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

// Normalize one raw ICD token: strip a trailing dot ("I10." in the CMS-485
// grid) and re-dot dotless codes ("J209" → "J20.9", "J9601" → "J96.01" — the
// Post Hospital layout prints codes without the decimal point).
function normalizeIcdToken(raw) {
  const code = String(raw || '').toUpperCase().replace(/\.$/, '');
  if (/^[A-Z]\d{2}(\.\d{1,4})?$/.test(code)) return code;
  if (/^[A-Z]\d{3,6}$/.test(code)) return `${code.slice(0, 3)}.${code.slice(3)}`;
  return code;
}

// Scoped diagnosis-code scan: only lines in/after a "…Diagnosis…" heading are
// mined, so page headers, med lists and phone numbers can't produce ICD-lookalike
// false positives. Handles all three real layouts + the test-kit form:
//   A: "Primary Diagnosis" / "Secondary/Other Diagnosis" headings, one
//      "CODE Description --" line each ("I10.", "M54.17", …)
//   B: same headings, dotless codes ("J209 Acute bronchitis…")
//   C: "Diagnosis: G40.89 Other seizures" inline + continuation lines
//   kit: "Principal Diagnosis: I50.9" / "Other Diagnoses: E11.9, N18.30"
export function extractDiagnosisCodes(text) {
  const codeAtStart = /^([A-Z]\d{2}(?:\.\d{1,4})?|[A-Z]\d{3,6})\.?\s+\S/;
  const inlineLabel = /Diagnos(?:is|es)[^:\n]{0,30}:\s*(\S.*)$/i;
  const codes = [];
  let inSection = false;
  let misses = 0;
  for (const line of String(text || '').split('\n')) {
    const inline = line.match(inlineLabel);
    if (inline) {
      for (const part of inline[1].split(/[,;]/)) {
        const m = part.trim().match(/^([A-Z]\d{2}(?:\.\d{1,4})?|[A-Z]\d{3,6})\.?(?:\s|$)/);
        if (m) codes.push(normalizeIcdToken(m[1]));
      }
      inSection = true;
      misses = 0;
      continue;
    }
    if (/Diagnos(?:is|es)/i.test(line)) { inSection = true; misses = 0; continue; }
    if (!inSection) continue;
    const m = line.match(codeAtStart);
    if (m) { codes.push(normalizeIcdToken(m[1])); misses = 0; }
    else if (++misses > 2) { inSection = false; misses = 0; }
  }
  return codes;
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
// Order of checks matters: an explicit "Order Type:" label wins (test-kit PDFs),
// then the document TITLE (the real CMS-485 attestation text contains both
// "recertify" and "face-to-face", so a whole-document keyword scan would
// misclassify every real 485), then the original keyword fallback.
function classifyOrderType(text) {
  const t = String(text || '');
  const labeled = t.match(/Order\s*Type[:\s]+([^\n]+)/i);
  if (labeled) {
    const v = labeled[1].toLowerCase();
    if (/face[\s-]*to[\s-]*face|\bf2f\b/.test(v)) return 'F2F';
    if (/recert/.test(v)) return 'RECERT';
    if (/485|plan\s*of\s*care/.test(v)) return '485';
    if (/cert/.test(v)) return 'CERT';
  }
  const head = t.split('\n').slice(0, 3).join(' ').toLowerCase();
  if (/home\s*health\s*certification\s*and\s*plan\s*of\s*care|cms[\s-]*485/.test(head)) return '485';
  if (/(?:post\s*hospital|frequency(?:\s+change|\s+discontinue)?|prn|physician|telephone|verbal)\s+order/.test(head)) return 'OTHER';
  const lower = t.toLowerCase();
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
// Exported so the harness (scripts/test-pdf-extraction.mjs) can score patterns.
export function regexExtract(text) {
  const t = text || '';
  const cert = (() => {
    for (const re of PATTERNS.certificationPeriod) {
      const m = t.match(re);
      if (m && m[1] && m[2]) return { soe: cleanString(m[1]), eoe: cleanString(m[2]) };
    }
    return { soe: null, eoe: null };
  })();

  // Address patterns may capture across two lines (street \n city) or in two
  // groups (street …noise… city) — join into one comma-separated string.
  const address = (() => {
    for (const re of PATTERNS.patientAddress) {
      const m = t.match(re);
      if (!m || !m[1]) continue;
      const parts = [m[1], m[2]].filter(hasValue).join('\n');
      return cleanString(parts.replace(/\s*\n\s*/g, ', '));
    }
    return null;
  })();

  // Scoped diagnosis-section scan first; global ICD-lookalike scan only as the
  // fallback (older fixtures with no Diagnosis heading).
  const scoped = extractDiagnosisCodes(t);
  const icdCodes = cleanDiagnosisCodes(
    scoped.length ? scoped : [...t.matchAll(PATTERNS.icd10)].map((m) => m[1])
  );

  return {
    patientName: firstMatch(t, PATTERNS.patientName),
    patientDOB: firstMatch(t, PATTERNS.patientDOB),
    patientSex: firstMatch(t, PATTERNS.patientSex),
    patientAddress: address,
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

// Fetch the order PDF stamped on the item at bulk upload
// (extraction_payload.pdf = {fileName, blobUrl, blobPath, signed}). Blob URLs are
// public-read; failures are non-fatal (Tier 1 falls back to payload text).
async function fetchPdfBufferForItem(item) {
  const url = item?.extraction_payload?.pdf?.blobUrl;
  if (!hasValue(url)) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// Cap the cached PDF text stored on the item output (the real 6-page orders run
// ~12KB; the cap only guards against pathological documents bloating payloads).
const PDF_TEXT_CACHE_LIMIT = 20000;

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
 * Tier 1a: regex over the REAL order PDF text. The PDF stamped on the item at
 *          bulk upload (extraction_payload.pdf.blobUrl) — or an explicitly passed
 *          pdfBuffer — is read with extractPdfText (unpdf, pure JS). Previously
 *          extracted text cached on extraction_payload.pdfText is reused without
 *          refetching. Fills only blank fields.
 * Tier 1b: regex over any other available text (workbook payload fields, prior
 *          extraction text) — free, instant. Fills only blank fields.
 * Tier 2:  Gemini (extractMissingDataFromPdf) ONLY when core fields are still
 *          missing AND the PDF bytes are available — fills only the fields regex
 *          could not. Skips gracefully (non-fatal) when the key is dead/missing.
 * Then:    validation (date → YYYY-MM-DD, NPI 10 digits, ICD-10 format regex).
 *
 * @param {{ item: object, pdfBuffer?: Buffer|null }} args
 * @returns {Promise<{ ok, data, tiersUsed, missingAfter, model, validationErrors, pdfText }>}
 *   `data` is shaped {patient, order, PG?, HHAH?, practitioner?} so the caller can
 *   mergeDeep it into the item payloads exactly like ai.extractMissingDataFromPdf.
 *   `pdfText` is the normalized extracted text (capped) so callers can cache it on
 *   the item for provenance and re-runs.
 */
export async function extractWithPatterns({ item, pdfBuffer = null }) {
  const tiersUsed = [];
  const merged = currentFields(item);

  // ── Tier 1a: regex over the real PDF text ──
  let buffer = pdfBuffer;
  let pdfText = cleanString(item?.extraction_payload?.pdfText || '') || null;
  if (!pdfText) {
    if (!buffer) buffer = await fetchPdfBufferForItem(item);
    if (buffer) {
      try {
        pdfText = (await extractPdfText(buffer)) || null;
      } catch {
        pdfText = null; // unreadable/scanned PDF — payload text + Gemini remain
      }
    }
  }
  if (hasValue(pdfText)) {
    applyRegex(merged, regexExtract(pdfText));
    tiersUsed.push('pdf-regex');
  }

  // ── Tier 1b: regex over payload text ──
  const text = gatherText(item);
  if (hasValue(text)) {
    const rx = regexExtract(text);
    applyRegex(merged, rx);
    tiersUsed.push('regex');
  }

  let model = 'none';
  let missing = missingCore(merged);

  // ── Tier 2: Gemini (only for still-missing core fields, only with a PDF) ──
  if (missing.length > 0 && !buffer) buffer = await fetchPdfBufferForItem(item);
  if (missing.length > 0 && buffer) {
    try {
      const result = await extractMissingDataFromPdf({
        pdfBuffer: buffer,
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
    pdfText: pdfText ? pdfText.slice(0, PDF_TEXT_CACHE_LIMIT) : null,
  };
}
