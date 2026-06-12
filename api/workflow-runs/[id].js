import { handleError, methodNotAllowed, sendJson } from '../_lib/http.js';
import { deleteWorkflowRun, getRunWithDefinition, listTaskRunsForRun } from '../_lib/repositories.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const run = await getRunWithDefinition(req.query.id);
      if (!run) return sendJson(res, 404, { error: 'Run not found' });
      const tasks = await listTaskRunsForRun(run.id);
      return sendJson(res, 200, { run: { ...run, tasks } });
    } catch (error) {
      return handleError(res, error);
    }
  }

  if (req.method === 'DELETE') {
    try {
      const deleted = await deleteWorkflowRun(req.query.id);
      if (!deleted) return sendJson(res, 404, { error: 'Run not found' });
      return sendJson(res, 200, { ok: true, id: req.query.id });
    } catch (error) {
      return handleError(res, error);
    }
  }

  return methodNotAllowed(res, ['GET', 'DELETE']);
}
