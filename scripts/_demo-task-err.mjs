import { getSql } from '../api/_lib/db.js';
const sql = getSql();
const runId = process.argv[2];
const t = await sql`SELECT id, name, status, output, notes FROM workflow_task_runs WHERE run_id=${runId} AND status='failed'`;
console.log('FAILED_TASKS:', JSON.stringify(t, null, 1));
const items = await sql`SELECT id, item_index, patient_payload->'patient_info' as pinfo, patient_payload->'admission_details' as adm, decisions FROM workflow_items WHERE run_id=${runId} ORDER BY item_index`;
console.log('ITEMS:', JSON.stringify(items, null, 1));
process.exit(0);
