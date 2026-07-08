import { getSql } from '../api/_lib/db.js';
const sql = getSql();
// remove the midrun test patient/order rows created during validation
await sql`DELETE FROM orders WHERE order_number LIKE 'O-MIDRUN-%'`;
await sql`DELETE FROM patients WHERE mrn LIKE 'MRN-MIDRUN-%'`;
await sql`DELETE FROM patients WHERE mrn LIKE 'MRN-0708%'`;
await sql`DELETE FROM orders WHERE order_number LIKE '90708%'`;
// patient_units left; report
const pu = await sql`SELECT count(*)::int n FROM patient_units`;
console.log('patient_units:', JSON.stringify(pu));
process.exit(0);
