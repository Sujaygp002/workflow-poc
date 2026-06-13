export const WF_AREA_ONBOARDING_DEFINITION = {
  id: 'wf-area-onboarding',
  name: 'Area Onboarding & Daily Upload Monitor',
  description:
    'Starts when an area/HHAH onboarding is successful. It keeps the area intake cycle active, waits for expected HHAH uploads, and triggers missing-upload notifications when an HHAH has not uploaded within the 24-hour window.',
  trigger: {
    id: 'trigger-daily-upload-timer',
    type: 'time_interval',
    intervalSeconds: 10,
    label: 'Time trigger · every 10s',
  },
  conditions: {
    upload_received_within_24h: 'expected HHAH uploaded Excel + PDF ZIP within 24 hours',
    upload_missing_after_24h: 'expected HHAH did not upload within 24 hours',
    notification_sent: 'missing-upload notification was sent/logged for the HHAH',
  },
  // The visible flowchart collapses the monitor steps (innerStepIds) into one
  // "HHAH Upload Monitor" mega-task box. After it, `outsideStepIds` render as their
  // own boxes — here area-s4 (Notification — Missing Upload), gated by a decision
  // diamond from its condition (upload_missing_after_24h).
  megaTask: {
    id: 'area-monitor',
    name: 'HHAH Upload Monitor',
    info: 'This task checks every onboarded HHAH for whether they have uploaded their documents. If an HHAH has not uploaded, the next task notifies them.',
    innerStepIds: ['area-s2', 'area-s3', 'area-s5', 'area-s6'],
    outsideStepIds: ['area-s4'],
  },
  steps: [
    {
      id: 'area-s2',
      actor: 'system',
      taskKey: 'area.monitorExpectedUploads',
      name: 'Monitor Expected HHAH Uploads',
      description: 'Track each expected HHAH in the selected micro/metro statistical area for the daily upload window.',
      preReq: [],
    },
    {
      id: 'area-s3',
      actor: 'system',
      taskKey: 'area.continueUploadWorkflow',
      name: 'Upload Trigger Continues Normally',
      description: 'When an HHAH uploads Excel + PDF ZIP, the existing wf7 upload workflow starts independently.',
      condition: 'upload_received_within_24h',
      preReq: ['area-s2'],
    },
    {
      id: 'area-s4',
      actor: 'human',
      taskKey: 'area.sendMissingUploadNotification',
      name: 'Notification Trigger — Missing Upload',
      description: 'An expected HHAH did not upload within 24 hours. A person sends the missing-upload email to the HHAH. The system separately posts a notification to the HHAH login page (Record Notification Status).',
      condition: 'upload_missing_after_24h',
      preReq: ['area-s2'],
    },
    {
      id: 'area-s5',
      actor: 'system',
      taskKey: 'area.recordNotificationStatus',
      name: 'Record Notification Status',
      description: 'System posts the missing-upload notification to the HHAH login page and logs the email notification state, while keeping the upload workflow independent for late uploads.',
      condition: 'notification_sent',
      preReq: ['area-s4'],
    },
    {
      id: 'area-s6',
      actor: 'system',
      taskKey: 'area.waitForHhahUpload',
      name: 'Wait for HHAH to Upload (24h limit)',
      description: 'Hold the monitor open for up to 24 hours waiting for each expected HHAH to upload Excel + PDF ZIP. When an HHAH uploads, Trigger 2 (HHAH Uploads Documents) fires independently and starts a new wf7 run for that upload.',
      preReq: ['area-s2', 'area-s3', 'area-s5'],
    },
  ],
};

export const WF7_DEFINITION = {
  id: 'wf7',
  name: 'update patients objects',
  description:
    'Ingest an uploaded Excel workbook and related order PDFs. For each patient-order row, parse Excel, use AI extraction when fields are missing, validate upload context, then create/update patient, admission object, episode object, and order records. A human reviews and confirms each assembled record.',
  trigger: {
    id: 'upload-patient-order-documents',
    type: 'file_upload',
    inputs: {
      workbook: { accepted: ['.xlsx'] },
      pdfs: { accepted: ['.pdf'], required: false },
    },
  },
  loop: {
    over: 'patient_order_row',
    until: 'last patient & last order',
  },
  // The visible flowchart collapses the steps into these two mega-task boxes.
  // Each box has a View button that expands its inner sub-task flowchart.
  megaGroups: [
    {
      id: 'wf7-g1',
      name: 'Update Patient Object',
      info: 'Parses the Excel workbook, extracts any missing fields from order PDFs (AI + human), confirms HHAH upload context, then checks/creates/updates the Patient Unit and Patient Record.',
      stepIds: ['wf7-s1', 'wf7-s2', 'wf7-s3', 'wf7-s4', 'wf7-s5', 'wf7-s12', 'wf7-s10', 'wf7-s14', 'wf7-s11', 'wf7-s30', 'wf7-s13', 'wf7-s15', 'wf7-s16'],
    },
    {
      id: 'wf7-g2',
      name: 'Update Admission, Episode, Order',
      info: 'Checks/creates the Admission (by SOC), the Episode (by SOE/EOE), and the Order (by order number, skipping duplicates), then a human reviews the assembled Patient → Admission → Episode → Orders.',
      stepIds: ['wf7-s24', 'wf7-s25', 'wf7-s31', 'wf7-s26', 'wf7-s27', 'wf7-s32', 'wf7-s17', 'wf7-s28', 'wf7-s29', 'wf7-s18', 'wf7-s19', 'wf7-s20', 'wf7-s21'],
    },
  ],
  conditions: {
    excel_row_complete: 'required Excel fields exist for patient, admission object, episode object, order, and HHAH upload context',
    excel_row_incomplete: 'one or more required Excel fields are missing',
    ai_extraction_success: 'Gemini extracted missing values from order PDF',
    ai_extraction_fail: 'Gemini could not extract enough usable values',
    human_data_validated: 'human reviewed and confirmed extracted or manually filled data',
    upload_context_ready: 'HHAH upload context is present, so patient/order processing can continue',
    unit_exists: 'patient unit found by name + dob + mrn (same person already in system)',
    unit_not_exists: 'patient unit not found, so a new unit will be created',
    patient_exists: 'patient already exists (unit found by name + dob + mrn)',
    patient_not_exists: 'patient not found, so a new patient unit and record are created',
    record_context_changed: 'con1: HHAH / PG / practitioner changed, so a new patient record is created under the same unit',
    unit_only_changed: 'con2: only patient unit fields changed, so the existing unit/record is updated',
    patient_write_success: 'create/update patient record, admission object, and episode object committed',
    patient_write_fail: 'create/update patient record, admission object, and episode object failed',
    patient_retry_success: 'patient write succeeded on retry',
    patient_retry_fail: 'patient write still failing after retry',
    admission_dates_ready: 'SOC exists, so the admission object can be matched or created',
    admission_dates_missing: 'SOC is missing, so a human must add admission object dates',
    admission_ready: 'admission object is available after the patient write (by Start of Care)',
    admission_exists: 'admission object already existed and the order was attached to it',
    admission_created: 'a new admission object was created for the patient',
    episode_dates_ready: 'SOE and EOE exist, so the episode object can be matched or created',
    episode_dates_missing: 'SOE or EOE is missing, so a human must add episode object dates',
    episode_ready: 'episode object is available after the patient write (by SOE/EOE)',
    episode_exists: 'episode object already existed and the order was attached to it',
    episode_created: 'a new episode object was created in the admission object',
    order_exists: 'order already exists by order number, so this duplicate is skipped',
    order_not_exists: 'order not found by order number, so a new order is created',
    order_fields_ready: 'required order fields and the matched PDF are present',
    order_fields_missing: 'required order fields or the matched PDF are missing',
    order_write_success: 'create order committed',
    order_write_fail: 'create order failed',
    order_retry_success: 'order write succeeded on retry',
    order_retry_fail: 'order write still failing after retry',
  },
  steps: [
    {
      id: 'wf7-s1',
      actor: 'system',
      taskKey: 'excel.parseWorkbook',
      name: 'Parse Excel Workbook',
      description: 'Read Sheet1 patient/admission object/episode object data and Sheet2 order data, then join rows by patientName + dob + mrn.',
      preReq: [],
    },
    {
      id: 'wf7-s2',
      actor: 'system',
      taskKey: 'row.checkCompleteness',
      name: 'Check Required Fields',
      description: 'Check whether required fields exist in the Excel row before DB checks begin.',
      preReq: ['wf7-s1'],
    },
    {
      id: 'wf7-s3',
      actor: 'ai',
      taskKey: 'ai.extractMissingDataFromPdf',
      name: 'Extract Missing Data From PDF',
      description: 'Use Gemini to extract missing patient/order/reference fields from the uploaded order PDFs.',
      condition: 'excel_row_incomplete',
      preReq: ['wf7-s2'],
    },
    {
      id: 'wf7-s4',
      actor: 'human',
      taskKey: 'human.validateExtractedData',
      name: 'Validate Extracted Data',
      description: 'Human validates or edits AI-extracted data before DB writes continue.',
      condition: 'ai_extraction_success',
      preReq: ['wf7-s3'],
    },
    {
      id: 'wf7-s5',
      actor: 'human',
      taskKey: 'human.fillMissingData',
      name: 'Manually Fill Missing Data',
      description: 'AI extraction failed or was incomplete, so a human fills the missing values.',
      condition: 'ai_extraction_fail',
      preReq: ['wf7-s3'],
    },
    {
      id: 'wf7-s12',
      actor: 'system',
      taskKey: 'refs.confirmUploadContext',
      name: 'Confirm HHAH Upload Context',
      description: 'Confirm the workflow has the HHAH/upload context needed before patient and order writes continue.',
      condition: 'upload_context_ready',
      preReq: ['wf7-s2', 'wf7-s4', 'wf7-s5'],
    },

    // ─────────────────────────────────────────────────────────────
    // PHASE 1 — PATIENT (Unit + Record together), per complex.drawio
    //   check patient exists?
    //     NO  -> create new Patient Unit + Patient Record
    //     YES -> what changed?  con1 (HHAH/PG/practitioner) -> new Record
    //                           con2 (unit fields)          -> update Unit
    // ─────────────────────────────────────────────────────────────
    {
      id: 'wf7-s10',
      actor: 'system',
      taskKey: 'patient.resolve',
      name: 'Check If Patient Exists',
      description: 'Look up the Patient Unit by name + DOB + MRN and the Patient Record by Unit + HHAH + PG. Decides create-new vs reuse/update.',
      preReq: ['wf7-s12'],
    },
    {
      id: 'wf7-s14',
      actor: 'system',
      taskKey: 'patient.create',
      name: 'Create Patient Unit + Record',
      description: 'Patient not found. Create the stable Patient Unit (name+DOB+MRN) and a Patient Record for this HHAH + PG context.',
      condition: 'patient_not_exists',
      preReq: ['wf7-s10'],
    },
    {
      id: 'wf7-s11',
      actor: 'system',
      taskKey: 'record.checkChanges',
      name: 'Check What Changed',
      description: 'Patient exists. Decide what to update: con1 — HHAH / PG / practitioner changed (a new Patient Record is created); con2 — only Patient Unit fields changed (the unit is updated).',
      condition: 'patient_exists',
      preReq: ['wf7-s10'],
    },
    {
      id: 'wf7-s30',
      actor: 'system',
      taskKey: 'record.create',
      name: 'Create New Patient Record',
      description: 'con1: HHAH, PG or practitioner changed for this person, so a new Patient Record is created under the same Patient Unit.',
      condition: 'record_context_changed',
      preReq: ['wf7-s11'],
    },
    {
      id: 'wf7-s13',
      actor: 'system',
      taskKey: 'patient.update',
      name: 'Update Patient Unit',
      description: 'con2: only Patient Unit fields changed, so the existing Patient Unit/Record is updated (no new record).',
      condition: 'unit_only_changed',
      preReq: ['wf7-s11'],
    },
    {
      id: 'wf7-s15',
      actor: 'system',
      taskKey: 'patient.retryWrite',
      name: 'Retry Patient Write',
      description: 'Patient unit/record write failed. Retry once automatically.',
      condition: 'patient_write_fail',
      preReq: ['wf7-s13', 'wf7-s14', 'wf7-s30'],
    },
    {
      id: 'wf7-s16',
      actor: 'human',
      taskKey: 'human.fixPatientWrite',
      name: 'Fix Patient Write',
      description: 'Patient write still failed after retry. Human fixes the patient unit/record.',
      condition: 'patient_retry_fail',
      preReq: ['wf7-s15'],
    },

    // ─────────────────────────────────────────────────────────────
    // PHASE 2 — ADMISSION (by Start of Care)
    //   check SOC present -> (human fill if missing)
    //   check admission with that SOC exists -> reuse, else create
    // ─────────────────────────────────────────────────────────────
    {
      id: 'wf7-s24',
      actor: 'system',
      taskKey: 'dates.checkAdmission',
      name: 'Check Admission Dates (SOC)',
      description: 'Confirm Start of Care exists before matching or creating the admission object.',
      preReq: ['wf7-s13', 'wf7-s14', 'wf7-s30', 'wf7-s15', 'wf7-s16'],
    },
    {
      id: 'wf7-s25',
      actor: 'human',
      taskKey: 'human.fillAdmissionDates',
      name: 'Manually Add Admission Dates',
      description: 'SOC is missing. Human adds admission dates before the admission object is matched or created.',
      condition: 'admission_dates_missing',
      preReq: ['wf7-s24'],
    },
    {
      id: 'wf7-s31',
      actor: 'system',
      taskKey: 'admission.resolve',
      name: 'Check / Create Admission',
      description: 'Check if an admission with that SOC already exists for the patient. If yes, reuse it; if no, create a new admission.',
      preReq: ['wf7-s24', 'wf7-s25'],
    },

    // ─────────────────────────────────────────────────────────────
    // PHASE 3 — EPISODE (by SOE / EOE, inside the admission)
    //   check SOE/EOE present -> (human fill if missing)
    //   check episode with SOE/EOE exists -> update, else create new
    // ─────────────────────────────────────────────────────────────
    {
      id: 'wf7-s26',
      actor: 'system',
      taskKey: 'dates.checkEpisode',
      name: 'Check Episode Dates (SOE/EOE)',
      description: 'Confirm SOE and EOE exist before matching or creating the episode object.',
      preReq: ['wf7-s31'],
    },
    {
      id: 'wf7-s27',
      actor: 'human',
      taskKey: 'human.fillEpisodeDates',
      name: 'Manually Add Episode Dates',
      description: 'SOE or EOE is missing. Human adds episode dates before the episode object is matched or created.',
      condition: 'episode_dates_missing',
      preReq: ['wf7-s26'],
    },
    {
      id: 'wf7-s32',
      actor: 'system',
      taskKey: 'episode.resolve',
      name: 'Check / Create Episode',
      description: 'Check if an episode with that SOE/EOE exists in the admission. If yes, update it; if no, create a new episode in the admission. The order will attach to this episode.',
      preReq: ['wf7-s26', 'wf7-s27'],
    },

    // ─────────────────────────────────────────────────────────────
    // PHASE 4 — ORDER (by order number, attached to the episode)
    //   check order# exists -> skip duplicate
    //   else check fields (+ matched PDF) -> human fix -> create
    // ─────────────────────────────────────────────────────────────
    {
      id: 'wf7-s17',
      actor: 'system',
      taskKey: 'order.skipDuplicate',
      name: 'Skip Duplicate Order',
      description: 'Order number already exists. Skip this duplicate row — the existing order is left untouched and logged (never overwritten or deleted).',
      condition: 'order_exists',
      preReq: ['wf7-s32'],
    },
    {
      id: 'wf7-s28',
      actor: 'system',
      taskKey: 'order.checkFields',
      name: 'Check Order Fields',
      description: 'New order: confirm required order fields and the matched PDF are present before creating it.',
      condition: 'order_not_exists',
      preReq: ['wf7-s32'],
    },
    {
      id: 'wf7-s29',
      actor: 'human',
      taskKey: 'human.fixOrderFields',
      name: 'Manually Fix Order Fields',
      description: 'Required order fields or the matched PDF are missing. A human fills them before the order is created.',
      condition: 'order_fields_missing',
      preReq: ['wf7-s28'],
    },
    {
      id: 'wf7-s18',
      actor: 'system',
      taskKey: 'order.create',
      name: 'Create Order',
      description: 'Order not found. Create order and link it to the patient record, admission, episode, and HHAH context.',
      condition: 'order_not_exists',
      preReq: ['wf7-s28', 'wf7-s29'],
    },
    {
      id: 'wf7-s19',
      actor: 'system',
      taskKey: 'order.retryWrite',
      name: 'Retry Order Write',
      description: 'Order create failed. Retry once automatically.',
      condition: 'order_write_fail',
      preReq: ['wf7-s17', 'wf7-s18'],
    },
    {
      id: 'wf7-s20',
      actor: 'human',
      taskKey: 'human.fixOrderWrite',
      name: 'Fix Order Write',
      description: 'Order write still failed after retry. Human fixes the order record.',
      condition: 'order_retry_fail',
      preReq: ['wf7-s19'],
    },

    // ─────────────────────────────────────────────────────────────
    // PHASE 5 — REVIEW (patient -> admission -> episode -> orders)
    // ─────────────────────────────────────────────────────────────
    {
      id: 'wf7-s21',
      actor: 'human',
      taskKey: 'human.reviewRecord',
      name: 'Review Patient → Admission → Episode → Orders',
      description: 'Human reviews the assembled patient, admission, episode and orders. On fail it loops back to fix; on pass the order document becomes ready and Trigger 3 (signing) can start.',
      preReq: ['wf7-s17', 'wf7-s18', 'wf7-s19', 'wf7-s20'],
    },
  ],
};

export const WF_SIGNING_DEFINITION = {
  id: 'wf-signing',
  name: 'Document Signing Follow-up',
  description:
    'Starts after the patient is created/updated and an order document is uploaded. It reviews document readiness, sends the document to the physician for signature, waits up to 48 hours, then updates signed status or sends an overdue email.',
  trigger: {
    id: 'trigger-order-document-ready',
    type: 'order_document_ready',
  },
  conditions: {
    document_ready_for_signing: 'document has the fields and PDF needed for signing',
    document_not_ready_for_signing: 'document is missing fields or PDF readiness checks',
    signed_within_48h: 'physician signed the document within 48 hours',
    signing_overdue: 'physician has not signed within 48 hours',
  },
  // The visible flowchart collapses all steps into one "Review Document For Signing"
  // mega-task box. The View button expands the inner sub-task flowchart.
  megaTask: {
    id: 'sign-monitor',
    name: 'Review Document For Signing',
    info: 'Reviews whether the order document is ready for signing, sends it to the physician, waits up to 48 hours, then either marks the order signed or emails the physician an overdue reminder.',
  },
  steps: [
    {
      id: 'sign-s1',
      actor: 'system',
      taskKey: 'signing.reviewReadiness',
      name: 'Review Document Readiness For Signing',
      description: 'Check whether the uploaded order PDF and order metadata are ready to send for signature.',
      preReq: [],
    },
    {
      id: 'sign-s2',
      actor: 'human',
      taskKey: 'signing.fixDocument',
      name: 'Manually Fix Document',
      description: 'Document is not ready for signing. A person fixes missing fields or PDF readiness issues.',
      condition: 'document_not_ready_for_signing',
      preReq: ['sign-s1'],
    },
    {
      id: 'sign-s3',
      actor: 'system',
      taskKey: 'signing.sendToPhysician',
      name: 'Send Document To Physician',
      description: 'Send the ready document to the physician for signature.',
      condition: 'document_ready_for_signing',
      preReq: ['sign-s1', 'sign-s2'],
    },
    {
      id: 'sign-s4',
      actor: 'system',
      taskKey: 'signing.checkSignedWithin48h',
      name: 'Check Signed Within 48 Hours',
      description: 'Check whether the physician signed the document before the 48-hour deadline.',
      preReq: ['sign-s3'],
    },
    {
      id: 'sign-s5',
      actor: 'system',
      taskKey: 'signing.updateOrderSigned',
      name: 'Update Order Status — Signed',
      description: 'Document was signed within 48 hours, so update the order status to signed.',
      condition: 'signed_within_48h',
      preReq: ['sign-s4'],
    },
    {
      id: 'sign-s6',
      actor: 'system',
      taskKey: 'signing.emailPhysicianReminder',
      name: 'Email Physician — Signature Overdue',
      description: 'Document was not signed within 48 hours, so send/log an email reminder to the physician.',
      condition: 'signing_overdue',
      preReq: ['sign-s4'],
    },
  ],
};

export const WORKFLOW_DEFINITIONS = [
  WF_AREA_ONBOARDING_DEFINITION,
  WF7_DEFINITION,
  WF_SIGNING_DEFINITION,
];

export const SEEDED_USERS = [
  { id: 'u1', name: 'Alice', jobRole: 'Operations', accessLevel: 'worker' },
  { id: 'u2', name: 'Bob', jobRole: 'Clinical Ops', accessLevel: 'worker' },
  { id: 'u3', name: 'Carol', jobRole: 'Billing Ops', accessLevel: 'worker' },
];
