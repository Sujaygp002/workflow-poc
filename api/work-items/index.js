// Worker buckets (bearer-scoped): GET = the signed-in employee's three buckets
// (Untouched / Processing / Done); POST {action:'open'} claims a task and moves
// it to Processing, returning the full task detail + action checklist.
import { handleError, methodNotAllowed, readJson, sendJson } from '../_lib/http.js';
import {
  getItem,
  getPatientTree,
  listEmployeeBucketItems,
  listOrdersForPatient,
  openTaskRun,
} from '../_lib/repositories.js';
import { taskDisplayPayload } from '../_lib/taskRegistry.js';
import { requireSession } from '../_lib/auth.js';
import { getSql } from '../_lib/db.js';
import { businessToday, getSimOffsetMs } from '../_lib/clock.js';

const STATS_TZ = 'America/Chicago';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Business "yesterday" (YYYY-MM-DD in the sim tz) — one calendar day before the
// business "today" the clock reports (sim offset respected).
//
// This decrements the CALENDAR DAY of the business-today string rather than
// subtracting 86 400 000 ms from businessNow(). In America/Chicago a calendar
// day is 23 h (spring-forward) or 25 h (fall-back) on the two DST-transition
// nights, so fixed 24 h arithmetic would land on the same date as today
// (spring-forward) or skip a day (fall-back). Parsing today's date and
// subtracting one day in the (tz-agnostic) UTC calendar is exact on every day.
async function businessYesterday() {
  const today = await businessToday(STATS_TZ);
  const [y, m, d] = today.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d));
  prev.setUTCDate(prev.getUTCDate() - 1);
  const pad = (n) => String(n).padStart(2, '0');
  return `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-${pad(prev.getUTCDate())}`;
}

// Per-employee task buckets + completion performance for the Command Center
// admin Employees page. Bucket filters mirror the worker-portal buckets exactly
// (active/human/opened_at/assigned semantics); the shared NULL-assignee
// untouched pool is counted once as `unassignedUntouched`, not per employee.
// Day/range windows compare business-tz calendar dates against completed_at
// SHIFTED BY THE SIM OFFSET — completed_at is stamped by SQL now() (wall clock),
// but today/yesterday labels come from the simulated business clock, so without
// the shift a task completed right after a "+1 day" time-travel would land under
// "Yesterday" instead of the business "Today".
async function getEmployeeStats({ from, to }) {
  const sql = getSql();
  const [today, yesterday, simOffsetMs] = await Promise.all([
    businessToday(STATS_TZ),
    businessYesterday(),
    getSimOffsetMs(),
  ]);

  let rangeFrom = null;
  let rangeTo = null;
  if (from && to && DATE_RE.test(from) && DATE_RE.test(to) && from <= to) {
    rangeFrom = from;
    rangeTo = to;
  }

  const employees = await sql.query(
    `SELECT id, display_name, job_role
       FROM employees
      WHERE active = true
      ORDER BY display_name`,
    [],
  );

  // Active/human buckets per assigned employee (untouched-mine + processing).
  const bucketRows = await sql.query(
    `SELECT t.assigned_employee_id AS employee_id,
            COUNT(*) FILTER (WHERE t.status = 'active' AND t.opened_at IS NULL)      AS untouched,
            COUNT(*) FILTER (WHERE t.status = 'active' AND t.opened_at IS NOT NULL)  AS processing,
            COUNT(*) FILTER (WHERE t.status = 'completed')                          AS done
       FROM workflow_task_runs t
      WHERE t.actor = 'human' AND t.assigned_employee_id IS NOT NULL
      GROUP BY t.assigned_employee_id`,
    [],
  );

  // Shared pool: active/human/untouched with NO assignee.
  const [{ count: unassignedUntouched } = { count: 0 }] = await sql.query(
    `SELECT COUNT(*) AS count
       FROM workflow_task_runs t
      WHERE t.status = 'active' AND t.actor = 'human'
        AND t.opened_at IS NULL AND t.assigned_employee_id IS NULL`,
    [],
  );

  // Completions per employee, bucketed by business-tz completed date
  // (completed_at shifted into business time by the sim offset).
  const completedRows = await sql.query(
    `SELECT t.assigned_employee_id AS employee_id,
            COUNT(*) FILTER (WHERE ((t.completed_at + $6::double precision * interval '1 millisecond') AT TIME ZONE $1)::date = $2::date) AS completed_yesterday,
            COUNT(*) FILTER (WHERE ((t.completed_at + $6::double precision * interval '1 millisecond') AT TIME ZONE $1)::date = $3::date) AS completed_today,
            COUNT(*) FILTER (
              WHERE $4::date IS NOT NULL
                AND ((t.completed_at + $6::double precision * interval '1 millisecond') AT TIME ZONE $1)::date BETWEEN $4::date AND $5::date
            ) AS completed_range
       FROM workflow_task_runs t
      WHERE t.actor = 'human' AND t.status = 'completed'
        AND t.assigned_employee_id IS NOT NULL AND t.completed_at IS NOT NULL
      GROUP BY t.assigned_employee_id`,
    [STATS_TZ, yesterday, today, rangeFrom, rangeTo, simOffsetMs],
  );

  // Up to 10 newest completed tasks per employee (name + workflow + completed_at,
  // reported in business time so timestamps agree with the Yesterday/Today labels).
  const recentRows = await sql.query(
    `SELECT employee_id, name, workflow_name, completed_at FROM (
        SELECT t.assigned_employee_id AS employee_id,
               t.name,
               d.name AS workflow_name,
               t.completed_at + $1::double precision * interval '1 millisecond' AS completed_at,
               ROW_NUMBER() OVER (
                 PARTITION BY t.assigned_employee_id ORDER BY t.completed_at DESC
               ) AS rn
          FROM workflow_task_runs t
          JOIN workflow_runs r ON r.id = t.run_id
          JOIN workflow_definitions d ON d.id = r.workflow_id AND d.version = r.workflow_version
         WHERE t.actor = 'human' AND t.status = 'completed'
           AND t.assigned_employee_id IS NOT NULL AND t.completed_at IS NOT NULL
      ) ranked
      WHERE rn <= 10
      ORDER BY completed_at DESC`,
    [simOffsetMs],
  );

  const buckets = new Map(bucketRows.map((r) => [r.employee_id, r]));
  const completed = new Map(completedRows.map((r) => [r.employee_id, r]));
  const recent = new Map();
  for (const row of recentRows) {
    if (!recent.has(row.employee_id)) recent.set(row.employee_id, []);
    recent.get(row.employee_id).push({
      name: row.name,
      workflow_name: row.workflow_name,
      completed_at: row.completed_at,
    });
  }

  const num = (v) => Number(v || 0);
  const stats = employees.map((e) => {
    const b = buckets.get(e.id) || {};
    const c = completed.get(e.id) || {};
    const entry = {
      id: e.id,
      display_name: e.display_name,
      job_role: e.job_role,
      counts: {
        untouched: num(b.untouched),
        processing: num(b.processing),
        done: num(b.done),
      },
      completedYesterday: num(c.completed_yesterday),
      completedToday: num(c.completed_today),
      recentDone: recent.get(e.id) || [],
    };
    if (rangeFrom) entry.completedInRange = num(c.completed_range);
    return entry;
  });

  return {
    today,
    yesterday,
    range: rangeFrom ? { from: rangeFrom, to: rangeTo } : null,
    unassignedUntouched: num(unassignedUntouched),
    stats,
  };
}

// Legacy system-workflow human tasks carry no builder actions; surface them
// with one implicit action so the worker portal renders a uniform checklist.
export function taskActions(task) {
  const actions = Array.isArray(task.actions) ? task.actions : [];
  if (actions.length) return actions;
  return [{ id: 'legacy', actionKey: 'legacy', taskKey: task.task_key, label: task.name }];
}

// TASK container (definition megaGroup) the task's step belongs to, so the
// worker portal can read "TASK-Update / Create Patient Model › Review record".
function taskGroupName(task) {
  const groups = Array.isArray(task.workflow_mega_groups) ? task.workflow_mega_groups : [];
  const group = groups.find((g) => Array.isArray(g?.stepIds) && g.stepIds.includes(task.step_id));
  return group?.name || null;
}

function bucketRow(task) {
  const row = { ...task, actions: taskActions(task), group_name: taskGroupName(task) };
  delete row.workflow_mega_groups; // internal lookup column, not part of the payload
  return row;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      // Command Center admin view (per-employee task counts + performance).
      // Served WITHOUT a worker bearer session — branch before requireSession.
      if (req.query?.view === 'employee-stats') {
        const from = typeof req.query.from === 'string' ? req.query.from : null;
        const to = typeof req.query.to === 'string' ? req.query.to : null;
        const stats = await getEmployeeStats({ from, to });
        return sendJson(res, 200, stats);
      }

      const { employee } = await requireSession(req, { type: 'employee' });
      const buckets = await listEmployeeBucketItems(employee.id);
      return sendJson(res, 200, {
        employee: { id: employee.id, username: employee.username, displayName: employee.display_name },
        untouched: buckets.untouched.map(bucketRow),
        processing: buckets.processing.map(bucketRow),
        done: buckets.done.map(bucketRow),
      });
    }

    if (req.method === 'POST') {
      const { employee } = await requireSession(req, { type: 'employee' });
      const body = await readJson(req);
      if (body.action !== 'open') {
        return sendJson(res, 400, { error: 'Unsupported work-items action.' });
      }
      if (!body.taskRunId) return sendJson(res, 400, { error: 'taskRunId is required.' });
      const opened = await openTaskRun({ taskRunId: body.taskRunId, employeeId: employee.id });
      if (opened.error) return sendJson(res, opened.status || 400, { error: opened.error });
      const task = opened.task;
      const item = await getItem(task.item_id);
      // Task context for the redesigned worker panels: the patient's real DB
      // orders (review / fill / CCN tasks show "the order/s of that patient")
      // and the full patient object module (unit → record → admission →
      // episode → orders + CPO months/CC notes). Best-effort — a missing
      // patient just leaves them empty.
      const patientId = item?.extraction_payload?.patientBundle?.patientId || null;
      const [patientOrders, patientTree] = patientId
        ? await Promise.all([
            listOrdersForPatient(patientId).catch(() => []),
            getPatientTree(patientId).catch(() => null),
          ])
        : [[], null];
      return sendJson(res, 200, {
        task,
        actions: taskActions(task),
        actionState: task.action_state || {},
        payload: item ? { ...taskDisplayPayload(item), patientOrders, patientTree } : {},
        pdf: item?.extraction_payload?.pdf || null,
      });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (error) {
    return handleError(res, error);
  }
}
