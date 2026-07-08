import { parseWorkflowWorkbook } from '../api/_lib/excelParser.js';
const parsed = await parseWorkflowWorkbook('/Users/sujaygp/Desktop/poc/docs/_demo-upload.xlsx');
console.log('summary:', JSON.stringify(parsed.summary));
const j = parsed.joined[0];
console.log('joined[0].patient_info:', JSON.stringify(j.patientPayload.patient_info));
console.log('joined[0].admission_details:', JSON.stringify(j.patientPayload.admission_details));
console.log('joined[0].order_info:', JSON.stringify(j.orderPayload.order_info));
process.exit(0);
