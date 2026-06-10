// Lightweight localStorage-backed store for POC
//
// MVP model (per boss notes): keep it intentionally simple.
//  - A small, hardcoded set of TRIGGERS. Each trigger maps to one workflow.
//  - A workflow has a name + description and a list of STEPS.
//  - A step is exactly one of three types: 'task' | 'conditional' | 'loop'.
//  - Tasks have no execution mode (parallel by default); sequencing is via PreReq.
//  - No actions / owners at the workflow level. The orchestrator auto-assigns
//    people when a workflow is launched (no manual Dispatcher).
//  - A minimal, set-based object model: MSA, PG, HHS. Loops run over a set.

const KEYS = {
  workflows: 'wf_workflows',
  instances: 'wf_instances',
  users: 'wf_users',
  seeded: 'wf_seeded_v19',
  patientDb: 'wf_patient_db',   // persistent "database" of patients (existence check)
  orderDb: 'wf_order_db',       // persistent "database" of orders
};

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch {
    return [];
  }
}

function save(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// ── Object-model modules ───────────────────────────────
// Three real modules with schemas. `fields` drives the fill-in form and the
// validation (required fields). `sample` are a couple of seed records.
//
//  SA      — Statistical Area (has counties → zipcodes; SA is the map target)
//  PG      — Physician Group / Practice
//  Agency  — Home Health Agency / Hospice / Hospital org
export const MODULES = {
  SA: {
    id: 'SA', name: 'SA', label: 'Statistical Area',
    fields: [
      { key: 'sa', label: 'Statistical Area name', required: true },
      { key: 'sa_type', label: 'Type (metro | micro)', required: true },
    ],
    // counties/zipcodes are structured; kept on the record, not in the simple form
  },
  PG: {
    id: 'PG', name: 'PG', label: 'Physician Group',
    fields: [
      { key: 'name', label: 'Group / Practice name', required: true },
      { key: 'npi', label: 'NPI', required: true },
      { key: 'type', label: 'Organization type', required: true },
      { key: 'phone_number', label: 'Phone number', required: true },
      { key: 'email', label: 'Email', required: true },
      { key: 'address', label: 'Street address', required: true },
      { key: 'city', label: 'City', required: true },
      { key: 'state', label: 'State', required: true },
      { key: 'county', label: 'County', required: false },
      { key: 'zip', label: 'ZIP code', required: true },
    ],
  },
  Agency: {
    id: 'Agency', name: 'Agency', label: 'Home Health Agency',
    fields: [
      { key: 'name', label: 'Organization name', required: true },
      { key: 'npi', label: 'NPI', required: true },
      { key: 'type', label: 'Organization type', required: true },
      { key: 'type_of_service', label: 'Type of service', required: false },
      { key: 'phone_number', label: 'Phone number', required: true },
      { key: 'email', label: 'Email', required: true },
      { key: 'address', label: 'Street address', required: true },
      { key: 'city', label: 'City', required: true },
      { key: 'state', label: 'State', required: true },
      { key: 'county', label: 'County', required: false },
      { key: 'zip', label: 'ZIP code', required: true },
    ],
  },
};

// Seed SA records (the map targets). zipcodes here are matched against PG/Agency zip.
export const SA_RECORDS = [
  {
    sa: 'Austin-Round Rock, TX', sa_type: 'metro',
    counties: [
      { county_name: 'Travis', zipcodes: ['78701', '78702', '78703', '78704'] },
      { county_name: 'Williamson', zipcodes: ['78664', '78681'] },
    ],
  },
  {
    sa: 'Boise City, ID', sa_type: 'metro',
    counties: [
      { county_name: 'Ada', zipcodes: ['83702', '83704', '83709'] },
      { county_name: 'Canyon', zipcodes: ['83605', '83651'] },
    ],
  },
  {
    sa: 'Pinedale, WY', sa_type: 'micro',
    counties: [
      { county_name: 'Sublette', zipcodes: ['82941', '82935'] },
    ],
  },
];

// Loops / for-each can still operate over a module. `size` = sample count.
export function getObjectSets() {
  return Object.values(MODULES).map(m => ({ id: m.id, name: m.name, label: m.label, size: m.id === 'SA' ? SA_RECORDS.length : 0 }));
}

export function getModules() { return MODULES; }
export function getModule(id) { return MODULES[id] || null; }
export function getSARecords() { return SA_RECORDS; }

// Find the SA whose counties contain this zipcode. Returns { sa, county } or null.
export function mapZipToSA(zip) {
  const z = String(zip || '').trim();
  for (const sa of SA_RECORDS) {
    for (const c of sa.counties) {
      if (c.zipcodes.includes(z)) return { sa: sa.sa, sa_type: sa.sa_type, county: c.county_name };
    }
  }
  return null;
}

// Required-field validation for a module record. Returns { ok, missing: [..] }.
export function validateRecord(moduleId, data) {
  const mod = MODULES[moduleId];
  if (!mod) return { ok: false, missing: ['(unknown module)'] };
  const missing = mod.fields
    .filter(f => f.required && !String((data || {})[f.key] || '').trim())
    .map(f => f.label);
  return { ok: missing.length === 0, missing };
}

// ── Bulk-upload object model: Patient (nested) + Order ──────────────────────
// A patient owns one→many Admissions; each Admission owns one→many Episodes.
// An order references a patient by the natural key (patientName + dob + mrn)
// and carries its own orderno key. The flat upload columns are folded into this
// nested shape by `parseUploadRows` below.
export const PATIENT_FIELDS = [
  { key: 'patientName', label: 'Patient name', key_field: true },
  { key: 'dob', label: 'DOB', key_field: true },
  { key: 'mrn', label: 'MRN', key_field: true },
  { key: 'patient_sex', label: 'Sex' },
  { key: 'address', label: 'Address' },
  { key: 'PgName', label: 'Physician Group' },
  { key: 'Agencyname', label: 'Agency' },
];
export const ADMISSION_FIELDS = [
  { key: 'SOC', label: 'SOC (admission start)' },
  { key: 'EOC', label: 'EOC (admission end)' },
];
export const EPISODE_FIELDS = [
  { key: 'SOE', label: 'SOE (episode start)' },
  { key: 'EOE', label: 'EOE (episode end)' },
  { key: 'Diagnosis1', label: 'Diagnosis 1' },
  { key: 'Diagnosis2', label: 'Diagnosis 2' },
  { key: 'Diagnosis3', label: 'Diagnosis 3' },
  { key: 'Diagnosis4', label: 'Diagnosis 4' },
  { key: 'Diagnosis5', label: 'Diagnosis 5' },
  { key: 'Diagnosis6', label: 'Diagnosis 6' },
];
export const ORDER_FIELDS = [
  { key: 'orderno', label: 'Order no', key_field: true },
  { key: 'orderdate', label: 'Order date' },
  { key: 'patientName', label: 'Patient name' },
  { key: 'dob', label: 'DOB' },
  { key: 'mrn', label: 'MRN' },
  { key: 'documentType', label: 'Document type' },
  { key: 'SOC', label: 'SOC' },
  { key: 'EOC', label: 'EOC' },
  { key: 'SOE', label: 'SOE' },
  { key: 'EOE', label: 'EOE' },
  { key: 'SignedDate', label: 'Signed date' },
  { key: 'NPI', label: 'NPI' },
];

// Natural key for a patient (the existence-check key).
export function patientKey(p) {
  return [p.patientName, p.dob, p.mrn].map(x => String(x || '').trim().toLowerCase()).join('|');
}

// ── Data-access layer (the ONLY place that touches the "database") ──────────
// Today this is localStorage; swap these five functions for Vercel Postgres / KV
// calls later without touching the workflow engine or UI.
function loadObj(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}
function saveObj(key, obj) { localStorage.setItem(key, JSON.stringify(obj)); }

export function patientExists(patient) {
  const db = loadObj(KEYS.patientDb);
  return !!db[patientKey(patient)];
}
export function getPatientRecord(patient) {
  const db = loadObj(KEYS.patientDb);
  return db[patientKey(patient)] || null;
}
export function orderExists(orderno) {
  const db = loadObj(KEYS.orderDb);
  return !!db[String(orderno || '').trim()];
}
// Insert or update a patient (merging admissions/episodes). Returns the stored record.
export function upsertPatient(patient) {
  const db = loadObj(KEYS.patientDb);
  const k = patientKey(patient);
  const existing = db[k];
  if (existing) {
    db[k] = { ...existing, ...patient, admissions: [...(existing.admissions || []), ...(patient.admissions || [])] };
  } else {
    db[k] = { ...patient };
  }
  saveObj(KEYS.patientDb, db);
  return db[k];
}
export function upsertOrder(order) {
  const db = loadObj(KEYS.orderDb);
  db[String(order.orderno || '').trim()] = { ...order };
  saveObj(KEYS.orderDb, db);
  return db[String(order.orderno || '').trim()];
}

// Fold flat upload rows (one row = patient demo + admission + episode + order)
// into the nested patient shape, grouping rows that share a patient key. Returns
// [{ patient: {...nested}, order: {...} }] — one entry per row (per order).
export function parseUploadRows(rows) {
  const byPatient = {};
  const result = [];
  for (const r of rows) {
    const pkey = patientKey(r);
    const episode = {};
    EPISODE_FIELDS.forEach(f => { if (r[f.key] != null) episode[f.key] = r[f.key]; });
    const admission = { SOC: r.SOC, EOC: r.EOC, episodes: [episode] };

    let patient = byPatient[pkey];
    if (!patient) {
      patient = {};
      PATIENT_FIELDS.forEach(f => { patient[f.key] = r[f.key]; });
      patient.admissions = [admission];
      byPatient[pkey] = patient;
    } else {
      patient.admissions.push(admission);
    }

    const order = {};
    ORDER_FIELDS.forEach(f => { order[f.key] = r[f.key]; });
    result.push({ patient, order, patientKey: pkey });
  }
  return result;
}

// A sample upload batch (stands in for a parsed CSV/XLSX). Mix of patients that
// already exist in the seeded DB (→ update path) and new ones (→ create path),
// and orders likewise.
export const SAMPLE_UPLOAD_ROWS = [
  {
    patientName: 'John Carter', dob: '1958-03-12', mrn: 'MRN1001', patient_sex: 'M',
    address: '101 Lavaca St, Austin, TX 78701', PgName: 'Lakeside Family Practice', Agencyname: 'Boise Home Health',
    SOC: '2026-01-05', EOC: '2026-03-05', SOE: '2026-01-05', EOE: '2026-02-04',
    Diagnosis1: 'I50.9', Diagnosis2: 'E11.9', Diagnosis3: '', Diagnosis4: '', Diagnosis5: '', Diagnosis6: '',
    orderno: 'ORD5001', orderdate: '2026-01-06', documentType: 'Plan of Care',
    SignedDate: '2026-01-08', NPI: '1234567890',
  },
  {
    patientName: 'Maria Gomez', dob: '1971-07-22', mrn: 'MRN1002', patient_sex: 'F',
    address: '500 Capitol Blvd, Boise, ID 83702', PgName: 'Capitol Internal Medicine', Agencyname: 'Treasure Valley Hospice',
    SOC: '2026-02-01', EOC: '2026-04-01', SOE: '2026-02-01', EOE: '2026-03-03',
    Diagnosis1: 'J44.9', Diagnosis2: '', Diagnosis3: '', Diagnosis4: '', Diagnosis5: '', Diagnosis6: '',
    orderno: 'ORD5002', orderdate: '2026-02-02', documentType: 'Recertification',
    SignedDate: '2026-02-05', NPI: '9876543210',
  },
  {
    // Same patient as row 1 (John Carter) → a second admission for the same patient.
    patientName: 'John Carter', dob: '1958-03-12', mrn: 'MRN1001', patient_sex: 'M',
    address: '101 Lavaca St, Austin, TX 78701', PgName: 'Lakeside Family Practice', Agencyname: 'Boise Home Health',
    SOC: '2026-04-10', EOC: '2026-06-10', SOE: '2026-04-10', EOE: '2026-05-10',
    Diagnosis1: 'I10', Diagnosis2: '', Diagnosis3: '', Diagnosis4: '', Diagnosis5: '', Diagnosis6: '',
    orderno: 'ORD5003', orderdate: '2026-04-11', documentType: 'Plan of Care',
    SignedDate: '2026-04-13', NPI: '1234567890',
  },
  {
    patientName: 'David Lee', dob: '1965-11-30', mrn: 'MRN1003', patient_sex: 'M',
    address: '742 Evergreen Terrace, Round Rock, TX 78664', PgName: 'Round Rock Cardiology', Agencyname: 'Lone Star Home Care',
    SOC: '2026-03-15', EOC: '2026-05-15', SOE: '2026-03-15', EOE: '2026-04-14',
    Diagnosis1: 'N18.3', Diagnosis2: 'I12.9', Diagnosis3: '', Diagnosis4: '', Diagnosis5: '', Diagnosis6: '',
    orderno: 'ORD5004', orderdate: '2026-03-16', documentType: 'Plan of Care',
    SignedDate: '2026-03-18', NPI: '5551234567',
  },
];

// ── Predefined triggers ────────────────────────────────
// A small, hardcoded set of triggers for the MVP. Each trigger corresponds to
// a workflow (workflowId). Triggers whose workflowId has no matching workflow
// are the "unmapped" ones the user is meant to set up first.
export const TRIGGERS = [
  { id: 'trigger-1', name: 'Trigger 1', label: 'Call Doctor',        description: 'A patient requests a doctor call-back.',          workflowId: 'wf1' },
  { id: 'trigger-2', name: 'Trigger 2', label: 'New Patient Intake', description: 'A new patient is registered in the system.',       workflowId: 'wf2' },
  { id: 'trigger-3', name: 'Trigger 3', label: 'Claim Submitted',    description: 'An insurance claim is filed for review.',          workflowId: 'wf3' },
  { id: 'trigger-4', name: 'Trigger 4', label: 'Episode Review',     description: 'A care episode is flagged for batch review.',      workflowId: 'wf4' },
  { id: 'trigger-5', name: 'Trigger 5', label: 'Expense Submitted',  description: 'An expense report is submitted for approval.',     workflowId: 'wf5' },
  { id: 'trigger-6', name: 'Trigger 6', label: 'Provider Onboarding', description: 'A new Physician Group + Agency need onboarding & SA mapping.', workflowId: 'wf6' },
  { id: 'trigger-7', name: 'Trigger 7', label: 'Bulk Upload Patient & Order', description: 'A CSV / XLSX of patients & orders is uploaded for ingestion.', workflowId: 'wf7' },
];

export function getTriggers() {
  seedIfNeeded();
  return TRIGGERS;
}

// Triggers that do not yet have a workflow — the primary ones to set up.
export function getUnmappedTriggers() {
  const wfs = getWorkflows();
  return TRIGGERS.filter(t => !t.workflowId || !wfs.find(w => w.id === t.workflowId));
}

// ── Seed Data ──────────────────────────────────────────
// Step schema:
//   { id, type: 'task'|'conditional'|'loop', name, description,
//     PreReq: 'none' | ['stepId', ...],
//     // conditional only:
//     condition: 'if/else'|'switch', conditionExpr, branches: ['label → dest']
//     // loop only:
//     loopSet: 'MSA'|'PG'|'HHS', loopExpr,
//     Tasksteps: ['sub-step label', ...]   // display only
//   }
function seedIfNeeded() {
  if (localStorage.getItem(KEYS.seeded)) return;

  const users = [
    { id: 'u1', name: 'Alice' },
    { id: 'u2', name: 'Bob' },
    { id: 'u3', name: 'Carol' },
  ];

  const workflows = [
    {
      id: 'wf1',
      name: 'Call Doctor',
      description: 'Route a patient call-back request to the right doctor and confirm the call.',
      triggerId: 'trigger-1',
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      steps: [
        {
          id: 'wf1-s1', type: 'task', name: 'Log Call Request',
          description: 'Front desk records the patient request and reason for the call.',
          PreReq: 'none',
          Tasksteps: ['Capture Patient Details', 'Record Reason for Call'],
        },
        {
          id: 'wf1-s2', type: 'conditional', name: 'Urgency Check',
          description: 'Decide routing based on how urgent the request is.',
          PreReq: ['wf1-s1'],
          condition: 'if/else', conditionExpr: 'urgency === "high"',
          // false → left, true → right (each points to a real task below)
          branches: ['false → Scheduled Doctor', 'true → On-call Doctor'],
          Tasksteps: [],
        },
        {
          id: 'wf1-s3', type: 'task', name: 'Scheduled Doctor',
          description: 'Non-urgent: route to the scheduled doctor (Carol).',
          PreReq: ['wf1-s2'],
          Tasksteps: ['Find Next Available Slot', 'Notify Scheduled Doctor'],
        },
        {
          id: 'wf1-s4', type: 'task', name: 'On-call Doctor',
          description: 'Urgent: page the on-call doctor (Bob) immediately.',
          PreReq: ['wf1-s2'],
          Tasksteps: ['Page On-call Doctor', 'Confirm Availability'],
        },
        {
          id: 'wf1-s5', type: 'task', name: 'Doctor Call-back',
          description: 'The assigned doctor calls the patient back.',
          PreReq: ['wf1-s3', 'wf1-s4'],
          Tasksteps: ['Review Patient History', 'Call Patient', 'Log Outcome'],
        },
      ],
    },

    {
      id: 'wf2',
      name: 'New Patient Intake',
      description: 'Register a new patient, verify insurance, and create their record.',
      triggerId: 'trigger-2',
      createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      steps: [
        {
          id: 'wf2-s1', type: 'task', name: 'Collect Intake Form',
          description: 'Gather the patient demographics and history.',
          PreReq: 'none',
          Tasksteps: ['Collect Demographics', 'Collect Medical History'],
        },
        {
          id: 'wf2-s2', type: 'conditional', name: 'Insurance Check',
          description: 'Route based on whether insurance is on file.',
          PreReq: ['wf2-s1'],
          condition: 'if/else', conditionExpr: 'hasInsurance === true',
          trueTarget: 'wf2-s3', falseTarget: 'wf2-s4',
          branches: ['true → Verify Coverage', 'false → Self-pay Setup'],
          Tasksteps: [],
        },
        {
          id: 'wf2-s3', type: 'task', name: 'Verify Coverage',
          description: 'Has insurance: Carol verifies the coverage details.',
          PreReq: ['wf2-s2'],
          Tasksteps: ['Check Plan Eligibility', 'Record Coverage'],
        },
        {
          id: 'wf2-s4', type: 'task', name: 'Self-pay Setup',
          description: 'No insurance: Alice sets up a self-pay account.',
          PreReq: ['wf2-s2'],
          Tasksteps: ['Create Self-pay Account', 'Share Payment Options'],
        },
        {
          id: 'wf2-s5', type: 'task', name: 'Create Patient Record',
          description: 'Create the chart and notify the care team.',
          PreReq: ['wf2-s3', 'wf2-s4'],
          Tasksteps: ['Create Chart', 'Notify Care Team'],
        },
      ],
    },

    {
      id: 'wf3',
      name: 'Claim Review',
      description: 'Triage a submitted claim and route it by type to the right desk.',
      triggerId: 'trigger-3',
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      steps: [
        {
          id: 'wf3-s1', type: 'task', name: 'Validate Claim',
          description: 'Check the claim for completeness and required fields.',
          PreReq: 'none',
          Tasksteps: ['Check Required Fields', 'Assign Claim Type'],
        },
        {
          id: 'wf3-s2', type: 'conditional', name: 'Route by Claim Type',
          description: 'Switch on claim type to the matching desk.',
          PreReq: ['wf3-s1'],
          condition: 'switch', conditionExpr: 'claimType',
          branches: ['inpatient → Inpatient Desk (Bob)', 'outpatient → Outpatient Desk (Carol)', 'pharmacy → Pharmacy Desk (Alice)'],
          Tasksteps: ['Determine Desk'],
        },
        {
          id: 'wf3-s3', type: 'task', name: 'Adjudicate Claim',
          description: 'The assigned desk reviews and decides the claim.',
          PreReq: ['wf3-s2'],
          Tasksteps: ['Review Documentation', 'Approve or Deny'],
        },
        {
          id: 'wf3-s4', type: 'task', name: 'Notify & Close',
          description: 'Notify the provider of the decision and close the claim.',
          PreReq: ['wf3-s3'],
          Tasksteps: ['Send Decision Letter', 'Close Claim'],
        },
      ],
    },

    {
      id: 'wf4',
      name: 'Episode Review (for-each)',
      description: 'Review every care episode in a Home Health Services batch, one by one.',
      triggerId: 'trigger-4',
      createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      steps: [
        {
          id: 'wf4-s1', type: 'task', name: 'Load Episode Batch',
          description: 'Pull the set of episodes due for review this cycle.',
          PreReq: 'none',
          Tasksteps: ['Pull Open Episodes', 'Prioritise Queue'],
        },
        {
          id: 'wf4-s2', type: 'loop', name: 'Review Each Episode',
          description: 'For each episode in the HHS set, review and sign off.',
          PreReq: ['wf4-s1'],
          loopSet: 'HHS', loopExpr: 'for each episode in HHS',
          Tasksteps: ['Open Episode', 'Verify Documentation', 'Sign Off Episode'],
        },
        {
          id: 'wf4-s3', type: 'task', name: 'Close Batch',
          description: 'Summarise the reviewed batch and archive it.',
          PreReq: ['wf4-s2'],
          Tasksteps: ['Compile Summary', 'Archive Batch'],
        },
      ],
    },

    {
      id: 'wf5',
      name: 'Expense Approval (Conditionals Demo)',
      description: 'Demonstrates all step types: if/else on amount, switch on category, loop over receipts.',
      triggerId: 'trigger-5',
      createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      steps: [
        {
          id: 'wf5-s1', type: 'task', name: 'Submit & Validate Expense',
          description: 'Employee submits the report and finance validates required fields.',
          PreReq: 'none',
          Tasksteps: ['Submit Expense Report', 'Validate Required Fields'],
        },
        {
          id: 'wf5-s2', type: 'conditional', name: 'Amount Check',
          description: 'If amount > $1,000 → Manager Approval (Bob), else → Finance Auto-approve (Carol).',
          PreReq: ['wf5-s1'],
          condition: 'if/else', conditionExpr: 'amount > 1000',
          branches: ['if true → Manager Approval (Bob)', 'else → Finance Auto-approve (Carol)'],
          Tasksteps: ['Evaluate Claimed Amount'],
        },
        {
          id: 'wf5-s3', type: 'conditional', name: 'Route by Category',
          description: 'Switch on category: "travel" → Carol, otherwise → Alice.',
          PreReq: ['wf5-s2'],
          condition: 'switch', conditionExpr: 'category',
          branches: ['category === "travel" → Travel Desk (Carol)', 'otherwise → General Desk (Alice)'],
          Tasksteps: ['Classify Expense Category', 'Forward to Matching Desk'],
        },
        {
          id: 'wf5-s4', type: 'loop', name: 'Verify Receipts',
          description: 'For each receipt in the PG set, match it and mark it verified.',
          PreReq: ['wf5-s3'],
          loopSet: 'PG', loopExpr: 'for each receipt until all verified',
          Tasksteps: ['Open Next Receipt', 'Match to Line Item', 'Mark Verified'],
        },
        {
          id: 'wf5-s5', type: 'task', name: 'Reimburse & Close',
          description: 'Finance issues reimbursement and closes the report.',
          PreReq: ['wf5-s4'],
          Tasksteps: ['Issue Reimbursement', 'Notify Employee'],
        },
      ],
    },

    {
      id: 'wf6',
      name: 'Provider Onboarding (PG + Agency → SA)',
      description: 'Two people fill in a Physician Group and a Home Health Agency in parallel, the records are validated, and on success they are mapped to a Statistical Area by ZIP code. Invalid records are sent back to the creators to fix.',
      triggerId: 'trigger-6',
      createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      steps: [
        {
          id: 'wf6-s1', type: 'task', taskKind: 'fill', module: 'PG',
          name: 'Create Physician Group',
          description: 'Fill in the Physician Group (PG) details: name, NPI, type, contact and address (incl. ZIP).',
          PreReq: 'none',
        },
        {
          id: 'wf6-s2', type: 'task', taskKind: 'fill', module: 'Agency',
          name: 'Create Home Health Agency',
          description: 'Fill in the Home Health Agency details: name, NPI, type, contact and address (incl. ZIP).',
          PreReq: 'none',
        },
        {
          id: 'wf6-s3', type: 'task', taskKind: 'validate',
          name: 'Validate Records',
          description: 'Check that both the PG and Agency records have all required fields filled correctly.',
          PreReq: ['wf6-s1', 'wf6-s2'],
        },
        {
          id: 'wf6-s4', type: 'conditional', name: 'Records Valid?',
          description: 'If both records pass validation, map them to a Statistical Area; otherwise send them back to be fixed.',
          PreReq: ['wf6-s3'],
          condition: 'if/else', conditionExpr: 'records valid',
          trueTarget: 'wf6-s5', falseTarget: 'wf6-s6',
          branches: ['true → Map to SA', 'false → Send Back to Fix'],
        },
        {
          id: 'wf6-s5', type: 'task', taskKind: 'map',
          name: 'Map to Statistical Area',
          description: 'Match each record’s ZIP code to a Statistical Area (SA) and link them.',
          PreReq: ['wf6-s4'],
        },
        {
          id: 'wf6-s6', type: 'task', taskKind: 'fix',
          name: 'Send Back to Fix',
          description: 'Validation failed — the creators correct the PG / Agency data, then it is re-validated.',
          PreReq: ['wf6-s4'],
          loopBackTo: 'wf6-s3',
        },
      ],
    },

    {
      // Bulk upload: a loop over every uploaded patient. The steps below are the
      // LOOP BODY (run once per patient). System steps (blue) auto-run; the human
      // step (pink) goes to a person to confirm. The live run expands the body
      // once per patient (see launchBulkUpload).
      id: 'wf7',
      name: 'Bulk Upload Patient & Order',
      description: 'Ingest an uploaded CSV/XLSX of patients & orders. For each patient (one at a time): check if the patient exists → create or update; check if the order exists → create or update; then a person reviews & confirms the assembled record.',
      triggerId: 'trigger-7',
      bulkUpload: true,
      createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      steps: [
        {
          id: 'wf7-s1', type: 'conditional', actor: 'system', name: 'Patient Exists?',
          description: 'Look the patient up by name + DOB + MRN.',
          PreReq: 'none',
          condition: 'if/else', conditionExpr: 'patient (name+dob+mrn) in DB',
          trueTarget: 'wf7-s2', falseTarget: 'wf7-s3',
          branches: ['true → Update Patient', 'false → Create Patient'],
        },
        {
          id: 'wf7-s2', type: 'task', actor: 'system', taskKind: 'update-patient',
          name: 'Update Patient', description: 'Patient found — append the new admission & episode.',
          PreReq: ['wf7-s1'],
        },
        {
          id: 'wf7-s3', type: 'task', actor: 'system', taskKind: 'create-patient',
          name: 'Create Patient', description: 'New patient — create with admission & episode.',
          PreReq: ['wf7-s1'],
        },
        {
          id: 'wf7-s4', type: 'conditional', actor: 'system', name: 'Order Exists?',
          description: 'Look the order up by order no.',
          PreReq: ['wf7-s2', 'wf7-s3'],
          condition: 'if/else', conditionExpr: 'orderno in DB',
          trueTarget: 'wf7-s5', falseTarget: 'wf7-s6',
          branches: ['true → Update Order', 'false → Create Order'],
        },
        {
          id: 'wf7-s5', type: 'task', actor: 'system', taskKind: 'update-order',
          name: 'Update Order', description: 'Order found — update it.',
          PreReq: ['wf7-s4'],
        },
        {
          id: 'wf7-s6', type: 'task', actor: 'system', taskKind: 'create-order',
          name: 'Create Order', description: 'New order — create and link to the patient.',
          PreReq: ['wf7-s4'],
        },
        {
          id: 'wf7-s7', type: 'task', actor: 'human', taskKind: 'review-record',
          name: 'Review & Confirm Record',
          description: 'A person reviews the assembled patient + admission + episode + order and confirms it.',
          PreReq: ['wf7-s5', 'wf7-s6'],
        },
      ],
    },
  ];

  // Seed the persistent "database" so the existence checks have both outcomes.
  // John Carter (MRN1001) and order ORD5002 already exist → update paths;
  // everyone/everything else is new → create paths.
  const patientDb = {
    [patientKey({ patientName: 'John Carter', dob: '1958-03-12', mrn: 'MRN1001' })]: {
      patientName: 'John Carter', dob: '1958-03-12', mrn: 'MRN1001', patient_sex: 'M',
      address: '101 Lavaca St, Austin, TX 78701', PgName: 'Lakeside Family Practice', Agencyname: 'Boise Home Health',
      admissions: [{ SOC: '2025-09-01', EOC: '2025-11-01', episodes: [{ SOE: '2025-09-01', EOE: '2025-10-01', Diagnosis1: 'I50.9' }] }],
    },
  };
  const orderDb = {
    'ORD5002': {
      orderno: 'ORD5002', orderdate: '2025-12-01', patientName: 'Maria Gomez', dob: '1971-07-22', mrn: 'MRN1002',
      documentType: 'Plan of Care', SignedDate: '2025-12-03', NPI: '9876543210',
    },
  };

  save(KEYS.users, users);
  save(KEYS.workflows, workflows);
  save(KEYS.instances, []);
  saveObj(KEYS.patientDb, patientDb);
  saveObj(KEYS.orderDb, orderDb);
  localStorage.setItem(KEYS.seeded, '1');
}

// ── Users ──────────────────────────────────────────────
export function getUsers() {
  seedIfNeeded();
  return load(KEYS.users);
}

// ── Workflows ──────────────────────────────────────────
export function getWorkflows() {
  seedIfNeeded();
  return load(KEYS.workflows);
}

export function getWorkflowForTrigger(triggerId) {
  const trig = TRIGGERS.find(t => t.id === triggerId);
  if (!trig || !trig.workflowId) return null;
  return getWorkflows().find(w => w.id === trig.workflowId) || null;
}

export function saveWorkflow(wf) {
  const list = load(KEYS.workflows);
  if (wf.id) {
    const idx = list.findIndex(w => w.id === wf.id);
    if (idx >= 0) { list[idx] = wf; } else { list.push(wf); }
  } else {
    wf = { ...wf, id: uid(), createdAt: new Date().toISOString() };
    list.push(wf);
  }
  save(KEYS.workflows, list);

  // Keep the trigger → workflow mapping in sync (in-memory; predefined list).
  if (wf.triggerId) {
    const trig = TRIGGERS.find(t => t.id === wf.triggerId);
    if (trig) trig.workflowId = wf.id;
  }
  return list;
}

export function deleteWorkflow(id) {
  save(KEYS.workflows, load(KEYS.workflows).filter(w => w.id !== id));
  TRIGGERS.forEach(t => { if (t.workflowId === id) t.workflowId = null; });
}

// ── Instances (launched workflows) ────────────────────
export function getInstances() { return load(KEYS.instances); }
export function getInstance(id) { return load(KEYS.instances).find(i => i.id === id) || null; }

// ── Execution helpers ──────────────────────────────────
//
// Execution is prerequisite + branch aware:
//   - A step becomes 'active' once ALL its prerequisites are completed
//     (skipped prereqs are treated as satisfied so flow can continue).
//   - A conditional randomly picks ONE branch target (if/else or switch case).
//     The chosen target activates; the NOT-chosen targets are 'skipped', and
//     any step that depended only on a skipped step cascades to 'skipped'.

function activateStep(si) {
  si.actionInstances.forEach(a => {
    if (a.status === 'blocked') a.status = 'active';
  });
  si.status = 'active';
}

// Round-robin auto-assignment across the team.
function autoAssign(users, counterRef) {
  if (!users.length) return null;
  const u = users[counterRef.n % users.length];
  counterRef.n += 1;
  return u.id;
}

export function launchWorkflow(workflowId) {
  const wf = load(KEYS.workflows).find(w => w.id === workflowId);
  if (!wf) return null;

  const users = load(KEYS.users);
  const counterRef = { n: 0 };
  const now = new Date();
  const steps = wf.steps || wf.tasks || [];

  // Build task instances. Branch decisions are DEFERRED to recompute (decided
  // when the conditional becomes ready) so they can use real form data and
  // support loop-back. A task is one atomic unit (one assignee, one complete).
  const taskInstances = steps.map(s => {
    const noPrereq = !Array.isArray(s.PreReq) || s.PreReq.length === 0;
    const startStatus = noPrereq ? 'active' : 'pending';

    const actionInstances = [{
      id: uid(),
      actionName: s.name,
      assignedTo: autoAssign(users, counterRef),
      status: noPrereq ? 'active' : 'blocked',
      completedAt: null,
      notes: '',
      order: 0,
    }];

    return {
      id: uid(),
      stepId: s.id,
      taskName: s.name,
      description: s.description || '',
      type: s.type || 'task',
      taskKind: s.taskKind || null,        // 'fill' | 'validate' | 'map' | 'fix'
      module: s.module || null,            // 'PG' | 'Agency' | 'SA'
      loopBackTo: s.loopBackTo || null,    // stepId to re-open on send-back
      formData: {},                        // filled-in record (fill tasks)
      validation: null,                    // { ok, missing } (validate task)
      mapping: null,                       // SA mapping result (map task)
      condition: s.condition || 'none',
      conditionExpr: s.conditionExpr || '',
      branches: s.branches || [],
      trueTarget: s.trueTarget || null,
      falseTarget: s.falseTarget || null,
      cases: s.cases || [],
      chosenTarget: null,
      loopSet: s.loopSet || null,
      loopExpr: s.loopExpr || '',
      PreReq: s.PreReq || 'none',
      assignedTo: actionInstances[0].assignedTo,
      status: startStatus,
      actionInstances,
    };
  });

  const instance = {
    id: uid(),
    workflowId,
    workflowName: wf.name,
    launchedAt: now.toISOString(),
    status: 'running',
    taskInstances,
  };

  recomputeInstance(instance);

  const list = load(KEYS.instances);
  list.push(instance);
  save(KEYS.instances, list);
  return instance;
}

// ── Bulk upload launch ──────────────────────────────────
// Parses the uploaded rows into patients, then builds ONE instance whose body
// (the wf7 loop body) is expanded once per patient, run strictly one after the
// other. System (blue) steps run automatically against the real DB — including
// the patient/order existence branches; only the human (pink) review step per
// patient is left for a person. `patientIndex` groups task instances per patient.
export function launchBulkUpload(rows) {
  const wf = load(KEYS.workflows).find(w => w.id === 'wf7');
  if (!wf) return null;
  const parsed = parseUploadRows(rows || []);
  // Collapse to unique patients (a patient may span multiple rows/orders).
  const patients = [];
  const seen = {};
  for (const entry of parsed) {
    if (!seen[entry.patientKey]) {
      seen[entry.patientKey] = { patient: entry.patient, orders: [] };
      patients.push(seen[entry.patientKey]);
    }
    seen[entry.patientKey].orders.push(entry.order);
  }

  const users = load(KEYS.users);
  const counterRef = { n: 0 };
  const now = new Date();
  const body = wf.steps;

  const taskInstances = [];
  let prevPatientReviewStepUid = null;

  patients.forEach((pp, pIdx) => {
    const { patient, orders } = pp;
    const order = orders[0];                 // primary order for this patient
    const exists = patientExists(patient);
    const ordExists = orderExists(order?.orderno);

    // unique per-patient step id so PreReq references stay within this patient
    const sid = stepBase => `p${pIdx}-${stepBase}`;
    const uidByStep = {};

    const makeTi = (s, extra = {}) => {
      const isHuman = s.actor === 'human';
      const ti = {
        id: uid(),
        stepId: sid(s.id),
        baseStepId: s.id,
        patientIndex: pIdx,
        patientName: patient.patientName,
        actor: s.actor || 'system',
        taskName: s.name,
        description: s.description || '',
        type: s.type || 'task',
        taskKind: s.taskKind || null,
        condition: s.condition || 'none',
        conditionExpr: s.conditionExpr || '',
        branches: s.branches || [],
        trueTarget: s.trueTarget ? sid(s.trueTarget) : null,
        falseTarget: s.falseTarget ? sid(s.falseTarget) : null,
        cases: [],
        chosenTarget: null,
        PreReq: Array.isArray(s.PreReq) ? s.PreReq.map(sid) : 'none',
        patientRecord: null,
        orderRecord: null,
        existsDecision: null,
        status: 'pending',
        assignedTo: null,
        actionInstances: [{ id: uid(), actionName: s.name, assignedTo: null, status: 'blocked', completedAt: null, notes: '', order: 0 }],
        ...extra,
      };
      // Humans get assigned; the human review also gates the next patient.
      if (isHuman) {
        const a = autoAssign(users, counterRef);
        ti.assignedTo = a;
        ti.actionInstances[0].assignedTo = a;
      }
      uidByStep[s.id] = ti;
      taskInstances.push(ti);
      return ti;
    };

    body.forEach(s => makeTi(s));

    // Sequence patients: this patient's first conditional waits on the previous
    // patient's human review (one patient at a time).
    const first = uidByStep['wf7-s1'];
    if (prevPatientReviewStepUid) {
      first.PreReq = [prevPatientReviewStepUid];
    } else {
      first.PreReq = 'none';
    }

    // ── Pre-resolve the system branches & auto-run system steps ──
    const condPatient = uidByStep['wf7-s1'];
    const updPatient = uidByStep['wf7-s2'];
    const crtPatient = uidByStep['wf7-s3'];
    const condOrder = uidByStep['wf7-s4'];
    const updOrder = uidByStep['wf7-s5'];
    const crtOrder = uidByStep['wf7-s6'];
    const review = uidByStep['wf7-s7'];

    condPatient.existsDecision = exists;
    condOrder.existsDecision = ordExists;

    // Persist to the DB (the system actually creates/updates).
    const storedPatient = upsertPatient(patient);
    const storedOrder = order ? upsertOrder(order) : null;

    const chosenPatient = exists ? updPatient : crtPatient;
    const skippedPatient = exists ? crtPatient : updPatient;
    const chosenOrder = ordExists ? updOrder : crtOrder;
    const skippedOrder = ordExists ? crtOrder : updOrder;

    chosenPatient.patientRecord = storedPatient;
    chosenOrder.orderRecord = storedOrder;
    review.patientRecord = storedPatient;
    review.orderRecord = storedOrder;
    review.allOrders = orders;

    review.PreReq = [chosenOrder.stepId];   // review only follows the taken order branch

    prevPatientReviewStepUid = review.stepId;
  });

  const instance = {
    id: uid(),
    workflowId: 'wf7',
    workflowName: wf.name,
    bulkUpload: true,
    patientCount: patients.length,
    launchedAt: now.toISOString(),
    status: 'running',
    taskInstances,
  };

  recomputeBulk(instance);

  const list = load(KEYS.instances);
  list.push(instance);
  save(KEYS.instances, list);
  return instance;
}

// Recompute for a bulk instance: system conditionals/tasks auto-resolve using
// their pre-computed existsDecision; human steps stop and wait for a person.
function recomputeBulk(inst) {
  const byStep = {};
  inst.taskInstances.forEach(t => { byStep[t.stepId] = t; });
  const isSatisfied = id => {
    const t = byStep[id];
    return t && (t.status === 'completed' || t.status === 'skipped');
  };
  const skip = stepId => {
    const t = byStep[stepId];
    if (!t || t.status === 'skipped' || t.status === 'completed') return;
    t.status = 'skipped';
    t.actionInstances.forEach(a => { if (a.status !== 'completed') a.status = 'skipped'; });
    inst.taskInstances.forEach(d => {
      if (Array.isArray(d.PreReq) && d.PreReq.includes(stepId)) {
        const allSkipped = d.PreReq.every(p => byStep[p] && byStep[p].status === 'skipped');
        if (allSkipped) skip(d.stepId);
      }
    });
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const ti of inst.taskInstances) {
      if (ti.status !== 'pending') continue;
      const prereqs = Array.isArray(ti.PreReq) ? ti.PreReq : [];
      if (!prereqs.every(isSatisfied)) continue;

      if (ti.type === 'conditional') {
        const chosen = ti.existsDecision ? ti.trueTarget : ti.falseTarget;
        const other = ti.existsDecision ? ti.falseTarget : ti.trueTarget;
        ti.chosenTarget = chosen;
        ti.status = 'completed';
        ti.actionInstances.forEach(a => { a.status = 'completed'; a.completedAt = new Date().toISOString(); });
        if (other) skip(other);
        changed = true;
      } else if (ti.actor === 'system') {
        // System task auto-completes immediately.
        ti.status = 'completed';
        ti.actionInstances.forEach(a => { a.status = 'completed'; a.completedAt = new Date().toISOString(); });
        changed = true;
      } else {
        // Human task: activate and wait.
        ti.status = 'active';
        ti.actionInstances.forEach(a => { if (a.status === 'blocked') a.status = 'active'; });
        changed = true;
      }
    }
  }

  const live = inst.taskInstances.filter(t => t.status !== 'skipped');
  if (live.length && live.every(t => t.status === 'completed')) inst.status = 'completed';
}

// Decide a conditional that has just become ready. Returns the chosen target
// stepId. Data-driven if/else (records valid) uses the validation result of the
// prereq validate task; otherwise random.
function decideBranch(inst, condTi) {
  if (condTi.condition === 'switch') {
    const targets = (condTi.cases || []).map(c => c.target).filter(Boolean);
    return targets.length ? targets[Math.floor(Math.random() * targets.length)] : null;
  }
  // if/else
  const prereqs = Array.isArray(condTi.PreReq) ? condTi.PreReq : [];
  const validatePrereq = inst.taskInstances.find(t =>
    prereqs.includes(t.stepId) && t.taskKind === 'validate'
  );
  if (validatePrereq && validatePrereq.validation) {
    return validatePrereq.validation.ok ? condTi.trueTarget : condTi.falseTarget;
  }
  // no data backing → random
  const opts = [condTi.trueTarget, condTi.falseTarget].filter(Boolean);
  return opts.length ? opts[Math.floor(Math.random() * opts.length)] : null;
}

// Mark a task-instance (and anything reachable only through it) as skipped.
function cascadeSkipInstance(inst, stepId) {
  const ti = inst.taskInstances.find(t => t.stepId === stepId);
  if (!ti || ti.status === 'skipped' || ti.status === 'completed') return;
  ti.status = 'skipped';
  ti.actionInstances.forEach(a => { if (a.status !== 'completed') a.status = 'skipped'; });
  for (const t of inst.taskInstances) {
    if (!Array.isArray(t.PreReq) || !t.PreReq.includes(stepId)) continue;
    const allSkipped = t.PreReq.every(p => {
      const pt = inst.taskInstances.find(x => x.stepId === p);
      return pt && pt.status === 'skipped';
    });
    if (allSkipped) cascadeSkipInstance(inst, t.stepId);
  }
}

// Unlock ready steps, decide conditionals as they become ready, roll up status.
function recomputeInstance(inst) {
  const isSatisfied = id => {
    const t = inst.taskInstances.find(x => x.stepId === id);
    return t && (t.status === 'completed' || t.status === 'skipped');
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const ti of inst.taskInstances) {
      if (ti.status !== 'pending') continue;
      const prereqs = Array.isArray(ti.PreReq) ? ti.PreReq : [];
      if (!prereqs.every(isSatisfied)) continue;

      if (ti.type === 'conditional') {
        // Decide now: activate chosen target, skip the others.
        const chosen = decideBranch(inst, ti);
        ti.chosenTarget = chosen;
        ti.status = 'completed';                 // the decision itself is instant
        ti.actionInstances.forEach(a => { a.status = 'completed'; });
        const allTargets = ti.condition === 'switch'
          ? (ti.cases || []).map(c => c.target).filter(Boolean)
          : [ti.trueTarget, ti.falseTarget].filter(Boolean);
        allTargets.filter(t => t && t !== chosen).forEach(t => cascadeSkipInstance(inst, t));
        changed = true;
      } else {
        activateStep(ti);
        changed = true;
      }
    }
  }

  const live = inst.taskInstances.filter(t => t.status !== 'skipped');
  if (live.length && live.every(t => t.status === 'completed')) inst.status = 'completed';
}

// completeActionInstance accepts an optional `validationOverrides` map:
//   { [taskInstanceId]: true | false }
// When provided for a validate task, the per-module verdict comes from the
// override rather than the auto-computed required-field check.
export function completeActionInstance(instanceId, taskInstanceId, actionInstanceId, notes, validationOverrides) {
  const list = load(KEYS.instances);
  const inst = list.find(i => i.id === instanceId);
  if (!inst) return;

  const ti = inst.taskInstances.find(t => t.id === taskInstanceId);
  if (!ti) return;
  const ai = ti.actionInstances.find(a => a.id === actionInstanceId);
  if (!ai) return;

  ai.status = 'completed';
  ai.completedAt = new Date().toISOString();
  ai.notes = notes;

  if (ti.actionInstances.filter(a => a.status !== 'skipped').every(a => a.status === 'completed')) {
    ti.status = 'completed';
  }

  // ── Validate task: per-module verdicts (user override > auto-check) ──
  if (ti.taskKind === 'validate') {
    const prereqs = Array.isArray(ti.PreReq) ? ti.PreReq : [];
    const fillTasks = inst.taskInstances.filter(t => prereqs.includes(t.stepId) && t.taskKind === 'fill');
    const results = fillTasks.map(ft => {
      // If the reviewer explicitly set a verdict for this fill task, use it.
      const override = validationOverrides && validationOverrides[ft.id];
      if (override !== undefined) {
        const auto = validateRecord(ft.module, ft.formData);
        return {
          module: ft.module,
          taskInstanceId: ft.id,
          name: ft.formData?.name || ft.taskName,
          ok: override === true,
          missing: override === true ? [] : auto.missing,
          overridden: true,
        };
      }
      return {
        module: ft.module,
        taskInstanceId: ft.id,
        name: ft.formData?.name || ft.taskName,
        ...validateRecord(ft.module, ft.formData),
      };
    });
    const ok = results.every(r => r.ok);
    ti.validation = { ok, results };
  }

  // ── Map task: resolve each fill record's ZIP to an SA ──
  if (ti.taskKind === 'map') {
    const fills = inst.taskInstances.filter(t => t.taskKind === 'fill');
    ti.mapping = fills.map(ft => ({
      module: ft.module,
      name: ft.formData?.name || ft.taskName,
      zip: ft.formData?.zip || '',
      sa: mapZipToSA(ft.formData?.zip),
    }));
  }

  // ── Fix / send-back: re-open the loop target (and its dependent gate) ──
  if (ti.taskKind === 'fix' && ti.loopBackTo) {
    reopenLoop(inst, ti);
  }

  // Bulk-upload instances have their own per-patient recompute (auto-running
  // system steps, unlocking the next patient after a human review).
  if (inst.bulkUpload) recomputeBulk(inst);
  else recomputeInstance(inst);
  save(KEYS.instances, list);
  return list;
}

// Save the filled-in record for a fill task (does not complete it).
export function setTaskFormData(instanceId, taskInstanceId, formData) {
  const list = load(KEYS.instances);
  const inst = list.find(i => i.id === instanceId);
  if (!inst) return;
  const ti = inst.taskInstances.find(t => t.id === taskInstanceId);
  if (!ti) return;
  ti.formData = { ...(ti.formData || {}), ...formData };
  save(KEYS.instances, list);
  return ti.formData;
}

// Re-open the validate task the fix loops back to, plus re-open ONLY the fill
// tasks whose module was marked invalid in the last validation result. If all
// were invalid (or no granular result exists) all fills are re-opened.
function reopenLoop(inst, fixTi) {
  const reset = ti => {
    ti.status = 'active';
    ti.validation = null;
    ti.mapping = null;
    ti.chosenTarget = null;
    ti.actionInstances.forEach(a => { a.status = 'active'; a.completedAt = null; });
  };
  const toPending = ti => {
    ti.status = 'pending';
    ti.validation = null;
    ti.mapping = null;
    ti.chosenTarget = null;
    ti.actionInstances.forEach(a => { a.status = 'blocked'; a.completedAt = null; });
  };

  const validate = inst.taskInstances.find(t => t.stepId === fixTi.loopBackTo);
  if (!validate) return;

  // Determine which fill task-instance IDs were invalid in the last round.
  const lastResults = validate.validation?.results || [];
  const invalidIds = new Set(
    lastResults.filter(r => !r.ok).map(r => r.taskInstanceId).filter(Boolean)
  );

  const fillIds = Array.isArray(validate.PreReq) ? validate.PreReq : [];
  inst.taskInstances.forEach(t => {
    if (!fillIds.includes(t.stepId) || t.taskKind !== 'fill') return;
    // Re-open only the invalid ones; if no granular info re-open all.
    if (invalidIds.size === 0 || invalidIds.has(t.id)) reset(t);
  });
  // Validate becomes pending again (waits for the re-opened fills to complete).
  toPending(validate);

  // Gate, map, and fix all reset so the gate can re-route next round.
  inst.taskInstances.forEach(t => {
    if (t.type === 'conditional' && Array.isArray(t.PreReq) && t.PreReq.includes(validate.stepId)) {
      toPending(t);
    }
    if (t.taskKind === 'map' || t.taskKind === 'fix') toPending(t);
  });
}

// ── Instance status header: unassigned → assigned → done ──
export function instanceStage(inst) {
  const live = inst.taskInstances.filter(t => t.status !== 'skipped');
  const allDone = live.every(t => t.status === 'completed');
  if (allDone) return 'done';
  const anyAssigned = live.some(t =>
    t.actionInstances.some(a => a.assignedTo && a.status !== 'skipped' && a.status !== 'completed')
  );
  return anyAssigned ? 'assigned' : 'unassigned';
}

export function getMyWorkItems(userId) {
  const instances = load(KEYS.instances).filter(i => i.status === 'running');
  const items = [];

  for (const inst of instances) {
    for (const ti of inst.taskInstances) {
      for (const ai of ti.actionInstances) {
        if (ai.assignedTo === userId && ai.status === 'active') {
          items.push({
            instanceId: inst.id,
            workflowName: inst.workflowName,
            launchedAt: inst.launchedAt,
            taskInstanceId: ti.id,
            taskName: ti.taskName,
            description: ti.description || '',
            type: ti.type || 'task',
            taskKind: ti.taskKind || null,
            module: ti.module || null,
            actor: ti.actor || null,
            formData: ti.formData || {},
            validation: ti.validation || null,
            mapping: ti.mapping || null,
            // bulk-upload review payload (nested patient + orders)
            patientRecord: ti.patientRecord || null,
            orderRecord: ti.orderRecord || null,
            allOrders: ti.allOrders || null,
            patientName: ti.patientName || null,
            actionInstanceId: ai.id,
            actionName: ai.actionName,
            status: ai.status,
          });
        }
      }
    }
  }

  return items;
}

export function getMyCompletedItems(userId) {
  const instances = load(KEYS.instances);
  const items = [];

  for (const inst of instances) {
    for (const ti of inst.taskInstances) {
      for (const ai of ti.actionInstances) {
        if (ai.assignedTo === userId && ai.status === 'completed') {
          items.push({
            instanceId: inst.id,
            workflowName: inst.workflowName,
            taskInstanceId: ti.id,
            taskName: ti.taskName,
            actionInstanceId: ai.id,
            actionName: ai.actionName,
            completedAt: ai.completedAt,
            notes: ai.notes,
          });
        }
      }
    }
  }

  return items.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
}
