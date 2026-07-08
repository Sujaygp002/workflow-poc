import { getSql, jsonParam } from './db.js';
import { WORKFLOW_DEFINITIONS as SYSTEM_WORKFLOW_DEFINITIONS } from './workflowDefinition.js';
import {
  blankToNull,
  normalizeName,
  normalizeNpi,
  parseDate,
  patientKey,
  recordContextKey,
  unitKey,
} from './normalizers.js';

export async function getActiveWorkflow(id) {
  const sql = getSql();
  const rows = await sql`
    SELECT id, version, name, description, definition, kind
    FROM workflow_definitions
    WHERE id = ${id} AND active = true
    ORDER BY version DESC
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function listActiveWorkflowDefinitions() {
  const sql = getSql();
  return sql`
    SELECT id, version, name, description, definition, kind, created_by, created_at, updated_at
    FROM workflow_definitions
    WHERE active = true
    ORDER BY updated_at DESC, id
  `;
}

export async function upsertWorkflowDefinition(definition, version = 1, { kind = 'system', createdBy = null } = {}) {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO workflow_definitions (id, version, name, description, definition, active, kind, created_by, updated_at)
    VALUES (${definition.id}, ${version}, ${definition.name}, ${definition.description}, ${await jsonParam(definition)}::jsonb, true, ${kind}, ${createdBy}, now())
    ON CONFLICT (id, version)
    DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      definition = EXCLUDED.definition,
      active = true,
      kind = EXCLUDED.kind,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

export async function getWorkflowMaxVersion(id) {
  const sql = getSql();
  const rows = await sql`SELECT max(version)::int AS v FROM workflow_definitions WHERE id = ${id}`;
  return rows[0]?.v || 0;
}

// Deactivate all versions of a definition (builder soft-delete, or before a new
// version becomes the single active one). Returns affected count.
export async function deactivateWorkflowDefinition(id, { keepVersion = null } = {}) {
  const sql = getSql();
  const rows = keepVersion == null
    ? await sql`UPDATE workflow_definitions SET active = false, updated_at = now() WHERE id = ${id} AND active = true RETURNING version`
    : await sql`UPDATE workflow_definitions SET active = false, updated_at = now() WHERE id = ${id} AND active = true AND version <> ${keepVersion} RETURNING version`;
  return rows.length;
}

// Active builder-authored workflows whose trigger matches (e.g. 'document_upload').
export async function listActiveBuilderWorkflowsByTrigger(triggerType) {
  const sql = getSql();
  return sql`
    SELECT id, version, name, description, definition, kind
    FROM workflow_definitions
    WHERE active = true
      AND kind = 'builder'
      AND definition->'trigger'->>'type' = ${triggerType}
    ORDER BY id, version DESC
  `;
}

// Idempotent: re-upsert the 4 system workflow definitions (kind='system') when
// missing — the wipe empties workflow_definitions. NO user seeding.
export async function ensureSystemDefinitions() {
  for (const definition of SYSTEM_WORKFLOW_DEFINITIONS) {
    const existing = await getActiveWorkflow(definition.id);
    if (!existing) await upsertWorkflowDefinition(definition, 1, { kind: 'system' });
  }
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
        run_id, item_id, step_id, task_key, actor, name, description, condition, input,
        actions, assigned_employee_id
      )
      VALUES (
        ${runId}, ${itemId}, ${step.id}, ${step.taskKey}, ${step.actor}, ${step.name},
        ${step.description || null}, ${step.condition || null}, ${await jsonParam(step)}::jsonb,
        ${await jsonParam(step.actions || [])}::jsonb, ${step.assigneeEmployeeId || null}
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

export async function findWorkflowItemByIssueSignature(workflowId, issueSignature) {
  if (!issueSignature) return null;
  const sql = getSql();
  const rows = await sql`
    SELECT i.*, r.id AS run_id, r.source_label
    FROM workflow_items i
    JOIN workflow_runs r ON r.id = i.run_id
    WHERE r.workflow_id = ${workflowId}
      AND i.extraction_payload->>'issueSignature' = ${issueSignature}
    ORDER BY i.created_at DESC
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function findActiveWorkflowRunForHhah(workflowId, hhahId = null, hhahName = null) {
  const sql = getSql();
  const rows = await sql`
    SELECT *
    FROM workflow_runs
    WHERE workflow_id = ${workflowId}
      AND status = 'running'
      AND (
        (${hhahId}::uuid IS NOT NULL AND hhah_id = ${hhahId})
        OR (${hhahId}::uuid IS NULL AND ${hhahName}::text IS NOT NULL AND input_summary->>'hhahName' = ${hhahName})
        OR (${hhahId}::uuid IS NULL AND ${hhahName}::text IS NULL AND (hhah_id IS NULL AND COALESCE(input_summary->>'hhahName', '') = 'Unknown HHAH'))
      )
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

export async function countWorkflowItems(runId) {
  const sql = getSql();
  const rows = await sql`SELECT count(*)::int AS n FROM workflow_items WHERE run_id = ${runId}`;
  return rows[0]?.n || 0;
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

export async function listTaskRunsForRuns(runIds) {
  if (!Array.isArray(runIds) || runIds.length === 0) return [];
  const sql = getSql();
  return sql`
    SELECT t.id, t.run_id, t.item_id, t.step_id, t.task_key, t.actor, t.status, t.condition, t.created_at,
      i.item_index, i.decisions
    FROM workflow_task_runs t
    JOIN workflow_items i ON i.id = t.item_id
    WHERE t.run_id = ANY(${runIds})
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
      assigned_employee_id = ${patch.assignedEmployeeId === undefined ? current.assigned_employee_id : patch.assignedEmployeeId},
      opened_at = ${patch.openedAt === undefined ? current.opened_at : patch.openedAt},
      action_state = ${await jsonParam(patch.actionState ?? current.action_state)}::jsonb,
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

// ── Worker buckets (Untouched / Processing / Done) ───────────────────────────
// Untouched:  active AND opened_at IS NULL AND (mine OR unassigned/shared)
// Processing: active AND opened_at IS NOT NULL AND mine
// Done:       completed AND mine
const BUCKET_ITEM_SELECT = `
    SELECT
      t.*,
      r.workflow_id,
      r.source_label,
      r.created_at AS run_created_at,
      d.name AS workflow_name,
      i.item_index,
      i.patient_payload,
      i.order_payload,
      i.reference_payload,
      i.extraction_payload,
      i.decisions
    FROM workflow_task_runs t
    JOIN workflow_runs r ON r.id = t.run_id
    JOIN workflow_definitions d ON d.id = r.workflow_id AND d.version = r.workflow_version
    JOIN workflow_items i ON i.id = t.item_id
`;

export async function listEmployeeBucketItems(employeeId) {
  const sql = getSql();
  const [untouched, processing, done] = await Promise.all([
    sql.query(`${BUCKET_ITEM_SELECT}
      WHERE t.status = 'active' AND t.actor = 'human' AND t.opened_at IS NULL
        AND (t.assigned_employee_id = $1 OR t.assigned_employee_id IS NULL)
      ORDER BY r.created_at, i.item_index, t.created_at
    `, [employeeId]),
    sql.query(`${BUCKET_ITEM_SELECT}
      WHERE t.status = 'active' AND t.actor = 'human' AND t.opened_at IS NOT NULL
        AND t.assigned_employee_id = $1
      ORDER BY t.opened_at DESC
    `, [employeeId]),
    sql.query(`${BUCKET_ITEM_SELECT}
      WHERE t.status = 'completed' AND t.actor = 'human' AND t.assigned_employee_id = $1
      ORDER BY t.completed_at DESC NULLS LAST
      LIMIT 100
    `, [employeeId]),
  ]);
  return { untouched, processing, done };
}

// "Open" a task: claims it for the employee (if unassigned) and stamps
// opened_at, moving it Untouched -> Processing. Idempotent for the claimer.
export async function openTaskRun({ taskRunId, employeeId }) {
  const sql = getSql();
  const task = await getTaskRun(taskRunId);
  if (!task) return { error: 'Task not found', status: 404 };
  if (task.status !== 'active') return { error: 'Task is not active', status: 409 };
  if (task.assigned_employee_id && task.assigned_employee_id !== employeeId) {
    return { error: 'Task is claimed by another employee', status: 403 };
  }
  const rows = await sql`
    UPDATE workflow_task_runs
    SET assigned_employee_id = ${employeeId},
        opened_at = COALESCE(opened_at, now()),
        updated_at = now()
    WHERE id = ${taskRunId}
    RETURNING *
  `;
  return { task: rows[0] };
}

export async function findNewestRunForWorkflow(workflowId) {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM workflow_runs
    WHERE workflow_id = ${workflowId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] || null;
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
  const status = total > 0 && completed === total ? 'completed' : failed > 0 ? 'failed' : 'running';
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

export async function getHhahById(id) {
  if (!id) return null;
  const sql = getSql();
  const rows = await sql`SELECT * FROM home_health_agencies WHERE id = ${id} LIMIT 1`;
  return rows[0] || null;
}

// Active agencies for the daily-intake trigger. home_health_agencies has no
// `active` column, so every agency row is treated as active.
export async function listActiveAgencies() {
  const sql = getSql();
  return sql`
    SELECT id, name, contact_info
    FROM home_health_agencies
    ORDER BY created_at, name
  `;
}

// Find the Patient RECORD for this care context (Unit + HHAH + PG). A different
// HHAH or PG is a different record, so the reference payload is required to key it.
export async function findPatient(patientPayload, referencePayload) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM patients WHERE record_context_key = ${recordContextKey(patientPayload, referencePayload)} LIMIT 1`;
  return rows[0] || null;
}

// Find the stable Patient UNIT by identity (name | DOB | MRN).
export async function findPatientUnit(patientPayload) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM patient_units WHERE unit_key = ${unitKey(patientPayload)} LIMIT 1`;
  return rows[0] || null;
}

export async function findOrder(orderNumber) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM orders WHERE order_number = ${blankToNull(orderNumber)} LIMIT 1`;
  return rows[0] || null;
}

export async function findOrderById(orderId) {
  if (!orderId) return null;
  const sql = getSql();
  const rows = await sql`SELECT * FROM orders WHERE id = ${orderId} LIMIT 1`;
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
      unit_key, name, dob, mrn, sex,
      personal_information, insurance_details, raw_data, updated_at
    )
    VALUES (
      ${unitKey(patient)},
      ${patient.patient_info?.name},
      ${parseDate(patient.patient_info?.DOB)},
      ${patient.admission_details?.MRN},
      ${blankToNull(patient.patient_info?.sex)},
      ${await jsonParam(patient.personal_information || {})}::jsonb,
      ${await jsonParam(patient.insurance_details || {})}::jsonb,
      ${await jsonParam(patient)}::jsonb,
      now()
    )
    ON CONFLICT (unit_key)
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
  const hhahName = blankToNull(reference?.HHAH?.name);
  const pgName = blankToNull(reference?.PG?.name);

  // Patient RECORD: a new row per (Unit + HHAH + PG) context. Same context
  // updates the existing record; a changed HHAH/PG creates a new record.
  const patientRows = await sql`
    INSERT INTO patients (
      unit_id, record_context_key, hhah_name, pg_name, agency_id, pg_id,
      name, dob, mrn, sex, age,
      personal_information, insurance_details, admission_details, raw_data, updated_at
    )
    VALUES (
      ${unit?.id || null},
      ${recordContextKey(patient, reference)},
      ${hhahName},
      ${pgName},
      ${existingHhah?.id || null},
      ${existingPg?.id || null},
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
    ON CONFLICT (record_context_key)
    DO UPDATE SET
      unit_id = COALESCE(patients.unit_id, EXCLUDED.unit_id),
      hhah_name = COALESCE(EXCLUDED.hhah_name, patients.hhah_name),
      pg_name = COALESCE(EXCLUDED.pg_name, patients.pg_name),
      agency_id = COALESCE(EXCLUDED.agency_id, patients.agency_id),
      pg_id = COALESCE(EXCLUDED.pg_id, patients.pg_id),
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

  return { unit, patient: storedPatient };
}

export async function writeAdmissionBundle(item, patientId) {
  if (!patientId) throw new Error('Cannot resolve admission before patient record exists');

  const patient = item.patient_payload;
  const reference = item.reference_payload;
  const existingPg = await findPgByName(reference?.PG?.name);
  const existingHhah = await findHhahByName(reference?.HHAH?.name);
  const existingPractitioner = await findPractitionerByNpi(reference?.practitioner?.NPI);
  const existingAdmission = await findAdmission(patientId, patient.admission_details?.SOC);
  const sql = getSql();

  const admissionRows = await sql`
    INSERT INTO patient_admissions (
      patient_id, soc, eoc, agency_id, pg_id, care_provider_id, mrn, raw_data, updated_at
    )
    VALUES (
      ${patientId},
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

  return { admission: admissionRows[0], existed: !!existingAdmission };
}

export async function writeEpisodeBundle(item, admissionId) {
  if (!admissionId) throw new Error('Cannot resolve episode before admission exists');

  const patient = item.patient_payload;
  const existingEpisode = await findEpisode(
    admissionId,
    patient.admission_details?.SOE,
    patient.admission_details?.EOE,
  );
  const sql = getSql();
  const episodeRows = await sql`
    INSERT INTO patient_episodes (admission_id, soe, eoe, diagnosis_codes, raw_data, updated_at)
    VALUES (
      ${admissionId},
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

  return { episode: episodeRows[0], existed: !!existingEpisode };
}

export async function writeOrderBundle(item, patientBundle) {
  const order = item.order_payload;
  const reference = item.reference_payload;
  const patient = patientBundle?.patient || await findPatient(item.patient_payload, reference);
  const pg = await findPgByName(reference?.PG?.name);
  const hhah = await findHhahByName(reference?.HHAH?.name);
  const practitioner = await findPractitionerByNpi(reference?.practitioner?.NPI);
  const admission = patientBundle?.admission || null;
  const episode = patientBundle?.episode || null;
  const sql = getSql();

  const orderNumber = blankToNull(order.order_info?.order_number);
  const documentType = blankToNull(order.order_info?.document_type || order.order_info?.order_type);

  // Duplicate-order policy: if this order_number already exists, SKIP it — the
  // existing order is left completely untouched (no overwrite).
  const existing = orderNumber ? await findOrder(orderNumber) : null;
  if (existing) {
    return { order: existing, skipped: true };
  }

  const rows = await sql`
    INSERT INTO orders (
      order_number, order_type, document_type, order_date, patient_id, admission_id, episode_id,
      agency_id, pg_id, billing_provider_id, order_status, order_admission_details, raw_data, updated_at
    )
    VALUES (
      ${orderNumber},
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
    ON CONFLICT (order_number) DO NOTHING
    RETURNING *
  `;
  const storedOrder = rows[0];
  if (!storedOrder) {
    return { order: await findOrder(orderNumber), skipped: true };
  }

  // Order's billing provider is also a direct patient↔practitioner link.
  await linkPatientToPractitioner(patient?.id || null, practitioner?.id || null, 'billing_provider');
  await linkPatientToPg(patient?.id || null, pg?.id || null);

  return { order: storedOrder, skipped: false };
}

// ── Episode / CPO status ─────────────────────────────────
// eligible = episode has a 485 + an admission-level F2F whose order_date is
//            within 180 days of the episode EOE, even if unsigned.
// billable = eligible + all of the episode's orders are signed.
export function isOrderSigned(order) {
  const s = order.order_status || {};
  return !!(
    s.SignedByPhysician_Status === true
    || s.SignedByPhysician_Status === 'true'
    || s.SignedByPhyscianDate
    // Backward-compatible reads for records created before the new field contract.
    || s.signed === true
    || s.order_signed_date
    || s.signedDate
    || order.signed_date
  );
}

function docTypeOf(order) {
  return String(order.document_type || order.order_type || '').toLowerCase();
}

function dayDiff(fromDate, toDate) {
  // Normalize through dateMs/dateOnly so this works whether the dates arrive as
  // 'YYYY-MM-DD' strings (Excel/AI payloads) or as Date objects (straight from
  // the DB driver). Naive `${value}T...` interpolation produced NaN for Date
  // objects, which silently failed the F2F-within-180-days eligibility check.
  const from = dateMs(fromDate);
  const to = dateMs(toDate);
  if (from === null || to === null) return null;
  return Math.floor((to - from) / (1000 * 60 * 60 * 24));
}

export function computeEpisodeAssessment(episode = {}, episodeOrders = [], admissionOrders = episodeOrders) {
  if (!episodeOrders.length) {
    return {
      status: 'started',
      eligible: false,
      billable: false,
      reason: {
        has485: false,
        hasF2f: false,
        f2fWithin180DaysOfEoe: false,
        allEpisodeOrdersSigned: false,
        unsignedOrderNumbers: [],
      },
    };
  }

  const has485 = episodeOrders.some((order) => docTypeOf(order).includes('485'));
  const f2fOrders = admissionOrders.filter((order) => docTypeOf(order).includes('f2f') || docTypeOf(order).includes('face'));
  const validF2f = f2fOrders.find((order) => {
    if (!order.order_date || !episode.eoe) return false;
    const days = dayDiff(order.order_date, episode.eoe);
    return days !== null && days >= 0 && days <= 180;
  });
  const unsignedOrderNumbers = episodeOrders
    .filter((order) => !isOrderSigned(order))
    .map((order) => order.order_number)
    .filter(Boolean);
  const allEpisodeOrdersSigned = unsignedOrderNumbers.length === 0;
  const eligible = has485 && !!validF2f;
  const billable = eligible && allEpisodeOrdersSigned;

  return {
    status: billable ? 'billable' : eligible ? 'eligible' : 'started',
    eligible,
    billable,
    reason: {
      has485,
      hasF2f: f2fOrders.length > 0,
      f2fWithin180DaysOfEoe: !!validF2f,
      f2fOrderNumber: validF2f?.order_number || null,
      episodeEoe: episode.eoe || null,
      allEpisodeOrdersSigned,
      unsignedOrderNumbers,
    },
  };
}

export function computeEpisodeStatus(orders = [], episode = {}, admissionOrders = orders) {
  return computeEpisodeAssessment(episode, orders, admissionOrders).status;
}

const ADMISSION_ARCHIVE_GAP_DAYS = 90;

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const str = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : null;
}

function dateMs(value) {
  const ymd = dateOnly(value);
  if (!ymd) return null;
  const time = new Date(`${ymd}T00:00:00.000Z`).getTime();
  return Number.isNaN(time) ? null : time;
}

function compareDateAsc(aValue, bValue, aFallback, bFallback) {
  const aTime = dateMs(aValue);
  const bTime = dateMs(bValue);
  if (aTime !== null && bTime !== null) return aTime - bTime;
  if (aTime !== null) return 1;
  if (bTime !== null) return -1;
  return new Date(aFallback || 0).getTime() - new Date(bFallback || 0).getTime();
}

function compareNewest(a, b) {
  const aTime = new Date(a.updated_at || a.created_at || 0).getTime();
  const bTime = new Date(b.updated_at || b.created_at || 0).getTime();
  return bTime - aTime;
}

function daysBetween(fromValue, toValue) {
  const from = dateMs(fromValue);
  const to = dateMs(toValue);
  if (from === null || to === null) return null;
  return Math.floor((to - from) / (1000 * 60 * 60 * 24));
}

function signedDateOf(order = {}) {
  const status = order.order_status || {};
  const raw = status.SignedByPhyscianDate
    || status.physicianSignedDate
    || status.order_signed_date
    || status.signedDate
    || order.signed_date
    || null;
  // Normalize to YYYY-MM-DD so display is consistent whether the value came from
  // a payload string or a DB Date object.
  return raw ? (dateOnly(raw) || raw) : null;
}

function archiveDecisionForAdmission(admission, nextAdmission) {
  if (!nextAdmission) {
    return { archived: false, reason: 'latest_admission', gapDays: null };
  }
  const gapDays = daysBetween(admission?.eoc, nextAdmission?.soc);
  if (gapDays === null) {
    return { archived: false, reason: 'missing_eoc_or_next_soc', gapDays: null };
  }
  if (gapDays >= ADMISSION_ARCHIVE_GAP_DAYS) {
    return { archived: true, reason: 'admission_gap_90_days', gapDays };
  }
  return { archived: false, reason: 'admission_gap_under_90_days', gapDays };
}

function decorateOrder(order, archiveReason = null) {
  const signed = isOrderSigned(order);
  return {
    ...order,
    signed,
    signed_status: signed ? 'signed' : 'unsigned',
    signed_date: signedDateOf(order),
    archive_reason: archiveReason,
  };
}

function splitSignedOrders(orders = []) {
  return {
    signed_orders: orders.filter((order) => order.signed),
    unsigned_orders: orders.filter((order) => !order.signed),
  };
}

function buildEpisodeEntry(episode, orders, admissionOrders, cpoMonths, archiveReason = null) {
  const episodeOrders = orders.map((order) => decorateOrder(order, archiveReason));
  const assessment = computeEpisodeAssessment(episode, orders, admissionOrders);
  return {
    ...episode,
    orders: episodeOrders,
    cpoMonths: cpoMonths.filter((month) => month.episode_id === episode.id),
    status: assessment.status,
    status_reason: assessment.reason,
    archive_reason: archiveReason,
    ...splitSignedOrders(episodeOrders),
  };
}

function buildArchivedAdmissionEntry(admission, episodes, orders, cpoMonths, archiveDecision) {
  const admissionOrders = orders.filter((order) => order.admission_id === admission.id);
  const archivedEpisodes = episodes.map((episode) => buildEpisodeEntry(
    episode,
    orders.filter((order) => order.episode_id === episode.id),
    admissionOrders,
    cpoMonths,
    archiveDecision.reason,
  ));
  const episodeOrderIds = new Set(archivedEpisodes.flatMap((episode) => (episode.orders || []).map((order) => order.id)));
  const archivedAdmissionOrders = admissionOrders
    .filter((order) => !episodeOrderIds.has(order.id))
    .map((order) => decorateOrder(order, archiveDecision.reason));

  return {
    ...admission,
    archive_reason: archiveDecision.reason,
    archive_gap_days: archiveDecision.gapDays,
    episodes: archivedEpisodes,
    archived_episodes: archivedEpisodes,
    orders: [...archivedEpisodes.flatMap((episode) => episode.orders || []), ...archivedAdmissionOrders],
    archived_orders: [...archivedEpisodes.flatMap((episode) => episode.orders || []), ...archivedAdmissionOrders],
  };
}

function buildLatestAdmissionEntry(admission, episodes, orders, cpoMonths) {
  if (!admission) return null;
  const admissionOrders = orders.filter((order) => order.admission_id === admission.id);
  const sortedEpisodes = [...episodes].sort((a, b) => compareDateAsc(a.soe, b.soe, a.created_at, b.created_at));
  const latestEpisodeRaw = sortedEpisodes[sortedEpisodes.length - 1] || null;
  const archivedEpisodeRaws = sortedEpisodes.slice(0, -1);
  const episodeArchive = archivedEpisodeRaws.map((episode) => buildEpisodeEntry(
    episode,
    orders.filter((order) => order.episode_id === episode.id),
    admissionOrders,
    cpoMonths,
    'older_episode_in_latest_admission',
  ));
  const latestEpisode = latestEpisodeRaw
    ? buildEpisodeEntry(
        latestEpisodeRaw,
        orders.filter((order) => order.episode_id === latestEpisodeRaw.id),
        admissionOrders,
        cpoMonths,
      )
    : null;
  const latestEpisodeOrderIds = new Set((latestEpisode?.orders || []).map((order) => order.id));
  const archivedEpisodeOrderIds = new Set(episodeArchive.flatMap((episode) => (episode.orders || []).map((order) => order.id)));
  const orderArchive = admissionOrders
    .filter((order) => !latestEpisodeOrderIds.has(order.id))
    .map((order) => decorateOrder(
      order,
      archivedEpisodeOrderIds.has(order.id) ? 'older_episode_in_latest_admission' : 'not_linked_to_latest_episode',
    ));

  return {
    ...admission,
    latest_episode: latestEpisode,
    episode_archive: episodeArchive,
    order_archive: orderArchive,
    signed_orders: latestEpisode?.signed_orders || [],
    unsigned_orders: latestEpisode?.unsigned_orders || [],
    episodes: latestEpisode ? [latestEpisode] : [],
    archived_episodes: episodeArchive,
  };
}

function latestAdmissionForRecord(record, admissionsByPatient) {
  const admissions = [...(admissionsByPatient.get(record.id) || [])]
    .sort((a, b) => compareDateAsc(a.soc, b.soc, a.created_at, b.created_at));
  return admissions[admissions.length - 1] || null;
}

function buildPatientRecordHierarchy(record, grouped) {
  const admissions = [...(grouped.admissionsByPatient.get(record.id) || [])]
    .sort((a, b) => compareDateAsc(a.soc, b.soc, a.created_at, b.created_at));
  const latestAdmissionRaw = admissions[admissions.length - 1] || null;
  const admissionArchive = [];
  const priorAdmissionsNotArchived = [];

  for (let index = 0; index < admissions.length - 1; index += 1) {
    const admission = admissions[index];
    const nextAdmission = admissions[index + 1];
    const decision = archiveDecisionForAdmission(admission, nextAdmission);
    if (decision.archived) {
      admissionArchive.push(buildArchivedAdmissionEntry(
        admission,
        grouped.episodesByAdmission.get(admission.id) || [],
        grouped.ordersByPatient.get(record.id) || [],
        grouped.cpoMonths,
        decision,
      ));
    } else {
      priorAdmissionsNotArchived.push({
        ...buildLatestAdmissionEntry(
          admission,
          grouped.episodesByAdmission.get(admission.id) || [],
          grouped.ordersByPatient.get(record.id) || [],
          grouped.cpoMonths,
        ),
        not_archived_reason: decision.reason,
        gap_days: decision.gapDays,
      });
    }
  }

  const latestAdmission = latestAdmissionRaw
    ? buildLatestAdmissionEntry(
        latestAdmissionRaw,
        grouped.episodesByAdmission.get(latestAdmissionRaw.id) || [],
        grouped.ordersByPatient.get(record.id) || [],
        grouped.cpoMonths,
      )
    : null;

  const latestEpisode = latestAdmission?.latest_episode || null;
  return {
    ...record,
    archive_status: 'current',
    admission_archive: admissionArchive,
    prior_admissions_not_archived: priorAdmissionsNotArchived,
    latest_admission: latestAdmission,
    episode_archive: latestAdmission?.episode_archive || [],
    latest_episode: latestEpisode,
    order_archive: latestAdmission?.order_archive || [],
    signed_orders: latestAdmission?.signed_orders || [],
    unsigned_orders: latestAdmission?.unsigned_orders || [],
  };
}

function patientRecordArchiveDecision(record, nextRecord, admissionsByPatient) {
  if (!nextRecord) return { archived: false, reason: 'current_patient_record', gapDays: null };
  const latestAdmission = latestAdmissionForRecord(record, admissionsByPatient);
  const nextLatestAdmission = latestAdmissionForRecord(nextRecord, admissionsByPatient);
  const gapDays = daysBetween(latestAdmission?.eoc, nextLatestAdmission?.soc);
  if (gapDays === null) return { archived: false, reason: 'missing_latest_eoc_or_next_soc', gapDays: null };
  if (gapDays >= ADMISSION_ARCHIVE_GAP_DAYS) return { archived: true, reason: 'patient_record_gap_90_days', gapDays };
  return { archived: false, reason: 'patient_record_gap_under_90_days', gapDays };
}

function buildUnitHierarchy({ unit, patientRecords, admissions, episodes, orders, cpoMonths, selectedPatientId = null }) {
  const admissionsByPatient = new Map();
  for (const admission of admissions) {
    const list = admissionsByPatient.get(admission.patient_id) || [];
    list.push(admission);
    admissionsByPatient.set(admission.patient_id, list);
  }

  const episodesByAdmission = new Map();
  for (const episode of episodes) {
    const list = episodesByAdmission.get(episode.admission_id) || [];
    list.push(episode);
    episodesByAdmission.set(episode.admission_id, list);
  }

  const ordersByPatient = new Map();
  for (const order of orders) {
    const list = ordersByPatient.get(order.patient_id) || [];
    list.push(order);
    ordersByPatient.set(order.patient_id, list);
  }

  const grouped = { admissionsByPatient, episodesByAdmission, ordersByPatient, cpoMonths };
  const sortedRecords = [...patientRecords].sort(compareNewest);
  const currentRecordRaw = sortedRecords[0] || null;
  const currentPatientRecord = currentRecordRaw ? buildPatientRecordHierarchy(currentRecordRaw, grouped) : null;
  const patientRecordArchive = [];
  const priorPatientRecordsNotArchived = [];

  for (let index = 1; index < sortedRecords.length; index += 1) {
    const record = sortedRecords[index];
    const nextRecord = sortedRecords[index - 1];
    const decision = patientRecordArchiveDecision(record, nextRecord, admissionsByPatient);
    const entry = {
      ...buildPatientRecordHierarchy(record, grouped),
      archive_reason: decision.reason,
      archive_gap_days: decision.gapDays,
    };
    if (decision.archived) {
      patientRecordArchive.push({
        ...entry,
        archive_status: 'archived',
        archived_admissions: [
          ...(entry.admission_archive || []),
          ...(entry.prior_admissions_not_archived || []),
          ...(entry.latest_admission ? [entry.latest_admission] : []),
        ],
      });
    } else {
      priorPatientRecordsNotArchived.push({ ...entry, archive_status: 'not_archived', not_archived_reason: decision.reason });
    }
  }

  const selectedPatientRecord = selectedPatientId
    ? sortedRecords.find((record) => record.id === selectedPatientId) || currentPatientRecord
    : currentPatientRecord;

  return {
    unit,
    selected_patient_id: selectedPatientId || currentPatientRecord?.id || null,
    current_patient_record: currentPatientRecord,
    selected_patient_record: selectedPatientRecord?.id === currentPatientRecord?.id
      ? currentPatientRecord
      : selectedPatientRecord
        ? buildPatientRecordHierarchy(selectedPatientRecord, grouped)
        : null,
    patient_record_archive: patientRecordArchive,
    prior_patient_records_not_archived: priorPatientRecordsNotArchived,
    patient_records: sortedRecords,
    admission_archive: currentPatientRecord?.admission_archive || [],
    prior_admissions_not_archived: currentPatientRecord?.prior_admissions_not_archived || [],
    latest_admission: currentPatientRecord?.latest_admission || null,
    episode_archive: currentPatientRecord?.episode_archive || [],
    latest_episode: currentPatientRecord?.latest_episode || null,
    order_archive: currentPatientRecord?.order_archive || [],
    signed_orders: currentPatientRecord?.signed_orders || [],
    unsigned_orders: currentPatientRecord?.unsigned_orders || [],
    archive_rule: {
      type: 'admission_gap',
      gapDays: ADMISSION_ARCHIVE_GAP_DAYS,
      description: 'Older admissions archive only when the next admission starts at least 90 days after the old admission ended.',
    },
  };
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

export async function listPatients({ hhahId = null } = {}) {
  const sql = getSql();
  const rows = await sql`
    SELECT
      p.id,
      COALESCE(pu.name, p.name) AS name,
      COALESCE(pu.dob, p.dob) AS dob,
      COALESCE(pu.mrn, p.mrn) AS mrn,
      COALESCE(pu.sex, p.sex) AS sex,
      p.hhah_name,
      p.pg_name,
      p.unit_id,
      p.latest_episode_status,
      p.latest_episode_status_reason,
      p.updated_at,
      COUNT(DISTINCT a.id)::int AS admission_count,
      COUNT(DISTINCT e.id)::int AS episode_count,
      COUNT(DISTINCT o.id)::int AS order_count
    FROM patients p
    LEFT JOIN patient_units pu ON pu.id = p.unit_id
    LEFT JOIN patient_admissions a ON a.patient_id = p.id
    LEFT JOIN patient_episodes e ON e.admission_id = a.id
    LEFT JOIN orders o ON o.patient_id = p.id
    WHERE (${hhahId}::uuid IS NULL OR p.agency_id = ${hhahId})
    GROUP BY p.id, pu.name, pu.dob, pu.mrn, pu.sex
    ORDER BY p.updated_at DESC, p.name
    LIMIT 200
  `;

  // Latest-episode status per patient (computed). One small query for the set.
  const ids = rows.map(r => r.id);
  if (!ids.length) return rows;
  const latestEpisodes = await sql`
    SELECT DISTINCT ON (a.patient_id) a.patient_id, e.id AS episode_id, e.soe, e.eoe, e.admission_id
    FROM patient_episodes e
    JOIN patient_admissions a ON a.id = e.admission_id
    WHERE a.patient_id = ANY(${ids})
    ORDER BY a.patient_id, e.soe DESC NULLS LAST, e.created_at DESC
  `;
  const episodeIds = latestEpisodes.map(r => r.episode_id);
  const episodeOrders = episodeIds.length
    ? await sql`SELECT id, admission_id, episode_id, order_number, order_type, document_type, order_date, order_status FROM orders WHERE episode_id = ANY(${episodeIds})`
    : [];
  const admissionIds = [...new Set(episodeOrders.map((order) => order.admission_id).filter(Boolean))];
  const admissionOrders = admissionIds.length
    ? await sql`SELECT id, admission_id, episode_id, order_number, order_type, document_type, order_date, order_status FROM orders WHERE admission_id = ANY(${admissionIds})`
    : [];
  const ordersByEpisode = new Map();
  for (const o of episodeOrders) {
    const list = ordersByEpisode.get(o.episode_id) || [];
    list.push(o);
    ordersByEpisode.set(o.episode_id, list);
  }
  const statusByPatient = new Map();
  for (const le of latestEpisodes) {
    const eo = ordersByEpisode.get(le.episode_id) || [];
    const ao = admissionOrders.filter((order) => order.admission_id === le.admission_id);
    statusByPatient.set(le.patient_id, computeEpisodeStatus(eo, le, ao));
  }
  return rows.map(r => ({ ...r, latest_episode_status: statusByPatient.get(r.id) || r.latest_episode_status || 'none' }));
}

export async function listPatientUnits() {
  const sql = getSql();
  const units = await sql`
    SELECT
      pu.id,
      pu.unit_key,
      pu.name,
      pu.dob,
      pu.mrn,
      pu.sex,
      pu.updated_at,
      COUNT(DISTINCT p.id)::int AS patient_record_count,
      COUNT(DISTINCT a.id)::int AS admission_count,
      COUNT(DISTINCT e.id)::int AS episode_count,
      COUNT(DISTINCT o.id)::int AS order_count
    FROM patient_units pu
    LEFT JOIN patients p ON p.unit_id = pu.id
    LEFT JOIN patient_admissions a ON a.patient_id = p.id
    LEFT JOIN patient_episodes e ON e.admission_id = a.id
    LEFT JOIN orders o ON o.patient_id = p.id
    GROUP BY pu.id
    ORDER BY pu.updated_at DESC, pu.name
    LIMIT 200
  `;
  const unitIds = units.map((unit) => unit.id);
  if (!unitIds.length) return [];

  const records = await sql`
    SELECT
      p.id,
      p.unit_id,
      p.hhah_name,
      p.pg_name,
      p.latest_episode_status,
      p.latest_episode_status_reason,
      p.created_at,
      p.updated_at,
      h.name AS agency_name,
      pg.name AS physician_group_name
    FROM patients p
    LEFT JOIN home_health_agencies h ON h.id = p.agency_id
    LEFT JOIN physician_groups pg ON pg.id = p.pg_id
    WHERE p.unit_id = ANY(${unitIds})
    ORDER BY p.updated_at DESC, p.created_at DESC
  `;
  const recordsByUnit = new Map();
  for (const record of records) {
    const list = recordsByUnit.get(record.unit_id) || [];
    list.push(record);
    recordsByUnit.set(record.unit_id, list);
  }

  return units.map((unit) => {
    const unitRecords = (recordsByUnit.get(unit.id) || []).sort(compareNewest);
    const current = unitRecords[0] || null;
    return {
      ...unit,
      id: current?.id || unit.id,
      unit_id: unit.id,
      patient_unit_id: unit.id,
      current_patient_id: current?.id || null,
      current_hhah_name: current?.agency_name || current?.hhah_name || null,
      current_pg_name: current?.physician_group_name || current?.pg_name || null,
      latest_episode_status: current?.latest_episode_status || 'none',
      latest_episode_status_reason: current?.latest_episode_status_reason || {},
      archived_patient_record_count: Math.max(0, unitRecords.length - 1),
      archive_status: current ? 'current' : 'empty',
    };
  });
}

export async function getPatientTree(patientId) {
  const sql = getSql();
  const patients = await sql`
    SELECT
      p.*,
      COALESCE(pu.name, p.name) AS name,
      COALESCE(pu.dob, p.dob) AS dob,
      COALESCE(pu.mrn, p.mrn) AS mrn,
      COALESCE(pu.sex, p.sex) AS sex,
      pu.id AS patient_unit_id,
      pu.unit_key,
      pu.name AS unit_name,
      pu.dob AS unit_dob,
      pu.mrn AS unit_mrn,
      pu.sex AS unit_sex
    FROM patients p
    LEFT JOIN patient_units pu ON pu.id = p.unit_id
    WHERE p.id = ${patientId}
    LIMIT 1
  `;
  const patient = patients[0];
  if (!patient) return null;

  const unit = {
    id: patient.patient_unit_id || patient.unit_id,
    unit_key: patient.unit_key,
    name: patient.unit_name || patient.name,
    dob: patient.unit_dob || patient.dob,
    mrn: patient.unit_mrn || patient.mrn,
    sex: patient.unit_sex || patient.sex,
  };

  const patientRecords = await sql`
    SELECT
      p.*,
      COALESCE(pu.name, p.name) AS name,
      COALESCE(pu.dob, p.dob) AS dob,
      COALESCE(pu.mrn, p.mrn) AS mrn,
      COALESCE(pu.sex, p.sex) AS sex,
      h.name AS agency_name,
      pg.name AS physician_group_name
    FROM patients p
    LEFT JOIN patient_units pu ON pu.id = p.unit_id
    LEFT JOIN home_health_agencies h ON h.id = p.agency_id
    LEFT JOIN physician_groups pg ON pg.id = p.pg_id
    WHERE p.unit_id = ${patient.unit_id}
    ORDER BY p.updated_at DESC, p.created_at DESC
  `;
  const patientIds = patientRecords.map((record) => record.id);

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
    WHERE a.patient_id = ANY(${patientIds})
    ORDER BY a.soc NULLS LAST, a.created_at
  `;

  const admissionIds = admissions.map((admission) => admission.id);
  const episodes = admissionIds.length
    ? await sql`
        SELECT e.*
        FROM patient_episodes e
        WHERE e.admission_id = ANY(${admissionIds})
        ORDER BY e.soe NULLS LAST, e.created_at
      `
    : [];

  const orders = await sql`
    SELECT
      o.*,
      h.name AS agency_name,
      pg.name AS pg_name,
      pr.physician_name AS billing_provider_name,
      pr.npi_digits AS billing_provider_npi,
      d.file_name AS pdf_file_name,
      d.blob_url AS pdf_blob_url
    FROM orders o
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
    WHERE o.patient_id = ANY(${patientIds})
    ORDER BY o.order_date NULLS LAST, o.created_at
  `;

  const cpoMonths = episodes.length
    ? await sql`
        SELECT *
        FROM cpo_months
        WHERE episode_id = ANY(${episodes.map((episode) => episode.id)})
        ORDER BY cpo_month
      `
    : [];

  const unitHierarchy = buildUnitHierarchy({
    unit,
    patientRecords,
    admissions,
    episodes,
    orders,
    cpoMonths,
    selectedPatientId: patientId,
  });

  const selectedAdmissions = admissions.filter((admission) => admission.patient_id === patientId);
  const selectedOrders = orders.filter((order) => order.patient_id === patientId);
  const selectedAdmissionIds = new Set(selectedAdmissions.map((admission) => admission.id));
  const selectedEpisodes = episodes.filter((episode) => selectedAdmissionIds.has(episode.admission_id));
  const episodesByAdmission = new Map();
  for (const episode of selectedEpisodes) {
    const episodeOrders = selectedOrders.filter((order) => order.episode_id === episode.id);
    const admissionOrders = selectedOrders.filter((order) => order.admission_id === episode.admission_id);
    const assessment = computeEpisodeAssessment(episode, episodeOrders, admissionOrders);
    const entry = {
      ...episode,
      orders: episodeOrders.map((order) => decorateOrder(order)),
      cpoMonths: cpoMonths.filter((month) => month.episode_id === episode.id),
      status: assessment.status,
      status_reason: assessment.reason,
    };
    const list = episodesByAdmission.get(episode.admission_id) || [];
    list.push(entry);
    episodesByAdmission.set(episode.admission_id, list);
  }

  // Latest episode = last by soe order; surface its computed status on the patient.
  const latestEpisode = selectedEpisodes.length
    ? {
        ...selectedEpisodes[selectedEpisodes.length - 1],
        status: computeEpisodeAssessment(
          selectedEpisodes[selectedEpisodes.length - 1],
          selectedOrders.filter(o => o.episode_id === selectedEpisodes[selectedEpisodes.length - 1].id),
          selectedOrders.filter(o => o.admission_id === selectedEpisodes[selectedEpisodes.length - 1].admission_id),
        ).status,
      }
    : null;

  const ordersWithoutEpisode = selectedOrders.filter((order) => !order.episode_id).map((order) => decorateOrder(order));
  return {
    patient: { ...patient, latest_episode_status: latestEpisode?.status || 'none' },
    admissions: selectedAdmissions.map((admission) => ({
      ...admission,
      episodes: episodesByAdmission.get(admission.id) || [],
      orders: selectedOrders.filter((order) => order.admission_id === admission.id && !order.episode_id).map((order) => decorateOrder(order)),
    })),
    ordersWithoutEpisode,
    unit,
    unitHierarchy,
    current_patient_record: unitHierarchy.current_patient_record,
    patient_record_archive: unitHierarchy.patient_record_archive,
    admission_archive: unitHierarchy.admission_archive,
    prior_admissions_not_archived: unitHierarchy.prior_admissions_not_archived,
    latest_admission: unitHierarchy.latest_admission,
    episode_archive: unitHierarchy.episode_archive,
    latest_episode: unitHierarchy.latest_episode,
    order_archive: unitHierarchy.order_archive,
    signed_orders: unitHierarchy.signed_orders,
    unsigned_orders: unitHierarchy.unsigned_orders,
  };
}

export async function listOrders({ hhahId = null } = {}) {
  const sql = getSql();
  const rows = await sql`
    SELECT
      o.*,
      COALESCE(pu.name, p.name) AS patient_name,
      COALESCE(pu.mrn, p.mrn) AS patient_mrn,
      h.name AS agency_name,
      pg.name AS pg_name,
      pr.physician_name AS billing_provider_name,
      pr.npi_digits AS billing_provider_npi,
      pe.soe AS episode_soe,
      pe.eoe AS episode_eoe,
      d.file_name AS pdf_file_name,
      d.blob_url AS pdf_blob_url
    FROM orders o
    LEFT JOIN patients p ON p.id = o.patient_id
    LEFT JOIN patient_units pu ON pu.id = p.unit_id
    LEFT JOIN patient_episodes pe ON pe.id = o.episode_id
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
    WHERE (${hhahId}::uuid IS NULL OR o.agency_id = ${hhahId})
    ORDER BY o.updated_at DESC, o.order_date DESC NULLS LAST
    LIMIT 250
  `;

  const episodeIds = [...new Set(rows.map((row) => row.episode_id).filter(Boolean))];
  if (!episodeIds.length) return rows.map((row) => ({ ...row, episode_status: 'none' }));

  const episodeOrders = await sql`
    SELECT id, admission_id, episode_id, order_number, order_type, document_type, order_date, order_status
    FROM orders
    WHERE episode_id = ANY(${episodeIds})
  `;
  const admissionIds = [...new Set(episodeOrders.map((order) => order.admission_id).filter(Boolean))];
  const admissionOrders = admissionIds.length
    ? await sql`
        SELECT id, admission_id, episode_id, order_number, order_type, document_type, order_date, order_status
        FROM orders
        WHERE admission_id = ANY(${admissionIds})
      `
    : [];
  const ordersByEpisode = new Map();
  for (const order of episodeOrders) {
    const list = ordersByEpisode.get(order.episode_id) || [];
    list.push(order);
    ordersByEpisode.set(order.episode_id, list);
  }

  return rows.map((row) => ({
    ...row,
    episode_status: row.episode_id
      ? computeEpisodeStatus(
          ordersByEpisode.get(row.episode_id) || [],
          { ...row, soe: row.episode_soe, eoe: row.episode_eoe },
          admissionOrders.filter((order) => order.admission_id === row.admission_id),
        )
      : 'none',
  }));
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

export async function markOrderSentToPhysician(orderId, date = todayYmd()) {
  const sql = getSql();
  const rows = await sql`
    UPDATE orders
    SET order_status = order_status || ${await jsonParam({
      SentToPhysicianDate: date,
      SendToPhysician_Status: true,
    })}::jsonb,
        updated_at = now()
    WHERE id = ${orderId}
    RETURNING *
  `;
  return rows[0] || null;
}

export async function markOrderSignedByPhysician(orderId, date = todayYmd()) {
  const sql = getSql();
  const rows = await sql`
    UPDATE orders
    SET order_status = order_status || ${await jsonParam({
      SignedByPhyscianDate: date,
      SignedByPhysician_Status: true,
    })}::jsonb,
        updated_at = now()
    WHERE id = ${orderId}
    RETURNING *
  `;
  // Clear any Trigger-3 overdue reminder task now that this order is signed.
  await resolveOverdueSigningTasksForOrders([orderId], date);
  return rows[0] || null;
}

// When an order is signed (e.g. via PG Bulk Sign) AFTER Trigger 3 already raised an
// "Email Physician — Signature Overdue" manual task, that reminder is moot — the work
// is done. Auto-complete any still-active signing.emailPhysicianReminder task whose
// item points at one of the just-signed orders so it disappears from the worker bucket.
export async function resolveOverdueSigningTasksForOrders(orderIds = [], date = todayYmd()) {
  const ids = [...new Set((orderIds || []).filter(Boolean))].map(String);
  if (!ids.length) return { resolved: [] };
  const sql = getSql();
  const rows = await sql`
    UPDATE workflow_task_runs t
    SET status = 'completed',
        notes = 'Auto-resolved: physician signed the document after the reminder task was raised.',
        output = ${await jsonParam({ autoResolved: true, reason: 'order_signed_after_trigger', signedDate: date })}::jsonb,
        completed_at = now(),
        updated_at = now()
    FROM workflow_items i
    WHERE t.item_id = i.id
      AND t.task_key = 'signing.emailPhysicianReminder'
      AND t.status = 'active'
      AND (i.extraction_payload->>'orderId') = ANY(${ids})
    RETURNING t.id, t.item_id, t.run_id
  `;
  // Settle each affected item (mark completed when all its tasks are terminal) and
  // recompute its run status so a fully-resolved signing run rolls up to completed.
  const runIds = new Set();
  for (const row of rows) {
    const itemTasks = await sql`SELECT status FROM workflow_task_runs WHERE item_id = ${row.item_id}`;
    const live = itemTasks.filter((task) => task.status !== 'skipped');
    const allDone = live.length > 0 && live.every((task) => task.status === 'completed');
    await sql`
      UPDATE workflow_items SET status = ${allDone ? 'completed' : 'running'}, updated_at = now()
      WHERE id = ${row.item_id}
    `;
    runIds.add(row.run_id);
  }
  for (const runId of runIds) await updateRunStatus(runId);
  return { resolved: rows.map((row) => row.id) };
}

// R1 daily-reconcile helper (modeled on resolveOverdueSigningTasksForOrders):
// when an agency uploads while today's daily run is in flight and that agency's
// item is still blocked on the open "Ask agency to bulk upload" task, auto-complete
// that task so the item settles. The ask task is the "not uploaded" arm of the
// daily graph: a human task (task_key='human.performActions') gated on the
// agency_not_uploaded condition. We key on the CONDITION rather than a hardcoded
// step_id because the builder compiler assigns auto-generated node ids
// (e.g. 'nmrb1e11h3'), not stable literals like 't1' — the condition is the stable
// identifier of that branch. Matches the uploading agency by reference_payload.HHAH.id.
// Idempotent — the status='active' clause matches zero rows on a second same-day upload.
export async function resolveOpenAgencyAskTaskForRun(runId, agencyId) {
  if (!runId || !agencyId) return { resolved: [] };
  const sql = getSql();
  const rows = await sql`
    UPDATE workflow_task_runs t
    SET status = 'completed',
        notes = 'Agency uploaded — resolved automatically',
        output = ${await jsonParam({ autoResolved: true, reason: 'agency_uploaded_after_ask' })}::jsonb,
        completed_at = now(),
        updated_at = now()
    FROM workflow_items i
    WHERE t.item_id = i.id
      AND t.run_id = ${runId}
      AND t.task_key = 'human.performActions'
      AND t.condition = 'agency_not_uploaded'
      AND t.status = 'active'
      AND (i.reference_payload->'HHAH'->>'id') = ${String(agencyId)}
    RETURNING t.id, t.item_id, t.run_id
  `;
  // Settle each affected item (completed when all its non-skipped tasks are
  // completed, else running) and recompute run status — identical loop to
  // resolveOverdueSigningTasksForOrders.
  const runIds = new Set();
  for (const row of rows) {
    const itemTasks = await sql`SELECT status FROM workflow_task_runs WHERE item_id = ${row.item_id}`;
    const live = itemTasks.filter((task) => task.status !== 'skipped');
    const allDone = live.length > 0 && live.every((task) => task.status === 'completed');
    await sql`
      UPDATE workflow_items SET status = ${allDone ? 'completed' : 'running'}, updated_at = now()
      WHERE id = ${row.item_id}
    `;
    runIds.add(row.run_id);
  }
  for (const rid of runIds) await updateRunStatus(rid);
  return { resolved: rows.map((row) => row.id) };
}

export async function listPgUnsignedOrders(pgId = null) {
  const sql = getSql();
  return sql`
    SELECT
      o.*,
      COALESCE(pu.name, p.name) AS patient_name,
      COALESCE(pu.mrn, p.mrn) AS patient_mrn,
      h.name AS agency_name,
      pg.name AS pg_name,
      pr.physician_name AS billing_provider_name,
      pr.npi_digits AS billing_provider_npi,
      d.file_name AS pdf_file_name,
      d.blob_url AS pdf_blob_url
    FROM orders o
    LEFT JOIN patients p ON p.id = o.patient_id
    LEFT JOIN patient_units pu ON pu.id = p.unit_id
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
    WHERE (${pgId}::uuid IS NULL OR o.pg_id = ${pgId})
      AND (o.order_status->>'SendToPhysician_Status')::boolean IS TRUE
      AND COALESCE((o.order_status->>'SignedByPhysician_Status')::boolean, false) IS FALSE
    ORDER BY o.updated_at DESC, o.order_date DESC NULLS LAST
    LIMIT 250
  `;
}

export async function bulkSignOrders({ orderIds = [], pgId = null, date = todayYmd() }) {
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (!ids.length) return { updated: [], skipped: [] };
  const sql = getSql();
  const rows = await sql`
    UPDATE orders
    SET order_status = order_status || ${await jsonParam({
      SignedByPhyscianDate: date,
      SignedByPhysician_Status: true,
    })}::jsonb,
        updated_at = now()
    WHERE id = ANY(${ids})
      AND (${pgId}::uuid IS NULL OR pg_id = ${pgId})
      AND (order_status->>'SendToPhysician_Status')::boolean IS TRUE
      AND COALESCE((order_status->>'SignedByPhysician_Status')::boolean, false) IS FALSE
    RETURNING *
  `;
  const updatedIds = new Set(rows.map((row) => row.id));
  // Signing happened — clear any Trigger-3 overdue reminder tasks for these orders.
  await resolveOverdueSigningTasksForOrders([...updatedIds], date);
  return {
    updated: rows,
    skipped: ids.filter((id) => !updatedIds.has(id)),
  };
}

function parseDateOnly(value) {
  // value may be a Date (as the Neon driver returns soe/eoe) or a string. Using
  // String(dateObj).slice(0,10) yields "Mon Jan 05" → NaN, which silently dropped
  // every CPO month (so the CPO billing check never ran). Reuse dateOnly, which
  // normalizes both Date objects and strings to YYYY-MM-DD.
  const ymd = dateOnly(value);
  if (!ymd) return null;
  const parsed = new Date(`${ymd}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function monthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date, count) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
}

function cpoMonthDatesForEpisode(episode) {
  const start = parseDateOnly(episode.soe);
  const end = parseDateOnly(episode.eoe);
  if (!start || !end || end <= start) return [];
  const terminalMonth = monthStart(end);
  const exclusiveEnd = end.getUTCDate() === 1 ? terminalMonth : addMonths(terminalMonth, 1);
  const months = [];
  for (let cursor = monthStart(start); cursor < exclusiveEnd; cursor = addMonths(cursor, 1)) {
    months.push(cursor.toISOString().slice(0, 10));
  }
  return months;
}

// AC10: the TRUE billable flip site. A CPO month flips to 'billable' only when
// the episode is billable AND >=30 CPO minutes were captured. `monthReady` is an
// optional CPO-month-readiness co-requisite (businessRules.evaluateCpoMonthReadiness
// .dataComplete, surfaced on the rcm payload): when it is an explicit `false` the
// billable flip is suppressed even at >=30 minutes (incomplete demographics or no
// signed 485). `monthReady === null/undefined` means "readiness unknown" and leaves
// the existing minutes>=30 rule intact — so callers that don't thread a verdict
// (e.g. runBillingMonitorPass) behave byte-for-byte as before.
function cpoStatusForMonth(cpoMonth, episodeStatus, monthReady = null) {
  const hasMinutes = Number(cpoMonth.cpo_min || 0) >= 30;
  const episodeBillable = episodeStatus === 'billable';
  const readinessBlocks = monthReady === false;
  return {
    status: episodeBillable && hasMinutes && !readinessBlocks ? 'billable' : 'not_billable',
    reason: {
      episodeBillable,
      cpoMin: Number(cpoMonth.cpo_min || 0),
      cpoMinutesCaptured: hasMinutes,
      ...(monthReady === null ? {} : { cpoMonthReady: monthReady }),
    },
  };
}

export async function updateCpoMinutes({ cpoMonthId, cpoMin = 30, monthReady = null }) {
  const sql = getSql();
  const current = (await sql`
    SELECT cm.*, e.status AS episode_status
    FROM cpo_months cm
    JOIN patient_episodes e ON e.id = cm.episode_id
    WHERE cm.id = ${cpoMonthId}
    LIMIT 1
  `)[0];
  if (!current) throw new Error('CPO month not found');
  const next = cpoStatusForMonth({ ...current, cpo_min: cpoMin }, current.episode_status, monthReady);
  const rows = await sql`
    UPDATE cpo_months
    SET cpo_min = ${Number(cpoMin) || 0},
        status = ${next.status},
        reason = ${await jsonParam(next.reason)}::jsonb,
        updated_at = now()
    WHERE id = ${cpoMonthId}
    RETURNING *
  `;
  return rows[0];
}

export async function runBillingMonitorPass() {
  const sql = getSql();
  const episodes = await sql`
    SELECT e.*, a.patient_id, a.agency_id, h.name AS agency_name, h.contact_info AS agency_contact_info
    FROM patient_episodes e
    JOIN patient_admissions a ON a.id = e.admission_id
    LEFT JOIN home_health_agencies h ON h.id = a.agency_id
    ORDER BY e.updated_at DESC
    LIMIT 500
  `;
  const episodeIds = episodes.map((episode) => episode.id);
  const admissionIds = [...new Set(episodes.map((episode) => episode.admission_id).filter(Boolean))];
  const orders = episodeIds.length
    ? await sql`
        SELECT id, admission_id, episode_id, order_number, order_type, document_type, order_date, order_status, billing_provider_id
        FROM orders
        WHERE episode_id = ANY(${episodeIds}) OR admission_id = ANY(${admissionIds})
      `
    : [];

  const issues = { missingDocuments: [], physicianReminders: [], cpoMinutes: [] };
  const updatedEpisodes = [];
  const updatedCpoMonths = [];

  for (const episode of episodes) {
    const episodeOrders = orders.filter((order) => order.episode_id === episode.id);
    const admissionOrders = orders.filter((order) => order.admission_id === episode.admission_id);
    const assessment = computeEpisodeAssessment(episode, episodeOrders, admissionOrders);
    const hhah = {
      id: episode.agency_id,
      name: episode.agency_name,
      contact_info: episode.agency_contact_info || {},
    };
    const updatedEpisode = (await sql`
      UPDATE patient_episodes
      SET status = ${assessment.status},
          status_reason = ${await jsonParam(assessment.reason)}::jsonb,
          updated_at = now()
      WHERE id = ${episode.id}
      RETURNING *
    `)[0];
    updatedEpisodes.push(updatedEpisode);

    for (const cpoMonth of cpoMonthDatesForEpisode(episode)) {
      await sql`
        INSERT INTO cpo_months (episode_id, cpo_month)
        VALUES (${episode.id}, ${cpoMonth})
        ON CONFLICT (episode_id, cpo_month) DO NOTHING
      `;
    }

    const cpoRows = await sql`
      SELECT *
      FROM cpo_months
      WHERE episode_id = ${episode.id}
      ORDER BY cpo_month
    `;
    for (const cpoMonth of cpoRows) {
      const next = cpoStatusForMonth(cpoMonth, assessment.status);
      const updated = (await sql`
        UPDATE cpo_months
        SET status = ${next.status},
            reason = ${await jsonParam(next.reason)}::jsonb,
            updated_at = now()
        WHERE id = ${cpoMonth.id}
        RETURNING *
      `)[0];
      updatedCpoMonths.push(updated);
      if (assessment.billable && Number(updated.cpo_min || 0) < 30) {
        issues.cpoMinutes.push({ episode: updatedEpisode, cpoMonth: updated, hhah });
      }
    }

    if (!assessment.eligible) {
      const missing = [];
      if (!assessment.reason.has485) missing.push('485 cert/recert');
      if (!assessment.reason.hasF2f || !assessment.reason.f2fWithin180DaysOfEoe) missing.push('valid F2F');
      issues.missingDocuments.push({
        episode: updatedEpisode,
        missingDocuments: missing,
        hhah,
        reason: assessment.reason,
      });
    } else if (!assessment.billable && assessment.reason.unsignedOrderNumbers.length > 0) {
      issues.physicianReminders.push({
        episode: updatedEpisode,
        hhah,
        unsignedOrderNumbers: assessment.reason.unsignedOrderNumbers,
        orders: episodeOrders.filter((order) => !isOrderSigned(order)),
      });
    }
  }

  const patientIds = [...new Set(episodes.map((episode) => episode.patient_id).filter(Boolean))];
  const updatedPatients = [];
  for (const patientId of patientIds) {
    const latest = (await sql`
      SELECT e.*
      FROM patient_episodes e
      JOIN patient_admissions a ON a.id = e.admission_id
      WHERE a.patient_id = ${patientId}
      ORDER BY e.soe DESC NULLS LAST, e.created_at DESC
      LIMIT 1
    `)[0];
    if (!latest) continue;
    const row = (await sql`
      UPDATE patients
      SET latest_episode_status = ${latest.status || 'none'},
          latest_episode_status_reason = ${await jsonParam(latest.status_reason || {})}::jsonb,
          updated_at = now()
      WHERE id = ${patientId}
      RETURNING id, latest_episode_status, latest_episode_status_reason
    `)[0];
    updatedPatients.push(row);
  }

  return {
    updatedEpisodes,
    updatedPatients,
    updatedCpoMonths,
    issues,
  };
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
