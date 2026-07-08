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


// The system workflows `wf7` (update patients objects), `wf-signing`
// (Send To Physician), and `wf-billing-monitor` (Make Patients Billable) were
// removed in the phase-1 refactor. The daily builder workflow (trigger
// daily_time) is now the single intake pipeline: uploads append one item per
// workbook row to today's daily run (see api/workflows/bulk-upload/start.js),
// and silent agencies get a Contact-Agency task at the noon tick. Only
// WF_AREA_ONBOARDING_DEFINITION remains a seeded system definition.
export const WORKFLOW_DEFINITIONS = [WF_AREA_ONBOARDING_DEFINITION];
