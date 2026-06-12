import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

const outputDir = path.resolve('sample-artifacts');
const workbookPath = path.join(outputDir, 'hhh_upload_all_cases.xlsx');
const zipPath = path.join(outputDir, 'hhh_order_pdfs_all_cases.zip');

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
  [
    'John Smith',
    '1954-03-12',
    'MRN-100',
    'M',
    '101 Lavaca St, Austin, TX 78701',
    'Lakeside Family Practice',
    'Boise Home Health',
    '2026-01-01',
    '2026-03-31',
    '2026-01-01',
    '2026-01-31',
    'I10',
    'E11.9',
    '',
    '',
    '',
    '',
  ],
  [
    'Maria Gonzales',
    '1967-08-22',
    'MRN-200',
    'F',
    '742 Pine Ridge Rd, Phoenix, AZ 85004',
    'New Horizon Physician Group',
    'Sunrise Skilled Home Health',
    '2026-02-01',
    '2026-04-30',
    '2026-02-01',
    '2026-02-28',
    'J44.9',
    'R26.81',
    '',
    '',
    '',
    '',
  ],
  [
    'Sam Reed',
    '1975-12-05',
    'MRN-300',
    '',
    '',
    'Lakeside Family Practice',
    'Boise Home Health',
    '2026-03-01',
    '2026-05-31',
    '2026-03-01',
    '2026-03-31',
    'M62.81',
    'Z91.81',
    '',
    '',
    '',
    '',
  ],
  [
    'Priya Nair',
    '1981-06-18',
    'MRN-400',
    'F',
    '88 Cedar Lake Dr, Boise, ID 83702',
    'Lakeside Family Practice',
    'Boise Home Health',
    '2026-04-01',
    '2026-06-30',
    '2026-04-01',
    '2026-04-30',
    'G89.29',
    'M54.50',
    '',
    '',
    '',
    '',
  ],
];

const orders = [
  [
    'O-1001',
    '2026-01-04',
    'John Smith',
    '1954-03-12',
    'MRN-100',
    'Plan of Care',
    '2026-01-01',
    '2026-03-31',
    '2026-01-01',
    '2026-01-31',
    '2026-01-08',
    '1234567890',
  ],
  [
    'O-1002',
    '2026-02-04',
    'John Smith',
    '1954-03-12',
    'MRN-100',
    'Physician Order',
    '2026-01-01',
    '2026-03-31',
    '2026-02-01',
    '2026-02-28',
    '2026-02-09',
    '1234567890',
  ],
  [
    'O-2001',
    '2026-02-10',
    'Maria Gonzales',
    '1967-08-22',
    'MRN-200',
    'Medication Order',
    '2026-02-01',
    '2026-04-30',
    '2026-02-01',
    '2026-02-28',
    '2026-02-12',
    '2223334444',
  ],
  [
    'O-3001',
    '2026-03-08',
    'Sam Reed',
    '1975-12-05',
    'MRN-300',
    'Therapy Evaluation',
    '2026-03-01',
    '2026-05-31',
    '2026-03-01',
    '2026-03-31',
    '2026-03-10',
    '1234567890',
  ],
  [
    'O-4001',
    '2026-04-05',
    'Priya Nair',
    '1981-06-18',
    'MRN-400',
    'Wound Care Order',
    '2026-04-01',
    '2026-06-30',
    '2026-04-01',
    '2026-04-30',
    '2026-04-07',
    '1234567890',
  ],
  [
    'O-4001',
    '2026-04-09',
    'Priya Nair',
    '1981-06-18',
    'MRN-400',
    'Wound Care Order - Updated',
    '2026-04-01',
    '2026-06-30',
    '2026-04-01',
    '2026-04-30',
    '2026-04-11',
    '1234567890',
  ],
];

const pdfTextByOrder = {
  'O-1001': [
    'Order Number: O-1001',
    'Patient: John Smith',
    'DOB: 1954-03-12',
    'MRN: MRN-100',
    'Order Type: Plan of Care',
    'NPI: 1234567890',
    'PG: Lakeside Family Practice',
    'HHAH: Boise Home Health',
  ],
  'O-1002': [
    'Order Number: O-1002',
    'Patient: John Smith',
    'Episode: 2026-02-01 to 2026-02-28',
    'Order Type: Physician Order',
    'NPI: 1234567890',
  ],
  'O-2001': [
    'Order Number: O-2001',
    'Patient: Maria Gonzales',
    'DOB: 1967-08-22',
    'MRN: MRN-200',
    'Practitioner NPI: 2223334444',
    'Practitioner Name: Dr. Nina Patel',
    'PG: New Horizon Physician Group',
    'HHAH: Sunrise Skilled Home Health',
    'This row should allocate manual tasks because these references are not seeded.',
  ],
  'O-3001': [
    'Order Number: O-3001',
    'Patient: Sam Reed',
    'DOB: 1975-12-05',
    'MRN: MRN-300',
    'Sex: M',
    'Address: 19 Walker Ave, Boise, ID 83704',
    'Order Type: Therapy Evaluation',
    'NPI: 1234567890',
    'This row has missing sex and address in Excel so AI or human fill can resolve it.',
  ],
  'O-4001': [
    'Order Number: O-4001',
    'Patient: Priya Nair',
    'DOB: 1981-06-18',
    'MRN: MRN-400',
    'Order Type: Wound Care Order',
    'Updated signed date appears on duplicate Excel row to test order update path.',
    'NPI: 1234567890',
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
