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
