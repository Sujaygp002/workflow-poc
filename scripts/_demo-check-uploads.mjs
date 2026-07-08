import { getSql } from '../api/_lib/db.js';
const sql = getSql();
const ud = await sql`SELECT id, file_name, hhah_id, run_id, created_at FROM uploaded_documents ORDER BY created_at DESC LIMIT 5`;
console.log('UPLOADED_DOCS:', JSON.stringify(ud, null, 1));
const runs = await sql`SELECT id, source_label, status, total_items FROM workflow_runs ORDER BY created_at DESC LIMIT 6`;
console.log('RUNS:', JSON.stringify(runs));
process.exit(0);
