// Demo data for the Coverage Map (/map): generic names HHAH1/HHAH2, PG1/PG2,
// Practitioner1..N, with practitioners linked to PGs and patients/orders wired so the
// graph's per-edge counts (patients/admissions/episodes/orders, 485/F2F/other) populate.
//
// Small, idempotent, additive — does NOT touch the existing Boise/Maya seed.
// Run with:  node scripts/seed-map-demo.js
import { getSql, jsonParam } from '../api/_lib/db.js';
import { mapPgToPractitioner } from '../api/_lib/repositories.js';
import { normalizeName, normalizeNpi } from '../api/_lib/normalizers.js';

const sql = getSql();
const RAW = (tag) => ({ seed: true, mapDemo: true, tag });

async function upsertPg(name, npi) {
  const rows = await sql`
    INSERT INTO physician_groups (name, normalized_name, npi, type, contact_info, raw_data, updated_at)
    VALUES (${name}, ${normalizeName(name)}, ${npi}, 'Physician Group',
      ${await jsonParam({ email: `${name.toLowerCase()}@example.com` })}::jsonb,
      ${await jsonParam(RAW('pg'))}::jsonb, now())
    ON CONFLICT (normalized_name) DO UPDATE SET npi = EXCLUDED.npi, updated_at = now()
    RETURNING *`;
  return rows[0];
}
async function upsertHhah(name, npi) {
  const rows = await sql`
    INSERT INTO home_health_agencies (name, normalized_name, npi, type, type_of_service, contact_info, raw_data, updated_at)
    VALUES (${name}, ${normalizeName(name)}, ${npi}, 'Home Health Agency', 'Skilled Nursing',
      ${await jsonParam({ email: `${name.toLowerCase()}@example.com` })}::jsonb,
      ${await jsonParam(RAW('hhah'))}::jsonb, now())
    ON CONFLICT (normalized_name) DO UPDATE SET npi = EXCLUDED.npi, updated_at = now()
    RETURNING *`;
  return rows[0];
}
async function upsertPractitioner(name, npi, speciality) {
  const rows = await sql`
    INSERT INTO practitioners (npi_digits, physician_name, speciality, contact_info, history, raw_data, updated_at)
    VALUES (${normalizeNpi(npi)}, ${name}, ${speciality},
      ${await jsonParam({ email: `${name.toLowerCase().replace(/\s+/g, '')}@example.com` })}::jsonb,
      ${await jsonParam({})}::jsonb, ${await jsonParam(RAW('practitioner'))}::jsonb, now())
    ON CONFLICT (npi_digits) DO UPDATE SET physician_name = EXCLUDED.physician_name, updated_at = now()
    RETURNING *`;
  return rows[0];
}

async function upsertUnit(name, dob, mrn) {
  const unitKey = [normalizeName(name), String(dob).toLowerCase(), normalizeName(mrn)].join('|');
  const rows = await sql`
    INSERT INTO patient_units (unit_key, name, dob, mrn, sex, personal_information, insurance_details, raw_data, updated_at)
    VALUES (${unitKey}, ${name}, ${dob}::date, ${mrn}, 'F', '{}'::jsonb, '{}'::jsonb, ${await jsonParam(RAW('unit'))}::jsonb, now())
    ON CONFLICT (unit_key) DO UPDATE SET updated_at = now()
    RETURNING *`;
  return rows[0];
}
async function upsertRecord(unit, hhah, pg, name, dob, mrn) {
  const recKey = [normalizeName(name), String(dob).toLowerCase(), normalizeName(mrn), normalizeName(hhah.name), normalizeName(pg.name)].join('|');
  const rows = await sql`
    INSERT INTO patients (unit_id, record_context_key, hhah_name, pg_name, agency_id, pg_id, name, dob, mrn, sex,
      personal_information, insurance_details, admission_details, raw_data, updated_at, latest_episode_status, latest_episode_status_reason)
    VALUES (${unit.id}, ${recKey}, ${hhah.name}, ${pg.name}, ${hhah.id}, ${pg.id}, ${name}, ${dob}::date, ${mrn}, 'F',
      '{}'::jsonb, '{}'::jsonb, ${await jsonParam({ MRN: mrn })}::jsonb, ${await jsonParam(RAW('record'))}::jsonb, now(), 'started', '{}'::jsonb)
    ON CONFLICT (record_context_key) DO UPDATE SET updated_at = now()
    RETURNING *`;
  const p = rows[0];
  await sql`INSERT INTO patient_physician_groups (patient_id, pg_id, role, raw_data) VALUES (${p.id}, ${pg.id}, 'primary', ${await jsonParam(RAW('ppg'))}::jsonb) ON CONFLICT (patient_id, pg_id) DO NOTHING`;
  return p;
}
async function upsertAdmission(patientId, hhah, pg, soc, eoc) {
  const rows = await sql`
    INSERT INTO patient_admissions (patient_id, soc, eoc, agency_id, pg_id, raw_data, updated_at)
    VALUES (${patientId}, ${soc}::date, ${eoc}::date, ${hhah.id}, ${pg.id}, ${await jsonParam(RAW('adm'))}::jsonb, now())
    ON CONFLICT (patient_id, soc, eoc) DO UPDATE SET updated_at = now()
    RETURNING *`;
  return rows[0];
}
async function upsertEpisode(admissionId, soe, eoe) {
  const rows = await sql`
    INSERT INTO patient_episodes (admission_id, soe, eoe, diagnosis_codes, raw_data, updated_at)
    VALUES (${admissionId}, ${soe}::date, ${eoe}::date, '[]'::jsonb, ${await jsonParam(RAW('epi'))}::jsonb, now())
    ON CONFLICT (admission_id, soe, eoe) DO UPDATE SET updated_at = now()
    RETURNING *`;
  return rows[0];
}
async function upsertOrder(num, docType, patientId, admissionId, episodeId, hhah, pg, signed) {
  const rows = await sql`
    INSERT INTO orders (order_number, order_type, document_type, order_date, patient_id, admission_id, episode_id,
      agency_id, pg_id, order_status, raw_data, updated_at)
    VALUES (${num}, ${docType}, ${docType}, '2026-01-10'::date, ${patientId}, ${admissionId}, ${episodeId},
      ${hhah.id}, ${pg.id}, ${await jsonParam(signed ? { SignedByPhysician_Status: true, SignedByPhyscianDate: '2026-01-12' } : {})}::jsonb,
      ${await jsonParam(RAW('order'))}::jsonb, now())
    ON CONFLICT (order_number) DO NOTHING
    RETURNING *`;
  return rows[0];
}

async function main() {
  console.log('Seeding Coverage Map demo data (HHAH1/2, PG1/2, Practitioners)…');

  // 2 HHAHs, 2 PGs
  const hhah1 = await upsertHhah('HHAH1', '1000000011');
  const hhah2 = await upsertHhah('HHAH2', '1000000012');
  const pg1 = await upsertPg('PG1', '2000000011');
  const pg2 = await upsertPg('PG2', '2000000012');

  // a few practitioners, linked to PGs (PG1 gets 3, PG2 gets 2)
  const practitioners = [];
  for (let i = 1; i <= 5; i += 1) practitioners.push(await upsertPractitioner(`Practitioner${i}`, `30000000${i}0`, 'Family Medicine'));
  for (const p of [practitioners[0], practitioners[1], practitioners[2]]) await mapPgToPractitioner({ pgId: pg1.id, practitionerId: p.id });
  for (const p of [practitioners[3], practitioners[4]]) await mapPgToPractitioner({ pgId: pg2.id, practitionerId: p.id });

  // Patients wiring the HHAH↔PG edges. Each HHAH connects to BOTH PGs (so the graph shows
  // multiple edges per agency). Counts come out as: patients per edge, adm/epi/order, 485/F2F/other.
  const edges = [
    { hhah: hhah1, pg: pg1, n: 3 },
    { hhah: hhah1, pg: pg2, n: 2 },
    { hhah: hhah2, pg: pg1, n: 2 },
    { hhah: hhah2, pg: pg2, n: 3 },
  ];
  let patientSeq = 1, orderSeq = 1;
  for (const e of edges) {
    for (let i = 0; i < e.n; i += 1) {
      const pname = `MapPatient${patientSeq}`;
      const dob = `19${40 + (patientSeq % 50)}-0${1 + (patientSeq % 9)}-1${patientSeq % 9}`;
      const mrn = `MAP-${e.hhah.name}-${e.pg.name}-${i}`;
      const unit = await upsertUnit(pname, dob, mrn);
      const rec = await upsertRecord(unit, e.hhah, e.pg, pname, dob, mrn);
      const adm = await upsertAdmission(rec.id, e.hhah, e.pg, '2025-09-01', '2026-02-25');
      const epi = await upsertEpisode(adm.id, '2025-09-01', '2026-02-25');
      // 3 orders per patient: a 485, an F2F, and one "other" — drives the order-type split.
      await upsertOrder(`O-${orderSeq++}`, '485 Certification', rec.id, adm.id, epi.id, e.hhah, e.pg, true);
      await upsertOrder(`O-${orderSeq++}`, 'F2F Encounter', rec.id, adm.id, epi.id, e.hhah, e.pg, i % 2 === 0);
      await upsertOrder(`O-${orderSeq++}`, 'Skilled Nursing Order', rec.id, adm.id, epi.id, e.hhah, e.pg, false);
      patientSeq += 1;
    }
  }

  console.log('Done: 2 HHAHs, 2 PGs, 5 practitioners, 10 patients, 30 orders.');
  process.exit(0);
}

main().catch((e) => { console.error('seed-map-demo failed:', e.message); process.exit(1); });
