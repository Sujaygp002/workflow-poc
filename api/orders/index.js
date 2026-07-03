import { bulkSignOrders, listOrders, listPgUnsignedOrders } from '../_lib/repositories.js';
import { httpError, requireSession } from '../_lib/auth.js';
import { handleError, methodNotAllowed, readJson, sendJson } from '../_lib/http.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const orders = req.query.pgUnsigned === '1'
        ? await listPgUnsignedOrders(req.query.pgId || null)
        : await listOrders({ hhahId: req.query.hhahId || null });
      return sendJson(res, 200, { orders });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      if (body.action !== 'bulkSign') {
        return sendJson(res, 400, { error: 'Unsupported orders action.' });
      }
      // Bulk sign requires a signed-in PG practitioner; the PG scope comes
      // from the session (never from the client body).
      const { externalUser } = await requireSession(req, { type: 'external' });
      if (externalUser.user_type !== 'pg' || externalUser.role !== 'practitioner') {
        throw httpError(403, 'A PG practitioner login is required to sign orders');
      }
      const result = await bulkSignOrders({
        orderIds: Array.isArray(body.orderIds) ? body.orderIds : [],
        pgId: externalUser.pg_id,
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
