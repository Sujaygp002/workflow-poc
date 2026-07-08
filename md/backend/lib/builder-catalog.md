# Builder Catalog — the fixed palette (triggers, actions, conditions) + human-action validate/execute

**Source:** `api/_lib/builderCatalog.js`
**Read this when:** adding/renaming a palette trigger, system action, human checklist action, or condition; changing checklist validation messages or side effects; debugging why a builder task rejects a submission or why an email/order/CPO side effect didn't run.

## What it does
Defines the entire vocabulary the workflow builder can use, as data. `TRIGGERS`, `ACTIONS` (system, unattended), `HUMAN_ACTIONS` (employee checklists with server-side `validate` + optional `execute`), and `CONDITIONS` (each with a declared `negation` so if/else can compile). Every entry maps to EXISTING code — taskRegistry keys, repository functions, `mailer.sendEmail`. `runHumanActions` is the runtime: validate all submitted action results, and only if all pass, run each action's `execute()`. `builderCatalog()` serializes the palette (implementation stripped) for the builder UI.

## Key functions / exports
| name | signature (params -> return) | behavior in one line | called by |
|------|------------------------------|----------------------|-----------|
| `TRIGGERS` | `[{ key, label, description, params? }]` | 4 trigger types: `document_upload`, `manual`, `time_interval` (params:['intervalSeconds']), `daily_time` (params:['hour','minute','tz'] — fires once per day per active agency) | `builderCompiler.validateGraph`, `builderCatalog()` |
| `ACTIONS` | `{ [key]: { key, kind:'system', label, taskKey, actor? } }` | 19 system actions; `ai_extract_pdf_fields`, `run_ai_service`, `run_ai_audit`, `run_ai_rework`, `ai_extract_with_patterns` set `actor:'ai'`; 6 new Daily Agency Intake → RCM Pipeline actions (see table below) | `builderCompiler` (validate + compile), `builderCatalog()` |
| `HUMAN_ACTIONS` | `{ [key]: { key, label, inputs[], validate?, execute? } }` | 12 checklist actions (9 original + 3 new agency-outreach: `call_agency`, `sms_agency`, `email_agency`) | `runHumanActions`, `builderCompiler` (validate + label fallback), `builderCatalog()` |
| `CONDITIONS` | `{ [key]: { key, label, negation, description } }` | 24 condition keys (12 pairs); 3 new pairs for the RCM pipeline: `agency_uploaded`/`agency_not_uploaded`, `ai_service_failed`/`ai_service_ok`, `audit_failed`/`audit_passed` | `builderCompiler` (branch compilation + per-key descriptions), `builderCatalog()` |
| `runHumanActions` | `({ actions, results, item }) -> { errors: {actionId: msg}, outputs: {actionId: out} }` | Validates ALL actions first (unknown actionKey = error); any error → `{ errors, outputs:{} }` and NO execute runs; else runs each `execute` in order (no-execute actions output `{ done:true }`) | `taskRegistry['human.performActions']` |
| `builderCatalog` | `() -> { triggers, actions:{system[],human[]}, conditions[] }` | Palette for the UI — strips `taskKey`/`validate`/`execute`, keeps key/label/kind/inputs/negation/description | `api/workflows/index.js` action `catalog` |
| `resolveOrderForItem` (internal) | `(item) -> order row \| null` | Real order for an item: `extraction_payload.orderId` (stamped by a prior Create-order step) via `findOrderById`, else `order_payload.order_info.order_number` via `findOrder` | `mark_order_sent` validate + execute |
| `mergeDeep` (internal) | `(target, source) -> merged` | Deep object merge that **skips** `undefined`/`null`/`''` source values (can never blank a field) | date/field-fill executes |

## Data shapes
`HUMAN_ACTIONS` behavior matrix (validate error message returned to the client verbatim):
| actionKey | inputs | validate requires | execute side effect |
|-----------|--------|-------------------|---------------------|
| `send_email_to_physician` | to, subject, body, confirmed | valid email `to`, `confirmed === true` | `sendEmail(...)`; if `item.extraction_payload.orderId` set → `markOrderSentToPhysician(orderId)`; returns `{ email_sent, email_skipped, email_reason, orderId }` |
| `send_email_to_hhah` | to, subject, body, confirmed | same as above | `sendEmail(...)` only |
| `enter_admission_dates` | SOC, EOC | `SOC` valid `YYYY-MM-DD` (EOC optional but validated) | mergeDeep into `patient_payload.admission_details` via `updateItem` |
| `enter_episode_dates` | SOE, EOE | both valid dates, `SOE <= EOE` | mergeDeep into `patient_payload.admission_details` |
| `fill_missing_fields` | patient, order, references | result is an object | mergeDeep each sub-object into the item's three payloads |
| `review_record` | approved | `approved === true` | stamps `decisions.record_reviewed = true` |
| `add_cpo_minutes` | minutes | `minutes >= 30` AND `item.extraction_payload.cpoMonthId` present | `updateCpoMinutes({ cpoMonthId, cpoMin })`; returns `{ cpoMonthId, cpoMin, status }` |
| `mark_order_sent` | (none) | `resolveOrderForItem(item)` finds a row (async validate) | `markOrderSentToPhysician(order.id)`; throws `NO_LINKED_ORDER_MESSAGE` if the order vanished between validate and execute |
| `confirm_checklist` | confirmed | `confirmed === true` | none → output `{ done:true }` |
| `call_agency` | confirmed, note | `confirmed === true` | placeholder only — no live telephony; returns `{ channel:'call', placeholder:true, note }` |
| `sms_agency` | confirmed, note | `confirmed === true` | placeholder only — no SMS integration; returns `{ channel:'sms', placeholder:true, note }` |
| `email_agency` | to, subject, body, confirmed | valid email `to`, `confirmed === true` | `sendEmail(...)` (to = agency contact email, pre-fillable from `referencePayload.HHAH.contact.email`); returns `{ channel:'email', email_sent, email_skipped, email_reason }` |

New system actions added for the Daily Agency Intake → RCM Pipeline:
| actionKey | taskKey | actor | behavior |
|-----------|---------|-------|----------|
| `check_agency_upload` | `agency.checkUploadedToday` | system | queries `uploaded_documents` for the item's agency + `dayBucket`; stamps `agency_uploaded`/`agency_not_uploaded` |
| `ai_extract_with_patterns` | `ai.extractWithPatterns` | ai | Tier 1 regex extraction (referenceLogic/extraction.js) → Tier 2 Gemini fallback for unfilled fields |
| `run_ai_service` | `ai.runService` | ai | CC-note generation + CPO minute distribution (referenceLogic/aiService.js); stamps `ai_service_failed`/`ai_service_ok` |
| `generate_rcm` | `rcm.generate` | system | CPT decision tree (G0179/G0180/G0181/G0182), upserts `rcm_records` (referenceLogic/rcm.js) |
| `run_ai_audit` | `ai.audit` | ai | rules R1–R4 audit over `rcm_records`; writes `audit_records`; stamps `audit_failed`/`audit_passed` |
| `run_ai_rework` | `ai.rework` | ai | bounded auto-fix + re-audit loop (up to 3 cycles); re-stamps `audit_failed`/`audit_passed` |

`runHumanActions` input (from `human.performActions`):
```js
{ actions: [{ id:'a1', actionKey:'send_email_to_physician', label, params:{ subjectTemplate? } }],
  results: { a1: { to, subject, body, confirmed } },   // payload.actionResults keyed by action id
  item }                                               // full workflow_items row
```
Catalog response (per `builderCatalog()`):
```js
{ triggers: TRIGGERS,
  actions: { system: [{ key, label, kind:'system' }], human: [{ key, label, kind:'human', inputs }] },
  conditions: [{ key, label, negation, description }] }
```

## Invariants & gotchas
- **Two-phase, half-transactional**: validation is all-or-nothing (one bad action blocks every execute), but the execute loop is sequential and NOT rolled back — if action 2's execute throws after action 1 sent an email, the task stays active and a resubmit re-sends action 1's email.
- `validate` may be **async** (`mark_order_sent` hits the DB) — `runHumanActions` awaits every validate; new validates can query freely.
- `mergeDeep` treats `''`/`null`/`undefined` as "no value": a human action can never CLEAR an existing field, only set/overwrite with a non-empty value. Intentional.
- `send_email_to_physician` stamps sent-to-physician only via `item.extraction_payload.orderId` (no order-number fallback), while `mark_order_sent` uses `resolveOrderForItem` (orderId first, then order-number lookup). The asymmetry means an email action on an item without a prior Create-order step sends the mail but never stamps the order.
- `sendEmail` (mailer.js) never throws — SMTP failure returns `{ sent:false, skipped:true, reason }`, so email actions COMPLETE even when nothing was delivered; check `email_sent` in the task output, not the task status.
- Every `CONDITIONS` key must also be handled by `taskRegistry.evaluateCondition`; a catalog-only key evaluates false at runtime → the gated step always skips. Negations must be symmetric (`a.negation === b.key` and vice versa) or the compiler stamps a wrong false-branch condition.
- Unknown `actionKey` at runtime is a per-action validation error (`Unknown action "x"`), not a crash — old runs survive palette renames only until someone submits.
- `time_interval` and `daily_time` triggers fire via two paths: (a) the Orchestrator's 10s poll now calls `tickTimeTriggers()` (which posts `{action:'tick'}`) as well as `runBillingMonitor`; (b) a Vercel cron (`vercel.json` `0 17 * * *`) hits `GET /api/workflow-runs?action=tick` daily. Without at least one of these running, neither trigger type advances.
- `daily_time` trigger params (`hour`/`minute`/`tz`) control the idempotency key (one run per agency per calendar day in the configured tz). The Vercel cron fires unconditionally at 17:00 UTC; whether that coincides with the configured hour/minute is the operator's responsibility.
- `add_cpo_minutes` depends on the item carrying `extraction_payload.cpoMonthId` — only billing-monitor issue items have it (stamped by `runBillingMonitorHandler` in `api/workflow-runs/index.js`).
- Date validation is strict `YYYY-MM-DD` string (`YMD_RE` + `Date.parse`) — Date objects or ISO datetimes are rejected.

## Change recipes
1. **Add a human checklist action**: add a spec to `HUMAN_ACTIONS` (unique `key`, `label`, `inputs[]`, `validate(action,result,item) -> msg|null`, optional async `execute(action,result,item) -> output`); use existing repo fns for side effects; then add the input form for its `inputs` in the worker task detail UI ([worker pages](../../frontend/pages/worker.md)).
2. **Add a system action**: add to `ACTIONS` with a `taskKey` that exists in `taskRegistry` (create the task fn in `api/_lib/taskRegistry.js` first if needed); set `actor:'ai'` only if the flowchart should render it as AI.
3. **Add a condition pair**: add both keys to `CONDITIONS` referencing each other via `negation`, then implement evaluation in `evaluateCondition` (`api/_lib/taskRegistry.js`) — stamp results into `item.decisions` so repeat evaluations are memoized.
4. **Change a validation message/rule**: edit the action's `validate` here only — the message flows verbatim to the 400 `actionErrors` response and the worker UI.
5. **Add a trigger type**: append to `TRIGGERS` (declare `params` if configurable), then extend the trigger check in `validateGraph` ([builder compiler](./builder-compiler.md)) and implement the firing path ([workflow-runs route](../routes/workflow-runs.md) or [bulk-upload route](../routes/bulk-upload.md)).

## Related
- [builder workflows (business)](../../business/builder-workflows.md) — rules this palette implements
- [builder compiler](./builder-compiler.md) — consumes ACTIONS/CONDITIONS/TRIGGERS at save time
- [task registry](./task-registry.md) — `human.performActions` caller + `evaluateCondition`
- [workflow engine](./workflow-engine.md) — retry-on-validation rule in `completeHumanTask`
- [repositories](./repositories.md) — `findOrder(ById)`, `markOrderSentToPhysician`, `updateCpoMinutes`, `updateItem`
- [utils](./utils.md) — `mailer.sendEmail` never-throw contract, `normalizers.hasValue`
