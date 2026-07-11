// Entities: GET = reference data snapshot; POST = create / update agency, PG,
// practitioner + PG↔practitioner mapping (Entity page).
import { handleError, methodNotAllowed, readJson, sendJson } from '../_lib/http.js';
import {
  createHhahFromPayload,
  createPgFromPayload,
  createPractitionerFromPayload,
  listReferenceData,
  mapPgToPractitioner,
  updateHhahEntity,
  updatePgEntity,
  updatePractitionerEntity,
} from '../_lib/repositories.js';
import { httpError } from '../_lib/auth.js';
import { normalizeNpi } from '../_lib/normalizers.js';

async function createAgency({ name, npi, contact }) {
  if (!name || !String(name).trim()) throw httpError(400, 'Agency name is required');
  const agency = await createHhahFromPayload({
    HHAH: { name: String(name).trim(), NPI: npi || null, contact_info: contact || {} },
  });
  return { agency };
}

async function createPg({ name, npi }) {
  if (!name || !String(name).trim()) throw httpError(400, 'PG name is required');
  const pg = await createPgFromPayload({ PG: { name: String(name).trim(), NPI: npi || null } });
  return { pg };
}

async function createPractitioner({ name, npi }) {
  if (!name || !String(name).trim()) throw httpError(400, 'Practitioner name is required');
  if (!normalizeNpi(npi)) throw httpError(400, 'Practitioner NPI is required');
  const practitioner = await createPractitionerFromPayload({
    practitioner: { physician_name: String(name).trim(), NPI: npi },
  });
  return { practitioner };
}

// Update-by-id wrappers. Unique-key collisions (rename to an existing
// normalized_name, NPI already taken) surface as a 400, not a 500.
function requireId(id) {
  if (!id) throw httpError(400, 'id is required');
}

async function runUpdate(fn, body, entityLabel) {
  try {
    return await fn(body);
  } catch (error) {
    if (String(error?.code) === '23505') {
      throw httpError(400, `Another ${entityLabel} already uses that name/NPI`);
    }
    if (/not found/i.test(error?.message || '')) throw httpError(404, error.message);
    throw error;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      return sendJson(res, 200, await listReferenceData());
    }
    if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

    const body = await readJson(req);
    switch (body.action) {
      case 'createAgency':
        return sendJson(res, 201, await createAgency(body));
      case 'createPg':
        return sendJson(res, 201, await createPg(body));
      case 'createPractitioner':
        return sendJson(res, 201, await createPractitioner(body));
      case 'updateAgency':
        requireId(body.id);
        return sendJson(res, 200, { agency: await runUpdate(updateHhahEntity, body, 'agency') });
      case 'updatePg':
        requireId(body.id);
        return sendJson(res, 200, { pg: await runUpdate(updatePgEntity, body, 'physician group') });
      case 'updatePractitioner':
        requireId(body.id);
        return sendJson(res, 200, { practitioner: await runUpdate(updatePractitionerEntity, body, 'practitioner') });
      case 'mapPgPractitioner':
        return sendJson(res, 200, await mapPgToPractitioner({
          pgId: body.pgId,
          practitionerId: body.practitionerId,
        }));
      default:
        return sendJson(res, 400, { error: 'Unsupported reference-data action.' });
    }
  } catch (error) {
    return handleError(res, error);
  }
}
