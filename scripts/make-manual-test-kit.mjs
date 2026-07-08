// make-manual-test-kit.mjs — regenerates the manual end-to-end test kit for the
// Phase-1 Daily Agency Intake workflow (cc-1783522521545 v2).
//
// Outputs (all under docs/manual-test-kit/):
//   TestKit_upload.xlsx      Sheet1 = 5 patient rows, Sheet2 = 7 order rows
//   orders_unsigned.zip      one <order_number>.pdf per UNSIGNED order
//   orders_signed.zip        one <order_number>.pdf per SIGNED order
//   README.md                scenario table + creds + manual test script
//
// The workbook column headers match api/_lib/excelParser.js PATIENT_HEADERS /
// ORDER_HEADERS aliases. The PDF text labels are phrased to hit the regexes in
// api/_lib/referenceLogic/extraction.js PATTERNS, so the Tier-1 regex extractor
// back-fills the sparse scenario-(c) row. Idempotent: re-running overwrites.
//
// Usage:  node scripts/make-manual-test-kit.mjs
//   verify only (no write): node scripts/make-manual-test-kit.mjs --verify

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { PATTERNS } from '../api/_lib/referenceLogic/extraction.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const OUT_DIR = join(REPO, 'docs', 'manual-test-kit');

// ── TEST entities (must match the live DB rows created via the reference APIs) ──
const AGENCY = 'Sunrise Meadows Home Health (TEST)';
const AGENCY_ADDR = '1420 Meadowlark Drive, Boise, ID 83704';
const PG = 'Lakeside Physicians Group (TEST)';
const CARTER = { name: 'Dr. Emily Carter', last: 'Carter', npi: '1568473921' };
const PATEL = { name: 'Dr. Raj Patel', last: 'Patel', npi: '1902847365' };

// MM/DD/YYYY for PDF text (extraction PATTERNS want US dates); YYYY-MM-DD for workbook.
const iso = (d) => d; // workbook keeps YYYY-MM-DD strings
function toUs(isoStr) {
  if (!isoStr) return '';
  const [y, m, d] = isoStr.split('-');
  return `${m}/${d}/${y}`;
}

// ── Scenario data ───────────────────────────────────────────────────────────
// 5 patients, 7 orders. Episode lengths are 58-92 days (audit-safe).
// order_number = O-TK-90xx, MRN = MRN-TK-1xx.

const patients = [
  // (a) Happy path — complete patient, 1 unsigned 485, 60-day episode
  {
    id: 'A',
    patientName: 'Margaret Sullivan', dob: '1948-03-12', mrn: 'MRN-TK-101',
    sex: 'Female', address: '2255 Birchwood Lane, Boise, ID 83705',
    soc: '2026-02-02', eoc: '', soe: '2026-02-02', eoe: '2026-04-02', // 59 days
    dx: ['I50.9', 'E11.9', 'N18.30'],
  },
  // (b) Missing SOC — exercises enter-admission-dates human task. SOE/EOE also blank so
  //     the episode-dates task also fires; PDF does NOT carry SOC (so it stays missing).
  {
    id: 'B',
    patientName: 'Harold Jennings', dob: '1952-07-25', mrn: 'MRN-TK-102',
    sex: 'Male', address: '88 Cypress Court, Meridian, ID 83642',
    soc: '', eoc: '', soe: '', eoe: '',
    dx: ['J44.9', 'I10'],
  },
  // (c) Sparse row — sex/address blank in workbook, order_type blank; PDF carries them
  //     so the Tier-1 regex extractor back-fills sex, address, and order type.
  {
    id: 'C',
    patientName: 'Beatrice Coleman', dob: '1945-11-08', mrn: 'MRN-TK-103',
    sex: '', address: '', // <- intentionally blank; PDF supplies
    soc: '2026-03-05', eoc: '', soe: '2026-03-05', eoe: '2026-05-20', // 76 days
    dx: ['M17.11', 'E11.9'],
  },
  // (d) Duplicate order_number — same order twice -> skip-duplicate path
  {
    id: 'D',
    patientName: 'Walter Nakamura', dob: '1950-01-30', mrn: 'MRN-TK-104',
    sex: 'Male', address: '714 Sagebrush Way, Nampa, ID 83651',
    soc: '2026-01-15', eoc: '', soe: '2026-01-15', eoe: '2026-03-25', // 69 days
    dx: ['I48.91', 'I50.9'],
  },
  // (e) Patient with 2 orders: one unsigned 485 + one SIGNED F2F (goes in signed zip)
  {
    id: 'E',
    patientName: 'Dorothy Fitzgerald', dob: '1943-09-17', mrn: 'MRN-TK-105',
    sex: 'Female', address: '3390 Kestrel Ridge Road, Eagle, ID 83616',
    soc: '2026-02-20', eoc: '', soe: '2026-02-20', eoe: '2026-04-25', // 64 days
    dx: ['I63.9', 'I69.30', 'E11.9'],
  },
];
const patientById = Object.fromEntries(patients.map((p) => [p.id, p]));

// Orders. `signed` -> goes in orders_signed.zip and carries a signature block.
// `physician` picks the ordering physician (Carter or Patel) + their NPI.
const orders = [
  // (a) happy path unsigned 485
  { orderno: 'O-TK-9001', patient: 'A', type: '485', orderdate: '2026-02-03', signed: false, physician: CARTER, scenario: 'a' },
  // (b) missing-SOC patient, unsigned 485 (order carries no SOC either)
  { orderno: 'O-TK-9002', patient: 'B', type: '485', orderdate: '2026-03-10', signed: false, physician: PATEL, scenario: 'b' },
  // (c) sparse — workbook order_type BLANK; PDF says "Plan of Care" so regex classifies 485
  { orderno: 'O-TK-9003', patient: 'C', type: '', orderdate: '2026-03-06', signed: false, physician: CARTER, scenario: 'c' },
  // (d) duplicate order_number — SAME order number twice (two order rows)
  { orderno: 'O-TK-9004', patient: 'D', type: '485', orderdate: '2026-01-16', signed: false, physician: PATEL, scenario: 'd' },
  { orderno: 'O-TK-9004', patient: 'D', type: '485', orderdate: '2026-01-16', signed: false, physician: PATEL, scenario: 'd-dup' },
  // (e) two orders for one patient: unsigned 485 + signed F2F
  { orderno: 'O-TK-9005', patient: 'E', type: '485', orderdate: '2026-02-21', signed: false, physician: CARTER, scenario: 'e-485' },
  { orderno: 'O-TK-9006', patient: 'E', type: 'F2F', orderdate: '2026-02-22', signed: true, signedDate: '2026-02-24', physician: CARTER, scenario: 'e-f2f' },
];

// ── Workbook ─────────────────────────────────────────────────────────────────
async function buildWorkbook() {
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet('Sheet1');
  const s2 = wb.addWorksheet('Sheet2');

  // Patient headers — use the canonical alias strings the parser recognizes.
  s1.addRow([
    'PatientName', 'DOB', 'MRN', 'Patient_Sex', 'Address', 'PG Name', 'Agency Name',
    'SOC', 'EOC', 'SOE', 'EOE',
    'Diagnosis 1', 'Diagnosis 2', 'Diagnosis 3', 'Diagnosis 4', 'Diagnosis 5', 'Diagnosis 6',
  ]);
  for (const p of patients) {
    s1.addRow([
      p.patientName, iso(p.dob), p.mrn, p.sex, p.address, PG, AGENCY,
      iso(p.soc), iso(p.eoc), iso(p.soe), iso(p.eoe),
      p.dx[0] || '', p.dx[1] || '', p.dx[2] || '', p.dx[3] || '', p.dx[4] || '', p.dx[5] || '',
    ]);
  }

  // Order headers.
  s2.addRow([
    'OrderNo', 'OrderDate', 'PatientName', 'DOB', 'MRN', 'DocumentType',
    'SOC', 'EOC', 'SOE', 'EOE', 'SignedDate', 'NPI',
  ]);
  for (const o of orders) {
    const p = patientById[o.patient];
    s2.addRow([
      o.orderno, iso(o.orderdate), p.patientName, iso(p.dob), p.mrn, o.type,
      iso(p.soc), iso(p.eoc), iso(p.soe), iso(p.eoe),
      o.signed ? iso(o.signedDate) : '', o.physician.npi,
    ]);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ── PDF (hand-rolled minimal single-page CMS-485, same technique as sample-4) ──
// Each visible line becomes a positioned Helvetica text object. Coordinates go
// top-down; PDF origin is bottom-left so y decreases as we descend.
function escapePdf(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildPdf(lines) {
  // lines: array of { text, size? }.  US Letter-ish tall page.
  const pageW = 612;
  const pageH = 792;
  let y = pageH - 48;
  const parts = [];
  for (const ln of lines) {
    const size = ln.size || 10;
    const text = escapePdf(ln.text);
    parts.push(`BT /F1 ${size} Tf 40 ${y} Td (${text}) Tj ET`);
    y -= (ln.gap || size + 4);
  }
  const content = parts.join('\n');
  const objs = [];
  objs.push('<</Type/Catalog/Pages 2 0 R>>');
  objs.push('<</Type/Pages/Kids[3 0 R]/Count 1>>');
  objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${pageW} ${pageH}]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>`);
  objs.push(`<</Length ${Buffer.byteLength(content, 'latin1')}>>\nstream\n${content}\nendstream`);
  objs.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj${body}endobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer<</Root 1 0 R/Size ${objs.length + 1}>>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

// Build the CMS-485 text layer. Labels are chosen to hit extraction.js PATTERNS:
//   patientName  -> "Patient's Name: First Last" (2nd patientName pattern)
//   patientDOB   -> "Date of Birth: MM/DD/YYYY"
//   patientSex   -> "Sex: Female"
//   patientAddress -> "Patient's Address: 123 Some St, ST 12345"
//   mrn          -> "Medical Record No.: 123456"
//   orderNumber  -> "Order Number: 9001"  (6-10 digits — see below)
//   orderDate    -> "Order Date: MM/DD/YYYY"
//   startOfCare  -> "Start of Care: MM/DD/YYYY"
//   certPeriod   -> "Certification Period: MM/DD/YYYY - MM/DD/YYYY"
//   physicianName-> "Attending Physician: Emily Carter, MD"
//   npi          -> "Physician NPI: 1568473921"
//   agencyName   -> "Home Health Agency: Sunrise Meadows Home Health"
//   icd10        -> diagnosis codes anywhere in text
//   signedDate   -> "Signed Date: MM/DD/YYYY" (+ /s/ signature = digital)
//   orderType    -> classifyOrderType sees "Plan of Care"/"485"/"Face-to-Face"
//
// NOTE on orderNumber: PATTERNS.orderNumber needs 6-10 DIGITS. Our order labels
// are "O-TK-9001" (non-numeric) which the workbook carries verbatim — the workbook
// value is authoritative for order_number, and the PDF filename match uses the
// full "O-TK-9001". So the PDF also prints a numeric "Order Number: <digits>" line
// purely to satisfy the regex tier; the workbook order_number is what the workflow
// keys on. This mirrors real 485s that carry a numeric plan-of-care id.
function cms485Lines(order) {
  const p = patientById[order.patient];
  const phys = order.physician;
  // extraction.js orderNumber PATTERNS require 6-10 digits, so pad the numeric id
  // to 6 digits (e.g. O-TK-9001 -> 990001). The workbook order_number is authoritative.
  const numericOrderNo = `99${order.orderno.replace(/\D/g, '')}`;
  const sexOut = p.sex || (order.scenario === 'c' ? 'Female' : ''); // scenario-c PDF supplies sex
  const addrOut = p.address || (order.scenario === 'c' ? '318 Aspen Grove Street, Boise, ID 83706' : '');

  const typeText = order.type === 'F2F'
    ? 'Face-to-Face Encounter'
    : (order.type === '485' || !order.type ? 'Plan of Care (CMS-485)' : order.type);

  const lines = [
    { text: 'HOME HEALTH CERTIFICATION AND PLAN OF CARE', size: 13, gap: 22 },
    { text: 'CMS-485  ·  Home Health Certification and Plan of Care', size: 9, gap: 18 },

    { text: 'PATIENT INFORMATION', size: 11, gap: 16 },
    { text: `Patient's Name: ${p.patientName}`, gap: 14 },
    { text: `Date of Birth: ${toUs(p.dob)}`, gap: 14 },
    { text: `Sex: ${sexOut}`, gap: 14 },
    { text: `Medical Record No.: ${p.mrn.replace(/\D/g, '')}`, gap: 14 },
    { text: `Patient's Address: ${addrOut}`, gap: 18 },

    { text: 'CERTIFICATION / EPISODE', size: 11, gap: 16 },
    ...(p.soc ? [{ text: `Start of Care: ${toUs(p.soc)}`, gap: 14 }] : [{ text: 'Start of Care: (pending admission)', gap: 14 }]),
    ...((p.soe && p.eoe)
      ? [{ text: `Certification Period: ${toUs(p.soe)} - ${toUs(p.eoe)}`, gap: 18 }]
      : [{ text: 'Certification Period: (to be assigned)', gap: 18 }]),

    { text: 'PROVIDER / AGENCY', size: 11, gap: 16 },
    // agencyName PATTERNS want the agency NAME right after the label (ending in
    // "Home Health"/"Healthcare"/etc.), so keep the name on the Branch Name line
    // and print the street address separately.
    { text: `Branch Name: ${AGENCY.replace(' (TEST)', '')}`, gap: 14 },
    { text: `Home Health Agency: ${AGENCY.replace(' (TEST)', '')} (TEST)`, gap: 14 },
    { text: `Agency Address: ${AGENCY_ADDR}`, gap: 18 },

    { text: 'PHYSICIAN', size: 11, gap: 16 },
    { text: `Attending Physician: ${phys.name.replace('Dr. ', '')}, MD`, gap: 14 },
    { text: `Physician NPI: ${phys.npi}`, gap: 14 },
    { text: `Physician Group: ${PG}`, gap: 18 },

    { text: 'DIAGNOSES (ICD-10)', size: 11, gap: 16 },
    { text: `Principal Diagnosis: ${p.dx[0]}`, gap: 14 },
    ...(p.dx.slice(1).length
      ? [{ text: `Other Diagnoses: ${p.dx.slice(1).join(', ')}`, gap: 18 }]
      : [{ text: 'Other Diagnoses: none', gap: 18 }]),

    { text: 'MEDICATIONS', size: 11, gap: 16 },
    { text: 'Lisinopril 10 mg PO daily; Metformin 500 mg PO BID; Furosemide 20 mg PO daily.', size: 9, gap: 14 },
    { text: 'Aspirin 81 mg PO daily; Atorvastatin 40 mg PO nightly.', size: 9, gap: 18 },

    { text: 'ORDERS FOR DISCIPLINE AND TREATMENTS / GOALS', size: 11, gap: 16 },
    { text: 'SN to assess cardiopulmonary status; teach medication regimen and disease process.', size: 9, gap: 14 },
    { text: 'PT to evaluate and treat for gait/strength; goal: safe ambulation with assistive device.', size: 9, gap: 18 },

    { text: 'ORDER DETAIL', size: 11, gap: 16 },
    { text: `Order Number: ${numericOrderNo}`, gap: 14 },
    { text: `Plan of Care ID: ${numericOrderNo}`, gap: 14 },
    { text: `Order Date: ${toUs(order.orderdate)}`, gap: 14 },
    { text: `Order Type: ${typeText}`, gap: 16 },
    { text: `(Workbook Order Reference: ${order.orderno})`, size: 8, gap: 18 },
  ];

  if (order.signed) {
    lines.push({ text: 'PHYSICIAN CERTIFICATION / SIGNATURE', size: 11, gap: 16 });
    lines.push({ text: `Physician Signature: /s/ ${phys.name.replace('Dr. ', '')}, MD`, gap: 14 });
    lines.push({ text: `Signature Date: ${toUs(order.signedDate)}`, gap: 14 });
    lines.push({ text: 'Electronically Signed — signature verified.', size: 9, gap: 14 });
  } else {
    lines.push({ text: 'PHYSICIAN CERTIFICATION / SIGNATURE', size: 11, gap: 16 });
    lines.push({ text: 'Physician Signature: __________________________  (UNSIGNED)', gap: 14 });
    lines.push({ text: 'Signed Date: ____________', gap: 14 });
  }
  return lines;
}

// Flatten the PDF line objects into one text blob for regex verification.
function pdfText(lines) {
  return lines.map((l) => l.text).join('\n');
}

// ── Regex verification (runs PATTERNS over each PDF text layer) ────────────────
function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}
function certPeriod(text) {
  for (const re of PATTERNS.certificationPeriod) {
    const m = text.match(re);
    if (m && m[1] && m[2]) return { soe: m[1], eoe: m[2] };
  }
  return { soe: null, eoe: null };
}
function classifyOrderType(text) {
  const lower = text.toLowerCase();
  if (/recert|re-cert|recertification/.test(lower)) return 'RECERT';
  if (/face[\s-]*to[\s-]*face|\bf2f\b/.test(lower)) return 'F2F';
  if (/cms[\s-]*485|plan\s*of\s*care|\b485\b/.test(lower)) return '485';
  if (/certification/.test(lower)) return 'CERT';
  return null;
}
function icd10(text) {
  return [...text.matchAll(PATTERNS.icd10)].map((m) => m[1]);
}

function verifyPdf(order) {
  const text = pdfText(cms485Lines(order));
  const cp = certPeriod(text);
  return {
    order: order.orderno,
    patientName: firstMatch(text, PATTERNS.patientName),
    patientDOB: firstMatch(text, PATTERNS.patientDOB),
    patientSex: firstMatch(text, PATTERNS.patientSex),
    patientAddress: firstMatch(text, PATTERNS.patientAddress),
    mrn: firstMatch(text, PATTERNS.mrn),
    orderNumber: firstMatch(text, PATTERNS.orderNumber),
    orderDate: firstMatch(text, PATTERNS.orderDate),
    orderType: classifyOrderType(text),
    startOfCare: firstMatch(text, PATTERNS.startOfCare),
    soe: cp.soe, eoe: cp.eoe,
    physicianName: firstMatch(text, PATTERNS.physicianName),
    npi: firstMatch(text, PATTERNS.npi),
    agencyName: firstMatch(text, PATTERNS.agencyName),
    icd: icd10(text),
    signedDate: firstMatch(text, PATTERNS.signedDate),
  };
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const verifyOnly = process.argv.includes('--verify');

  // Verify every PDF's regex extraction; hard-fail if scenario-(c) back-fill fields miss.
  const report = orders.map(verifyPdf);
  const cOrder = orders.find((o) => o.scenario === 'c');
  const cReport = verifyPdf(cOrder);
  const cOk = cReport.patientSex && cReport.patientAddress && cReport.orderType === '485';
  console.log('=== Regex extraction report (per PDF) ===');
  for (const r of report) {
    console.log(`${r.order}: name=${!!r.patientName} dob=${!!r.patientDOB} sex=${r.patientSex} addr=${!!r.patientAddress} mrn=${r.mrn} ordNo=${r.orderNumber} ordDate=${!!r.orderDate} type=${r.orderType} soc=${!!r.startOfCare} soe=${!!r.soe} eoe=${!!r.eoe} phys=${!!r.physicianName} npi=${r.npi} agency=${!!r.agencyName} icd=[${r.icd.join(',')}] signed=${r.signedDate || '-'}`);
  }
  console.log(`\nScenario (c) back-fill check: sex=${cReport.patientSex} address=${!!cReport.patientAddress} orderType=${cReport.orderType} -> ${cOk ? 'PASS' : 'FAIL'}`);
  if (!cOk) {
    console.error('FATAL: scenario-(c) PDF does not yield the back-fill fields; aborting.');
    process.exit(1);
  }
  if (verifyOnly) return;

  mkdirSync(OUT_DIR, { recursive: true });

  // Workbook
  const xlsx = await buildWorkbook();
  writeFileSync(join(OUT_DIR, 'TestKit_upload.xlsx'), xlsx);

  // PDFs -> two zips. One PDF per order; DUPLICATE order (d-dup) reuses the same
  // filename, so it is written only once into the unsigned zip (the second workbook
  // row is what triggers the skip-duplicate path at upload time).
  const unsignedZip = new JSZip();
  const signedZip = new JSZip();
  const written = new Set();
  for (const o of orders) {
    const fname = `${o.orderno}.pdf`;
    if (written.has(fname)) continue; // don't double-add the duplicate order PDF
    written.add(fname);
    const pdf = buildPdf(cms485Lines(o));
    if (o.signed) signedZip.file(fname, pdf);
    else unsignedZip.file(fname, pdf);
  }
  const unsignedBuf = await unsignedZip.generateAsync({ type: 'nodebuffer' });
  const signedBuf = await signedZip.generateAsync({ type: 'nodebuffer' });
  writeFileSync(join(OUT_DIR, 'orders_unsigned.zip'), unsignedBuf);
  writeFileSync(join(OUT_DIR, 'orders_signed.zip'), signedBuf);

  writeFileSync(join(OUT_DIR, 'README.md'), README);

  console.log('\n=== Kit written to', OUT_DIR, '===');
  console.log('  TestKit_upload.xlsx  (5 patient rows, 7 order rows)');
  console.log(`  orders_unsigned.zip  (${Object.keys(unsignedZip.files).length} PDFs)`);
  console.log(`  orders_signed.zip    (${Object.keys(signedZip.files).length} PDF)`);
  console.log('  README.md');
}

// ── README content ───────────────────────────────────────────────────────────
const README = `# Manual End-to-End Test Kit — Phase-1 Daily Agency Intake

Files in this folder, generated by \`scripts/make-manual-test-kit.mjs\` (idempotent —
re-run to regenerate):

| File | What |
|------|------|
| \`TestKit_upload.xlsx\` | Workbook. **Sheet1** = 5 patient rows, **Sheet2** = 7 order rows. |
| \`orders_unsigned.zip\` | 5 UNSIGNED order PDFs (\`<order_number>.pdf\`). |
| \`orders_signed.zip\` | 1 SIGNED order PDF (\`O-TK-9006.pdf\`, the F2F). |

All rows use the TEST agency / PG / practitioners already created in the live DB.
PDFs are minimal single-page CMS-485s whose label phrasing is tuned to the
\`api/_lib/referenceLogic/extraction.js\` regex PATTERNS, so the Tier-1 regex
extractor fills fields (and back-fills the sparse row).

---

## Live DB entities (created via the real Entity / External-User APIs)

| Entity | Name | id | Notes |
|--------|------|----|-------|
| Agency (HHAH) | Sunrise Meadows Home Health (TEST) | \`d7e3686b-63f1-4d27-b766-c84bfeee2c8a\` | contact email resources@ucodemint.com, 1420 Meadowlark Drive, Boise, ID 83704 |
| PG | Lakeside Physicians Group (TEST) | \`74bbad3e-ce10-4343-8a82-0f013af128c7\` | both practitioners mapped |
| Practitioner | Dr. Emily Carter | \`2699c4b8-1d09-47da-aa39-81f4b80b7cc7\` | NPI 1568473921 |
| Practitioner | Dr. Raj Patel | \`38bd5264-a54d-467c-b3d3-28d6caa2ee15\` | NPI 1902847365 |

### Portal credentials

| Portal | URL | Username | Password | Scope |
|--------|-----|----------|----------|-------|
| HHAH upload | \`/hhh-login\` | \`sunrise-test\` | \`TestAgency!2026\` | Sunrise Meadows (TEST) |
| PG practitioner (Bulk Sign) | \`/pg-login\` | \`lakeside-test\` | \`TestPg!2026\` | Lakeside (TEST) — Dr. Emily Carter, NPI 1568473921 |
| Worker portal | \`/worker\` | \`demo-rcm-coordinator\` | \`DemoWorker!2026\` | completes the phase-1 human tasks |

---

## Scenario table (workbook row → what to expect in the workflow)

| # | Patient (MRN) | Order(s) | Scenario | Expected workflow behavior |
|---|---------------|----------|----------|----------------------------|
| a | Margaret Sullivan (MRN-TK-101) | O-TK-9001 (unsigned 485, 59-day ep) | **Happy path** | \`patient_exists\`=NO → create patient; admission + episode dates present → no human date task; \`order_exists\`=NO → create order; ends at Review Record human task. |
| b | Harold Jennings (MRN-TK-102) | O-TK-9002 (unsigned 485) | **Missing SOC** | SOC (and SOE/EOE) blank in workbook AND absent from the PDF → \`admission_dates_missing\`=YES → **Enter admission dates** human task; then \`episode_dates_missing\`=YES → **Enter episode dates** human task. |
| c | Beatrice Coleman (MRN-TK-103) | O-TK-9003 (order_type blank) | **Sparse row, PDF back-fill** | Workbook has blank sex, blank address, blank order_type. The PDF carries Sex=Female, a full address, and "Plan of Care (CMS-485)" → **Tier-1 regex extraction back-fills** sex + address + order type = 485 before the record is written. |
| d | Walter Nakamura (MRN-TK-104) | O-TK-9004 ×2 (same order number twice) | **Duplicate order** | Two order rows share \`O-TK-9004\`. First creates the order; the second hits \`order_exists\`=YES → **skip-duplicate** path (order not re-created, logged as skipped). |
| e | Dorothy Fitzgerald (MRN-TK-105) | O-TK-9005 (unsigned 485) + O-TK-9006 (SIGNED F2F) | **Two orders, one signed** | One patient, two orders. O-TK-9005 is an unsigned 485 (unsigned zip). O-TK-9006 is a **signed F2F** (signed zip) carrying \`/s/ Emily Carter, MD\` + Signed Date → arrives already signed. |

Notes on the join: Sheet2 order rows join to Sheet1 patient rows by identity
(name | DOB | MRN). Every order's NPI column carries the ordering physician's NPI
(Carter 1568473921 / Patel 1902847365). Episode lengths are all 58–92 days so the
episode-length audit rule stays happy.

---

## Step-by-step manual test script

1. **Upload as the agency.** Open \`/hhh-login\`, log in as **sunrise-test** /
   **TestAgency!2026**. On the Bulk Upload form attach the **three** files:
   - Workbook: \`TestKit_upload.xlsx\`
   - Unsigned orders zip: \`orders_unsigned.zip\`
   - Signed orders zip: \`orders_signed.zip\`
   Submit the upload.

2. **Watch the Orchestrator.** Open the Command Center → **Orchestrator**. Because
   the Phase-1 daily workflow (\`cc-1783522521545\` v2) is active, your upload is
   reconciled into today's live daily run (mid-run append seam) — the Sunrise Meadows
   (TEST) item appears with the agency-upload branch taken (uploaded = YES), then the
   extraction / patient-exists / admission-dates / episode-dates / order-exists
   diamonds resolve per row. Confirm:
   - Scenario **a** flows straight to Review Record.
   - Scenario **b** raises the **Enter admission dates** then **Enter episode dates**
     human tasks (pink, in the worker backlog).
   - Scenario **c** shows the record written **with** sex + address + order type even
     though the workbook cells were blank (regex back-fill from the PDF).
   - Scenario **d**'s second O-TK-9004 is marked skipped-duplicate.
   - Scenario **e** produces two orders; the F2F arrives signed.

3. **Complete the human tasks.** Open \`/worker\`, log in as **demo-rcm-coordinator**
   / **DemoWorker!2026**. Work the backlog:
   - Enter admission dates for Harold Jennings (pick a 2026 SOC, e.g. 2026-03-01).
   - Enter episode dates (e.g. SOE 2026-03-01 / EOE 2026-05-01 → 61 days).
   - Complete each **Review Record** task to settle the remaining items.

4. **(Optional) Bulk Sign the unsigned orders.** Open \`/pg-login\`, log in as
   **lakeside-test** / **TestPg!2026** (Dr. Emily Carter). The unsigned 485s ordered
   by Carter (O-TK-9001, O-TK-9003, O-TK-9005) appear in Bulk Sign; sign them to
   drive the downstream signed-status update.

When the run's items are all completed/skipped, the daily run rolls up to completed.
`;

main().catch((err) => { console.error(err); process.exit(1); });
