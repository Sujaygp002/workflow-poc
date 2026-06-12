import { handleError, methodNotAllowed, sendJson } from '../_lib/http.js';
import { listReferenceData } from '../_lib/repositories.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    return sendJson(res, 200, await listReferenceData());
  } catch (error) {
    return handleError(res, error);
  }
}
