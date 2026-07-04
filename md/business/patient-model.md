# Patient Model — Unit vs Record identity, admission/episode reuse, PG-change fork

**Source:** `api/_lib/normalizers.js` (`unitKey`, `recordContextKey`, `patientKey`), `api/_lib/repositories.js` (`writePatientBundle`, `writePatientUnit`, patient/admission/episode resolve + write), `api/_lib/taskRegistry.js` (`patient.resolve`, `patient.create`, `patient.update`, `record.create`, `admission.resolve`, `episode.resolve`, `evaluateRecordChanges`), `db/migrations/001_core_intake.sql`
**Read this when:** changing what counts as "the same patient", when a new record/admission/episode is created vs reused, or the patient write bundle.

## The business rules
1. **A person is identified by name + DOB + MRN — the Patient UNIT.** Same three values = same human, regardless of which agency or physician group sent them. `unit_key = normalizeName(name) | lower(DOB) | normalizeName(MRN)`.
2. **A Patient RECORD is the care context: Unit + HHAH + PG.** The same person under a *different* agency or physician group gets a NEW record (a "fork"), sharing the Unit. `record_context_key = unit_key | normalizeName(HHAH) | normalizeName(PG)`. Same context → reuse the existing record.
3. **Admissions are identified within a record by Start of Care** (`patient_admissions UNIQUE(patient_id, soc, eoc)`) — same SOC reuses, new SOC creates.
4. **Episodes are identified within an admission by SOE/EOE** (`patient_episodes UNIQUE(admission_id, soe, eoe)`) — same dates reuse, new dates create.
5. **Orders hang off the episode**, deduped by `order_number` (see [orders & signing](orders-and-signing.md)).
6. So the hierarchy is: **Patient Unit → Patient Record(s) → Admission(s) → Episode(s) → Order(s)**, and the workflow decides create-vs-reuse at each level.

## How the rules map to code
| Rule | Code |
|---|---|
| Unit identity | `unitKey`/`patientKey` in `normalizers.js`; `patient_units.unit_key` UNIQUE |
| Record context / fork | `recordContextKey` in `normalizers.js`; `patients.record_context_key` UNIQUE; `evaluateRecordChanges` in `taskRegistry.js` decides `record_context_changed` vs `unit_only_changed` |
| Patient-exists decision | `patient.resolve` (`evaluatePatientExistence`) keys `patient_exists` on the UNIT |
| Create vs update vs fork | `patient.create` (new unit+record), `patient.update` (update unit), `record.create` (new record under existing unit) — all call `runPatientWrite` → `writePatientBundle` |
| Admission reuse/create | `admission.resolve` → find by (patient, SOC) else create |
| Episode reuse/create | `episode.resolve` → find by (admission, SOE/EOE) else create/update |
| Atomic write | `writePatientBundle` writes unit → record → admission → episode together |

## Data shapes
```js
// patient_units row — the stable person
{ id, unit_key, name, dob, mrn, sex, personal_information, insurance_details, family, ... }
// patients row — the Patient Record (care context)
{ id, unit_id, record_context_key, hhah_name, pg_name, agency_id, pg_id,
  name, dob, mrn, admission_details, latest_episode_status, latest_episode_status_reason }
// patient_admissions: { id, patient_id, soc, eoc, agency_id, pg_id, care_provider_id, mrn }
// patient_episodes:   { id, admission_id, soe, eoe, diagnosis_codes[], status, status_reason }
```
The workflow item's `patient_payload` feeds this write:
`{ patient_info:{name,sex,DOB}, personal_information:{address}, admission_details:{HHAH,PG,MRN,SOC,EOC,SOE,EOE,diagnosis_codes} }` and `reference_payload:{HHAH:{name}, PG:{name}, practitioner:{NPI}}`.

## Invariants & gotchas
- **`unitKey === patientKey`** (same function) — the Unit key and the item's `patient_key` are identical. Changing name/MRN normalization in `normalizers.js` silently re-buckets identity everywhere (dedup, joins, existence checks).
- **A PG or HHAH change forks a new Record, NOT a new Unit.** This is intentional — the same person legitimately appears under multiple agencies. `record.create` runs only when `record_context_changed` is true AND the original Unit exists.
- **Reuse keys are exact-match on normalized values.** A typo in DOB/MRN/name creates a *different* Unit — there is no fuzzy matching. Dates are normalized via `parseDate` to `YYYY-MM-DD` before keying.
- Admission/episode UNIQUE constraints include the end dates (`eoc`, `eoe`) — a different EOC is a different admission even with the same SOC. Watch this when "reuse" seems not to happen.
- `latest_episode_status` on `patients` is a denormalized cache updated by the billing pass ([eligibility & billing](eligibility-billing.md)) — reads use it, but the source of truth is `patient_episodes.status`.
- Neon returns dates as `Date` objects; always compare via the repo's `dateOnly`/`dayDiff` (built on `parseDate`) — raw string-slicing a `Date` was a real historical bug.

## Change recipes
1. **Change what makes "the same patient":** edit `patientKey`/`unitKey` in `normalizers.js` — reshapes existence checks, joins, dedup. Re-seed/re-test; existing rows keep their old keys.
2. **Change the fork rule (when a new Record is created):** edit `recordContextKey` in `normalizers.js` + `evaluateRecordChanges` in `taskRegistry.js` (`record_context_changed`/`unit_only_changed`).
3. **Change admission/episode reuse identity:** edit the find-by queries in `repositories.js` (admission by SOC, episode by SOE/EOE) AND the `UNIQUE` constraints in `db/migrations/001_core_intake.sql` — they must agree (see [schema](../db/schema.md)).
4. **Add a field to the patient write:** extend `writePatientBundle` in `repositories.js` + the `patient_payload` producers in `excelParser.js`/`taskRegistry.js`.

## Related
- [intake pipeline](intake-pipeline.md) — the workflow phase order that calls resolve/create
- [orders & signing](orders-and-signing.md) — orders attach to the episode this model builds
- [eligibility & billing](eligibility-billing.md) — computes `latest_episode_status` from episodes/orders
- [repositories](../backend/lib/repositories.md) — the write bundle + resolve SQL
- [task-registry](../backend/lib/task-registry.md) — the patient/admission/episode task fns + conditions
- [db schema](../db/schema.md) — the tables + UNIQUE constraints that enforce identity
- [utils/normalizers](../backend/lib/utils.md) — the key + date functions
