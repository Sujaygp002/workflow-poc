// Off-camera pre-record clean: delete ALL workflow runs (all are demo/test
// artifacts) so the worker buckets + Orchestrator start empty, and remove any
// validation-created patient/order rows. The frozen workflow definition and the
// seeded DEMO-RCM patient/agency fixtures are left intact.
import { getSql } from '../api/_lib/db.js';
const BASE = 'http://localhost:8791';
const sql = getSql();
const runs = await sql`SELECT id FROM workflow_runs`;
for (const r of runs) await fetch(`${BASE}/api/workflow-runs/${r.id}`, { method: 'DELETE' });
console.log('deleted runs:', runs.length);
await sql`DELETE FROM orders WHERE order_number LIKE 'O-MIDRUN-%' OR order_number LIKE '90708%'`;
await sql`DELETE FROM patients WHERE mrn LIKE 'MRN-MIDRUN-%' OR mrn LIKE 'MRN-0708%'`;
await sql`DELETE FROM patient_units WHERE unit_key ILIKE '%demo patient%' OR unit_key ILIKE '%midrun%'`;
const left = await sql`SELECT (SELECT count(*)::int FROM workflow_runs) runs, (SELECT count(*)::int FROM patients) patients, (SELECT count(*)::int FROM orders) orders, (SELECT count(*)::int FROM patient_units) units`;
console.log('remaining:', JSON.stringify(left[0]));
process.exit(0);
