# Worker Pages — employee 2FA portal with task buckets + per-action checklist detail

**Source:** `src/pages/worker/WorkerPortal.jsx`, `src/pages/worker/WorkerTaskDetail.jsx`
**Read this when:** changing the worker login/TOTP flow, the Untouched/Processing/Done buckets, how a task is opened/claimed, any per-action input (builder actions or legacy system-workflow panels), or the complete-task submit payload/error contract.

## What it does
`WorkerPortal` is the standalone `/worker` app (own chrome, no sidebar): two-step login (username/password → 6-digit TOTP via `workerLogin`/`workerTotp`), then three bucket tabs — **Untouched | Processing | Done** — fed by `fetchMyBuckets()` (bearer-scoped `GET /api/work-items`) with a 5s poll. Clicking an Untouched/Processing card calls `openWorkItem` — the API claims the task, stamps `opened_at` (Untouched → Processing) and returns the checklist detail; Done cards open read-only from the bucket row alone. `WorkerTaskDetail` renders the context panel (patient/order summary + PDF iframe) plus one input row per action, and submits `completeDbWorkItem` — builder tasks send `payload.actionResults`, legacy system-workflow tasks reuse the old WorkBucket panels (email compose, CPO minutes, missing-fields editor).

## Key functions / exports
| name | signature (params -> return) | behavior in one line | called by |
|---|---|---|---|
| `WorkerPortal` (default) | `() -> JSX` | Phase machine `boot → login → totp → portal`; session restore, poll, tabs, detail swap | `src/WorkerApp.jsx` |
| `loadBuckets` | `() -> Promise<boolean>` | Fetch `{employee, untouched, processing, done}`; 401 → `resetToLogin('session expired')` | mount restore, 5s poll, open/back/complete |
| `openTask` | `(row) -> Promise` | `openWorkItem(row.id)` claims + returns detail; merges bucket row into `opened.task` to keep joined fields | `TaskCard` onOpen (untouched/processing) |
| `detailFromDoneRow` | `(row) -> detail` | Builds a `readOnly:true` detail straight from the bucket row (Done tasks cannot be re-opened via the API) | `TaskCard` onOpen (done) |
| `resetToLogin` | `(message) -> void` | Clears worker token + all portal state, shows amber notice on the login form | 401 paths, sign-out, TOTP "different account" |
| `TaskCard` | `({ row, bucket, onOpen, opening }) -> JSX` | Card: name, workflow badge, action count, patient/order chips, per-bucket timestamp + CTA (Open/Resume/View) | bucket list |
| `WorkerTaskDetail` (default) | `({ detail, onBack, onCompleted, onAuthExpired }) -> JSX` | Context + checklist + submit; read-only rendering for Done | `WorkerPortal` |
| `initialActionResult` | `(action, payload) -> object` | Prefill per `actionKey` (email to/subject/body from references + `subjectTemplate` interpolation, dates via `ymd`, `minutes:'30'`, …) | detail `useState` init |
| `BuilderActionInput` | `({ action, value, onChange, payload }) -> JSX` | The right control set per builder `actionKey`; default = "Done" checkbox | action rows |
| `buildSubmit` | `() -> { notes, payload }` | Picks the submit shape: legacy email / legacy CPO / legacy missing-fields / builder `actionResults` | `submit` |
| `lifecycleFromDecisions` | `(decisions) -> {objectName: state}` | Client mirror of server `objectLifecycle()` → chips (found/created/updated/missing/skipped/in-review/pending) | `LifecycleStrip` in `RecordSummary` |
| `MissingFieldsEditor` | `({ patch, setPatch, missingFields }) -> JSX` | Inputs only for fields present in `FIELD_DEFS` (maps `payload.missingFields` keys → section+path) | legacy fallback + `fill_missing_fields` action |
| `interpolate` / `templateContext` | `(template, ctx) -> string` | `{{orderNumber}} {{patientName}} {{pgName}} {{hhahName}}` substitution; unknown tokens left as-is | email prefills |

## Data shapes
Bucket row (from `GET /api/work-items`, fields this UI reads): `id, run_id, name, task_key, workflow_id, workflow_name, actions[], action_state{}, patient_payload, order_payload, reference_payload, extraction_payload, decisions, output, notes, created_at, run_created_at, opened_at, completed_at`.
Detail object (open response merged in `openTask`, or `detailFromDoneRow`):
```js
{ task: { ...bucketRow, ...openedTaskRow },   // open response task is the RAW task-run row
  actions: [{ id, actionKey, label, params?, taskKey? }],   // actionKey 'legacy' = system-workflow human task
  actionState: { [actionId]: outputObject },                // read-only rendering
  payload: { patient, order, references, extraction, decisions, missingFields },
  pdf: { fileName, blobUrl|url, signed } | null,
  readOnly: boolean }
```
`completeDbWorkItem({ runId, taskRunId, notes, payload })` → `POST /api/work-items/:taskRunId/complete`. The four `payload` variants from `buildSubmit`:
```js
// builder task:                { actionResults: { [actionId]: result } }
// legacy email task:           { recipient, subject, notes }            // note: 'recipient', NOT 'to'
// legacy billing.addCpoMinutes:{ cpoMin: Number(minutes) || 30 }
// other legacy:                payloadForSubmit(patch)  // { patient, order, references:{...,practitioner,PG,HHAH}, practitioner, PG, HHAH }
```
Per-`actionKey` result shapes (must match server validation in `human.performActions`): `send_email_to_physician|hhah → {to, subject, body, confirmed}`; `enter_admission_dates → {SOC, EOC}`; `enter_episode_dates → {SOE, EOE}`; `fill_missing_fields → {patient, order, references}`; `review_record → {approved}`; `add_cpo_minutes → {minutes}`; `mark_order_sent → {}` (no input); default `→ {confirmed}`.
Completion error contract: `400` with `error.actionErrors = { [actionId]: message }` keeps the task Processing and highlights the failing rows; `401` → `onAuthExpired()`.
Legacy email panels: `LEGACY_EMAIL_TASKS` keyed by `task.task_key` — `area.sendMissingUploadNotification`, `billing.sendHhahMissingDocumentEmail`, `billing.sendPhysicianReminder`, and `signing.emailPhysicianReminder` (alias to the same spec object). Each = `{ tone, banner(payload), defaults(payload) -> {to,subject,body}, sendLabel }`.

## Invariants & gotchas
- **Done tasks are never re-opened through the API** — `detailFromDoneRow` synthesizes the detail from the bucket row (`actions`, `action_state`, `*_payload`, `extraction_payload.pdf`). Renaming bucket-row columns breaks the Done view even if the open endpoint still works.
- **`openTask` merges rows on purpose**: the open response `task` is the raw task-run row without joins, so the code does `task: { ...row, ...opened.task }` to keep `workflow_name`/`run_created_at` for the header. Dropping the merge silently blanks the header badges.
- `WorkerTaskDetail` is keyed `key={detail.task.id}` and all its state initializers are lazy `useState(() => ...)` — state resets only when a different task opens; the initializers run once per task.
- Legacy detection is `actions.length === 1 && actions[0].actionKey === 'legacy'`; the WHICH-panel decision then keys off `task.task_key`. Legacy email + legacy CPO panels render standalone (no RecordSummary/PDF — `showRecordContext`/`showPdf` are gated off); every other task shows context + PDF beside the checklist.
- The Notes textarea is hidden for legacy email tasks because the email **body is** the notes (`buildSubmit` sets `notes: legacyEmail.body`).
- `signing.emailPhysicianReminder` is a reference to the `billing.sendPhysicianReminder` spec object — mutating one mutates both.
- `ymd()` only accepts strings starting `YYYY-MM-DD`; Date objects or other formats prefill as `''` (empty date inputs), never crash. `interpolate` leaves unresolved `{{tokens}}` visible in the subject.
- "Back to buckets" deliberately keeps the task in Processing (`opened_at` stays stamped); only successful completion moves it to Done (`handleCompleted` switches to the Done tab + green notice).
- The 5s poll skips when `document.hidden` and only runs in `phase === 'portal'`; any 401 from poll/open/complete funnels through `resetToLogin` / `onAuthExpired` with the "session expired" notice.
- Auth tokens live under kind `'worker'` (`getAuthToken/clearAuthToken('worker')` in `src/lib/authApi.js`); `workerTotp` stores the real token, `workerLogin` only returns a `tempToken`. Session restore on mount = try `fetchMyBuckets()` with the stored token.
- CPO minutes: legacy panel seeds from `payload.extraction.cpoMin` when ≥30 else `'30'`; builder `add_cpo_minutes` always seeds `'30'`. Min-30 enforcement is server-side; inputs only set `min="30"`.
- `PdfPanel` uses `pdf.blobUrl || pdf.url` in an iframe and shows a signed/unsigned badge from `pdf.signed === true`; no URL renders the "filename must match the order number" hint.

## Change recipes
1. **Add a new builder action input**: add a case to `BuilderActionInput` AND a prefill case to `initialActionResult` in `WorkerTaskDetail.jsx`; add the action to the server catalog and its validation/execution in `taskRegistry.js` (`human.performActions`) — the 400 `actionErrors` keys must be action ids ([builder](builder.md) covers the authoring side).
2. **Add a new legacy email task**: add a `LEGACY_EMAIL_TASKS[task_key]` entry (`tone`, `banner`, `defaults`, `sendLabel`) in `WorkerTaskDetail.jsx`; the server task fn must read `{recipient, subject, notes}` from the completion payload.
3. **Add/rename a bucket**: edit `TABS` + `EMPTY_COPY` + `EMPTY_BUCKETS` and the `TaskCard` per-bucket timestamp/CTA switch in `WorkerPortal.jsx`, and return the new array from `GET /api/work-items` ([work-items route](../../backend/routes/work-items.md)).
4. **Change claim/open semantics** (e.g. unclaim, reassign): change `openTask`/`handleBack` in `WorkerPortal.jsx` and the `action:'open'` handler server-side — today opening is the only state transition besides complete, and it is one-way.
5. **Support a new missing field**: add a `FIELD_DEFS['<dotted.key>']` entry (label, `section`: patient|order|references, `path`) in `WorkerTaskDetail.jsx`; the server must emit that key in `payload.missingFields` and accept it in the `payloadForSubmit` merge shape.

## Related
- [work-items route](../../backend/routes/work-items.md) — buckets/open/complete API this page drives
- [auth-model](../../business/auth-model.md) — employee accounts, TOTP, worker bearer sessions
- [task-registry](../../backend/lib/task-registry.md) — server execution of `human.performActions` + legacy task fns
- [frontend lib](../lib.md) — `fetchMyBuckets`/`openWorkItem`/`completeDbWorkItem`/`authApi` contracts
- [eligibility-billing](../../business/eligibility-billing.md) — why CPO-minutes and billing email tasks exist
- [builder](builder.md) — where the actions rendered here are authored
