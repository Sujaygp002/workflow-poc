import { getSql } from '../api/_lib/db.js';
import { SEEDED_USERS, WORKFLOW_DEFINITIONS } from '../api/_lib/workflowDefinition.js';
import {
  createHhahFromPayload,
  createTaskRunsForItem,
  createWorkflowItem,
  createWorkflowRun,
  findHhahByName,
  findWorkflowRunBySourceLabel,
  getActiveWorkflow,
  linkHhahToArea,
  updateItem,
  upsertStatisticalArea,
  upsertUser,
  upsertWorkflowDefinition,
} from '../api/_lib/repositories.js';
import { runWorkflowAutomation } from '../api/_lib/workflowEngine.js';
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

  await createHhahFromPayload({
    HHAH: {
      name: 'Sunrise Skilled Home Health',
      NPI: '2223334444',
      type: 'Home Health Agency',
      type_of_service: 'Skilled Nursing',
      contact_info: {
        phone_number: '602-555-0120',
        email: 'intake@sunriseskilled.example',
        address: { street: '44 Central Ave', city: 'Phoenix', state: 'AZ', county: 'Maricopa', zip: '85004' },
      },
      raw_data: { seed: true },
    },
  });

  await createHhahFromPayload({
    HHAH: {
      name: 'Treasure Valley Hospice',
      NPI: '3334445555',
      type: 'Home Health Agency',
      type_of_service: 'Hospice',
      contact_info: {
        phone_number: '208-555-0188',
        email: 'uploads@treasurevalley.example',
        address: { street: '500 Capitol Blvd', city: 'Boise', state: 'ID', county: 'Ada', zip: '83702' },
      },
      raw_data: { seed: true },
    },
  });

  const area = await upsertStatisticalArea({
    name: 'Boise-Ada Metro Intake',
    areaType: 'metro_statistical_area',
    state: 'ID',
    metadata: { seed: true, description: 'Demo area with three expected HHAHs' },
  });
  for (const name of ['Boise Home Health', 'Sunrise Skilled Home Health', 'Treasure Valley Hospice']) {
    const hhah = await findHhahByName(name);
    if (hhah) {
      await linkHhahToArea({
        areaId: area.id,
        hhahId: hhah.id,
        expectedDailyUploadTime: '17:00',
        uploadWindowHours: 24,
      });
    }
  }
}

async function seedAreaOnboardingRun() {
  const sourceLabel = 'area-onboarding:boise-ada-metro-intake';
  const existing = await findWorkflowRunBySourceLabel('wf-area-onboarding', sourceLabel);
  if (existing) return;

  const workflow = await getActiveWorkflow('wf-area-onboarding');
  if (!workflow) return;

  // One item per expected HHAH in the area, so the monitor's instance count reads 3.
  // Boise Home Health is missing its upload (active manual email task); the other
  // two received their uploads and continue normally.
  const expectedHhahs = ['Boise Home Health', 'Sunrise Skilled Home Health', 'Treasure Valley Hospice'];
  const run = await createWorkflowRun({
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    sourceLabel,
    totalItems: expectedHhahs.length,
    inputSummary: { trigger: 'onboarding_successful', area: 'Boise-Ada Metro Intake', expectedHhahs: expectedHhahs.length },
  });

  for (let i = 0; i < expectedHhahs.length; i += 1) {
    const name = expectedHhahs[i];
    const missing = i === 0; // first HHAH (Boise Home Health) is missing its upload
    const hhah = await findHhahByName(name);
    const item = await createWorkflowItem({
      runId: run.id,
      itemIndex: i,
      patientPayload: {},
      orderPayload: {},
      referencePayload: {},
      extractionPayload: { area: 'Boise-Ada Metro Intake', trigger: 'onboarding_successful', hhah: name },
    });
    await updateItem(item.id, {
      decisions: missing
        ? { upload_missing_after_24h: true, upload_received_within_24h: false }
        : { upload_received_within_24h: true, upload_missing_after_24h: false },
      referencePayload: hhah
        ? { HHAH: { name: hhah.name, contact_info: hhah.contact_info || {} } }
        : { HHAH: { name } },
    });
    await createTaskRunsForItem({
      runId: run.id,
      itemId: item.id,
      steps: workflow.definition.steps,
    });
  }

  // Run automation: received HHAHs continue normally; the missing one pauses at
  // area-s4 as an active manual email task.
  await runWorkflowAutomation({ runId: run.id, definition: workflow.definition, concurrency: expectedHhahs.length });
}

async function main() {
  for (const user of SEEDED_USERS) {
    await upsertUser(user);
  }
  for (const definition of WORKFLOW_DEFINITIONS) {
    await upsertWorkflowDefinition(definition, 1);
  }
  await seedReferenceData();
  await seedAreaOnboardingRun();
  console.log('seeded users, workflow definitions, and reference records');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
