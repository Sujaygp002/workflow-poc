import { getSql } from '../api/_lib/db.js';
const sql = getSql();
const BASE='http://localhost:8791';
const rows = await sql`SELECT id, source_label FROM workflow_runs WHERE source_label LIKE 'daily:%' OR source_label LIKE '%_demo-upload%' OR source_label LIKE '%demo-upload%'`;
for (const r of rows) { await fetch(`${BASE}/api/workflow-runs/${r.id}`, { method: 'DELETE' }); console.log('deleted', r.id, r.source_label); }
process.exit(0);
