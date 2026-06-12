import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

// Second sample dataset — same shape/rules as create-sample-hhh-artifacts.js
// but different patients, orders, and PDFs. Designed to exercise the same
// branches: a complete row, a row missing fields (AI/human fill), a row with
// unseeded references (manual create), and a duplicate order (update path).
const outputDir = path.resolve('sample-2-artifacts');
const workbookPath = path.join(outputDir, 'hhh_upload_set2.xlsx');
const zipPath = path.join(outputDir, 'hhh_order_pdfs_set2.zip');

const patientHeaders = [
  'patientName(FK)',
  'DOB(FK)',
  'MRN(FK)',
  'patient_sex',
  'address',
  'PgName',
  'Agencyname',
  'SOC(admission start)',
  'EOC(admission end)',
  'SOE(StartOfEpisode)',
  'EOE(EndOfEpisode)',
  'Diagnosis 1',
  'Diagnosis 2',
  'Diagnosis 3',
  'Diagnosis 4',
  'Diagnosis 5',
  'Diagnosis 6',
];

const orderHeaders = [
  'orderno',
  'orderdate',
  'patientName(FK)',
  'DOB(FK)',
  'MRN(FK)',
  'documentType',
  'SOC',
  'EOC',
  'SOE',
  'EOE',
  'SignedDate',
  'NPI',
];

const patients = [
  // complete row — seeded references (if present), straight through
  [
    'Robert Lang',
    '1949-11-02',
    'MRN-510',
    'M',
    '320 Maple Ave, Denver, CO 80205',
    'Front Range Physician Group',
    'Mile High Home Health',
    '2026-01-15',
    '2026-04-15',
    '2026-01-15',
    '2026-02-14',
    'I50.9',
    'N18.3',
    '',
    '',
    '',
    '',
  ],
  // unseeded references — should fall to manual create for PG/HHAH/practitioner
  [
    'Elena Petrova',
    '1972-05-19',
    'MRN-620',
    'F',
    '14 Bayshore Blvd, Tampa, FL 33606',
    'Gulf Coast Care Partners',
    'Sunshine State Home Health',
    '2026-02-20',
    '2026-05-20',
    '2026-02-20',
    '2026-03-19',
    'E11.65',
    'I10',
    '',
    '',
    '',
    '',
  ],
  // missing sex + address — should trigger AI extraction / manual fill
  [
    'Marcus Webb',
    '1985-09-30',
    'MRN-730',
    '',
    '',
    'Front Range Physician Group',
    'Mile High Home Health',
    '2026-03-10',
    '2026-06-10',
    '2026-03-10',
    '2026-04-09',
    'M17.11',
    'Z96.651',
    '',
    '',
    '',
    '',
  ],
  // another complete row
  [
    'Aisha Khan',
    '1990-02-14',
    'MRN-840',
    'F',
    '77 Birchwood Ct, Seattle, WA 98109',
    'Front Range Physician Group',
    'Mile High Home Health',
    '2026-04-01',
    '2026-07-01',
    '2026-04-01',
    '2026-04-30',
    'G62.9',
    'M54.16',
    '',
    '',
    '',
    '',
  ],
];

const orders = [
  [
    'O-5101',
    '2026-01-18',
    'Robert Lang',
    '1949-11-02',
    'MRN-510',
    'Plan of Care',
    '2026-01-15',
    '2026-04-15',
    '2026-01-15',
    '2026-02-14',
    '2026-01-22',
    '1593574652',
  ],
  [
    'O-5102',
    '2026-02-18',
    'Robert Lang',
    '1949-11-02',
    'MRN-510',
    'Physician Order',
    '2026-01-15',
    '2026-04-15',
    '2026-02-15',
    '2026-03-14',
    '2026-02-20',
    '1593574652',
  ],
  [
    'O-6201',
    '2026-02-25',
    'Elena Petrova',
    '1972-05-19',
    'MRN-620',
    'Medication Order',
    '2026-02-20',
    '2026-05-20',
    '2026-02-20',
    '2026-03-19',
    '2026-02-27',
    '4445556666',
  ],
  [
    'O-7301',
    '2026-03-15',
    'Marcus Webb',
    '1985-09-30',
    'MRN-730',
    'Therapy Evaluation',
    '2026-03-10',
    '2026-06-10',
    '2026-03-10',
    '2026-04-09',
    '2026-03-18',
    '1593574652',
  ],
  [
    'O-8401',
    '2026-04-05',
    'Aisha Khan',
    '1990-02-14',
    'MRN-840',
    'Wound Care Order',
    '2026-04-01',
    '2026-07-01',
    '2026-04-01',
    '2026-04-30',
    '2026-04-08',
    '1593574652',
  ],
  // duplicate order number for Aisha — exercises the order update path
  [
    'O-8401',
    '2026-04-12',
    'Aisha Khan',
    '1990-02-14',
    'MRN-840',
    'Wound Care Order - Updated',
    '2026-04-01',
    '2026-07-01',
    '2026-04-01',
    '2026-04-30',
    '2026-04-14',
    '1593574652',
  ],
];

const pdfTextByOrder = {
  'O-5101': [
    'Order Number: O-5101',
    'Patient: Robert Lang',
    'DOB: 1949-11-02',
    'MRN: MRN-510',
    'Order Type: Plan of Care',
    'NPI: 1593574652',
    'PG: Front Range Physician Group',
    'HHAH: Mile High Home Health',
  ],
  'O-5102': [
    'Order Number: O-5102',
    'Patient: Robert Lang',
    'Episode: 2026-02-15 to 2026-03-14',
    'Order Type: Physician Order',
    'NPI: 1593574652',
  ],
  'O-6201': [
    'Order Number: O-6201',
    'Patient: Elena Petrova',
    'DOB: 1972-05-19',
    'MRN: MRN-620',
    'Practitioner NPI: 4445556666',
    'Practitioner Name: Dr. Omar Hassan',
    'PG: Gulf Coast Care Partners',
    'HHAH: Sunshine State Home Health',
    'These references are not seeded, so manual create tasks should be allocated.',
  ],
  'O-7301': [
    'Order Number: O-7301',
    'Patient: Marcus Webb',
    'DOB: 1985-09-30',
    'MRN: MRN-730',
    'Sex: M',
    'Address: 905 Lakeview Dr, Seattle, WA 98109',
    'Order Type: Therapy Evaluation',
    'NPI: 1593574652',
    'Excel is missing sex and address, so AI or human fill resolves it from this PDF.',
  ],
  'O-8401': [
    'Order Number: O-8401',
    'Patient: Aisha Khan',
    'DOB: 1990-02-14',
    'MRN: MRN-840',
    'Order Type: Wound Care Order',
    'Updated signed date appears on a duplicate Excel row to test the order update path.',
    'NPI: 1593574652',
  ],
};

function styleSheet(sheet) {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
  sheet.getRow(1).alignment = { vertical: 'middle' };
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columnCount },
  };
  sheet.columns.forEach((column) => {
    let max = 12;
    column.eachCell({ includeEmpty: true }, (cell) => {
      max = Math.max(max, String(cell.value || '').length + 2);
    });
    column.width = Math.min(Math.max(max, 12), 34);
  });
}

function escapePdfText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function createSimplePdf(lines) {
  const stream = [
    'BT',
    '/F1 12 Tf',
    '50 750 Td',
    ...lines.flatMap((line, index) => [
      index === 0 ? '' : '0 -18 Td',
      `(${escapePdfText(line)}) Tj`,
    ]).filter(Boolean),
    'ET',
  ].join('\n');

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'FlowPOC';
  workbook.created = new Date();

  const patientSheet = workbook.addWorksheet('Sheet1');
  patientSheet.addRow(patientHeaders);
  patients.forEach((row) => patientSheet.addRow(row));
  styleSheet(patientSheet);

  const orderSheet = workbook.addWorksheet('Sheet2');
  orderSheet.addRow(orderHeaders);
  orders.forEach((row) => orderSheet.addRow(row));
  styleSheet(orderSheet);

  await workbook.xlsx.writeFile(workbookPath);

  const zip = new JSZip();
  for (const [orderNumber, lines] of Object.entries(pdfTextByOrder)) {
    zip.file(`${orderNumber}.pdf`, createSimplePdf(lines));
  }
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(zipPath, zipBuffer);

  console.log(JSON.stringify({
    workbookPath,
    zipPath,
    patientRows: patients.length,
    orderRows: orders.length,
    pdfs: Object.keys(pdfTextByOrder).length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
