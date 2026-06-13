import { handleError, methodNotAllowed, readJson, sendJson } from '../_lib/http.js';
import { listAreaIntakeStatus, runAreaIntakeCheck } from '../_lib/repositories.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const checkDate = req.query?.date || null;
      const areas = await listAreaIntakeStatus({ checkDate });
      return sendJson(res, 200, { areas });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      if (!body.areaId) throw new Error('areaId is required.');
      const result = await runAreaIntakeCheck({
        areaId: body.areaId,
        checkDate: body.checkDate || null,
        now: body.now || null,
        forceExpired: body.forceExpired === true,
      });
      return sendJson(res, 200, result);
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (error) {
    return handleError(res, error);
  }
}
