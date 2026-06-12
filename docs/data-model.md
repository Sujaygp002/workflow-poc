# Data Model — actual DB schema (source of truth)

Derived from `db/migrations/001_initial_workflow_db.sql`. Use this to correct the
class/object diagram. The diagram currently shows several entities and links the DB
does **not** have (see "Diagram mismatches" at the bottom).

## Entities (domain tables)

| Entity | Table | Key fields |
|--------|-------|-----------|
| Patient | `patients` | `normalized_patient_key` (unique), name, dob, mrn, sex; `personal_information`, `insurance_details`, `admission_details` are JSONB |
| Admission | `patient_admissions` | `patient_id` FK, soc, eoc, `agency_id`, `pg_id`, `care_provider_id` |
| Episode | `patient_episodes` | `admission_id` FK, soe, eoe, `diagnosis_codes` |
| Order | `orders` | `order_number` (unique), patient/admission/episode FKs + agency/pg/billing+supervising provider FKs |
| Physician Group (PG) | `physician_groups` | `normalized_name` (unique), npi |
| HHAH (Home Health Agency) | `home_health_agencies` | `normalized_name` (unique), npi |
| Practitioner (Physician) | `practitioners` | `npi_digits` (unique), physician_name, speciality |

## Relationships (the real object connections)

```
Patient (1) ──< (many) Admission ──< (many) Episode
                   │                     
                   ├── agency_id ───────► HHAH
                   ├── pg_id ───────────► Physician Group
                   └── care_provider_id ► Practitioner

Order ── patient_id ──────────► Patient
      ── admission_id ────────► Admission
      ── episode_id ──────────► Episode
      ── agency_id ───────────► HHAH
      ── pg_id ───────────────► Physician Group
      ── billing_provider_id ─► Practitioner
      ── supervising_provider_id ► Practitioner
```

Cardinality:
- **Patient 1 — * Admission** (`patient_admissions.patient_id`, cascade delete)
- **Admission 1 — * Episode** (`patient_episodes.admission_id`, cascade delete)
- **Admission * — 1 HHAH / PG / Practitioner** (nullable FKs on the admission)
- **Order * — 1** each of Patient, Admission, Episode, HHAH, PG, Practitioner (billing + supervising)

So an HHAH/PG/Practitioner reaches a Patient **through an Admission (or Order)** — there
is no direct Patient→HHAH or Patient→Practice edge.

## Diagram mismatches (what to fix)

The class/object diagram should be corrected because these do **not** exist in the DB:

- **"Practice"** — no `practices` table. The diagram's Practice is not modeled. The
  closest real entities are **Physician Group** and **HHAH**. Remove "Practice" or relabel
  it to Physician Group.
- **Practice → Physician link** — no such relationship. Practitioners attach to
  **Admissions** and **Orders**, not to a Practice.
- **Direct Patient → HHAH edge** — should route **Patient → Admission → HHAH**.
- **"Archived Admission" / "billed"** — no archived-admission table or billed/archived
  flag in the schema. Either drop it or add it as a migration if genuinely needed.
- **"Current episodes" / "Past episodes"** — there's only one `patient_episodes` table;
  current-vs-past is a date filter (soe/eoe), not separate entities.
- **"Patient UNIT", "Insurance", "Ancillaries", "Others"** — none are tables. `insurance`
  lives as JSONB on `patients.insurance_details`; it is not a linked entity.

## Corrected diagram (minimal, matches DB)

```
                 ┌──────────┐
                 │ Patient  │
                 └────┬─────┘
                  1   │  *
                 ┌────▼───────┐   * ┌──────────────┐
                 │ Admission  ├────►│ HHAH         │
                 │            ├────►│ PhysicianGrp │
                 │            ├────►│ Practitioner │
                 └────┬───────┘     └──────────────┘
                  1   │  *
                 ┌────▼─────┐
                 │ Episode  │
                 └──────────┘

   Order ──► Patient, Admission, Episode, HHAH, PhysicianGrp, Practitioner(billing+supervising)
```
