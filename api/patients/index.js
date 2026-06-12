import { handleError, methodNotAllowed, sendJson } from '../_lib/http.js';
import { listPatients } from '../_lib/repositories.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const patients = await listPatients();
    return sendJson(res, 200, { patients });
  } catch (error) {
    return handleError(res, error);
  }
}
