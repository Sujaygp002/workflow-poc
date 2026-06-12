import { handleError, methodNotAllowed, sendJson } from '../_lib/http.js';
import { listActiveWorkflowDefinitions } from '../_lib/repositories.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const workflows = await listActiveWorkflowDefinitions();
    return sendJson(res, 200, { workflows });
  } catch (error) {
    return handleError(res, error);
  }
}
