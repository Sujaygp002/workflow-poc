// No system workflow definitions remain. wf7 (update patients objects),
// wf-signing (Send To Physician), and wf-billing-monitor (Make Patients
// Billable) were removed in the phase-1 refactor; wf-area-onboarding (Area
// Onboarding & Daily Upload Monitor) was removed after it. The daily builder
// workflow (trigger daily_time) is the single intake pipeline: uploads append
// one item per workbook row to today's daily run (see
// api/workflows/bulk-upload/start.js), and silent agencies get a
// Contact-Agency task at the noon tick. The empty export keeps
// ensureSystemDefinitions (repositories.js) and scripts/seed.js as no-op seams
// for any future system definition.
export const WORKFLOW_DEFINITIONS = [];
