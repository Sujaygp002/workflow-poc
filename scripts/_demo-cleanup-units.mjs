import { getSql } from '../api/_lib/db.js';
const sql = getSql();
// Remove any patient_units created by validation (demo patient names / midrun).
await sql`DELETE FROM orders WHERE order_number LIKE 'O-MIDRUN-%' OR order_number LIKE '90708%'`;
await sql`DELETE FROM patients WHERE mrn LIKE 'MRN-MIDRUN-%' OR mrn LIKE 'MRN-0708%'`;
await sql`DELETE FROM patient_units WHERE unit_key ILIKE '%demo patient%' OR unit_key ILIKE '%midrun%'`;
const pu = await sql`SELECT count(*)::int n FROM patient_units`;
const pt = await sql`SELECT count(*)::int n FROM patients`;
const od = await sql`SELECT count(*)::int n FROM orders`;
const runs = await sql`SELECT count(*)::int n FROM workflow_runs`;
console.log('after cleanup - units:', pu[0].n, 'patients:', pt[0].n, 'orders:', od[0].n, 'runs:', runs[0].n);
process.exit(0);
