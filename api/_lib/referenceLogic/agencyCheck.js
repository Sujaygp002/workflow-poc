// Agency upload check — has this HHAH uploaded documents for the day bucket?
//
// The daily "Agency Intake -> RCM Pipeline" workflow fires once per active agency
// per day; the first system step asks whether that agency has already bulk-uploaded
// its workbook + order PDFs for the day. If not, a human task reaches out (call /
// sms / email). If yes, the extraction -> AI -> RCM -> audit chain runs.
//
// "Uploaded today" is derived from uploaded_documents: a bulk-upload writes one
// uploaded_documents row per file with hhah_id set to the uploading agency (see
// repositories.insertUploadedDocument). We consider the agency to have uploaded on
// dayBucket (YYYY-MM-DD, in the trigger's timezone) if any such row's created_at
// falls on that calendar date. dayBucket is compared in the same tz the trigger
// used to compute it (default America/Chicago) so the "today" boundary lines up.

import { getSql } from '../db.js';

const DEFAULT_TZ = 'America/Chicago';

function agencyIdFromItem(item) {
  return item?.reference_payload?.HHAH?.id || item?.hhah_id || null;
}

function dayBucketFromItem(item) {
  return item?.extraction_payload?.dayBucket || null;
}

/**
 * Has the item's agency uploaded any documents on its day bucket?
 *
 * @param {{ item: object, tz?: string }} args
 * @returns {Promise<{ uploaded: boolean, agencyId: string|null, dayBucket: string|null, count: number }>}
 */
export async function checkUploadedToday({ item, tz = DEFAULT_TZ }) {
  const sql = getSql();
  const agencyId = agencyIdFromItem(item);
  const dayBucket = dayBucketFromItem(item);

  if (!agencyId) {
    return { uploaded: false, agencyId: null, dayBucket, count: 0, error: 'no_agency_on_item' };
  }

  // Compare the upload timestamp in the trigger tz so "today" matches the bucket
  // the tick handler computed. When dayBucket is absent, fall back to "current
  // date in tz". AT TIME ZONE shifts the stored timestamptz into local wall time.
  const rows = dayBucket
    ? await sql`
        SELECT COUNT(*)::int AS n
        FROM uploaded_documents
        WHERE hhah_id = ${agencyId}
          AND (created_at AT TIME ZONE ${tz})::date = ${dayBucket}::date`
    : await sql`
        SELECT COUNT(*)::int AS n
        FROM uploaded_documents
        WHERE hhah_id = ${agencyId}
          AND (created_at AT TIME ZONE ${tz})::date = (now() AT TIME ZONE ${tz})::date`;

  const count = rows[0]?.n || 0;
  return { uploaded: count > 0, agencyId, dayBucket, count };
}
