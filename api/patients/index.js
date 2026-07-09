import { handleError, methodNotAllowed, sendJson } from '../_lib/http.js';
import { listPatients, listPatientUnits, listRcmPatients, listRcmBilling } from '../_lib/repositories.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const hhahId = req.query.hhahId || null;
    const pgId = req.query.pgId || null;
    if (req.query.view === 'units') {
      const units = await listPatientUnits();
      return sendJson(res, 200, { units });
    }
    if (req.query.view === 'rcm') {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
      const result = await listRcmPatients({ hhahId, pgId, page, limit });
      return sendJson(res, 200, result);
    }
    if (req.query.view === 'rcm-billing') {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
      const result = await listRcmBilling({ hhahId, pgId, page, limit });
      return sendJson(res, 200, result);
    }
    const patients = await listPatients({ hhahId, pgId });
    return sendJson(res, 200, { patients });
  } catch (error) {
    return handleError(res, error);
  }
}
