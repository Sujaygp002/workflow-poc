import { bulkSignOrders, listOrders, listPgUnsignedOrders } from '../_lib/repositories.js';
import { handleError, methodNotAllowed, readJson, sendJson } from '../_lib/http.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const orders = req.query.pgUnsigned === '1'
        ? await listPgUnsignedOrders(req.query.pgId || null)
        : await listOrders();
      return sendJson(res, 200, { orders });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      if (body.action !== 'bulkSign') {
        return sendJson(res, 400, { error: 'Unsupported orders action.' });
      }
      const result = await bulkSignOrders({
        orderIds: Array.isArray(body.orderIds) ? body.orderIds : [],
        pgId: body.pgId || null,
        date: body.date || new Date().toISOString().slice(0, 10),
      });
      return sendJson(res, 200, {
        updatedCount: result.updated.length,
        skippedCount: result.skipped.length,
        updated: result.updated,
        skipped: result.skipped,
      });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (error) {
    return handleError(res, error);
  }
}
