# Backend Utils — config, db, http, mailer, gemini, blobStore, multipart, normalizers

**Source:** `api/_lib/config.js`, `api/_lib/db.js`, `api/_lib/http.js`, `api/_lib/mailer.js`, `api/_lib/gemini.js`, `api/_lib/blobStore.js`, `api/_lib/multipart.js`, `api/_lib/normalizers.js`
**Read this when:** touching env/credentials, the Neon client, HTTP response/error helpers, outbound email, PDF AI extraction, Blob upload, multipart parsing, or the name/date/key normalizers.

## What each file does
- **`config.js`** — every credential as `export const X = process.env.X || '<hardcoded fallback>'`: `DATABASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL` (`gemini-2.5-flash`), `BLOB_READ_WRITE_TOKEN`, and SMTP (`SMTP_HOST/PORT/SECURE/USER/PASS/FROM`). Env vars override. **These are live secrets committed to the repo** — rotate before real use (see [ops](../../ops/scripts-and-deploy.md)).
- **`db.js`** — `getSql()` returns a cached Neon serverless HTTP client (tagged-template SQL). `jsonParam(value)` wraps a value for a jsonb column. Every repo call goes through `getSql()`.
- **`http.js`** — `sendJson(res, status, body)`, `methodNotAllowed(res, allowed)`, `readJson(req)` (buffers the body, parses JSON, `{}` if empty), and `handleError(res, error)`: maps `error.status` (from `httpError`) straight to the HTTP code and merges `error.details` (e.g. `messages`, `actionErrors`) into the body; `'not configured'` → 503, else 500.
- **`mailer.js`** — `sendEmail({to, subject, text, html}) -> {sent, ...}`. Best-effort: no SMTP config → `{sent:false, skipped:true}`; no recipient → skip; a send throw is **caught** and returned as `{sent:false, skipped:true, reason}` — email NEVER throws/deadlocks a workflow.
- **`gemini.js`** — wraps `@google/genai` to extract missing patient/order fields from an order PDF buffer (used by the `ai.extractMissingDataFromPdf` task).
- **`blobStore.js`** — `uploadPdfBufferToBlob(...)` (skips gracefully with no token), plus PDF↔order-number helpers `orderNumberFromPdfName` / `withPdfOrderKey` used by the intake pipeline.
- **`multipart.js`** — parses `multipart/form-data` uploads into fields + files (workbook + `unsignedZip`/`signedZip`). Fields arrive as arrays (hence `firstField` in the route).
- **`normalizers.js`** — the identity/key + date functions the whole domain shares (below).

## Key functions / exports
| file | export | signature -> return | behavior |
|---|---|---|---|
| db.js | `getSql` | `() -> neon sql` | cached tagged-template client |
| db.js | `jsonParam` | `(value) -> param` | jsonb bind helper |
| http.js | `sendJson`/`methodNotAllowed`/`readJson`/`handleError` | see above | HTTP plumbing every route uses |
| mailer.js | `sendEmail` | `async ({to,subject,text,html}) -> {sent,skipped?,reason?,messageId?}` | best-effort, never throws |
| normalizers.js | `normalizeName` | `(v)->string` | lowercased, single-spaced |
| normalizers.js | `normalizeNpi` | `(v)->string` | digits only |
| normalizers.js | `patientKey` / `patientKeyFromParts` | `(patient) / (name,dob,mrn) -> 'name|dob|mrn'` | the join + item `patient_key` |
| normalizers.js | `unitKey` | `(patient) -> string` | == `patientKey` — the stable Patient Unit identity |
| normalizers.js | `recordContextKey` | `(patient, reference) -> 'unitKey|hhah|pg'` | the Patient Record key (forks on HHAH/PG change) |
| normalizers.js | `parseDate` | `(value) -> 'YYYY-MM-DD'\|null` | handles Date objects, Excel serials, and strings |
| normalizers.js | `cleanString`/`blankToNull`/`hasValue`/`safeJson` | small guards | trim/empty/jsonb-default helpers |

## Data shapes
```js
// password/session/etc. shapes live in md/backend/lib/auth.md, not here.
// normalizers key formats:
patientKey  = `${normalizeName(name)}|${dob.toLowerCase()}|${normalizeName(mrn)}`
recordContextKey = `${unitKey}|${normalizeName(HHAH.name)}|${normalizeName(PG.name)}`
sendEmail() -> { sent:true, messageId, accepted, rejected }
            |  { sent:false, skipped:true, reason:'smtp_not_configured'|'no_recipient'|'smtp_error: …' }
```

## Invariants & gotchas
- **`parseDate` is the canonical date coercer.** Neon returns date columns as JS `Date` objects; raw `String(dateObj).slice(0,10)` produced `NaN`-day bugs historically. Always route dates through `parseDate` (and the repo's `dateOnly`/`dayDiff`) — never string-slice a date yourself.
- **`unitKey === patientKey`** by definition; if you change one, both move. `recordContextKey` layers HHAH+PG on top — changing name normalization silently re-buckets who counts as "the same patient/record."
- `handleError` is the ONLY place HTTP status is derived from thrown errors — throw `httpError(status, msg, details)` (from [auth](./auth.md)) anywhere and it maps correctly; a plain `Error` becomes 500.
- `sendEmail` swallowing failures is deliberate — a dead Gmail login must not block Trigger-4 human tasks. If you need delivery guarantees, that's a design change, not a bug.
- `config.js` fallbacks mean the app runs with zero env vars (personal-test convenience) — but the committed Neon/Gemini/Blob/SMTP creds are real. Treat the repo as public-secret-leaked.
- `getSql()` is a serverless HTTP client (not a pooled TCP connection) — fine for one query per call, but the N+1 pattern (a query per row) is slow from a distant region; batch where you can (see `listTaskRunsForRuns`).

## Change recipes
1. **Add a credential/env var:** add `export const X = process.env.X || '<default>'` to `config.js`; import where needed. Document it in [ops](../../ops/scripts-and-deploy.md).
2. **Change how errors become HTTP responses:** edit `handleError` in `http.js` (all routes funnel through it).
3. **Change patient identity/dedup:** edit `patientKey`/`unitKey`/`recordContextKey` in `normalizers.js` — this reshapes joins AND dedup everywhere; see [patient model](../../business/patient-model.md).
4. **Change email content/behavior:** edit `sendEmail` in `mailer.js`; callers are the billing/notification human tasks in [task-registry](./task-registry.md).
5. **Change PDF↔order matching:** `orderNumberFromPdfName`/`withPdfOrderKey` here must agree with `pdfMetadataForItem` (route) and `findPdfForOrder` (task-registry) — see [intake pipeline](../../business/intake-pipeline.md).

## Related
- [repositories](./repositories.md) — every SQL function built on `getSql`
- [auth](./auth.md) — `httpError` consumed by `handleError`
- [db schema](../../db/schema.md) — the tables `getSql` talks to
- [intake pipeline](../../business/intake-pipeline.md) — uses multipart, blobStore, gemini, normalizers
- [patient model](../../business/patient-model.md) — the key functions' business meaning
- [ops & deploy](../../ops/scripts-and-deploy.md) — env/credentials conventions
