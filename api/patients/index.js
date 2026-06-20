import { handleError, methodNotAllowed, sendJson } from '../_lib/http.js';
import { listPatients, listPatientUnits } from '../_lib/repositories.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const hhahId = req.query.hhahId || null;
    if (req.query.view === 'units') {
      const units = await listPatientUnits();
      return sendJson(res, 200, { units });
    }
    const patients = await listPatients({ hhahId });
    return sendJson(res, 200, { patients });
  } catch (error) {
    return handleError(res, error);
  }
}
