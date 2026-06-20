import { handleError, methodNotAllowed, sendJson } from '../_lib/http.js';
import { listPatients, listPatientUnits } from '../_lib/repositories.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    if (req.query.view === 'units') {
      const units = await listPatientUnits();
      return sendJson(res, 200, { units });
    }
    const patients = await listPatients();
    return sendJson(res, 200, { patients });
  } catch (error) {
    return handleError(res, error);
  }
}
