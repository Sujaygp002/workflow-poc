// Complete a human task (bearer-scoped). Validation failures come back as
// 400 { error, actionErrors } and the task STAYS active/Processing.
import { getRunWithDefinition, getTaskRun, updateTask } from '../../_lib/repositories.js';
import { completeHumanTask } from '../../_lib/workflowEngine.js';
import { requireSession } from '../../_lib/auth.js';
import { handleError, methodNotAllowed, readJson, sendJson } from '../../_lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const { employee } = await requireSession(req, { type: 'employee' });
    const body = await readJson(req);
    const task = await getTaskRun(req.query.taskRunId);
    if (!task) return sendJson(res, 404, { error: 'Task not found' });
    if (task.assigned_employee_id && task.assigned_employee_id !== employee.id) {
      return sendJson(res, 403, { error: 'Task is claimed by another employee' });
    }
    if (!task.assigned_employee_id) {
      // Unclaimed shared task completed directly — claim it so it lands in
      // this employee's Done bucket.
      await updateTask(task.id, { assignedEmployeeId: employee.id, openedAt: task.opened_at || new Date().toISOString() });
    }
    const run = await getRunWithDefinition(body.runId || task.run_id);
    if (!run) return sendJson(res, 404, { error: 'Run not found' });
    const result = await completeHumanTask({
      taskRunId: req.query.taskRunId,
      notes: body.notes || '',
      payload: body.payload || {},
      definition: run.definition,
    });
    return sendJson(res, 200, result);
  } catch (error) {
    return handleError(res, error);
  }
}
