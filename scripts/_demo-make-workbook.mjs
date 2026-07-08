// Synthesize a 1-row bulk-upload workbook (Sheet1 patient, Sheet2 order) for the
// phase-1 demo. Unique patient name + MRN per today so it never collides. Leaves
// SEX + ADDRESS blank so (a) ai_extract_with_patterns reports missingCore -> the
// ai_extraction_fail branch fires (the "Manually fill missing data" human task),
// and (b) the fill task surfaces exactly sex + address editors. All date fields
// present so admission/episode/order all write cleanly, ending in the review task.
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import fs from 'node:fs/promises';

const OUT = process.argv[2] || '/Users/sujaygp/Desktop/poc/docs/_demo-upload.xlsx';
const ZIP_OUT = process.argv[3] || '/Users/sujaygp/Desktop/poc/docs/_demo-upload-unsigned.zip';
const stamp = new Date();
const dd = String(stamp.getDate()).padStart(2, '0');
const mm = String(stamp.getMonth() + 1).padStart(2, '0');
// Uniqueness: minute-of-day suffix so re-runs within a day still differ.
const uniq = `${stamp.getHours()}${String(stamp.getMinutes()).padStart(2, '0')}`;
const MRN = `MRN-${mm}${dd}${uniq}`;
const NAME = `Demo Patient ${mm}${dd}-${uniq}`;
const ORDER = `${9}${mm}${dd}${uniq}`.slice(0, 8); // 8-digit-ish order number

const wb = new ExcelJS.Workbook();

const s1 = wb.addWorksheet('Sheet1');
s1.addRow([
  'PatientName(FK)', 'DOB(FK)', 'MRN(FK)', 'Patient_Sex', 'Address',
  'PG Name', 'Agency Name', 'SOC(Admission Start)', 'EOC(Admission End)',
  'SOE(StartOfEpisode)', 'EOE(EndOfEpisode)', 'Diagnosis 1',
]);
s1.addRow([
  NAME, '1955-04-12', MRN, '' /* sex blank */, '' /* address blank */,
  'Demo Physician Group', 'Demo RCM Agency (DEMO-RCM)',
  '2026-06-01', '2026-07-30', '2026-06-01', '2026-07-30', 'I10',
]);

const s2 = wb.addWorksheet('Sheet2');
s2.addRow([
  'OrderNo', 'OrderDate', 'PatientName(FK)', 'DOB(FK)', 'MRN(FK)',
  'DocumentType', 'SOC', 'EOC', 'SOE', 'EOE', 'SignedDate', 'NPI',
]);
s2.addRow([
  ORDER, '2026-06-02', NAME, '1955-04-12', MRN,
  '485', '2026-06-01', '2026-07-30', '2026-06-01', '2026-07-30', '', '',
]);

await wb.xlsx.writeFile(OUT);

// A minimal valid 1-page PDF named <ORDER>.pdf, zipped as the unsigned ZIP. This
// writes an uploaded_documents row (hhah_id = agency) so checkUploadedToday sees
// the upload on the mid-run reconcile. Text is intentionally sparse so the regex
// extraction tier still can't fill core fields -> ai_extraction_fail holds.
function minimalPdf(text) {
  const content = `BT /F1 12 Tf 40 750 Td (${text}) Tj ET`;
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => { pdf += `${String(off).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

const zip = new JSZip();
zip.file(`${ORDER}.pdf`, minimalPdf(`Order ${ORDER} - plan of care for ${NAME}`));
const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
await fs.writeFile(ZIP_OUT, zipBuf);

console.log(JSON.stringify({ out: OUT, zip: ZIP_OUT, patient: NAME, mrn: MRN, order: ORDER }));
