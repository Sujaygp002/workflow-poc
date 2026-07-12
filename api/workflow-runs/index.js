import { handleError, methodNotAllowed, readJson, sendJson } from '../_lib/http.js';
import {
  computeEpisodeAssessment,
  countWorkflowItems,
  createTaskRunsForItem,
  createWorkflowItem,
  createWorkflowRun,
  deleteAllWorkflowRuns,
  findNewestRunForWorkflow,
  findWorkflowRunBySourceLabel,
  getActiveWorkflow,
  getRunItems,
  getRunWithDefinition,
  isOrderSigned,
  listActiveAgencies,
  listActiveBuilderWorkflowsByTrigger,
  listTaskRunsForRun,
  listTaskRunsForRuns,
  listWorkflowRuns,
  resolveSettledGateTasks,
} from '../_lib/repositories.js';
import { getSql } from '../_lib/db.js';
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
// force=true bypasses the noon fire-time guard — used when the operator
// explicitly advances the simulated day (+1d/+1m): the intent is "show me the
// next day's run now", so the daily run is created regardless of the sim
// time-of-day. A real cron/poll tick passes force=false and still only fires
// at/after the configured hour.
async function dailyTimeTickHandler({ force = false } = {}) {
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
    // One workflow's bad tz must not abort the tick for every other workflow
    // (Intl.DateTimeFormat throws RangeError on invalid IANA names).
    let nowParts;
    try {
      nowParts = await nowPartsInTz(tz);
    } catch {
      skipped.push({ workflowId: workflow.id, reason: `invalid_tz_${tz}` });
      continue;
    }
    const { dayBucket, hour, minute } = nowParts;
    const beforeFireTime = !force && (hour * 60 + minute < targetHour * 60 + targetMinute);

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

// ── "Objects this run" server-side aggregate ─────────────────────────────────
// For each run, compute one compact runObjects rollup describing the real domain
// objects this run's items touched:
//   { agencies, pgs, practitioners,
//     patientUnits:{ total, created, updated, billed, eligible, ineligible },
//     admissions:{ total },
//     episodes:{ total, billed, eligible, ineligible },
//     orders:{ total, signed, unsigned } }
// Identity counts (agencies/pgs/practitioners) come from each item's
// reference_payload; object links come from extraction_payload.patientBundle
// (patientId/admissionId/episodeId) + extraction_payload.orderId stamped by the
// resolve/write task fns. Episode + patient buckets use computeEpisodeAssessment
// (eligible = has 485; billable = eligible + all episode orders signed):
//   billed = billable, eligible = eligible-but-not-billable, ineligible = rest.
// INVARIANT: total is DEFINED as the sum of the three buckets, so
//   billed + eligible + ineligible === total ALWAYS (mutually exclusive AND
//   exhaustive). Every distinct object that this run touched is bucketed exactly
//   once: a seen patient/episode id whose DB row is missing (deleted after the
//   run, or not yet written when this aggregate is computed) falls into
//   `ineligible` rather than being counted in total-but-no-bucket. Likewise the
//   patientUnits created/updated lifecycle is counted per-DISTINCT-patient (once,
//   keyed on the seen patient), so created + updated <= total always holds.
// Orders signed/unsigned derive from orders.order_status via isOrderSigned;
// orders.total === signed + unsigned (a seen order id with no DB row is unsigned).
// All DB reads are batched with ANY() across every run (no per-item queries).
function distinctIdCount(items, pick) {
  const ids = new Set();
  for (const item of items) {
    const id = pick(item);
    if (id !== undefined && id !== null && id !== '') ids.add(String(id));
  }
  return ids.size;
}

async function computeRunObjectsForRuns(runIds) {
  const out = new Map();
  if (!Array.isArray(runIds) || !runIds.length) return out;
  const sql = getSql();

  // One items query for every run (slim: only the payload columns we read).
  const items = await sql`
    SELECT run_id, reference_payload, extraction_payload, decisions
    FROM workflow_items
    WHERE run_id = ANY(${runIds})
  `;
  const itemsByRun = new Map();
  const episodeIds = new Set();
  const orderIds = new Set();
  const patientIds = new Set();
  for (const item of items) {
    const list = itemsByRun.get(item.run_id) || [];
    list.push(item);
    itemsByRun.set(item.run_id, list);
    const bundle = item.extraction_payload?.patientBundle || {};
    if (bundle.episodeId) episodeIds.add(bundle.episodeId);
    if (bundle.patientId) patientIds.add(bundle.patientId);
    const orderId = item.extraction_payload?.orderId;
    if (orderId) orderIds.add(orderId);
  }

  // Batched domain reads. Orders indexed by id (signed check) + grouped per
  // episode/admission (episode assessment needs the episode's + admission's orders).
  const orderRows = orderIds.size
    ? await sql`SELECT id, admission_id, episode_id, order_number, order_type, document_type, order_date, order_status FROM orders WHERE id = ANY(${[...orderIds]})`
    : [];
  const orderById = new Map(orderRows.map((o) => [String(o.id), o]));

  const episodeRows = episodeIds.size
    ? await sql`SELECT * FROM patient_episodes WHERE id = ANY(${[...episodeIds]})`
    : [];
  const episodeById = new Map(episodeRows.map((e) => [String(e.id), e]));
  const admissionIds = [...new Set(episodeRows.map((e) => e.admission_id).filter(Boolean))];
  const episodeOrderRows = episodeIds.size
    ? await sql`SELECT episode_id, admission_id, order_number, order_type, document_type, order_date, order_status FROM orders WHERE episode_id = ANY(${[...episodeIds]})`
    : [];
  const admissionOrderRows = admissionIds.length
    ? await sql`SELECT admission_id, order_number, order_type, document_type, order_date, order_status FROM orders WHERE admission_id = ANY(${admissionIds})`
    : [];
  const ordersByEpisode = new Map();
  for (const o of episodeOrderRows) {
    const list = ordersByEpisode.get(String(o.episode_id)) || [];
    list.push(o);
    ordersByEpisode.set(String(o.episode_id), list);
  }
  const ordersByAdmission = new Map();
  for (const o of admissionOrderRows) {
    const list = ordersByAdmission.get(String(o.admission_id)) || [];
    list.push(o);
    ordersByAdmission.set(String(o.admission_id), list);
  }
  const patientRows = patientIds.size
    ? await sql`SELECT id, latest_episode_status FROM patients WHERE id = ANY(${[...patientIds]})`
    : [];
  const patientById = new Map(patientRows.map((p) => [String(p.id), p]));

  // Bucket an episode assessment into exactly one of billed/eligible/ineligible.
  const bucketOf = (assessment) => {
    if (assessment.billable) return 'billed';
    if (assessment.eligible) return 'eligible';
    return 'ineligible';
  };
  // Same three buckets from a persisted patients.latest_episode_status label.
  const bucketOfStatus = (status) => {
    if (status === 'billable') return 'billed';
    if (status === 'eligible') return 'eligible';
    return 'ineligible';
  };

  for (const runId of runIds) {
    const runItems = itemsByRun.get(runId) || [];
    const agencies = distinctIdCount(runItems, (it) => it.reference_payload?.HHAH?.id);
    const pgs = distinctIdCount(runItems, (it) => it.reference_payload?.PG?.id ?? it.reference_payload?.PG?.name);
    const practitioners = distinctIdCount(
      runItems,
      (it) => it.reference_payload?.practitioner?.id
        ?? it.reference_payload?.practitioner?.NPI
        ?? it.reference_payload?.practitioner?.physician_name
        ?? it.reference_payload?.practitioner?.name,
    );

    // Distinct domain objects this run's items resolved. Buckets are counted
    // per-DISTINCT-id and are exhaustive (a seen id whose DB row is missing lands
    // in the "ineligible"/"unsigned" residual bucket), so the per-object total is
    // DEFINED as the sum of its buckets — the mutual-exclusion invariant holds
    // regardless of deleted or not-yet-written rows.
    const seenPatients = new Set();
    const seenAdmissions = new Set();
    const seenEpisodes = new Set();
    const seenOrders = new Set();
    const patientUnits = { created: 0, updated: 0, billed: 0, eligible: 0, ineligible: 0 };
    const episodes = { billed: 0, eligible: 0, ineligible: 0 };
    const orders = { signed: 0, unsigned: 0 };

    for (const item of runItems) {
      const bundle = item.extraction_payload?.patientBundle || {};
      const d = item.decisions || {};
      if (bundle.patientId && !seenPatients.has(String(bundle.patientId))) {
        seenPatients.add(String(bundle.patientId));
        // Status bucket for THIS distinct patient (exhaustive: missing row = ineligible).
        const patient = patientById.get(String(bundle.patientId));
        patientUnits[patient ? bucketOfStatus(patient.latest_episode_status) : 'ineligible'] += 1;
        // Created-vs-updated lifecycle counted ONCE per distinct patient from the
        // item that first resolved it (a fresh unit / successful write on a new
        // patient = created; a write on an existing unit = updated). Because this
        // is per-distinct-patient, created + updated <= total (= seenPatients.size).
        if (d.unit_not_exists || (d.patient_not_exists && (d.patient_write_success || d.patient_retry_success))) patientUnits.created += 1;
        else if ((d.unit_exists || d.patient_exists) && (d.unit_only_changed || d.patient_write_success || d.patient_retry_success)) patientUnits.updated += 1;
      }
      if (bundle.admissionId) seenAdmissions.add(String(bundle.admissionId));
      if (bundle.episodeId && !seenEpisodes.has(String(bundle.episodeId))) {
        seenEpisodes.add(String(bundle.episodeId));
        const episode = episodeById.get(String(bundle.episodeId));
        if (episode) {
          const epOrders = ordersByEpisode.get(String(episode.id)) || [];
          const admOrders = episode.admission_id
            ? (ordersByAdmission.get(String(episode.admission_id)) || epOrders)
            : epOrders;
          const assessment = computeEpisodeAssessment(episode, epOrders, admOrders);
          episodes[bucketOf(assessment)] += 1;
        } else {
          // Seen episode id with no DB row (deleted / not yet written) → residual.
          episodes.ineligible += 1;
        }
      }
      const orderId = item.extraction_payload?.orderId;
      if (orderId && !seenOrders.has(String(orderId))) {
        seenOrders.add(String(orderId));
        const order = orderById.get(String(orderId));
        // Exhaustive: a seen order with no DB row counts as unsigned (not signed).
        if (order && isOrderSigned(order)) orders.signed += 1;
        else orders.unsigned += 1;
      }
    }

    // total is DEFINED as the sum of the buckets so the invariant is structural,
    // not incidental: billed + eligible + ineligible === total for every object.
    out.set(runId, {
      agencies,
      pgs,
      practitioners,
      patientUnits: {
        total: patientUnits.billed + patientUnits.eligible + patientUnits.ineligible,
        ...patientUnits,
      },
      admissions: { total: seenAdmissions.size },
      episodes: {
        total: episodes.billed + episodes.eligible + episodes.ineligible,
        ...episodes,
      },
      orders: { total: orders.signed + orders.unsigned, ...orders },
    });
  }
  return out;
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
      // Server-computed "Objects this run" rollup (one per run). Best-effort: if
      // the aggregate fails the runs still return with their previous fields and
      // the sidebar falls back to its decision-derived counts.
      let objectsByRun = new Map();
      try {
        objectsByRun = await computeRunObjectsForRuns(runs.map((run) => run.id));
      } catch {
        objectsByRun = new Map();
      }
      const withTasks = runs.map((run) => ({
        ...run,
        tasks: tasksByRun.get(run.id) || [],
        runObjects: objectsByRun.get(run.id) || null,
      }));
      return sendJson(res, 200, { runs: withTasks });
    }

    if (req.method === 'DELETE') {
      const body = await readJson(req);
      if (body?.all === true) {
        await deleteAllWorkflowRuns();
        return sendJson(res, 200, { deleted: true });
      }
      return sendJson(res, 400, { error: 'Missing all:true in body.' });
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
        case 'simulateTime': {
          const simState = await applySimTimeOp(body.op);
          // Advancing the simulated day/month is an explicit "run the next
          // day now" gesture — force the daily tick so the new day's run
          // appears immediately (bypasses the noon fire-time guard).
          let tick = null;
          if (body.op === '+1d' || body.op === '+1m') {
            tick = await dailyTimeTickHandler({ force: true });
          }
          return sendJson(res, 200, { ...simState, tick });
        }
        default:
          return sendJson(res, 400, { error: 'Unsupported workflow-runs action.' });
      }
    }

    return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
  } catch (error) {
    return handleError(res, error);
  }
}
