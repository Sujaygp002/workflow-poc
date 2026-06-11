import { getSql } from '../api/_lib/db.js';
import { SEEDED_USERS, WF7_DEFINITION } from '../api/_lib/workflowDefinition.js';
import { upsertUser, upsertWorkflowDefinition } from '../api/_lib/repositories.js';
import { normalizeName, normalizeNpi } from '../api/_lib/normalizers.js';

async function seedReferenceData() {
  const sql = getSql();
  await sql`
    INSERT INTO physician_groups (name, normalized_name, npi, type, contact_info, raw_data)
    VALUES (
      'Lakeside Family Practice',
      ${normalizeName('Lakeside Family Practice')},
      '1234567890',
      'Single-Specialty Group',
      '{"phone_number":"512-555-0143","email":"contact@lakesidefp.com","address":{"street":"101 Lavaca St","city":"Austin","state":"TX","county":"Travis","zip":"78701"}}'::jsonb,
      '{"seed":true}'::jsonb
    )
    ON CONFLICT (normalized_name) DO NOTHING
  `;
  await sql`
    INSERT INTO home_health_agencies (name, normalized_name, npi, type, type_of_service, contact_info, raw_data)
    VALUES (
      'Boise Home Health',
      ${normalizeName('Boise Home Health')},
      '9876543210',
      'Home Health Agency',
      'Skilled Nursing',
      '{"phone_number":"208-555-0199","email":"intake@boisehh.com","address":{"street":"500 Capitol Blvd","city":"Boise","state":"ID","county":"Ada","zip":"83702"}}'::jsonb,
      '{"seed":true}'::jsonb
    )
    ON CONFLICT (normalized_name) DO NOTHING
  `;
  await sql`
    INSERT INTO practitioners (npi_digits, physician_name, speciality, contact_info, raw_data)
    VALUES (
      ${normalizeNpi('1234567890')},
      'Dr. Example',
      'Primary Care',
      '{"phone_number":"","email":""}'::jsonb,
      '{"seed":true}'::jsonb
    )
    ON CONFLICT (npi_digits) DO NOTHING
  `;
}

async function main() {
  for (const user of SEEDED_USERS) {
    await upsertUser(user);
  }
  await upsertWorkflowDefinition(WF7_DEFINITION, 1);
  await seedReferenceData();
  console.log('seeded users, wf7, and reference records');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
