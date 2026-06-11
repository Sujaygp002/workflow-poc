import { getRunWithDefinition } from '../../_lib/repositories.js';
import { completeHumanTask } from '../../_lib/workflowEngine.js';
import { handleError, methodNotAllowed, readJson, sendJson } from '../../_lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const body = await readJson(req);
    const run = await getRunWithDefinition(body.runId);
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
