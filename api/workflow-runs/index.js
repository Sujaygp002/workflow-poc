import { handleError, methodNotAllowed, sendJson } from '../_lib/http.js';
import { listTaskRunsForRun, listWorkflowRuns } from '../_lib/repositories.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const runs = await listWorkflowRuns();
    const withTasks = [];
    for (const run of runs) {
      const tasks = await listTaskRunsForRun(run.id);
      withTasks.push({ ...run, tasks });
    }
    return sendJson(res, 200, { runs: withTasks });
  } catch (error) {
    return handleError(res, error);
  }
}
