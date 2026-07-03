import { getSql, jsonParam } from '../api/_lib/db.js';
import { WORKFLOW_DEFINITIONS } from '../api/_lib/workflowDefinition.js';
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
  upsertWorkflowDefinition,
} from '../api/_lib/repositories.js';
import { runWorkflowAutomation } from '../api/_lib/workflowEngine.js';
import { normalizeName, normalizeNpi, recordContextKey, unitKey } from '../api/_lib/normalizers.js';

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

function demoPatientPayload({ soc = '', eoc = '', soe = '', eoe = '' } = {}) {
  return {
    patient_info: {
      name: 'Maya Thompson',
      DOB: '1944-04-12',
      sex: 'F',
      age: 82,
      phone: '208-555-0101',
      email: 'maya.thompson@example.test',
      address: {
        street: '71 Riverstone Way',
        city: 'Boise',
        state: 'ID',
        county: 'Ada',
        zip: '83702',
      },
    },
    personal_information: {
      marital_status: 'Widowed',
      language: 'English',
      emergency_contact: {
        name: 'Lena Thompson',
        relationship: 'Daughter',
        phone: '208-555-0102',
      },
    },
    insurance_details: {
      primary: {
        payer: 'Medicare',
        policy_number: 'MED-DEMO-445512',
        group_number: 'A-102',
      },
      secondary: {
        payer: 'Blue Shield Idaho',
        policy_number: 'BSI-DEMO-2209',
      },
    },
    family: [
      { name: 'Lena Thompson', relationship: 'Daughter', phone: '208-555-0102' },
      { name: 'Owen Thompson', relationship: 'Son', phone: '208-555-0103' },
    ],
    blood_group: 'O+',
    admission_details: {
      MRN: 'MRN-DEMO-ARCHIVE-001',
      SOC: soc,
      EOC: eoc,
      SOE: soe,
      EOE: eoe,
      diagnosis_codes: ['I50.9', 'E11.9', 'R26.81'],
      ehr_record_number: 'EHR-DEMO-7711',
      ehr_account_number: 'ACCT-DEMO-4412',
    },
  };
}

async function hhahByName(sql, name) {
  const rows = await sql`
    SELECT * FROM home_health_agencies
    WHERE normalized_name = ${normalizeName(name)}
    LIMIT 1
  `;
  return rows[0] || null;
}

async function pgByName(sql, name) {
  const rows = await sql`
    SELECT * FROM physician_groups
    WHERE normalized_name = ${normalizeName(name)}
    LIMIT 1
  `;
  return rows[0] || null;
}

async function seedDemoReferences() {
  const sql = getSql();
  await sql`
    INSERT INTO physician_groups (name, normalized_name, npi, type, contact_info, raw_data, updated_at)
    VALUES (
      'Mountain View Physician Group',
      ${normalizeName('Mountain View Physician Group')},
      '5556667777',
      'Multi-Specialty Group',
      '{"phone_number":"208-555-0110","email":"pg@mountainview.example","address":{"street":"900 Grove St","city":"Boise","state":"ID","county":"Ada","zip":"83702"}}'::jsonb,
      '{"seed":true,"demoHierarchy":true}'::jsonb,
      now()
    )
    ON CONFLICT (normalized_name)
    DO UPDATE SET
      npi = EXCLUDED.npi,
      type = EXCLUDED.type,
      contact_info = physician_groups.contact_info || EXCLUDED.contact_info,
      raw_data = physician_groups.raw_data || EXCLUDED.raw_data,
      updated_at = now()
  `;
  await sql`
    INSERT INTO practitioners (npi_digits, physician_name, speciality, contact_info, raw_data, updated_at)
    VALUES (
      ${normalizeNpi('5556667777')},
      'Dr. Amelia Hart',
      'Family Medicine',
      '{"phone_number":"208-555-0111","email":"amelia.hart@mountainview.example"}'::jsonb,
      '{"seed":true,"demoHierarchy":true}'::jsonb,
      now()
    )
    ON CONFLICT (npi_digits)
    DO UPDATE SET
      physician_name = EXCLUDED.physician_name,
      speciality = EXCLUDED.speciality,
      contact_info = practitioners.contact_info || EXCLUDED.contact_info,
      raw_data = practitioners.raw_data || EXCLUDED.raw_data,
      updated_at = now()
  `;
}

async function seedDemoWorkflowRun() {
  const existing = await findWorkflowRunBySourceLabel('wf7', 'demo-patient-unit-hierarchy');
  if (existing) return existing;
  const workflow = await getActiveWorkflow('wf7');
  if (!workflow) return null;
  return createWorkflowRun({
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    sourceLabel: 'demo-patient-unit-hierarchy',
    totalItems: 1,
    inputSummary: {
      seed: true,
      demo: 'Patient Unit hierarchy with archived/current admissions, episodes, and orders',
    },
  });
}

async function upsertDemoPatientRecord({ unit, patientPayload, referencePayload, agency, pg, practitioner, latestStatus, createdAt, updatedAt }) {
  const sql = getSql();
  const key = recordContextKey(patientPayload, referencePayload);
  const rows = await sql`
    INSERT INTO patients (
      unit_id, record_context_key, hhah_name, pg_name, agency_id, pg_id,
      name, dob, mrn, sex, age,
      personal_information, insurance_details, admission_details, raw_data, created_at, updated_at,
      latest_episode_status, latest_episode_status_reason
    )
    VALUES (
      ${unit.id},
      ${key},
      ${referencePayload.HHAH.name},
      ${referencePayload.PG.name},
      ${agency?.id || null},
      ${pg?.id || null},
      ${patientPayload.patient_info.name},
      ${patientPayload.patient_info.DOB},
      ${patientPayload.admission_details.MRN},
      ${patientPayload.patient_info.sex},
      ${patientPayload.patient_info.age},
      ${await jsonParam(patientPayload.personal_information)}::jsonb,
      ${await jsonParam(patientPayload.insurance_details)}::jsonb,
      ${await jsonParam(patientPayload.admission_details)}::jsonb,
      ${await jsonParam({ ...patientPayload, seed: true, demoHierarchy: true })}::jsonb,
      ${createdAt}::timestamptz,
      ${updatedAt}::timestamptz,
      ${latestStatus},
      ${await jsonParam({ seed: true, demoHierarchy: true })}::jsonb
    )
    ON CONFLICT (record_context_key)
    DO UPDATE SET
      unit_id = EXCLUDED.unit_id,
      hhah_name = EXCLUDED.hhah_name,
      pg_name = EXCLUDED.pg_name,
      agency_id = EXCLUDED.agency_id,
      pg_id = EXCLUDED.pg_id,
      name = EXCLUDED.name,
      dob = EXCLUDED.dob,
      mrn = EXCLUDED.mrn,
      sex = EXCLUDED.sex,
      age = EXCLUDED.age,
      personal_information = EXCLUDED.personal_information,
      insurance_details = EXCLUDED.insurance_details,
      admission_details = EXCLUDED.admission_details,
      raw_data = patients.raw_data || EXCLUDED.raw_data,
      latest_episode_status = EXCLUDED.latest_episode_status,
      latest_episode_status_reason = EXCLUDED.latest_episode_status_reason,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `;

  const patient = rows[0];
  if (patient?.id && pg?.id) {
    await sql`
      INSERT INTO patient_physician_groups (patient_id, pg_id, role, raw_data)
      VALUES (${patient.id}, ${pg.id}, 'primary', '{"seed":true,"demoHierarchy":true}'::jsonb)
      ON CONFLICT (patient_id, pg_id) DO NOTHING
    `;
  }
  if (patient?.id && practitioner?.id) {
    await sql`
      INSERT INTO patient_practitioners (patient_id, practitioner_id, relationship, raw_data)
      VALUES (${patient.id}, ${practitioner.id}, 'billing_provider', '{"seed":true,"demoHierarchy":true}'::jsonb)
      ON CONFLICT (patient_id, practitioner_id) DO NOTHING
    `;
  }
  return patient;
}

async function upsertDemoAdmission({ patient, agency, pg, practitioner, soc, eoc, label }) {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO patient_admissions (
      patient_id, soc, eoc, agency_id, pg_id, care_provider_id, mrn,
      ehr_record_number, ehr_account_number, raw_data, updated_at
    )
    VALUES (
      ${patient.id},
      ${soc},
      ${eoc},
      ${agency?.id || null},
      ${pg?.id || null},
      ${practitioner?.id || null},
      'MRN-DEMO-ARCHIVE-001',
      ${`EHR-${label}`},
      ${`ACCT-${label}`},
      ${await jsonParam({ seed: true, demoHierarchy: true, label, SOC: soc, EOC: eoc })}::jsonb,
      now()
    )
    ON CONFLICT (patient_id, soc, eoc)
    DO UPDATE SET
      agency_id = EXCLUDED.agency_id,
      pg_id = EXCLUDED.pg_id,
      care_provider_id = EXCLUDED.care_provider_id,
      mrn = EXCLUDED.mrn,
      ehr_record_number = EXCLUDED.ehr_record_number,
      ehr_account_number = EXCLUDED.ehr_account_number,
      raw_data = patient_admissions.raw_data || EXCLUDED.raw_data,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

async function upsertDemoEpisode({ admission, soe, eoe, label }) {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO patient_episodes (admission_id, soe, eoe, diagnosis_codes, raw_data, updated_at, status, status_reason)
    VALUES (
      ${admission.id},
      ${soe},
      ${eoe},
      '["I50.9","E11.9","R26.81"]'::jsonb,
      ${await jsonParam({ seed: true, demoHierarchy: true, label, SOE: soe, EOE: eoe })}::jsonb,
      now(),
      ${label.includes('latest') ? 'eligible' : 'billable'},
      ${await jsonParam({ seed: true, demoHierarchy: true })}::jsonb
    )
    ON CONFLICT (admission_id, soe, eoe)
    DO UPDATE SET
      diagnosis_codes = EXCLUDED.diagnosis_codes,
      raw_data = patient_episodes.raw_data || EXCLUDED.raw_data,
      status = EXCLUDED.status,
      status_reason = EXCLUDED.status_reason,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

async function upsertDemoOrder({ patient, admission, episode = null, agency, pg, practitioner, orderNumber, documentType, orderType, orderDate, signed, sent = true }) {
  const sql = getSql();
  const orderStatus = {
    SentToPhysicianDate: sent ? orderDate : null,
    SendToPhysician_Status: !!sent,
    ...(signed ? {
      SignedByPhyscianDate: orderDate,
      SignedByPhysician_Status: true,
    } : {}),
  };
  const rows = await sql`
    INSERT INTO orders (
      order_number, order_type, document_type, order_date,
      patient_id, admission_id, episode_id, agency_id, pg_id, billing_provider_id,
      order_status, order_admission_details, raw_data, updated_at
    )
    VALUES (
      ${orderNumber},
      ${orderType},
      ${documentType},
      ${orderDate},
      ${patient.id},
      ${admission?.id || null},
      ${episode?.id || null},
      ${agency?.id || null},
      ${pg?.id || null},
      ${practitioner?.id || null},
      ${await jsonParam(orderStatus)}::jsonb,
      ${await jsonParam({
        SOC: admission?.soc,
        EOC: admission?.eoc,
        SOE: episode?.soe,
        EOE: episode?.eoe,
        billing_provider: { NPI: practitioner?.npi_digits, name: practitioner?.physician_name },
      })}::jsonb,
      ${await jsonParam({ seed: true, demoHierarchy: true, source: signed ? 'signed_zip' : 'unsigned_zip' })}::jsonb,
      now()
    )
    ON CONFLICT (order_number)
    DO UPDATE SET
      order_type = EXCLUDED.order_type,
      document_type = EXCLUDED.document_type,
      order_date = EXCLUDED.order_date,
      patient_id = EXCLUDED.patient_id,
      admission_id = EXCLUDED.admission_id,
      episode_id = EXCLUDED.episode_id,
      agency_id = EXCLUDED.agency_id,
      pg_id = EXCLUDED.pg_id,
      billing_provider_id = EXCLUDED.billing_provider_id,
      order_status = EXCLUDED.order_status,
      order_admission_details = EXCLUDED.order_admission_details,
      raw_data = orders.raw_data || EXCLUDED.raw_data,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

async function upsertDemoDocument({ run, orderNumber, signed }) {
  if (!run?.id) return;
  const sql = getSql();
  const fileName = `${orderNumber}.pdf`;
  const existing = await sql`
    SELECT id FROM uploaded_documents
    WHERE run_id = ${run.id} AND file_name = ${fileName}
    LIMIT 1
  `;
  if (existing[0]) return;
  await sql`
    INSERT INTO uploaded_documents (run_id, file_name, content_type, size_bytes, blob_url, blob_path)
    VALUES (
      ${run.id},
      ${fileName},
      'application/pdf',
      2048,
      ${null},
      ${`demo/${signed ? 'signed' : 'unsigned'}/${fileName}`}
    )
  `;
}

async function seedDemoPatientHierarchy() {
  await seedDemoReferences();
  const sql = getSql();
  const basePayload = demoPatientPayload();
  const key = unitKey(basePayload);
  const unitRows = await sql`
    INSERT INTO patient_units (
      unit_key, name, dob, mrn, sex, personal_information, insurance_details, family, blood_group, raw_data, updated_at
    )
    VALUES (
      ${key},
      'Maya Thompson',
      '1944-04-12',
      'MRN-DEMO-ARCHIVE-001',
      'F',
      ${await jsonParam(basePayload.personal_information)}::jsonb,
      ${await jsonParam(basePayload.insurance_details)}::jsonb,
      ${await jsonParam(basePayload.family)}::jsonb,
      ${basePayload.blood_group},
      ${await jsonParam({ ...basePayload, seed: true, demoHierarchy: true })}::jsonb,
      now()
    )
    ON CONFLICT (unit_key)
    DO UPDATE SET
      name = EXCLUDED.name,
      dob = EXCLUDED.dob,
      mrn = EXCLUDED.mrn,
      sex = EXCLUDED.sex,
      personal_information = EXCLUDED.personal_information,
      insurance_details = EXCLUDED.insurance_details,
      family = EXCLUDED.family,
      blood_group = EXCLUDED.blood_group,
      raw_data = patient_units.raw_data || EXCLUDED.raw_data,
      updated_at = now()
    RETURNING *
  `;
  const unit = unitRows[0];

  const boiseHhah = await hhahByName(sql, 'Boise Home Health');
  const sunriseHhah = await hhahByName(sql, 'Sunrise Skilled Home Health');
  const currentPg = await pgByName(sql, 'Mountain View Physician Group');
  const oldPg = await pgByName(sql, 'Lakeside Family Practice');
  const practitionerRows = await sql`SELECT * FROM practitioners WHERE npi_digits = ${normalizeNpi('5556667777')} LIMIT 1`;
  const practitioner = practitionerRows[0] || null;

  const oldPayload = demoPatientPayload({ soc: '2025-01-01', eoc: '2025-03-01', soe: '2025-02-01', eoe: '2025-03-01' });
  const oldRecord = await upsertDemoPatientRecord({
    unit,
    patientPayload: oldPayload,
    referencePayload: { HHAH: { name: 'Sunrise Skilled Home Health' }, PG: { name: 'Lakeside Family Practice' } },
    agency: sunriseHhah,
    pg: oldPg,
    practitioner,
    latestStatus: 'billable',
    createdAt: '2024-08-01T08:00:00.000Z',
    updatedAt: '2025-03-02T08:00:00.000Z',
  });

  const currentPayload = demoPatientPayload({ soc: '2026-03-15', eoc: '2026-06-15', soe: '2026-04-15', eoe: '2026-06-15' });
  const currentRecord = await upsertDemoPatientRecord({
    unit,
    patientPayload: currentPayload,
    referencePayload: { HHAH: { name: 'Boise Home Health' }, PG: { name: 'Mountain View Physician Group' } },
    agency: boiseHhah,
    pg: currentPg,
    practitioner,
    latestStatus: 'eligible',
    createdAt: '2025-07-01T08:00:00.000Z',
    updatedAt: '2026-06-16T08:00:00.000Z',
  });

  const run = await seedDemoWorkflowRun();

  const oldAdm1 = await upsertDemoAdmission({ patient: oldRecord, agency: sunriseHhah, pg: oldPg, practitioner, soc: '2024-08-01', eoc: '2024-10-01', label: 'OLD-ARCHIVE-1' });
  const oldEp1 = await upsertDemoEpisode({ admission: oldAdm1, soe: '2024-08-01', eoe: '2024-09-29', label: 'old-archive-episode-1' });
  const oldAdm2 = await upsertDemoAdmission({ patient: oldRecord, agency: sunriseHhah, pg: oldPg, practitioner, soc: '2025-01-01', eoc: '2025-03-01', label: 'OLD-LATEST-CASCADED' });
  const oldEp2a = await upsertDemoEpisode({ admission: oldAdm2, soe: '2025-01-01', eoe: '2025-01-30', label: 'old-record-episode-archive' });
  const oldEp2b = await upsertDemoEpisode({ admission: oldAdm2, soe: '2025-02-01', eoe: '2025-03-01', label: 'old-record-latest-episode' });

  const curAdm1 = await upsertDemoAdmission({ patient: currentRecord, agency: boiseHhah, pg: currentPg, practitioner, soc: '2025-07-01', eoc: '2025-09-01', label: 'CURRENT-ARCHIVED-ADMISSION' });
  const curAdm1Ep = await upsertDemoEpisode({ admission: curAdm1, soe: '2025-07-01', eoe: '2025-08-30', label: 'current-archived-admission-episode' });
  const curAdm2 = await upsertDemoAdmission({ patient: currentRecord, agency: boiseHhah, pg: currentPg, practitioner, soc: '2025-12-15', eoc: '2026-02-20', label: 'CURRENT-PRIOR-NOT-ARCHIVED' });
  const curAdm2Ep = await upsertDemoEpisode({ admission: curAdm2, soe: '2025-12-15', eoe: '2026-02-15', label: 'current-prior-not-archived-episode' });
  const curAdm3 = await upsertDemoAdmission({ patient: currentRecord, agency: boiseHhah, pg: currentPg, practitioner, soc: '2026-03-15', eoc: '2026-06-15', label: 'CURRENT-LATEST-ADMISSION' });
  const curAdm3OldEp = await upsertDemoEpisode({ admission: curAdm3, soe: '2026-03-15', eoe: '2026-04-14', label: 'current-latest-admission-episode-archive' });
  const curAdm3LatestEp = await upsertDemoEpisode({ admission: curAdm3, soe: '2026-04-15', eoe: '2026-06-15', label: 'current-latest-episode' });

  const orderSeeds = [
    [oldRecord, oldAdm1, oldEp1, sunriseHhah, oldPg, 'DEMO-OLD-A-485', '485 Cert', '485 Certification', '2024-08-02', true],
    [oldRecord, oldAdm1, oldEp1, sunriseHhah, oldPg, 'DEMO-OLD-A-F2F', 'F2F Encounter', 'Face To Face', '2024-08-03', true],
    [oldRecord, oldAdm2, oldEp2a, sunriseHhah, oldPg, 'DEMO-OLD-B-SN', 'Skilled Nursing Order', 'SN Order', '2025-01-05', true],
    [oldRecord, oldAdm2, oldEp2b, sunriseHhah, oldPg, 'DEMO-OLD-B-485', '485 Recert', '485 Recertification', '2025-02-02', true],
    [currentRecord, curAdm1, curAdm1Ep, boiseHhah, currentPg, 'DEMO-CUR-ARCH-485', '485 Cert', '485 Certification', '2025-07-02', true],
    [currentRecord, curAdm1, curAdm1Ep, boiseHhah, currentPg, 'DEMO-CUR-ARCH-F2F', 'F2F Encounter', 'Face To Face', '2025-07-03', true],
    [currentRecord, curAdm2, curAdm2Ep, boiseHhah, currentPg, 'DEMO-CUR-NOTARCH-SN', 'Skilled Nursing Order', 'SN Order', '2025-12-20', true],
    [currentRecord, curAdm3, curAdm3OldEp, boiseHhah, currentPg, 'DEMO-CUR-EPARCH-SN', 'Skilled Nursing Order', 'SN Order', '2026-03-20', true],
    [currentRecord, curAdm3, null, boiseHhah, currentPg, 'DEMO-CUR-ADM-LEVEL', 'Admission Note', 'Admission Level Order', '2026-03-18', true],
    [currentRecord, curAdm3, curAdm3LatestEp, boiseHhah, currentPg, 'DEMO-CUR-LATEST-485', '485 Recert', '485 Recertification', '2026-04-16', true],
    [currentRecord, curAdm3, curAdm3LatestEp, boiseHhah, currentPg, 'DEMO-CUR-LATEST-F2F', 'F2F Encounter', 'Face To Face', '2026-04-17', true],
    [currentRecord, curAdm3, curAdm3LatestEp, boiseHhah, currentPg, 'DEMO-CUR-LATEST-UNSIGNED', 'Physician Order', 'Medication Change', '2026-06-01', false],
  ];

  for (const [patient, admission, episode, agency, pg, orderNumber, documentType, orderType, orderDate, signed] of orderSeeds) {
    await upsertDemoOrder({
      patient,
      admission,
      episode,
      agency,
      pg,
      practitioner,
      orderNumber,
      documentType,
      orderType,
      orderDate,
      signed,
    });
    await upsertDemoDocument({ run, orderNumber, signed });
  }

  if (curAdm3LatestEp?.id) {
    await sql`
      INSERT INTO cpo_months (episode_id, cpo_month, cpo_min, status, reason, updated_at)
      VALUES
        (${curAdm3LatestEp.id}, '2026-04-01', 30, 'billable', '{"seed":true,"demoHierarchy":true,"note":"latest episode billable CPO month"}'::jsonb, now()),
        (${curAdm3LatestEp.id}, '2026-05-01', 15, 'not_billable', '{"seed":true,"demoHierarchy":true,"note":"needs additional CPO minutes"}'::jsonb, now())
      ON CONFLICT (episode_id, cpo_month)
      DO UPDATE SET
        cpo_min = EXCLUDED.cpo_min,
        status = EXCLUDED.status,
        reason = EXCLUDED.reason,
        updated_at = now()
    `;
  }
}

async function main() {
  for (const definition of WORKFLOW_DEFINITIONS) {
    await upsertWorkflowDefinition(definition, 1);
  }
  await seedReferenceData();
  await seedAreaOnboardingRun();
  await seedDemoPatientHierarchy();
  console.log('seeded workflow definitions, reference records, and demo patient hierarchy');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
