# Bulk-Upload Route — HHAH document upload → daily run row-append

**Source:** `api/workflows/bulk-upload/start.js`
**Read this when:** changing the upload HTTP contract, auth on upload, multipart-vs-JSON handling, or how an upload targets today's daily run. (The deep item/task mechanics live in [intake pipeline](../../business/intake-pipeline.md) — read that for behavior; this is the endpoint surface.)

## What it does
`POST /api/workflows/bulk-upload/start` — the ONLY way an HHAH portal user sends data in. Requires an external `hhah` bearer session. Two modes: **multipart** (an `.xlsx` workbook + optional `unsignedZip`/`signedZip` of order PDFs — the real portal path) and **JSON** (pre-built items, for scripts). Parses/joins the workbook, matches PDFs to orders, then **appends one item per joined row** to today's daily run for each active `daily_time` builder workflow (creating the run on demand if it does not yet exist) — rather than creating a separate wf7 run per upload. The upload auto-resolves the agency's open contact task, writes `uploaded_documents` anchored to the daily run, and runs automation so rows flow from step n1 (uploaded branch) onward. `bodyParser` is disabled (`export const config`) so multipart streams raw.

> **Changed (2026-07-09):** uploads no longer create a standalone wf7 run per upload. `wf7` has been removed. The `targetWorkflows` / `wf7` fallback path is gone. Uploads now call `reconcileDailyRunForUpload`, which iterates ALL active `daily_time` builder workflows and appends row-level items (idempotent via `appendKey row:<hhahId>:<orderOrRowKey>:<dayBucket>`).

## Key functions / exports
| name | signature -> return | behavior |
|---|---|---|
| `handler` (default) | `(req,res) -> 201 {run, tasks, runs, inputSummary}` | POST only; `requireHhahUser` first; branch multipart vs JSON |
| `reconcileDailyRunForUpload` | `(wfDef, joinedRows, ctx) -> {run, tasks}` | for each active `daily_time` workflow: ensures today's daily run exists (creates with source label `daily:<wfId>:<dayBucket>` if absent), appends one item per joined row, auto-resolves the agency's open contact task, writes `uploaded_documents`, runs automation |
| `requireHhahUser` | `(req) -> externalUser` | `requireSession {type:'external'}` + must be `user_type==='hhah'` (else 403) |
| `stampSessionAgency` | `(referencePayload, areaContext) -> ref` | forces the session agency onto every item's `reference_payload.HHAH` (overrides the workbook); also sets `HHAH.id` + `HHAH.contact` |
| `resolveAreaUploadContext` | `(hhahUser, fields, body) -> {areaId, hhahId, hhah, …}` | agency from session; area/hhah form fields are fallbacks for scripts |
| `pdfsFromZip` / `pdfMetadataForItem` / `registerRunDocuments` | see [intake pipeline](../../business/intake-pipeline.md) | PDF extraction/matching/upload |

## Data shapes
**Multipart request** (`Content-Type: multipart/form-data`, `Authorization: Bearer <cc_hhah_token>`):
- file field `workbook` = `.xlsx` (Sheet1 patients, Sheet2 orders — columns in [intake pipeline](../../business/intake-pipeline.md) §Data / and the [HHAH portal frontend](../../frontend/pages/portals.md)).
- file fields `unsignedZip`, `signedZip` = ZIPs of `<orderNumber>.pdf`.
- optional text fields `areaId`/`areaName`/`hhahId`/`hhahName` (fallbacks; the session agency wins).

**JSON request** (`Content-Type: application/json`): `{ items:[{patientPayload, orderPayload, referencePayload, extractionPayload}], areaId?, hhahId? }` — skips PDFs/blob entirely; reshaped into the same joined-row append seam.

**Response** `201`:
```js
{ run:  /* first daily run object */,
  tasks:/* first run's task rows */,
  runs: [ /* daily run object */ ],   // one per active daily_time workflow
  inputSummary: { joinedRows, patientRows, orderRows, … } }
```

Each appended item carries `extraction_payload.appendKey = 'row:<hhahId>:<orderOrRowKey>:<dayBucket>'` for idempotent re-upload protection. `uploaded_documents` rows reference the daily run and the uploading agency's `hhahId`.

## Invariants & gotchas
- **Auth is enforced here, not just in the UI** — an unauthenticated POST (or a non-hhah user) is a 401/403. This is the fresh-auth guarantee: only External-Users-page HHAH accounts can upload.
- **The session's agency is authoritative** (`stampSessionAgency`) — whatever `Agencyname` the workbook says is overridden for every item, and stamped with `data_tags{source:'session_agency'}`. This is the root fix for the old "Unknown agency" map bug.
- **Re-uploading the same workbook is a no-op for items** — `appendKey` deduplication means a second upload with the same orders adds 0 new items to the daily run.
- **One daily run per day per active `daily_time` workflow** — `reconcileDailyRunForUpload` iterates ALL active `daily_time` workflows; every future `daily_time` workflow automatically participates.
- **`uploaded_documents` rows are the upload signal** — `agency.checkUploadedToday` queries them by `hhah_id` + today's bucket. They cascade-delete when the run is deleted.
- `bodyParser:false` is required for multipart — do not remove `export const config`.
- JSON mode is script-only (seeds/tests); it bypasses blob + PDF matching, so items carry `extractionPayload` verbatim.
- This route counts toward the **12-serverless-function Vercel cap** — see [ops](../../ops/scripts-and-deploy.md) before adding new `api/*` files.

## Change recipes
1. **Change upload auth:** edit `requireHhahUser` (currently external + `user_type==='hhah'`).
2. **Change target-workflow routing:** edit `reconcileDailyRunForUpload` + `listActiveBuilderWorkflowsByTrigger` in [repositories](../lib/repositories.md).
3. **Change accepted files/fields:** edit the multipart branch + `parseMultipart` in [utils](../lib/utils.md) and the Excel columns in `excelParser.js`; keep the [HHAH portal](../../frontend/pages/portals.md) form in sync.
4. **Change item/task creation or PDF matching:** that's [intake pipeline](../../business/intake-pipeline.md) territory (`pdfMetadataForItem`).

## Related
- [intake pipeline](../../business/intake-pipeline.md) — the full behavior this endpoint kicks off
- [auth](../lib/auth.md) — `requireSession`/`httpError`
- [workflow-engine](../lib/workflow-engine.md) — `runWorkflowAutomation`
- [repositories](../lib/repositories.md) — run/item/document CRUD, workflow lookups
- [utils](../lib/utils.md) — multipart, blobStore, excelParser, normalizers
- [HHAH portal frontend](../../frontend/pages/portals.md) — the uploader UI + `startBulkUploadRun` client
- [builder workflows](../../business/builder-workflows.md) — daily_time trigger + mid-run append seam
