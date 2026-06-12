import { handleError, methodNotAllowed, readJson, sendJson } from '../_lib/http.js';
import { mapPgToPractitioner } from '../_lib/repositories.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const body = await readJson(req);
    const result = await mapPgToPractitioner({
      pgId: body.pgId,
      practitionerId: body.practitionerId,
    });
    return sendJson(res, 200, result);
  } catch (error) {
    return handleError(res, error);
  }
}
