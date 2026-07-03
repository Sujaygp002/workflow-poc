// Entities: GET = reference data snapshot; POST = create agency / PG /
// practitioner + PG↔practitioner mapping (Entity page).
import { handleError, methodNotAllowed, readJson, sendJson } from '../_lib/http.js';
import {
  createHhahFromPayload,
  createPgFromPayload,
  createPractitionerFromPayload,
  listReferenceData,
  mapPgToPractitioner,
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
