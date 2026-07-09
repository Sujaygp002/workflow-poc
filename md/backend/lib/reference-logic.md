# Reference Logic — Daily Agency Intake → RCM Pipeline modules

**Source:** `api/_lib/referenceLogic/agencyCheck.js`, `api/_lib/referenceLogic/extraction.js`,
`api/_lib/referenceLogic/aiService.js`, `api/_lib/referenceLogic/rcm.js`,
`api/_lib/referenceLogic/audit.js`, `api/_lib/referenceLogic/rework.js`

**Read this when:** changing the agency-upload check, the AI extraction pipeline, CC-note /
CPO generation, RCM CPT billing record logic, audit rules R1–R4, or the auto-fix rework loop.

## What it does

Five ES-module files ported/adapted from the .NET 8 reference bundle at `reference/`
(see `reference/HANDOFF.md` §1.1–§1.5). They implement the server-side logic for the
**Daily Agency Intake → RCM Pipeline** builder workflow: every active home-health agency is
checked for today's upload; if uploaded, the full chain runs — enhanced extraction, AI
CC-note/CPO service, RCM billing-record generation, AI audit, and auto-fix rework. Human tasks
gate on failure branches (`agency_not_uploaded`, `ai_service_failed`, `audit_failed`).

**HANDOFF landmine #1 respected**: no Azure/OpenAI endpoints or API keys were copied from the
reference bundle. All LLM calls go through `api/_lib/gemini.js` (Gemini, keyed by
`GEMINI_API_KEY` in `api/_lib/config.js`).

## Key functions / exports

### Pipeline modules (task-key wired)

| File | Exported fn | Signature → return | Behavior in one line | Called by taskKey |
|------|-------------|-------------------|----------------------|-------------------|
| `agencyCheck.js` | `checkUploadedToday` | `({item, tz?}) -> {uploaded, agencyId, dayBucket, count, error?}` | Queries `uploaded_documents` for the item's `reference_payload.HHAH.id` + `extraction_payload.dayBucket` (YYYY-MM-DD) | `agency.checkUploadedToday` |
| `extraction.js` | `extractWithPatterns` | `({item}) -> {ok, patch:{patient,order,references}, tier, fieldsExtracted}` | Tier 1: ~60 regex extractors over existing payload text; Tier 2: Gemini for fields regex missed; mirrors the 3-tier pipeline of `NewPdfExtractionService.cs` | `ai.extractWithPatterns` |
| `aiService.js` | `runAiService` | `({item}) -> {ok, failed:bool, ccNotes:[], minutesDistributed:int}` | Generates CC notes (hybrid "nopii + 6para" Gemini prompt) + distributes CPO minutes; returns `failed:true` if any episode falls short of 30 min after distribution | `ai.runService` |
| `aiService.js` | `runCcnService` (internal) | delegates to `runAiService`; derives `ccnFailed = hadWork && generatedNotes === 0` — the exact Gemini-dead state; a run with NO billable months is NOT a failure (`ccn_ok`) | `ccn.runService` via `taskRegistry.js` |
| `rcm.js` | `generateRcm` | `({item}) -> {ok, rcmRecords:[], upserted:int}` | CPT decision tree (G0179/G0180/G0181/G0182) over eligible episodes + CPO months; upserts `rcm_records` (UNIQUE `episode_id,cpo_month,cpt_code`) | `rcm.generate` |
| `audit.js` | `auditRcm` | `({item}) -> {ok, passed:[], failed:[{rcmRecordId, findings:[]}]}` | Rules R1–R4 over every `rcm_record` for the item's agency; writes/updates `audit_records`; findings are structured `{rule,code,field,message,fixable}` | `ai.audit` |
| `rework.js` | `reworkAudits` | `({item, maxCycles?=3}) -> {ok, cycles:int, remaining:int}` | Consumes `rework`-status `audit_records`, applies fixable fixes to `rcm_records`, appends `change_log` entries, re-audits up to `maxCycles` (default 3 preserves old behaviour; `run_audit_cycle` passes 5, `re_audit` passes 1) until failures = 0 or < 10% | `ai.rework` (via `runAuditCycle` helper in `taskRegistry.js`) |

### businessRules.js — pure utility library (no taskKey; imported by rcm.js + aiService.js)

Ported from `reference/Order_Patient/Services/BusinessRequirementsService.cs` (HANDOFF §1.2).
All functions are pure exports with no side effects and no imports. Uses `dateOnly`/`dateMs`
idiom — no `String(date).slice` — to handle both Neon `Date` objects and ISO strings.

| Exported fn | Source rule (BRS line refs) | Behavior |
|-------------|----------------------------|----------|
| `isFilled(value)` | `IsFilled` (L2272–2276) | Returns `true` if value is non-null, non-empty, non-whitespace string |
| `isPatientDataComplete(patient)` | `IsPatientDataComplete` (L2484–2517) | Checks required patient fields (name, DOB, MRN, etc.) are `isFilled` |
| `carryForwardEpisodeDiagnoses(episodes)` | `CarryForwardEpisodeDiagnoses` (L526–584) | Propagates the most recent non-blank diagnosis code into subsequent episodes in an admission chain |
| `evaluateCpoMonthReadiness({patient, episodes, orders, cpoMonth})` | `EvaluateCpoMonthReadiness` (L2410–2482) | Checks episode overlap, 485-doc signed date, diagnosis completeness, CPO minutes — returns `{ready, reason}` |
| `pgBillableMinutes(episode, cpoMonthLabel)` | `GeneratePgBillable` minute rules (L1132–1282) | Accumulates CPO minutes from notes/docs in a given month for one episode; used by `aiService.js` (L547) |
| `derivePatientStatus(episodes)` | `UpdatePatientStatus / UpdatePatientStatusOP` (L1987–2123) | `'Active'` when latest episode EOE >= today (UTC), else `'Inactive'` |
| `deriveFilterStatus({isBillable, isPgBillable, isEligible, patientStatus})` | `UpdateBillingStatus / UpdateBillingStatusOP` (L1300–1333, L1694–1755) | Tier: `'Billable'` > `'Pgbillable'` > `'Eligible'` > `null`; Active patients only |

**Not ported** (legitimately absent — these are DTO-mapping layers with no POC equivalent):
- `GroupDocumentsIntoEpisodes` — groups Cosmos doc DTOs into episodes; POC writes directly to Postgres rows.
- `OrganizeEpisodesIntoAdmissions` — builds a DTO tree; POC queries the DB hierarchy directly.
- `FillCpoDatasFromPgBillables` — Cosmos writeback step; POC upserts `rcm_records` + `cpo_months` in-place.

**Known limitation (LOW / informational):** `deriveFilterStatus` in `rcm.js` computes the
`Pgbillable` tier via a local proxy (`assessment.eligible && cpo_min >= 30`) rather than calling
`pgBillableMinutes` over the episode's doc/note set. The `cpoStatusForMonth` flip in
`repositories.js` IS the correct single source of truth; `aiService.js` uses `pgBillableMinutes`
for minute accumulation correctly. The only practical effect is that the `filter_status:'Pgbillable'`
label on the RCM payload may under-classify a record as Eligible when full doc/note filtering would
push it over 30 minutes. POC adaptation acknowledged; the label is informational on the payload only.

## Data shapes

```js
// agencyCheck.js — item must carry:
item.reference_payload.HHAH.id  // agencyId
item.extraction_payload.dayBucket  // 'YYYY-MM-DD' set by tickHandler at item creation

// extraction.js — tier decision
{ tier: 1|2, fieldsExtracted: ['patient.name', 'order.order_number', …], patch: { patient:{}, order:{}, references:{} } }

// aiService.js — CC-note shape (stored on rcm_records payload)
{ ccNotes: [{ noteText, noteType, noteDate, data_tags:{ generated_by:'ai_service' } }] }
// COMPLIANCE: notes are NEVER marked physician-signed

// rcm.js — CPT codes
// G0181 $120 — CPO supervision, cpo_min >= 30
// G0182 $120 — long-episode variant (episode ~90 days, same CPO qualification)
// G0180 $60  — certification (485 physician-signed in CPO month)
// G0179 $40  — recertification (subsequent episode)
{ rcmRecords: [{ cpt_code, amount_cents, status:'generated', payload:{…} }] }

// audit.js — structured finding (NOT plain-text comment string like the .NET original)
{ rule: 'R1'|'R2'|'R3'|'R4', code: string, field: string, message: string, fixable: boolean }

// rework.js — change_log entry
{ timestamp, field, old, new, source:'rework' }
```

## Compliance deviations (deliberate, documented in module headers)

1. **`aiService.js`** (HANDOFF landmine): the .NET `AIProcessingService.cs` stamped every generated
   CC note `SignedByPhysicianStatus=true`. Here every note is tagged
   `data_tags.generated_by='ai_service'` and is **never** marked physician-signed. AI-generated
   care-coordination notes are not physician attestations; a human or physician must independently
   attest and sign.

2. **`audit.js`/`rework.js`** (HANDOFF landmine): the .NET `AuditorService.cs` Part 1→Part 2
   coupling was via plain-text comment strings ("Missing: PatientName", "Duplicate NoteText").
   Here Part 1 writes **structured finding objects** `{rule, code, field, message, fixable}` into
   `audit_records.rule_results` (jsonb). Rework dispatches on `{rule, code, field}` — never prose
   parsing. This makes findings queryable and the fix logic deterministic.

## Invariants & gotchas

- **`dayBucket` is the idempotency key** for `agencyCheck.js` — it must be stamped on the item
  by `tickHandler` at creation time (`extraction_payload.dayBucket`). If missing, the check returns
  `agency_not_uploaded` with `error:'no_agency_on_item'` and does not throw.
- **`extraction.js` Tier 2 calls Gemini** — the same `extractMissingDataFromPdf` in
  `api/_lib/gemini.js` used by the core `ai.extractMissingDataFromPdf` task. If Gemini is
  unavailable, Tier 2 is skipped and only the regex fields are returned (Tier 1 result is `ok:true`
  regardless).
- **`rcm.js` upserts are idempotent** via the UNIQUE index `(episode_id, cpo_month, cpt_code)` in
  migration 004. Re-running `rcm.generate` on the same item replaces existing records (same key)
  rather than duplicating.
- **`audit.js` scope is agency-wide**: it audits ALL `rcm_records` for the item's agency (not just
  those created in this run). An earlier revision also scoped by `cpo_month = dayBucket` but that
  was too narrow — see the module header comment.
- **`rework.js` loop cap is controlled by `maxCycles`** (default 3, not the .NET 20-cycle max).
  The 10% threshold logic from the reference is preserved: if remaining failures / total < 10%,
  the loop stops early. The `runAuditCycle` helper in `taskRegistry.js` orchestrates
  `auditRcm → reworkAudits → auditRcm` as ONE bounded unit, passing `maxCycles:5` for the full
  cycle and `maxCycles:1` for the `re_audit` tail step. This helper lives in `taskRegistry.js`
  (not a referenceLogic module) to avoid the `audit.js ↔ rework.js` circular import — it is the
  single place that imports both.
- **CCN verdict (`ccnFailed`)**: `hadWork && generatedNotes === 0` — only the exact Gemini-dead
  state (every billable CPO month lands in failures, 0 notes generated). A run with NO billable
  months produces `ccn_ok` so the audit cycle proceeds immediately.
- **No external API keys**: all LLM prompts go through `api/_lib/gemini.js`. Do not add Azure
  OpenAI endpoints or keys — that is HANDOFF landmine #1.

## Change recipes

1. **Add a new audit rule (R5+):** add a rule checker function in `audit.js` following the
   `checkDataCompleteness`/`check485DocumentDates`/… pattern (return `findings[]`); call it in
   `auditRcm`'s per-record loop; add a corresponding fix branch in `rework.js`'s `applyFixes`
   if the finding is fixable.
2. **Change CPT decision logic:** edit the `decideCptCode` function in `rcm.js`; the UNIQUE index
   key includes `cpt_code`, so changing the code for an existing episode+month pair will create a
   new record (old code row remains unless you add a delete step).
3. **Change CC-note prompt:** edit `BUILD_CC_NOTE_PROMPT` in `aiService.js`; keep the "nopii + 6para"
   hybrid structure and the 7 strict rules (no PII, no pharmaceutical claims, etc.) — they were
   ported verbatim from the reference to satisfy compliance.
4. **Extend extraction regex:** add a new `Rx*` extractor object to the `EXTRACTORS` array in
   `extraction.js`; it will run in Tier 1 before Gemini. Map the extracted field to the correct
   patch path (`patient.*`, `order.*`, or `references.*`).

## Related

- [builder catalog](./builder-catalog.md) — declares the 6 new system actions + 3 human agency-outreach actions that invoke these fns
- [task registry](./task-registry.md) — the `taskKey` handler stubs that call these module exports
- [db/schema](../../db/schema.md) — `rcm_records` + `audit_records` tables (migration 004)
- [workflow-runs route](../routes/workflow-runs.md) — `tickHandler` stamps `dayBucket` on `daily_time` items; `appendIssuesToRun` is the mid-run append seam
- [utils](./utils.md) — `gemini.js` (Tier 2 extraction + CC-note generation), `config.js` (GEMINI_API_KEY)
- `reference/HANDOFF.md` — the source .NET 8 bundle map with landmines; §1.1–§1.5 describe the five pipeline subsystems; §1.2 is `BusinessRequirementsService.cs` (the source for `businessRules.js`)
- `api/_lib/referenceLogic/businessRules.js` — pure utility exports used by `rcm.js` + `aiService.js`; no taskKey, no DB access
