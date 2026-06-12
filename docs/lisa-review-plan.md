# Plan — Lisa's data-model & workflow review (DRAFT v2, for green-light)

Status: **proposed, not implemented.** Reflects Lisa's answers from the 12 Jun review.
Nothing here is built until Sujay green-lights.

Source files involved:
- Schema: `db/migrations/001_initial_workflow_db.sql`
- Workflow definition: `api/_lib/workflowDefinition.js` (`WF7_DEFINITION`)
- Task logic: `api/_lib/taskRegistry.js`
- Persistence: `api/_lib/repositories.js`
- Visualization: `src/pages/orchestrator/Orchestrator.jsx`, `src/components/WorkflowFlowChart.jsx`

---

## Decisions locked (from Lisa)

1. **Patient ↔ PG:** many-to-many, **0..\* on both sides**, independent of admission.
2. **No PG → don't create the patient.** Route the **whole row to human review**; a human
   creates/adds the PG. (A PG may have 0..many patients.)
3. **Provider-doesn't-exist / temp-storage case:** **deferred** — ignore for this round.
4. **Admission/Episode structure:** an Admission starts at **SOC** and contains **multiple
   Episodes** (~60–90 days each, SOE→EOE). The **last episode's EOE = admission EOC**. If
   only SOC exists, create the admission and leave EOC empty (or set EOC = last EOE).
5. **Order carries its own SOC/SOE/EOE** — these are authoritative. No date inference.
   - Match admission by **patient + SOC**.
   - Within the admission, match episode by **SOE + EOE**: **if an episode with the same
     SOE/EOE exists, reuse it**; else **create a new episode** and place the order there.
6. **Episode status — computed on read, never stored:**
   - `eligible` = episode has a **485** + an **active F2F** (active = within **6 months of
     the F2F order's order_date**), even if unsigned.
   - `billable` = **all** the episode's orders (incl. 485) are **signed**.
   - The **latest episode's** status is surfaced on the Patient.
   - **485** and **F2F** are **document types on orders** — no separate tables.
7. **Lifecycle view scope:** only the objects in Lisa's diagram — Patient, Practice/PG,
   Physician/Practitioner, HHAH, Admission, Episode, Order. Show **found / missing /
   created / updated / in-review**, **plus the Episode's computed eligible/billable**
   (also shown on the Patient as latest status).

---

## A. Data-model corrections

### Current (wrong) state
- Patient connects to PG/practitioner **only via `patient_admissions`** (`pg_id`,
  `care_provider_id`). Lisa: this is wrong — those links are **direct on the patient**,
  independent of admission.

### Proposed (migration `002_patient_pg_links.sql`)
1. **`patient_physician_groups (patient_id, pg_id, role, created_at)`** — many-to-many,
   both 0..\*. The patient↔PG link, independent of admission.
2. **`patient_practitioners (patient_id, practitioner_id, relationship, created_at)`** —
   patient may have **0..many** practitioners directly.
3. Keep `patient_admissions.care_provider_id` / `pg_id` only as the **admitting/episode
   provider** for that admission — relabel in code/docs; it is *not* the patient's
   physician link.
4. **Patient Unit (stable base layer)** — `patient_units` for stable identity/insurance/
   family/address; `patients` becomes the changing/relationship layer with
   `patients.unit_id → patient_units.id`. (Reusable base for future RPM/TCM/CCM.)
   - *Implementation note:* this is the largest change. Could be **phase 2** if Lisa wants
     the relationship fixes shipped first.

### Diagram impact
Update `docs/data-model.svg` + `.md`: `Patient Unit 1—* Patient`, `Patient *—* PG`,
`Patient *—* Practitioner (0..many)`, Admission→PG/Practitioner = "admitting provider"
only, Admission `1—*` Episode, Order matched to Admission(SOC)+Episode(SOE/EOE).

---

## B. Workflow / orchestration logic

### B1. Missing-PG → block row → human review
- Today: `reference_records_ready = practitioner && pg && hhah`; if PG missing, a human
  step auto-creates it and proceeds.
- Change: if **PG is missing**, **do not create the patient** — set `needs_manual_review`
  and route the **whole row** to a manual-bucket task (`human.reviewMissingPg`). The row
  stays blocked until a human resolves the PG.

### B2. Order → Admission → Episode upsert (from order's own SOC/SOE/EOE)
- New/clarified write path in `writeOrderBundle` (and patient bundle):
  1. Upsert **Admission** by `(patient_id, SOC)`.
  2. Look for an **Episode** in that admission with the **same SOE/EOE**. Found → reuse;
     not found → **create episode**, then attach the order.
  3. Attach order to that episode.
- Lifecycle output per step: `{ admission: found|created, episode: found|created,
  order: created|updated }`.

### B3. Episode status (computed)
- New read helper `computeEpisodeStatus(episode, orders)`:
  - has 485 + F2F.order_date within 6 months → **eligible**
  - all orders (incl. 485) signed → **billable**
  - else → **started/none**
- Surface latest episode status on patient in `getPatientTree` / patient list.

### B4. Object-lifecycle view (not field-level)
- Each task returns an `objectStatus` map for the diagram's 7 objects.
- Orchestrator renders **lifecycle chips** (found / missing / created / updated /
  in-review) instead of NPI/field diffs; Episode chip also shows **eligible/billable**.

---

## C. AI vs scripted (Lisa: prefer scripts over AI)
- Keep Gemini only for unstructured PDF extraction. Completeness, NPI/format
  normalization, reference matching, episode SOE/EOE matching, and status computation are
  **all deterministic scripts** — no new AI calls. Document AI vs scripted per step.

---

## D. Implementation order (once green-lit)
1. **Docs/diagram** — corrected target-state `data-model.svg` for Lisa to confirm.
2. **Migration 002** — patient↔PG and patient↔practitioner joins (+ Patient Unit, possibly
   phase 2).
3. **Repositories** — patient/PG/practitioner links; order→admission→episode upsert by
   SOC/SOE/EOE; `computeEpisodeStatus`.
4. **Workflow def + registry** — missing-PG block→review; episode reuse/create; lifecycle
   `objectStatus` outputs.
5. **Orchestrator UI** — lifecycle chips for the 7 objects + episode eligible/billable.
6. **Re-run e2e** with sample sets.

---

## Still-open (small) confirmations for Lisa
1. **Patient Unit split** — ship relationship fixes first (phase 1) and do Patient Unit as
   phase 2, or all together?
2. **F2F document field** — current order rows have `documentType` + `SignedDate`; the
   6-month F2F check uses **order_date** (already present). Confirm no extra F2F field
   needed.
3. **"billed / Archived Admission" + "Current/Past episodes"** in her diagram — are these
   lifecycle *states* (archived = past admission, current/past = by date) rather than
   separate tables? Assuming yes (date-derived), not new entities.
