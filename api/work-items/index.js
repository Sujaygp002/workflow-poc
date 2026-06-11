import { handleError, methodNotAllowed, sendJson } from '../_lib/http.js';
import { listActiveWorkItems, listCompletedWorkItems, listUsers } from '../_lib/repositories.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const userId = req.query.userId;
    const users = await listUsers();
    if (!userId) return sendJson(res, 200, { users });
    const pending = await listActiveWorkItems(userId);
    const completed = await listCompletedWorkItems(userId);
    return sendJson(res, 200, { users, pending, completed });
  } catch (error) {
    return handleError(res, error);
  }
}
