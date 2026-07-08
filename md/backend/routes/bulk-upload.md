# Bulk-Upload Route — HHAH document upload → workflow run(s)

**Source:** `api/workflows/bulk-upload/start.js`
**Read this when:** changing the upload HTTP contract, auth on upload, multipart-vs-JSON handling, or which workflow(s) an upload targets. (The deep item/task mechanics live in [intake pipeline](../../business/intake-pipeline.md) — read that for behavior; this is the endpoint surface.)

## What it does
`POST /api/workflows/bulk-upload/start` — the ONLY way an HHAH portal user sends data in. Requires an external `hhah` bearer session. Two modes: **multipart** (an `.xlsx` workbook + optional `unsignedZip`/`signedZip` of order PDFs — the real portal path) and **JSON** (pre-built items, for scripts). Parses/joins the workbook, matches PDFs to orders, then starts one run of each target workflow (builder `document_upload` workflows if any active, else system `wf7`), one item per joined row, and runs automation. `bodyParser` is disabled (`export const config`) so multipart streams raw.

## Key functions / exports
| name | signature -> return | behavior |
|---|---|---|
| `handler` (default) | `(req,res) -> 201 {run, tasks, runs, inputSummary}` | POST only; `requireHhahUser` first; branch multipart vs JSON |
| `targetWorkflows` | `() -> workflow rows` | active builder `document_upload` workflows, else active `wf7`; `ensureSystemDefinitions()` first |
| `requireHhahUser` | `(req) -> externalUser` | `requireSession {type:'external'}` + must be `user_type==='hhah'` (else 403) |
| `stampSessionAgency` | `(referencePayload, areaContext) -> ref` | forces the session agency onto every item's `reference_payload.HHAH` (overrides the workbook) |
| `resolveAreaUploadContext` | `(hhahUser, fields, body) -> {areaId, hhahId, hhah, …}` | agency from session; area/hhah form fields are fallbacks for scripts |
| `startRunForWorkflow` / `pdfsFromZip` / `pdfMetadataForItem` / `registerRunDocuments` | see [intake pipeline](../../business/intake-pipeline.md) | per-workflow run creation, PDF extraction/matching/upload |

## Data shapes
**Multipart request** (`Content-Type: multipart/form-data`, `Authorization: Bearer <cc_hhah_token>`):
- file field `workbook` = `.xlsx` (Sheet1 patients, Sheet2 orders — columns in [intake pipeline](../../business/intake-pipeline.md) §Data / and the [HHAH portal frontend](../../frontend/pages/portals.md)).
- file fields `unsignedZip`, `signedZip` = ZIPs of `<orderNumber>.pdf`.
- optional text fields `areaId`/`areaName`/`hhahId`/`hhahName` (fallbacks; the session agency wins).

**JSON request** (`Content-Type: application/json`): `{ items:[{patientPayload, orderPayload, referencePayload, extractionPayload}], areaId?, hhahId? }` — skips PDFs/blob entirely.

**Response** `201`:
```js
{ run:  /* first target workflow's full run object */,
  tasks:/* first run's task rows */,
  runs: [ /* full run object */ ],   // one per target workflow (same shape as `run`)
  inputSummary: { joinedRows, patientRows, orderRows, … } }
```

## Invariants & gotchas
- **Auth is enforced here, not just in the UI** — an unauthenticated POST (or a non-hhah user) is a 401/403. This is the fresh-auth guarantee: only External-Users-page HHAH accounts can upload.
- **The session's agency is authoritative** (`stampSessionAgency`) — whatever `Agencyname` the workbook says is overridden for every item, and stamped with `data_tags{source:'session_agency'}`. This is the root fix for the old "Unknown agency" map bug.
- **One upload can start MANY runs** — every active builder `document_upload` workflow gets a run. The top-level `run`/`tasks` in the response are only the FIRST; `runs[]` lists them all. If no builder workflow is active, `wf7` runs instead.
- `bodyParser:false` is required for multipart — do not remove `export const config`.
- JSON mode is script-only (seeds/tests); it bypasses blob + PDF matching, so items carry `extractionPayload` verbatim.
- This route counts toward the **12-serverless-function Vercel cap** — see [ops](../../ops/scripts-and-deploy.md) before adding new `api/*` files.

## Change recipes
1. **Change upload auth:** edit `requireHhahUser` (currently external + `user_type==='hhah'`).
2. **Change target-workflow routing:** edit `targetWorkflows` + `listActiveBuilderWorkflowsByTrigger` in [repositories](../lib/repositories.md).
3. **Change accepted files/fields:** edit the multipart branch + `parseMultipart` in [utils](../lib/utils.md) and the Excel columns in `excelParser.js`; keep the [HHAH portal](../../frontend/pages/portals.md) form in sync.
4. **Change item/task creation or PDF matching:** that's [intake pipeline](../../business/intake-pipeline.md) territory (`startRunForWorkflow`, `pdfMetadataForItem`).

## Related
- [intake pipeline](../../business/intake-pipeline.md) — the full behavior this endpoint kicks off
- [auth](../lib/auth.md) — `requireSession`/`httpError`
- [workflow-engine](../lib/workflow-engine.md) — `runWorkflowAutomation`
- [repositories](../lib/repositories.md) — run/item/document CRUD, workflow lookups
- [utils](../lib/utils.md) — multipart, blobStore, excelParser, normalizers
- [HHAH portal frontend](../../frontend/pages/portals.md) — the uploader UI + `startBulkUploadRun` client
- [builder workflows](../../business/builder-workflows.md) — why builder workflows take over the upload trigger
