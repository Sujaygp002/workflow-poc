import { handleError, methodNotAllowed, sendJson } from '../_lib/http.js';
import { getRunWithDefinition, listTaskRunsForRun } from '../_lib/repositories.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const run = await getRunWithDefinition(req.query.id);
    if (!run) return sendJson(res, 404, { error: 'Run not found' });
    const tasks = await listTaskRunsForRun(run.id);
    return sendJson(res, 200, { run: { ...run, tasks } });
  } catch (error) {
    return handleError(res, error);
  }
}
