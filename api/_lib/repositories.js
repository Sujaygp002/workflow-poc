import { getSql, jsonParam } from './db.js';
import {
  blankToNull,
  normalizeName,
  normalizeNpi,
  parseDate,
  patientKey,
} from './normalizers.js';

export async function getActiveWorkflow(id) {
  const sql = getSql();
  const rows = await sql`
    SELECT id, version, name, description, definition
    FROM workflow_definitions
    WHERE id = ${id} AND active = true
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function listActiveWorkflowDefinitions() {
  const sql = getSql();
  return sql`
    SELECT id, version, name, description, definition, created_at, updated_at
    FROM workflow_definitions
    WHERE active = true
    ORDER BY updated_at DESC, id
  `;
}

export async function upsertWorkflowDefinition(definition, version = 1) {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO workflow_definitions (id, version, name, description, definition, active, updated_at)
    VALUES (${definition.id}, ${version}, ${definition.name}, ${definition.description}, ${await jsonParam(definition)}::jsonb, true, now())
    ON CONFLICT (id, version)
    DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      definition = EXCLUDED.definition,
      active = true,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

export async function upsertUser(user) {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO users (id, name, job_role, access_level, username, updated_at)
    VALUES (${user.id}, ${user.name}, ${user.jobRole || null}, ${user.accessLevel || null}, ${user.username || null}, now())
    ON CONFLICT (id)
    DO UPDATE SET
      name = EXCLUDED.name,
      job_role = EXCLUDED.job_role,
      access_level = EXCLUDED.access_level,
      username = EXCLUDED.username,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

export async function listUsers() {
  const sql = getSql();
  return sql`SELECT id, name, job_role, access_level FROM users ORDER BY id`;
}

export async function createWorkflowRun({ workflowId, workflowVersion, sourceLabel, totalItems, inputSummary, areaId = null, hhahId = null }) {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO workflow_runs (workflow_id, workflow_version, source_label, total_items, input_summary, area_id, hhah_id)
    VALUES (${workflowId}, ${workflowVersion}, ${sourceLabel || null}, ${totalItems}, ${await jsonParam(inputSummary)}::jsonb, ${areaId}, ${hhahId})
    RETURNING *
  `;
  return rows[0];
}

export async function createWorkflowItem({ runId, itemIndex, patientPayload, orderPayload, referencePayload, extractionPayload }) {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO workflow_items (
      run_id, item_index, patient_key, order_key,
      patient_payload, order_payload, reference_payload, extraction_payload
    )
    VALUES (
      ${runId}, ${itemIndex}, ${patientKey(patientPayload)}, ${blankToNull(orderPayload?.order_info?.order_number)},
      ${await jsonParam(patientPayload)}::jsonb,
      ${await jsonParam(orderPayload)}::jsonb,
      ${await jsonParam(referencePayload)}::jsonb,
      ${await jsonParam(extractionPayload || {})}::jsonb
    )
    RETURNING *
  `;
  return rows[0];
}

export async function createTaskRunsForItem({ runId, itemId, steps }) {
  const sql = getSql();
  const created = [];
  for (const step of steps) {
    const rows = await sql`
      INSERT INTO workflow_task_runs (
        run_id, item_id, step_id, task_key, actor, name, description, condition, input
      )
      VALUES (
        ${runId}, ${itemId}, ${step.id}, ${step.taskKey}, ${step.actor}, ${step.name},
        ${step.description || null}, ${step.condition || null}, ${await jsonParam(step)}::jsonb
      )
      ON CONFLICT (item_id, step_id) DO NOTHING
      RETURNING *
    `;
    if (rows[0]) created.push(rows[0]);
  }
  return created;
}

export async function insertUploadedDocument({ runId, fileName, contentType, sizeBytes, blobUrl, blobPath }) {
  const sql = getSql();
  const run = (await sql`SELECT hhah_id FROM workflow_runs WHERE id = ${runId} LIMIT 1`)[0];
  const rows = await sql`
    INSERT INTO uploaded_documents (run_id, file_name, content_type, size_bytes, blob_url, blob_path, hhah_id)
    VALUES (${runId}, ${fileName}, ${contentType || null}, ${sizeBytes || null}, ${blobUrl || null}, ${blobPath || null}, ${run?.hhah_id || null})
    RETURNING *
  `;
  return rows[0];
}

export async function getRunWithDefinition(runId) {
  const sql = getSql();
  const rows = await sql`
    SELECT r.*, d.definition
    FROM workflow_runs r
    JOIN workflow_definitions d
      ON d.id = r.workflow_id AND d.version = r.workflow_version
    WHERE r.id = ${runId}
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function findWorkflowRunBySourceLabel(workflowId, sourceLabel) {
  const sql = getSql();
  const rows = await sql`
    SELECT *
    FROM workflow_runs
    WHERE workflow_id = ${workflowId}
      AND source_label = ${sourceLabel}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] || null;
}

// Delete a run and everything scoped to it (items, task runs, uploaded docs,
// AI extractions) via ON DELETE CASCADE. Created domain records (patients,
// orders, practitioners, etc.) are intentionally kept. Returns true if a row
// was removed.
export async function deleteWorkflowRun(runId) {
  const sql = getSql();
  const rows = await sql`
    DELETE FROM workflow_runs
    WHERE id = ${runId}
    RETURNING id
  `;
  return rows.length > 0;
}

export async function getRunItems(runId) {
  const sql = getSql();
  return sql`
    SELECT *
    FROM workflow_items
    WHERE run_id = ${runId}
    ORDER BY item_index
  `;
}

export async function getItem(itemId) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM workflow_items WHERE id = ${itemId} LIMIT 1`;
  return rows[0] || null;
}

export async function getItemTasks(itemId) {
  const sql = getSql();
  return sql`
    SELECT *
    FROM workflow_task_runs
    WHERE item_id = ${itemId}
    ORDER BY created_at, step_id
  `;
}

export async function getTaskRun(taskRunId) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM workflow_task_runs WHERE id = ${taskRunId} LIMIT 1`;
  return rows[0] || null;
}

export async function listWorkflowRuns() {
  const sql = getSql();
  return sql`
    SELECT r.*, d.definition,
      sa.name AS area_name,
      sa.area_type,
      h.name AS hhah_name
    FROM workflow_runs r
    JOIN workflow_definitions d
      ON d.id = r.workflow_id AND d.version = r.workflow_version
    LEFT JOIN statistical_areas sa ON sa.id = r.area_id
    LEFT JOIN home_health_agencies h ON h.id = r.hhah_id
    ORDER BY r.created_at DESC
    LIMIT 100
  `;
}

export async function listTaskRunsForRun(runId) {
  const sql = getSql();
  return sql`
    SELECT t.*, i.item_index, i.patient_key, i.order_key, i.patient_payload, i.order_payload, i.reference_payload, i.decisions
    FROM workflow_task_runs t
    JOIN workflow_items i ON i.id = t.item_id
    WHERE t.run_id = ${runId}
    ORDER BY i.item_index, t.created_at, t.step_id
  `;
}

export async function listActiveWorkItems(userId) {
  const sql = getSql();
  return sql`
    SELECT
      t.*,
      r.workflow_id,
      r.source_label,
      r.created_at AS run_created_at,
      i.item_index,
      i.patient_payload,
      i.order_payload,
      i.reference_payload,
      i.extraction_payload,
      i.decisions,
      d.file_name AS pdf_file_name,
      d.blob_url AS pdf_blob_url
    FROM workflow_task_runs t
    JOIN workflow_runs r ON r.id = t.run_id
    JOIN workflow_items i ON i.id = t.item_id
    LEFT JOIN LATERAL (
      SELECT file_name, blob_url
      FROM uploaded_documents
      WHERE run_id = r.id
        AND lower(regexp_replace(file_name, '\\.pdf$', '', 'i')) = lower(i.order_key)
      ORDER BY created_at DESC
      LIMIT 1
    ) d ON true
    WHERE t.assigned_to = ${userId}
      AND t.status = 'active'
    ORDER BY r.created_at, i.item_index, t.created_at
  `;
}

export async function listCompletedWorkItems(userId) {
  const sql = getSql();
  return sql`
    SELECT t.*, r.workflow_id, r.source_label
    FROM workflow_task_runs t
    JOIN workflow_runs r ON r.id = t.run_id
    WHERE t.assigned_to = ${userId}
      AND t.status = 'completed'
    ORDER BY t.completed_at DESC NULLS LAST
    LIMIT 100
  `;
}

export async function updateTask(taskId, patch) {
  const sql = getSql();
  const current = (await sql`SELECT * FROM workflow_task_runs WHERE id = ${taskId} LIMIT 1`)[0];
  if (!current) return null;
  const rows = await sql`
    UPDATE workflow_task_runs
    SET
      status = ${patch.status ?? current.status},
      assigned_to = ${patch.assignedTo === undefined ? current.assigned_to : patch.assignedTo},
      output = ${await jsonParam(patch.output ?? current.output)}::jsonb,
      notes = ${patch.notes === undefined ? current.notes : patch.notes},
      error_message = ${patch.errorMessage === undefined ? current.error_message : patch.errorMessage},
      started_at = ${patch.startedAt === undefined ? current.started_at : patch.startedAt},
      completed_at = ${patch.completedAt === undefined ? current.completed_at : patch.completedAt},
      updated_at = now()
    WHERE id = ${taskId}
    RETURNING *
  `;
  return rows[0];
}

export async function updateItem(itemId, patch) {
  const sql = getSql();
  const current = await getItem(itemId);
  if (!current) return null;
  const rows = await sql`
    UPDATE workflow_items
    SET
      status = ${patch.status ?? current.status},
      patient_payload = ${await jsonParam(patch.patientPayload ?? current.patient_payload)}::jsonb,
      order_payload = ${await jsonParam(patch.orderPayload ?? current.order_payload)}::jsonb,
      reference_payload = ${await jsonParam(patch.referencePayload ?? current.reference_payload)}::jsonb,
      extraction_payload = ${await jsonParam(patch.extractionPayload ?? current.extraction_payload)}::jsonb,
      decisions = ${await jsonParam(patch.decisions ?? current.decisions)}::jsonb,
      error_message = ${patch.errorMessage === undefined ? current.error_message : patch.errorMessage},
      updated_at = now()
    WHERE id = ${itemId}
    RETURNING *
  `;
  return rows[0];
}

export async function updateRunStatus(runId) {
  const sql = getSql();
  const counts = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
    FROM workflow_items
    WHERE run_id = ${runId}
  `;
  const { total, completed, failed } = counts[0] || { total: 0, completed: 0, blocked: 0, failed: 0 };
  const status = total > 0 && completed === total ? 'completed' : failed > 0 ? 'running' : 'running';
  const rows = await sql`
    UPDATE workflow_runs
    SET status = ${status}, total_items = ${total}, completed_items = ${completed}, updated_at = now()
    WHERE id = ${runId}
    RETURNING *
  `;
  return rows[0];
}

export async function findPractitionerByNpi(npi) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM practitioners WHERE npi_digits = ${normalizeNpi(npi)} LIMIT 1`;
  return rows[0] || null;
}

export async function findPgByName(name) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM physician_groups WHERE normalized_name = ${normalizeName(name)} LIMIT 1`;
  return rows[0] || null;
}

export async function findHhahByName(name) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM home_health_agencies WHERE normalized_name = ${normalizeName(name)} LIMIT 1`;
  return rows[0] || null;
}

export async function findPatient(patientPayload) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM patients WHERE normalized_patient_key = ${patientKey(patientPayload)} LIMIT 1`;
  return rows[0] || null;
}

export async function findOrder(orderNumber) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM orders WHERE order_number = ${blankToNull(orderNumber)} LIMIT 1`;
  return rows[0] || null;
}

// Admission is identified by patient + Start of Care.
export async function findAdmission(patientId, soc) {
  if (!patientId) return null;
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM patient_admissions
    WHERE patient_id = ${patientId} AND soc IS NOT DISTINCT FROM ${parseDate(soc)}
    LIMIT 1
  `;
  return rows[0] || null;
}

// Episode is identified within an admission by SOE/EOE.
export async function findEpisode(admissionId, soe, eoe) {
  if (!admissionId) return null;
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM patient_episodes
    WHERE admission_id = ${admissionId}
      AND soe IS NOT DISTINCT FROM ${parseDate(soe)}
      AND eoe IS NOT DISTINCT FROM ${parseDate(eoe)}
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function createPractitionerFromPayload(referencePayload) {
  const sql = getSql();
  const practitioner = referencePayload?.practitioner || {};
  const npi = normalizeNpi(practitioner.NPI || practitioner.npi);
  const rows = await sql`
    INSERT INTO practitioners (npi_digits, physician_name, speciality, contact_info, history, raw_data, updated_at)
    VALUES (
      ${npi},
      ${blankToNull(practitioner.physician_name || practitioner.name) || `Practitioner ${npi}`},
      ${blankToNull(practitioner.speciality || practitioner.specialty)},
      ${await jsonParam(practitioner.contact_info || {})}::jsonb,
      ${await jsonParam(practitioner.history || {})}::jsonb,
      ${await jsonParam(practitioner)}::jsonb,
      now()
    )
    ON CONFLICT (npi_digits)
    DO UPDATE SET
      physician_name = COALESCE(EXCLUDED.physician_name, practitioners.physician_name),
      speciality = COALESCE(EXCLUDED.speciality, practitioners.speciality),
      contact_info = practitioners.contact_info || EXCLUDED.contact_info,
      history = practitioners.history || EXCLUDED.history,
      raw_data = practitioners.raw_data || EXCLUDED.raw_data,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

export async function createPgFromPayload(referencePayload) {
  const sql = getSql();
  const pg = referencePayload?.PG || {};
  const name = blankToNull(pg.name);
  const rows = await sql`
    INSERT INTO physician_groups (name, normalized_name, npi, type, contact_info, raw_data, updated_at)
    VALUES (
      ${name},
      ${normalizeName(name)},
      ${blankToNull(pg.NPI || pg.npi)},
      ${blankToNull(pg.type)},
      ${await jsonParam(pg.contact_info || {})}::jsonb,
      ${await jsonParam(pg)}::jsonb,
      now()
    )
    ON CONFLICT (normalized_name)
    DO UPDATE SET
      name = EXCLUDED.name,
      npi = COALESCE(EXCLUDED.npi, physician_groups.npi),
      type = COALESCE(EXCLUDED.type, physician_groups.type),
      contact_info = physician_groups.contact_info || EXCLUDED.contact_info,
      raw_data = physician_groups.raw_data || EXCLUDED.raw_data,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

export async function createHhahFromPayload(referencePayload) {
  const sql = getSql();
  const agency = referencePayload?.HHAH || {};
  const name = blankToNull(agency.name);
  const rows = await sql`
    INSERT INTO home_health_agencies (name, normalized_name, npi, type, type_of_service, contact_info, raw_data, updated_at)
    VALUES (
      ${name},
      ${normalizeName(name)},
      ${blankToNull(agency.NPI || agency.npi)},
      ${blankToNull(agency.type) || 'Home Health Agency'},
      ${blankToNull(agency.type_of_service)},
      ${await jsonParam(agency.contact_info || {})}::jsonb,
      ${await jsonParam(agency)}::jsonb,
      now()
    )
    ON CONFLICT (normalized_name)
    DO UPDATE SET
      name = EXCLUDED.name,
      npi = COALESCE(EXCLUDED.npi, home_health_agencies.npi),
      type = COALESCE(EXCLUDED.type, home_health_agencies.type),
      type_of_service = COALESCE(EXCLUDED.type_of_service, home_health_agencies.type_of_service),
      contact_info = home_health_agencies.contact_info || EXCLUDED.contact_info,
      raw_data = home_health_agencies.raw_data || EXCLUDED.raw_data,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

// Upsert the stable Patient Unit (identity/insurance/family) — the reusable base
// layer. Returns the unit row.
export async function writePatientUnit(patient) {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO patient_units (
      normalized_patient_key, name, dob, mrn, sex,
      personal_information, insurance_details, raw_data, updated_at
    )
    VALUES (
      ${patientKey(patient)},
      ${patient.patient_info?.name},
      ${parseDate(patient.patient_info?.DOB)},
      ${patient.admission_details?.MRN},
      ${blankToNull(patient.patient_info?.sex)},
      ${await jsonParam(patient.personal_information || {})}::jsonb,
      ${await jsonParam(patient.insurance_details || {})}::jsonb,
      ${await jsonParam(patient)}::jsonb,
      now()
    )
    ON CONFLICT (normalized_patient_key)
    DO UPDATE SET
      name = EXCLUDED.name,
      dob = EXCLUDED.dob,
      mrn = EXCLUDED.mrn,
      sex = COALESCE(EXCLUDED.sex, patient_units.sex),
      personal_information = patient_units.personal_information || EXCLUDED.personal_information,
      insurance_details = patient_units.insurance_details || EXCLUDED.insurance_details,
      raw_data = patient_units.raw_data || EXCLUDED.raw_data,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

// Direct Patient <-> Physician Group link (0..* both sides), independent of admission.
export async function linkPatientToPg(patientId, pgId, role = null) {
  if (!patientId || !pgId) return;
  const sql = getSql();
  await sql`
    INSERT INTO patient_physician_groups (patient_id, pg_id, role)
    VALUES (${patientId}, ${pgId}, ${role})
    ON CONFLICT (patient_id, pg_id) DO NOTHING
  `;
}

// Direct Patient <-> Practitioner link (0..many).
export async function linkPatientToPractitioner(patientId, practitionerId, relationship = null) {
  if (!patientId || !practitionerId) return;
  const sql = getSql();
  await sql`
    INSERT INTO patient_practitioners (patient_id, practitioner_id, relationship)
    VALUES (${patientId}, ${practitionerId}, ${relationship})
    ON CONFLICT (patient_id, practitioner_id) DO NOTHING
  `;
}

export async function writePatientBundle(item) {
  const patient = item.patient_payload;
  const reference = item.reference_payload;
  const existingPg = await findPgByName(reference?.PG?.name);
  const existingHhah = await findHhahByName(reference?.HHAH?.name);
  const existingPractitioner = await findPractitionerByNpi(reference?.practitioner?.NPI);
  const sql = getSql();

  // Stable base layer first, so the patient record can point at its unit.
  const unit = await writePatientUnit(patient);

  const patientRows = await sql`
    INSERT INTO patients (
      normalized_patient_key, unit_id, name, dob, mrn, sex, age,
      personal_information, insurance_details, admission_details, raw_data, updated_at
    )
    VALUES (
      ${patientKey(patient)},
      ${unit?.id || null},
      ${patient.patient_info?.name},
      ${parseDate(patient.patient_info?.DOB)},
      ${patient.admission_details?.MRN},
      ${blankToNull(patient.patient_info?.sex)},
      ${patient.patient_info?.age || null},
      ${await jsonParam(patient.personal_information || {})}::jsonb,
      ${await jsonParam(patient.insurance_details || {})}::jsonb,
      ${await jsonParam(patient.admission_details || {})}::jsonb,
      ${await jsonParam(patient)}::jsonb,
      now()
    )
    ON CONFLICT (normalized_patient_key)
    DO UPDATE SET
      unit_id = COALESCE(patients.unit_id, EXCLUDED.unit_id),
      name = EXCLUDED.name,
      dob = EXCLUDED.dob,
      mrn = EXCLUDED.mrn,
      sex = COALESCE(EXCLUDED.sex, patients.sex),
      age = COALESCE(EXCLUDED.age, patients.age),
      personal_information = patients.personal_information || EXCLUDED.personal_information,
      insurance_details = patients.insurance_details || EXCLUDED.insurance_details,
      admission_details = patients.admission_details || EXCLUDED.admission_details,
      raw_data = patients.raw_data || EXCLUDED.raw_data,
      updated_at = now()
    RETURNING *
  `;
  const storedPatient = patientRows[0];

  // Direct patient↔PG and patient↔practitioner links (not via admission).
  await linkPatientToPg(storedPatient.id, existingPg?.id || null);
  await linkPatientToPractitioner(storedPatient.id, existingPractitioner?.id || null);

  const admissionRows = await sql`
    INSERT INTO patient_admissions (
      patient_id, soc, eoc, agency_id, pg_id, care_provider_id, mrn, raw_data, updated_at
    )
    VALUES (
      ${storedPatient.id},
      ${parseDate(patient.admission_details?.SOC)},
      ${parseDate(patient.admission_details?.EOC)},
      ${existingHhah?.id || null},
      ${existingPg?.id || null},
      ${existingPractitioner?.id || null},
      ${patient.admission_details?.MRN || null},
      ${await jsonParam(patient.admission_details || {})}::jsonb,
      now()
    )
    ON CONFLICT (patient_id, soc, eoc)
    DO UPDATE SET
      agency_id = COALESCE(EXCLUDED.agency_id, patient_admissions.agency_id),
      pg_id = COALESCE(EXCLUDED.pg_id, patient_admissions.pg_id),
      care_provider_id = COALESCE(EXCLUDED.care_provider_id, patient_admissions.care_provider_id),
      raw_data = patient_admissions.raw_data || EXCLUDED.raw_data,
      updated_at = now()
    RETURNING *
  `;
  const admission = admissionRows[0];

  const episodeRows = await sql`
    INSERT INTO patient_episodes (admission_id, soe, eoe, diagnosis_codes, raw_data, updated_at)
    VALUES (
      ${admission.id},
      ${parseDate(patient.admission_details?.SOE)},
      ${parseDate(patient.admission_details?.EOE)},
      ${await jsonParam(patient.admission_details?.diagnosis_codes || [])}::jsonb,
      ${await jsonParam(patient.admission_details || {})}::jsonb,
      now()
    )
    ON CONFLICT (admission_id, soe, eoe)
    DO UPDATE SET
      diagnosis_codes = EXCLUDED.diagnosis_codes,
      raw_data = patient_episodes.raw_data || EXCLUDED.raw_data,
      updated_at = now()
    RETURNING *
  `;

  return { patient: storedPatient, admission, episode: episodeRows[0] };
}

export async function writeOrderBundle(item, patientBundle) {
  const order = item.order_payload;
  const reference = item.reference_payload;
  const patient = patientBundle?.patient || await findPatient(item.patient_payload);
  const pg = await findPgByName(reference?.PG?.name);
  const hhah = await findHhahByName(reference?.HHAH?.name);
  const practitioner = await findPractitionerByNpi(reference?.practitioner?.NPI);
  const admission = patientBundle?.admission || null;
  const episode = patientBundle?.episode || null;
  const sql = getSql();

  const documentType = blankToNull(order.order_info?.document_type || order.order_info?.order_type);

  const rows = await sql`
    INSERT INTO orders (
      order_number, order_type, document_type, order_date, patient_id, admission_id, episode_id,
      agency_id, pg_id, billing_provider_id, order_status, order_admission_details, raw_data, updated_at
    )
    VALUES (
      ${order.order_info?.order_number},
      ${blankToNull(order.order_info?.order_type)},
      ${documentType},
      ${parseDate(order.order_info?.order_date)},
      ${patient?.id || null},
      ${admission?.id || null},
      ${episode?.id || null},
      ${hhah?.id || null},
      ${pg?.id || null},
      ${practitioner?.id || null},
      ${await jsonParam(order.order_status || {})}::jsonb,
      ${await jsonParam(order.order_admission_details || {})}::jsonb,
      ${await jsonParam(order)}::jsonb,
      now()
    )
    ON CONFLICT (order_number)
    DO UPDATE SET
      order_type = COALESCE(EXCLUDED.order_type, orders.order_type),
      document_type = COALESCE(EXCLUDED.document_type, orders.document_type),
      order_date = COALESCE(EXCLUDED.order_date, orders.order_date),
      patient_id = COALESCE(EXCLUDED.patient_id, orders.patient_id),
      admission_id = COALESCE(EXCLUDED.admission_id, orders.admission_id),
      episode_id = COALESCE(EXCLUDED.episode_id, orders.episode_id),
      agency_id = COALESCE(EXCLUDED.agency_id, orders.agency_id),
      pg_id = COALESCE(EXCLUDED.pg_id, orders.pg_id),
      billing_provider_id = COALESCE(EXCLUDED.billing_provider_id, orders.billing_provider_id),
      order_status = orders.order_status || EXCLUDED.order_status,
      order_admission_details = orders.order_admission_details || EXCLUDED.order_admission_details,
      raw_data = orders.raw_data || EXCLUDED.raw_data,
      updated_at = now()
    RETURNING *
  `;
  const storedOrder = rows[0];

  // Order's billing provider is also a direct patient↔practitioner link.
  await linkPatientToPractitioner(patient?.id || null, practitioner?.id || null, 'billing_provider');
  await linkPatientToPg(patient?.id || null, pg?.id || null);

  return storedOrder;
}

// ── Episode status (computed, never stored) ──────────────
// eligible = episode has a 485 + an active F2F (within 6 months of the F2F
//            order's order_date), even if unsigned.
// billable = all of the episode's orders (incl. 485) are signed.
function isSigned(order) {
  const s = order.order_status || {};
  return !!(s.signed === true || s.order_signed_date || s.signedDate || order.signed_date);
}

function docTypeOf(order) {
  return String(order.document_type || order.order_type || '').toLowerCase();
}

export function computeEpisodeStatus(orders = []) {
  if (!orders.length) return 'none';
  const has485 = orders.some(o => docTypeOf(o).includes('485'));
  const f2f = orders.find(o => docTypeOf(o).includes('f2f') || docTypeOf(o).includes('face'));
  let f2fActive = false;
  if (f2f && f2f.order_date) {
    const ageMs = Date.now() - new Date(f2f.order_date).getTime();
    f2fActive = ageMs >= 0 && ageMs <= 1000 * 60 * 60 * 24 * 183; // ~6 months
  }
  const eligible = has485 && f2fActive;
  const allSigned = orders.every(isSigned);
  const billable = has485 && allSigned;
  if (billable) return 'billable';
  if (eligible) return 'eligible';
  return 'started';
}

export async function insertAiExtraction({ itemId, documentId, model, status, inputSummary, outputData, errorMessage }) {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO ai_extractions (item_id, document_id, model, status, input_summary, output_data, error_message)
    VALUES (
      ${itemId},
      ${documentId || null},
      ${model || null},
      ${status},
      ${await jsonParam(inputSummary || {})}::jsonb,
      ${await jsonParam(outputData || {})}::jsonb,
      ${errorMessage || null}
    )
    RETURNING *
  `;
  return rows[0];
}

export async function listPatients() {
  const sql = getSql();
  const rows = await sql`
    SELECT
      p.id,
      p.name,
      p.dob,
      p.mrn,
      p.sex,
      p.updated_at,
      COUNT(DISTINCT a.id)::int AS admission_count,
      COUNT(DISTINCT e.id)::int AS episode_count,
      COUNT(DISTINCT o.id)::int AS order_count
    FROM patients p
    LEFT JOIN patient_admissions a ON a.patient_id = p.id
    LEFT JOIN patient_episodes e ON e.admission_id = a.id
    LEFT JOIN orders o ON o.patient_id = p.id
    GROUP BY p.id
    ORDER BY p.updated_at DESC, p.name
    LIMIT 200
  `;

  // Latest-episode status per patient (computed). One small query for the set.
  const ids = rows.map(r => r.id);
  if (!ids.length) return rows;
  const latestEpisodes = await sql`
    SELECT DISTINCT ON (a.patient_id) a.patient_id, e.id AS episode_id
    FROM patient_episodes e
    JOIN patient_admissions a ON a.id = e.admission_id
    WHERE a.patient_id = ANY(${ids})
    ORDER BY a.patient_id, e.soe DESC NULLS LAST, e.created_at DESC
  `;
  const episodeIds = latestEpisodes.map(r => r.episode_id);
  const episodeOrders = episodeIds.length
    ? await sql`SELECT episode_id, order_type, document_type, order_date, order_status FROM orders WHERE episode_id = ANY(${episodeIds})`
    : [];
  const ordersByEpisode = new Map();
  for (const o of episodeOrders) {
    const list = ordersByEpisode.get(o.episode_id) || [];
    list.push(o);
    ordersByEpisode.set(o.episode_id, list);
  }
  const statusByPatient = new Map();
  for (const le of latestEpisodes) {
    statusByPatient.set(le.patient_id, computeEpisodeStatus(ordersByEpisode.get(le.episode_id) || []));
  }
  return rows.map(r => ({ ...r, latest_episode_status: statusByPatient.get(r.id) || 'none' }));
}

export async function getPatientTree(patientId) {
  const sql = getSql();
  const patients = await sql`
    SELECT *
    FROM patients
    WHERE id = ${patientId}
    LIMIT 1
  `;
  const patient = patients[0];
  if (!patient) return null;

  const admissions = await sql`
    SELECT
      a.*,
      h.name AS agency_name,
      pg.name AS pg_name,
      pr.physician_name AS care_provider_name,
      pr.npi_digits AS care_provider_npi
    FROM patient_admissions a
    LEFT JOIN home_health_agencies h ON h.id = a.agency_id
    LEFT JOIN physician_groups pg ON pg.id = a.pg_id
    LEFT JOIN practitioners pr ON pr.id = a.care_provider_id
    WHERE a.patient_id = ${patientId}
    ORDER BY a.soc NULLS LAST, a.created_at
  `;

  const episodes = await sql`
    SELECT e.*
    FROM patient_episodes e
    JOIN patient_admissions a ON a.id = e.admission_id
    WHERE a.patient_id = ${patientId}
    ORDER BY e.soe NULLS LAST, e.created_at
  `;

  const orders = await sql`
    SELECT
      o.*,
      h.name AS agency_name,
      pg.name AS pg_name,
      pr.physician_name AS billing_provider_name,
      pr.npi_digits AS billing_provider_npi
    FROM orders o
    LEFT JOIN home_health_agencies h ON h.id = o.agency_id
    LEFT JOIN physician_groups pg ON pg.id = o.pg_id
    LEFT JOIN practitioners pr ON pr.id = o.billing_provider_id
    WHERE o.patient_id = ${patientId}
    ORDER BY o.order_date NULLS LAST, o.created_at
  `;

  const episodesByAdmission = new Map();
  for (const episode of episodes) {
    const episodeOrders = orders.filter((order) => order.episode_id === episode.id);
    const entry = { ...episode, orders: episodeOrders, status: computeEpisodeStatus(episodeOrders) };
    const list = episodesByAdmission.get(episode.admission_id) || [];
    list.push(entry);
    episodesByAdmission.set(episode.admission_id, list);
  }

  // Latest episode = last by soe order; surface its computed status on the patient.
  const latestEpisode = episodes.length
    ? { ...episodes[episodes.length - 1], status: computeEpisodeStatus(orders.filter(o => o.episode_id === episodes[episodes.length - 1].id)) }
    : null;

  const ordersWithoutEpisode = orders.filter((order) => !order.episode_id);
  return {
    patient: { ...patient, latest_episode_status: latestEpisode?.status || 'none' },
    admissions: admissions.map((admission) => ({
      ...admission,
      episodes: episodesByAdmission.get(admission.id) || [],
      orders: orders.filter((order) => order.admission_id === admission.id && !order.episode_id),
    })),
    ordersWithoutEpisode,
  };
}

export async function listOrders() {
  const sql = getSql();
  const rows = await sql`
    SELECT
      o.*,
      p.name AS patient_name,
      p.mrn AS patient_mrn,
      h.name AS agency_name,
      pg.name AS pg_name,
      pr.physician_name AS billing_provider_name,
      pr.npi_digits AS billing_provider_npi,
      d.file_name AS pdf_file_name,
      d.blob_url AS pdf_blob_url
    FROM orders o
    LEFT JOIN patients p ON p.id = o.patient_id
    LEFT JOIN home_health_agencies h ON h.id = o.agency_id
    LEFT JOIN physician_groups pg ON pg.id = o.pg_id
    LEFT JOIN practitioners pr ON pr.id = o.billing_provider_id
    LEFT JOIN LATERAL (
      SELECT file_name, blob_url
      FROM uploaded_documents
      WHERE lower(regexp_replace(file_name, '\\.pdf$', '', 'i')) = lower(o.order_number)
      ORDER BY created_at DESC
      LIMIT 1
    ) d ON true
    ORDER BY o.updated_at DESC, o.order_date DESC NULLS LAST
    LIMIT 250
  `;

  const episodeIds = [...new Set(rows.map((row) => row.episode_id).filter(Boolean))];
  if (!episodeIds.length) return rows.map((row) => ({ ...row, episode_status: 'none' }));

  const episodeOrders = await sql`
    SELECT episode_id, order_type, document_type, order_date, order_status
    FROM orders
    WHERE episode_id = ANY(${episodeIds})
  `;
  const ordersByEpisode = new Map();
  for (const order of episodeOrders) {
    const list = ordersByEpisode.get(order.episode_id) || [];
    list.push(order);
    ordersByEpisode.set(order.episode_id, list);
  }

  return rows.map((row) => ({
    ...row,
    episode_status: row.episode_id ? computeEpisodeStatus(ordersByEpisode.get(row.episode_id) || []) : 'none',
  }));
}

export async function listReferenceData() {
  const sql = getSql();
  const [practitioners, physicianGroups, hhahs] = await Promise.all([
    sql`
      SELECT id, npi_digits, physician_name, speciality, contact_info, history, raw_data, updated_at
      FROM practitioners
      ORDER BY updated_at DESC, physician_name
      LIMIT 250
    `,
    sql`
      SELECT id, name, npi, type, contact_info, raw_data, updated_at
      FROM physician_groups
      ORDER BY updated_at DESC, name
      LIMIT 250
    `,
    sql`
      SELECT id, name, npi, type, type_of_service, contact_info, raw_data, updated_at
      FROM home_health_agencies
      ORDER BY updated_at DESC, name
      LIMIT 250
    `,
  ]);
  return { practitioners, physicianGroups, hhahs };
}

export async function mapPgToPractitioner({ pgId, practitionerId }) {
  const sql = getSql();
  const pgRows = await sql`SELECT * FROM physician_groups WHERE id = ${pgId} LIMIT 1`;
  const practitionerRows = await sql`SELECT * FROM practitioners WHERE id = ${practitionerId} LIMIT 1`;
  const pg = pgRows[0];
  const practitioner = practitionerRows[0];
  if (!pg || !practitioner) throw new Error('PG or practitioner not found');

  const pgContact = pg.contact_info || {};
  const existingPhysicianIds = Array.isArray(pgContact.physician_ids) ? pgContact.physician_ids : [];
  const physicianIds = Array.from(new Set([...existingPhysicianIds, practitioner.id]));
  const practitionerHistory = practitioner.history || {};
  const rawPgNames = practitionerHistory.PG_names || practitionerHistory.pg_names || [];
  const pgNames = Array.isArray(rawPgNames) ? rawPgNames : [];
  const nextPgNames = pgNames.some((entry) => entry.id === pg.id)
    ? pgNames
    : [...pgNames, { id: pg.id, name: pg.name }];

  const updatedPg = await sql`
    UPDATE physician_groups
    SET contact_info = ${await jsonParam({ ...pgContact, physician_ids: physicianIds })}::jsonb,
        updated_at = now()
    WHERE id = ${pg.id}
    RETURNING *
  `;
  const updatedPractitioner = await sql`
    UPDATE practitioners
    SET history = ${await jsonParam({ ...practitionerHistory, PG_names: nextPgNames })}::jsonb,
        updated_at = now()
    WHERE id = ${practitioner.id}
    RETURNING *
  `;

  return { pg: updatedPg[0], practitioner: updatedPractitioner[0] };
}

export async function upsertStatisticalArea({ name, areaType, state = null, metadata = {} }) {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO statistical_areas (name, area_type, state, metadata, updated_at)
    VALUES (${name}, ${areaType}, ${state}, ${await jsonParam(metadata)}::jsonb, now())
    ON CONFLICT (name, area_type)
    DO UPDATE SET
      state = COALESCE(EXCLUDED.state, statistical_areas.state),
      metadata = statistical_areas.metadata || EXCLUDED.metadata,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

export async function linkHhahToArea({ areaId, hhahId, expectedDailyUploadTime = '17:00', uploadWindowHours = 24 }) {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO statistical_area_hhahs (area_id, hhah_id, expected_daily_upload_time, upload_window_hours, active, updated_at)
    VALUES (${areaId}, ${hhahId}, ${expectedDailyUploadTime}, ${uploadWindowHours}, true, now())
    ON CONFLICT (area_id, hhah_id)
    DO UPDATE SET
      expected_daily_upload_time = EXCLUDED.expected_daily_upload_time,
      upload_window_hours = EXCLUDED.upload_window_hours,
      active = true,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

export async function findStatisticalAreaByName(name, areaType) {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM statistical_areas
    WHERE name = ${name} AND area_type = ${areaType}
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function listAreaIntakeStatus({ checkDate = null } = {}) {
  const sql = getSql();
  const dateExpr = checkDate || new Date().toISOString().slice(0, 10);
  const areas = await sql`
    SELECT id, name, area_type, state, metadata, created_at, updated_at
    FROM statistical_areas
    ORDER BY name
  `;
  const memberships = await sql`
    SELECT sah.area_id, sah.hhah_id, sah.expected_daily_upload_time, sah.upload_window_hours,
      h.name AS hhah_name, h.contact_info
    FROM statistical_area_hhahs sah
    JOIN home_health_agencies h ON h.id = sah.hhah_id
    WHERE sah.active = true
    ORDER BY h.name
  `;
  const checks = await sql`
    SELECT *
    FROM area_intake_checks
    WHERE check_date = ${dateExpr}
  `;
  const notifications = await sql`
    SELECT n.*, h.name AS hhah_name
    FROM missing_upload_notifications n
    JOIN home_health_agencies h ON h.id = n.hhah_id
    JOIN area_intake_checks c ON c.id = n.area_check_id
    WHERE c.check_date = ${dateExpr}
    ORDER BY n.created_at DESC
  `;
  const uploads = await sql`
    SELECT r.area_id, r.hhah_id, COUNT(*)::int AS run_count, MAX(r.created_at) AS last_upload_at
    FROM workflow_runs r
    WHERE r.created_at::date = ${dateExpr}
      AND r.area_id IS NOT NULL
      AND r.hhah_id IS NOT NULL
    GROUP BY r.area_id, r.hhah_id
  `;

  const membersByArea = new Map();
  for (const member of memberships) {
    const list = membersByArea.get(member.area_id) || [];
    const upload = uploads.find((u) => u.area_id === member.area_id && u.hhah_id === member.hhah_id);
    list.push({
      ...member,
      received: !!upload,
      run_count: upload?.run_count || 0,
      last_upload_at: upload?.last_upload_at || null,
    });
    membersByArea.set(member.area_id, list);
  }

  return areas.map((area) => {
    const areaMembers = membersByArea.get(area.id) || [];
    const check = checks.find((row) => row.area_id === area.id) || null;
    return {
      ...area,
      check,
      hhahs: areaMembers,
      notifications: notifications.filter((n) => n.area_id === area.id),
      expected_count: areaMembers.length,
      received_count: areaMembers.filter((m) => m.received).length,
      missing_count: areaMembers.filter((m) => !m.received).length,
    };
  });
}

export async function runAreaIntakeCheck({ areaId, checkDate = null, now = null, forceExpired = false }) {
  const sql = getSql();
  const checkedAt = now ? new Date(now) : new Date();
  const dateExpr = checkDate || checkedAt.toISOString().slice(0, 10);
  const members = await sql`
    SELECT sah.area_id, sah.hhah_id, sah.upload_window_hours, h.name AS hhah_name, h.contact_info
    FROM statistical_area_hhahs sah
    JOIN home_health_agencies h ON h.id = sah.hhah_id
    WHERE sah.area_id = ${areaId} AND sah.active = true
    ORDER BY h.name
  `;
  if (!members.length) throw new Error('No HHAHs are linked to this statistical area.');

  const uploads = await sql`
    SELECT hhah_id, COUNT(*)::int AS run_count, MAX(created_at) AS last_upload_at
    FROM workflow_runs
    WHERE area_id = ${areaId}
      AND hhah_id IS NOT NULL
      AND created_at::date = ${dateExpr}
    GROUP BY hhah_id
  `;
  const received = new Set(uploads.map((row) => row.hhah_id));
  const missing = members.filter((member) => !received.has(member.hhah_id));
  const maxWindow = Math.max(...members.map((member) => Number(member.upload_window_hours) || 24));
  const windowStartedAt = new Date(`${dateExpr}T00:00:00.000Z`);
  const windowEndsAt = new Date(windowStartedAt.getTime() + maxWindow * 60 * 60 * 1000);
  const expired = forceExpired || checkedAt >= windowEndsAt;
  const status = missing.length === 0 ? 'complete' : expired ? 'missing_uploads' : 'monitoring';

  const checkRows = await sql`
    INSERT INTO area_intake_checks (
      area_id, check_date, window_started_at, window_ends_at, status,
      expected_count, received_count, missing_count, updated_at
    )
    VALUES (
      ${areaId}, ${dateExpr}, ${windowStartedAt.toISOString()}, ${windowEndsAt.toISOString()}, ${status},
      ${members.length}, ${members.length - missing.length}, ${missing.length}, now()
    )
    ON CONFLICT (area_id, check_date)
    DO UPDATE SET
      window_started_at = EXCLUDED.window_started_at,
      window_ends_at = EXCLUDED.window_ends_at,
      status = EXCLUDED.status,
      expected_count = EXCLUDED.expected_count,
      received_count = EXCLUDED.received_count,
      missing_count = EXCLUDED.missing_count,
      updated_at = now()
    RETURNING *
  `;
  const check = checkRows[0];

  const notifications = [];
  if (status === 'missing_uploads') {
    for (const member of missing) {
      const recipient = member.contact_info?.email || '';
      const message = `Missing daily intake upload for ${member.hhah_name} in area ${areaId} on ${dateExpr}.`;
      const rows = await sql`
        INSERT INTO missing_upload_notifications (
          area_check_id, area_id, hhah_id, notification_type, recipient, status, message, sent_at, updated_at
        )
        VALUES (${check.id}, ${areaId}, ${member.hhah_id}, 'email', ${recipient}, 'sent', ${message}, now(), now())
        ON CONFLICT (area_check_id, hhah_id)
        DO UPDATE SET
          recipient = EXCLUDED.recipient,
          status = EXCLUDED.status,
          message = EXCLUDED.message,
          sent_at = COALESCE(missing_upload_notifications.sent_at, EXCLUDED.sent_at),
          updated_at = now()
        RETURNING *
      `;
      notifications.push(rows[0]);
    }
  }

  return {
    check,
    expected: members,
    received: uploads,
    missing,
    notifications,
  };
}
