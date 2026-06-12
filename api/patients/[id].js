import { getPatientTree } from '../_lib/repositories.js';
import { handleError, methodNotAllowed, sendJson } from '../_lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const patient = await getPatientTree(req.query.id);
    if (!patient) return sendJson(res, 404, { error: 'Patient not found' });
    return sendJson(res, 200, patient);
  } catch (error) {
    return handleError(res, error);
  }
}
