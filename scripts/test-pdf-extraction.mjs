// test-pdf-extraction.mjs — offline harness for the Tier-1 PDF extraction
// (api/_lib/pdfText.js + referenceLogic/extraction.js PATTERNS).
//
// Runs extractPdfText + regexExtract over:
//   1. the REAL Nightingale order PDFs (the blob-preloaded demo set) from
//      REAL_PDF_DIR (default /Users/sujaygp/Desktop/data/dataa/pdfs — the
//      {signed,unsigned}/*.pdf dirs), and
//   2. the 6 CMS-485 test-kit PDFs inside docs/manual-test-kit/orders_*.zip
// and prints a per-file, per-field hit table plus per-field totals.
//
// No DB, no network, no Gemini — pure pattern scoring. Usage:
//   node scripts/test-pdf-extraction.mjs            # table + totals
//   node scripts/test-pdf-extraction.mjs --values   # also dump extracted values

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { extractPdfText } from '../api/_lib/pdfText.js';
import { regexExtract } from '../api/_lib/referenceLogic/extraction.js';

const REPO = resolve(new URL('..', import.meta.url).pathname);
const REAL_PDF_DIR = process.env.REAL_PDF_DIR || '/Users/sujaygp/Desktop/data/dataa/pdfs';
const SHOW_VALUES = process.argv.includes('--values');

const FIELDS = [
  ['patientName', 'name'],
  ['patientDOB', 'DOB'],
  ['mrn', 'MRN'],
  ['orderNumber', 'ordNo'],
  ['orderDate', 'ordDate'],
  ['orderType', 'ordType'],
  ['startOfEpisode', 'SOE'],
  ['endOfEpisode', 'EOE'],
  ['startOfCare', 'SOC'],
  ['physicianName', 'physician'],
  ['npi', 'NPI'],
  ['diagnosisCodes', 'ICD10'],
  ['patientSex', 'sex'],
  ['patientAddress', 'addr'],
  ['agencyName', 'agency'],
  ['signedDate', 'signed'],
];

function hit(rx, field) {
  const v = rx[field];
  if (Array.isArray(v)) return v.length > 0;
  return v != null && String(v).trim() !== '';
}

async function collectReal() {
  const out = [];
  for (const dir of ['signed', 'unsigned']) {
    const base = join(REAL_PDF_DIR, dir);
    if (!existsSync(base)) continue;
    for (const file of readdirSync(base).filter((f) => f.endsWith('.pdf')).sort()) {
      out.push({ set: 'real', label: `${dir}/${file}`, buffer: readFileSync(join(base, file)) });
    }
  }
  return out;
}

async function collectKit() {
  const out = [];
  for (const zipName of ['orders_unsigned.zip', 'orders_signed.zip']) {
    const zipPath = join(REPO, 'docs', 'manual-test-kit', zipName);
    if (!existsSync(zipPath)) continue;
    const zip = await JSZip.loadAsync(readFileSync(zipPath));
    for (const name of Object.keys(zip.files).filter((n) => n.toLowerCase().endsWith('.pdf')).sort()) {
      out.push({ set: 'kit', label: `kit/${name}`, buffer: Buffer.from(await zip.files[name].async('nodebuffer')) });
    }
  }
  return out;
}

function printTable(rows) {
  const nameWidth = Math.max(...rows.map((r) => r.label.length)) + 1;
  const header = ['file'.padEnd(nameWidth), ...FIELDS.map(([, short]) => short.padEnd(Math.max(short.length, 4)))].join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const row of rows) {
    const cells = FIELDS.map(([field, short]) =>
      (hit(row.rx, field) ? 'Y' : '.').padEnd(Math.max(short.length, 4)));
    console.log([row.label.padEnd(nameWidth), ...cells].join(' '));
  }
}

function printTotals(rows, setName) {
  const subset = rows.filter((r) => r.set === setName);
  if (!subset.length) return;
  console.log(`\n${setName === 'real' ? 'REAL order PDFs' : 'Test-kit PDFs'} — per-field hit rate (${subset.length} files):`);
  for (const [field, short] of FIELDS) {
    const n = subset.filter((r) => hit(r.rx, field)).length;
    const pct = Math.round((100 * n) / subset.length);
    console.log(`  ${short.padEnd(10)} ${String(n).padStart(2)}/${subset.length}  ${pct}%`);
  }
}

const docs = [...(await collectReal()), ...(await collectKit())];
if (!docs.length) {
  console.error(`No PDFs found (REAL_PDF_DIR=${REAL_PDF_DIR}).`);
  process.exit(1);
}

const rows = [];
for (const doc of docs) {
  const text = await extractPdfText(doc.buffer);
  const rx = regexExtract(text);
  rows.push({ ...doc, rx, textLength: text.length });
  if (SHOW_VALUES) {
    console.log(`\n=== ${doc.label} (${text.length} chars)`);
    for (const [field] of FIELDS) console.log(`  ${field}: ${JSON.stringify(rx[field])}`);
  }
}

console.log('');
printTable(rows);
printTotals(rows, 'real');
printTotals(rows, 'kit');
