# Orders & Signing — order lifecycle, duplicate policy, sent → signed, bulk sign

**Source:** `api/_lib/repositories.js` (`writeOrderBundle`, `markOrderSentToPhysician`, `markOrderSignedByPhysician`, `bulkSignOrders`, `listPgUnsignedOrders`, `listOrders`), `api/_lib/taskRegistry.js` (`order.create`, `order.checkFields`, `order.skipDuplicate`, `signing.*`), `api/_lib/workflowEngine.js` (`startBulkSigningRun`), `api/_lib/workflowDefinition.js` (`WF_SIGNING_DEFINITION`), `api/orders/index.js`
**Read this when:** changing how orders are created/deduped, how they get marked sent/signed, the wf-signing follow-up, or PG bulk signing.

## The business rules
1. **Orders are unique by `order_number`.** A second upload of the same order number is **SKIPPED, never overwritten** — the existing order is left untouched (`order_skipped_duplicate` decision).
2. **An order needs its fields + a matched PDF to be "ready"** before it's created (`order_fields_ready` vs `order_fields_missing`). A human can fill missing fields first.
3. **An order attaches to the episode** built by the patient model (see [patient model](patient-model.md)).
4. **Sent → signed is a two-step lifecycle.** An order is first *marked sent to the physician* (by a human task action or a system step), then *signed* by the physician (bulk sign in the PG portal, or a signed-ZIP upload that pre-stamps it signed).
5. **Trigger 3 (wf-signing)** fires once per wf7 run after every item's Review passes: one signing item per distinct written (non-duplicate) order. Orders whose PDF came from the SIGNED zip are pre-stamped signed so no reminder is raised.
6. **Bulk sign is practitioner-scoped:** only a signed-in PG practitioner signs, and only orders for their PG that were marked sent and are still unsigned appear in their queue.

## How the rules map to code
| Rule | Code |
|---|---|
| Unique by order_number, skip duplicate | `orders.order_number` UNIQUE; `writeOrderBundle` returns `{skipped:true}` if exists; `order.skipDuplicate` task |
| Fields + PDF readiness | `order.checkFields` (`order_fields_ready`); `findPdfForOrder`/`orderHasMatchedPdf` in `taskRegistry.js` |
| Create + attach to episode | `order.create` → `writeOrderBundle` (sets `patient_id`/`admission_id`/`episode_id`) |
| Mark sent | `markOrderSentToPhysician(orderId)` (sets `order_status.SendToPhysician_Status` + date); human action `mark_order_sent` / system `signing.sendToPhysician` |
| Mark signed | `markOrderSignedByPhysician` / `bulkSignOrders`; `order_status.SignedByPhysician_Status` + `SignedByPhyscianDate` |
| wf-signing follow-up | `startBulkSigningRun(wf7RunId)` in `workflowEngine.js`; `WF_SIGNING_DEFINITION` |
| Bulk sign queue + auth | `listPgUnsignedOrders(pgId)`; `bulkSignOrders`; `POST /api/orders {action:'bulkSign'}` requires pg-practitioner session |

## Data shapes
```js
// orders row (key columns)
{ id, order_number /* UNIQUE */, order_type, document_type, order_date,
  patient_id, admission_id, episode_id, agency_id, pg_id,
  order_status: { SendToPhysician_Status?:bool, SentToPhysicianDate?,
                  SignedByPhysician_Status?:bool, SignedByPhyscianDate? },
  order_admission_details, raw_data }
// bulkSignOrders({orderIds[], pgId, date}) -> { updated:[…], skipped:[…] }
// signing item extraction_payload:
{ sourceRunId, sourceItemId, orderId, orderNumber, pdf:{fileName,blobUrl,blobPath,signed} }
```
Note the misspelled JSON key **`SignedByPhyscianDate`** (in the DB payload) — match it exactly; it is not a typo you should "fix" without a migration/data update.

## Invariants & gotchas
- **Duplicate = skip, not update.** If you expect a re-upload to change an order, it won't — `writeOrderBundle` bails on conflict. Change this only if the business rule changes.
- **`mark_order_sent` refuses to no-op:** the human action validates that a real created order is linked to the task (via `extraction_payload.orderId`); completing without one is a 400 (this was an owner-mandated fix). See [builder-catalog](../backend/lib/builder-catalog.md) for validate/execute detail and [work-items route](../backend/routes/work-items.md) for the 400-retry path.
- **Signed-ZIP orders skip the reminder path:** `startBulkSigningRun` pre-stamps `order_status` signed for orders whose matched PDF came from the signed ZIP, so `signing.checkSignedWithin48h` resolves to signed and no overdue email fires.
- **Trigger 3 fires exactly once per wf7 run** and only after ALL items' `human.reviewRecord` completed — a single failed item blocks it forever for that run (see [intake pipeline](intake-pipeline.md)).
- **Bulk sign PG scope comes from the session**, never the request body — the client can't sign for a PG it isn't logged into.
- Only orders **marked sent AND unsigned** appear in `listPgUnsignedOrders` — an order created but never sent won't show in the signing queue.
- Order status is a jsonb blob, not columns — filter/sort in SQL via `order_status->>'…'`.

## Change recipes
1. **Change the duplicate policy:** edit `writeOrderBundle` (the conflict branch) in `repositories.js` + `order.skipDuplicate` in `taskRegistry.js`.
2. **Change sent/signed semantics or keys:** edit `markOrderSentToPhysician`/`markOrderSignedByPhysician`/`bulkSignOrders` in `repositories.js` (mind the `SignedByPhyscianDate` spelling); consumers are the [PG portal](../frontend/pages/portals.md) + eligibility.
3. **Change what wf-signing includes / when it fires:** `startBulkSigningRun` + the `allReviewed` predicate in `completeHumanTask` (both [workflow-engine](../backend/lib/workflow-engine.md)).
4. **Change the bulk-sign queue filter:** `listPgUnsignedOrders` in `repositories.js`.
5. **Add an order human action:** add to `HUMAN_ACTIONS` in [builder-catalog](../backend/lib/builder-catalog.md) + its validate/execute in `human.performActions` ([task-registry](../backend/lib/task-registry.md)).

## Related
- [patient model](patient-model.md) — the episode orders attach to
- [intake pipeline](intake-pipeline.md) — order phase + Trigger 3 firing
- [eligibility & billing](eligibility-billing.md) — "all orders signed" drives billable
- [repositories](../backend/lib/repositories.md) — order write/sign SQL
- [workflow-definitions](../backend/lib/workflow-definitions.md) — `WF_SIGNING_DEFINITION`
- [PG portal frontend](../frontend/pages/portals.md) — the Bulk Sign UI
- [data-reads route](../backend/routes/data-reads.md) — `GET /api/orders` + `bulkSign`
