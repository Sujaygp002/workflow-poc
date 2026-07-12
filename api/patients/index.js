import { handleError, methodNotAllowed, sendJson } from '../_lib/http.js';
import { listPatients, listPatientUnits, listRcmPatients, listRcmBilling } from '../_lib/repositories.js';
import { getSql } from '../_lib/db.js';

const TZ = 'America/Chicago';
const AS_OF_RE = /^\d{4}-\d{2}-\d{2}$/;

// Cumulative "as of end of business day D" object counts for the Coverage Map
// stats strip. count(D) = rows with created_at strictly before the START of the
// day AFTER D, evaluated in the business tz (so DST is handled by Postgres). This
// is monotonic in D: a later day never yields a smaller count.
async function objectCounts(asOf) {
  const sql = getSql();
  // Exclusive upper bound = midnight (Chicago) at the start of the day after `asOf`.
  // The cutoff arithmetic is inlined into the query text (not a composed fragment):
  // Neon's toParameterizedQuery rejects composing any fragment that carries bound
  // params ("This query is not composable"), and the live DATABASE_URL is a Neon URL,
  // so getSql() returns the Neon client rather than the makePgSql wrapper. Using the
  // plain .query(text, params) form (supported by BOTH clients) keeps $1/$2 as the
  // only bound params and never composes a parameterised fragment.
  const cutoffExpr = "(($1::date + interval '1 day') AT TIME ZONE $2)";
  const rows = await sql.query(
    `
    SELECT
      (SELECT count(*) FROM home_health_agencies WHERE created_at < ${cutoffExpr})::int AS agencies,
      (SELECT count(*) FROM physician_groups     WHERE created_at < ${cutoffExpr})::int AS "physicianGroups",
      (SELECT count(*) FROM practitioners        WHERE created_at < ${cutoffExpr})::int AS practitioners,
      (SELECT count(*) FROM patient_units        WHERE created_at < ${cutoffExpr})::int AS patients,
      (SELECT count(*) FROM patient_admissions   WHERE created_at < ${cutoffExpr})::int AS admissions,
      (SELECT count(*) FROM patient_episodes     WHERE created_at < ${cutoffExpr})::int AS episodes,
      (SELECT count(*) FROM orders               WHERE created_at < ${cutoffExpr})::int AS orders
    `,
    [asOf, TZ],
  );
  const row = rows[0] || {};
  return {
    agencies: row.agencies || 0,
    physicianGroups: row.physicianGroups || 0,
    practitioners: row.practitioners || 0,
    patients: row.patients || 0,
    admissions: row.admissions || 0,
    episodes: row.episodes || 0,
    orders: row.orders || 0,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const hhahId = req.query.hhahId || null;
    const pgId = req.query.pgId || null;
    if (req.query.view === 'object-counts') {
      const asOf = String(req.query.asOf || '');
      if (!AS_OF_RE.test(asOf)) {
        return sendJson(res, 400, { error: 'asOf must be a YYYY-MM-DD business date.' });
      }
      const counts = await objectCounts(asOf);
      return sendJson(res, 200, { asOf, tz: TZ, counts });
    }
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
