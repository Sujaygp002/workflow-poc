import { handleError, methodNotAllowed, sendJson } from '../_lib/http.js';
import { listOrders } from '../_lib/repositories.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const orders = await listOrders();
    return sendJson(res, 200, { orders });
  } catch (error) {
    return handleError(res, error);
  }
}
