import { handleError, methodNotAllowed, readJson, sendJson } from '../_lib/http.js';
import {
  countWorkflowItems,
  createTaskRunsForItem,
  createWorkflowItem,
  createWorkflowRun,
  findNewestRunForWorkflow,
  findWorkflowRunBySourceLabel,
  getActiveWorkflow,
  getRunItems,
  getRunWithDefinition,
  listActiveAgencies,
  listActiveBuilderWorkflowsByTrigger,
  listTaskRunsForRun,
  listTaskRunsForRuns,
  listWorkflowRuns,
  resolveSettledGateTasks,
} from '../_lib/repositories.js';
import { runWorkflowAutomation } from '../_lib/workflowEngine.js';
import { dailySourceLabel, nowPartsInTz } from '../_lib/dailyBucket.js';
import { applySimTimeOp, getSimTimeState } from '../_lib/clock.js'; // SIM (Milestone D)
import { httpError } from '../_lib/auth.js';

// Manual trigger: start a run of any active workflow (builder Run button).
// Default items = one empty item so system steps/conditions can still evaluate.
async function startWorkflowHandler(body) {
  const workflow = await getActiveWorkflow(body.workflowId);
  if (!workflow) throw httpError(404, 'Workflow not found');
  const items = Array.isArray(body.items) && body.items.length ? body.items : [{}];
  const run = await createWorkflowRun({
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    sourceLabel: body.sourceLabel || `manual:${workflow.id}:${Date.now()}`,
    totalItems: items.length,
    inputSummary: { trigger: 'manual', workflowName: workflow.name, itemCount: items.length },
  });
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] || {};
    const created = await createWorkflowItem({
      runId: run.id,
      itemIndex: i,
      patientPayload: item.patientPayload || {},
      orderPayload: item.orderPayload || {},
      referencePayload: item.referencePayload || {},
      extractionPayload: item.extractionPayload || {},
    });
    await createTaskRunsForItem({ runId: run.id, itemId: created.id, steps: workflow.definition.steps });
  }
  await runWorkflowAutomation({ runId: run.id, definition: workflow.definition });
  const refreshed = await getRunWithDefinition(run.id);
  const tasks = await listTaskRunsForRun(run.id);
  return { run: refreshed, tasks };
}

// Time trigger: for each active builder workflow with trigger.type =
// 'time_interval', start a run when the newest run is older than the interval.
// Idempotent via bucketed source labels (builder-tick:<wfId>:<bucketTs>).
async function tickHandler() {
  const workflows = await listActiveBuilderWorkflowsByTrigger('time_interval');
  const started = [];
  for (const workflow of workflows) {
    const intervalSeconds = Math.max(5, Number(workflow.definition?.trigger?.intervalSeconds) || 60);
    const newest = await findNewestRunForWorkflow(workflow.id);
    if (newest && Date.now() - new Date(newest.created_at).getTime() < intervalSeconds * 1000) continue;
    const bucketTs = Math.floor(Date.now() / 1000 / intervalSeconds) * intervalSeconds;
    const sourceLabel = `builder-tick:${workflow.id}:${bucketTs}`;
    const existing = await findWorkflowRunBySourceLabel(workflow.id, sourceLabel);
    if (existing) continue;
    const run = await createWorkflowRun({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      sourceLabel,
      totalItems: 1,
      inputSummary: { trigger: 'time_interval', intervalSeconds, workflowName: workflow.name },
    });
    const item = await createWorkflowItem({
      runId: run.id,
      itemIndex: 0,
      patientPayload: {},
      orderPayload: {},
      referencePayload: {},
      extractionPayload: {},
    });
    await createTaskRunsForItem({ runId: run.id, itemId: item.id, steps: workflow.definition.steps });
    await runWorkflowAutomation({ runId: run.id, definition: workflow.definition });
    started.push(run.id);
  }
  const daily = await dailyTimeTickHandler();
  return { started, daily: daily.started, dailySkipped: daily.skipped, gateResolved: daily.gateResolved };
}

// Build the set of agency ids already represented on a daily run — union of the
// native base items (reference_payload.HHAH.id) AND the row items an upload
// appended (also reference_payload.HHAH.id). A silent agency that later uploads
// gets its base item auto-resolved + a row item, so it is present here and the
// tick must NOT append a second Contact-Agency base item for it.
function presentAgencyIds(items) {
  const ids = new Set();
  for (const item of items) {
    const id = item.reference_payload?.HHAH?.id;
    if (id) ids.add(String(id));
  }
  return ids;
}

// Append ONE base item (Contact-Agency, full graph) for each active agency not
// already present on the run. Idempotent per (agency, dayBucket) via the
// base:<agencyId>:<dayBucket> appendKey stamped on extraction_payload.
async function appendMissingAgencyBaseItems({ workflow, run, dayBucket, tz }) {
  const withDefinition = await getRunWithDefinition(run.id);
  const steps = withDefinition?.definition?.steps || workflow.definition?.steps || [];
  if (!steps.length) return { appended: 0 };

  const agencies = await listActiveAgencies();
  const existingItems = await getRunItems(run.id);
  const present = presentAgencyIds(existingItems);
  const existingAppendKeys = new Set(
    existingItems.map((it) => it.extraction_payload?.appendKey).filter(Boolean),
  );

  let appended = 0;
  let itemIndex = await countWorkflowItems(run.id);
  for (const agency of agencies) {
    const agencyId = String(agency.id);
    const appendKey = `base:${agencyId}:${dayBucket}`;
    // Skip agencies already on the run (native base OR row items) and any whose
    // base appendKey already exists (a second same-day tick appends nothing).
    if (present.has(agencyId) || existingAppendKeys.has(appendKey)) continue;
    const contact = agency.contact_info || {};
    const created = await createWorkflowItem({
      runId: run.id,
      itemIndex,
      patientPayload: {},
      orderPayload: {},
      referencePayload: { HHAH: { id: agency.id, name: agency.name, contact } },
      extractionPayload: { dayBucket, tz, appendKey },
    });
    await createTaskRunsForItem({ runId: run.id, itemId: created.id, steps });
    existingAppendKeys.add(appendKey);
    present.add(agencyId);
    itemIndex += 1;
    appended += 1;
  }

  if (appended > 0) {
    await runWorkflowAutomation({ runId: run.id, definition: withDefinition?.definition || workflow.definition });
  }
  return { appended };
}

// daily_time trigger: fire ONCE per day (per active builder workflow) when the
// current time in the trigger tz has reached hour:minute.
//   - MISSING run + before fire time → skip (do NOT create early; uploads may
//     create the run on demand, but the tick only creates it at/after noon).
//   - MISSING run + at/after fire time → create today's run with one BASE item
//     per active agency.
//   - EXISTING running run (e.g. created early by an upload) → APPEND one BASE
//     item for each active agency not already present (silent agencies get a
//     Contact-Agency task at noon; new agencies join late). Idempotent.
// Run source label daily:<wfId>:<dayBucket> is shared with the upload on-demand
// create path, so at most one run exists per workflow per calendar day.
async function dailyTimeTickHandler() {
  const workflows = await listActiveBuilderWorkflowsByTrigger('daily_time');
  const started = [];
  const skipped = [];
  // ASYNC RULE (Milestone A): re-evaluate prior-day post-model remediation tasks
  // every tick — complete any whose gate now passes ('resolved by re-evaluation').
  // Independent of whether a new run is created below.
  const gateResolved = await resolveSettledGateTasks();
  for (const workflow of workflows) {
    const trigger = workflow.definition?.trigger || {};
    const tz = trigger.tz || 'America/Chicago';
    const targetHour = Number.isFinite(Number(trigger.hour)) ? Number(trigger.hour) : 12;
    const targetMinute = Number.isFinite(Number(trigger.minute)) ? Number(trigger.minute) : 0;
    const { dayBucket, hour, minute } = await nowPartsInTz(tz);
    const beforeFireTime = hour * 60 + minute < targetHour * 60 + targetMinute;

    const sourceLabel = dailySourceLabel(workflow.id, dayBucket);
    const existing = await findWorkflowRunBySourceLabel(workflow.id, sourceLabel);

    // Run already exists for today (upload-created early, or a prior tick). At
    // or after fire time, append base items for any silent/new agency missing
    // from the run. Before fire time, leave it untouched.
    if (existing) {
      if (existing.status !== 'running') {
        skipped.push({ workflowId: workflow.id, reason: `run_status_${existing.status}`, dayBucket });
        continue;
      }
      if (beforeFireTime) {
        skipped.push({ workflowId: workflow.id, reason: 'before_fire_time_run_exists', dayBucket });
        continue;
      }
      const { appended } = await appendMissingAgencyBaseItems({ workflow, run: existing, dayBucket, tz });
      if (appended > 0) {
        started.push({ runId: existing.id, workflowId: workflow.id, dayBucket, appendedBaseItems: appended });
      } else {
        skipped.push({ workflowId: workflow.id, reason: 'already_ran_today', dayBucket });
      }
      continue;
    }

    // No run yet. Only CREATE at/after the fire time (never a fresh full run
    // early — an early upload is what creates the run before noon).
    if (beforeFireTime) {
      skipped.push({ workflowId: workflow.id, reason: 'before_fire_time', dayBucket });
      continue;
    }

    const agencies = await listActiveAgencies();
    const run = await createWorkflowRun({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      sourceLabel,
      totalItems: Math.max(1, agencies.length),
      inputSummary: { trigger: 'daily_time', dayBucket, tz, workflowName: workflow.name, agencyCount: agencies.length },
    });

    for (let i = 0; i < agencies.length; i += 1) {
      const agency = agencies[i];
      const contact = agency.contact_info || {};
      const item = await createWorkflowItem({
        runId: run.id,
        itemIndex: i,
        patientPayload: {},
        orderPayload: {},
        referencePayload: { HHAH: { id: agency.id, name: agency.name, contact } },
        extractionPayload: { dayBucket, tz, appendKey: `base:${agency.id}:${dayBucket}` },
      });
      await createTaskRunsForItem({ runId: run.id, itemId: item.id, steps: workflow.definition.steps });
    }

    await runWorkflowAutomation({ runId: run.id, definition: workflow.definition, concurrency: Math.max(1, agencies.length) });
    started.push({ runId: run.id, workflowId: workflow.id, dayBucket, agencyCount: agencies.length });
  }
  return { started, skipped, gateResolved: gateResolved.resolved };
}

function actionFromUrl(req) {
  // req.query is populated by Vercel; the local shim may only set req.url.
  if (req.query && req.query.action) return req.query.action;
  try {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('action');
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      // GET /api/workflow-runs?action=tick — lets a vercel.json cron fire the
      // daily_time (and time_interval) triggers with a simple GET.
      if (actionFromUrl(req) === 'tick') {
        return sendJson(res, 200, await tickHandler());
      }
      // SIM (Milestone D): GET current simulated-business-time state.
      if (actionFromUrl(req) === 'simTime') {
        return sendJson(res, 200, await getSimTimeState());
      }
      const runs = await listWorkflowRuns();
      const allTasks = await listTaskRunsForRuns(runs.map((run) => run.id));
      const tasksByRun = new Map();
      for (const task of allTasks) {
        const list = tasksByRun.get(task.run_id) || [];
        list.push(task);
        tasksByRun.set(task.run_id, list);
      }
      const withTasks = runs.map((run) => ({ ...run, tasks: tasksByRun.get(run.id) || [] }));
      return sendJson(res, 200, { runs: withTasks });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      switch (body.action) {
        case 'startWorkflow':
          return sendJson(res, 201, await startWorkflowHandler(body));
        case 'tick':
          return sendJson(res, 200, await tickHandler());
        // SIM (Milestone D): advance / reset the simulated business clock.
        // op '+1d' | '+1m' | 'reset'. Handler logic lives in api/_lib/clock.js.
        case 'simulateTime':
          return sendJson(res, 200, await applySimTimeOp(body.op));
        default:
          return sendJson(res, 400, { error: 'Unsupported workflow-runs action.' });
      }
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (error) {
    return handleError(res, error);
  }
}
