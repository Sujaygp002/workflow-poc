import { getSql } from '../api/_lib/db.js';
import { hashPassword } from '../api/_lib/auth.js';
const sql = getSql();
const EMP_ID = 'b8f2826d-ade5-4384-bdfd-610a486c39a0';
const PW = process.argv[2] || 'DemoWorker!2026';
const hash = hashPassword(PW);
const rows = await sql`UPDATE employees SET password_hash=${hash}, active=true, updated_at=now() WHERE id=${EMP_ID} RETURNING id, username, display_name, active`;
console.log('UPDATED_EMPLOYEE:', JSON.stringify(rows));
console.log('PASSWORD_SET_TO:', PW);
// also ensure external hhah user has a known password for the /hhh-login scene
const EXT_ID = 'a8d9f24a-e44f-449b-8842-e9efbaf70eeb';
const EXT_PW = process.argv[3] || 'DemoAgency!2026';
const extHash = hashPassword(EXT_PW);
const extRows = await sql`UPDATE external_users SET password_hash=${extHash}, active=true, updated_at=now() WHERE id=${EXT_ID} RETURNING id, username, display_name, active`;
console.log('UPDATED_EXTERNAL:', JSON.stringify(extRows));
console.log('EXTERNAL_PASSWORD_SET_TO:', EXT_PW);
process.exit(0);
