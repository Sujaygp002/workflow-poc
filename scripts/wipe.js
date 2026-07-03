// Full data wipe (`npm run db:wipe`) — truncates every domain/workflow/identity
// table (FK-safe via CASCADE) while preserving the schema + schema_migrations.
// Prints per-table row counts before and after. System workflow definitions are
// re-upserted on demand by ensureSystemDefinitions() in the API layer.
import { getSql } from '../api/_lib/db.js';

const TABLES = [
  'ai_extractions',
  'uploaded_documents',
  'workflow_task_runs',
  'workflow_items',
  'workflow_runs',
  'missing_upload_notifications',
  'area_intake_checks',
  'statistical_area_hhahs',
  'statistical_areas',
  'cpo_months',
  'orders',
  'patient_episodes',
  'patient_admissions',
  'patient_physician_groups',
  'patient_practitioners',
  'patients',
  'patient_units',
  'practitioners',
  'physician_groups',
  'home_health_agencies',
  'auth_sessions',
  'external_users',
  'employees',
  'users',
  'workflow_definitions',
];

async function counts(sql) {
  const out = {};
  for (const table of TABLES) {
    try {
      const rows = await sql.query(`SELECT count(*)::int AS n FROM ${table}`);
      out[table] = rows[0]?.n ?? 0;
    } catch {
      out[table] = 'missing';
    }
  }
  return out;
}

function printCounts(label, byTable) {
  console.log(`\n${label}`);
  for (const [table, n] of Object.entries(byTable)) {
    console.log(`  ${table.padEnd(32)} ${n}`);
  }
}

async function main() {
  const sql = getSql();
  printCounts('before wipe:', await counts(sql));
  await sql.query(`TRUNCATE TABLE ${TABLES.join(', ')} CASCADE`);
  printCounts('after wipe:', await counts(sql));
  console.log('\nwipe complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
