# External Portals — HHAH upload portal and PG signing portal
**Source:** `src/pages/hhh/HhhLogin.jsx`, `src/pages/pg/PgLogin.jsx`
**Read this when:** changing the HHAH bulk-upload form, patient/order browsing in the HHAH portal, missing-upload notification banner, PG Bulk Sign flow, portal login/session-restore behavior, or portal scoping (agencyId/pgId).

## What it does
Two standalone external-facing portals, both gated by `externalLogin` accounts created on `/external-users`:
- **`/hhh-login`** (`HhhLogin.jsx`) — an HHAH (home health agency) signs in, uploads a bulk batch (1 xlsx + unsigned-PDF ZIP + signed-PDF ZIP) which starts a wf7 run, sees missing-upload notifications, and browses its own patients/orders (with eligible/billable chips, patient hierarchy tree, and inline order-PDF viewer).
- **`/pg-login`** (`PgLogin.jsx`) — a PG (physician group) user signs in; **practitioner** role gets the Bulk Sign view (select unsigned sent orders, sign in bulk); **admin** role gets a "Coming soon" dashboard placeholder.
Both portals enforce the account's `userType` at login and restore sessions from a scoped bearer token on mount.

## Key functions / exports
| name | signature (params -> return) | behavior in one line | called by |
|---|---|---|---|
| `HhhLogin` (default) | `() -> JSX` | Session-restore → LoginPanel or dashboard (metrics, upload form, patients/orders browser) | route `/hhh-login` in `src/App.jsx` |
| `LoginPanel` (both files) | `({onLogin}) -> JSX` | `externalLogin({username,password})`; rejects wrong `userType` (stores token then immediately `logout`s it); on success `setAuthToken(scope, token)` + `onLogin(user)` | portal roots |
| `refreshPatients` | `useCallback() -> Promise` | `Promise.all([fetchPatients({hhahId}), fetchOrders({hhahId}), fetchAreaIntakeStatus()])`; derives `areaContext` + this-HHAH notifications | mount (when `user` set), Refresh button, after upload |
| `uploadBatch` | `(event) -> Promise` | Requires workbook; `startBulkUploadRun({workbook, unsignedZip, signedZip, sourceLabel, areaId, hhahId, hhahName})`; shows joined-row count | Bulk Upload form submit |
| `openPatient` | `(patient) -> Promise` | Selects patient, loads `fetchPatientTree(patient.id)` for `PatientHierarchyView` | patient list buttons |
| `EligibilityChips` | `({status}) -> JSX` | eligible = status `'eligible'` OR `'billable'`; billable = `'billable'`; `'none'`/falsy renders both inactive | patient + order cards/detail |
| `NotificationBanner` | `({notifications}) -> JSX` | Amber banner of missing-upload reminders pushed by the Area Upload Monitor | HHAH dashboard top |
| `OrderPdfViewer` | `({order}) -> JSX` | iframe of `order.pdf_blob_url` + "Open PDF" link; placeholder tells you to name the PDF `ORDER_NUMBER.pdf` | order detail pane |
| `PgLogin` (default) | `() -> JSX` | Session-restore → LoginPanel; then `role==='practitioner' ? <BulkSign/> : <ComingSoonDashboard/>` | route `/pg-login` |
| `BulkSign` | `({user}) -> JSX` | Loads `fetchPgUnsignedOrders(pgId)`, checkbox multi-select, `bulkSignPgOrders({orderIds, pgId, date: todayYmd()})` | practitioner view |
| `todayYmd` | `() -> 'YYYY-MM-DD'` | Signing date sent with bulk sign (UTC slice of ISO string) | `bulkSign` |
| `signOut` (both) | `() -> void` | `logout(scope).catch(()=>{})` best-effort + clear all local state | header button |

## Data shapes
Session user (from `externalLogin`/`getSession`): HHAH → `{ userType:'hhah', agencyId, agencyName, displayName, username }`; PG → `{ userType:'pg', pgId, pgName, role:'admin'|'practitioner', displayName, username, npi? }`.
`getSession(scope)` returns `{ principalType:'external', user }` — anything else clears the token.
Patient row (HHAH list): `{ id, name, dob, mrn, latest_episode_status, admission_count, episode_count, order_count }`.
Order row (HHAH list + detail): `{ id, order_number, order_type, order_date, patient_name, patient_mrn, pg_name, agency_name, billing_provider_npi, episode_status, pdf_blob_url, pdf_file_name }`.
PG unsigned-order row (BulkSign table): `{ id, order_number, patient_name, patient_mrn, order_type|document_type, order_status: { SentToPhysicianDate }, agency_name, pdf_blob_url }`.
`startBulkUploadRun` response: `{ inputSummary: { joinedRows } , ... }`; `bulkSignPgOrders` response: `{ updatedCount, skippedCount }`.
Area intake rows (`fetchAreaIntakeStatus()`): `[{ id, name, hhahs:[{hhah_id, ...}], notifications:[{ id, hhah_id, hhah_name, message, notification_type, sent_at }] }]`.

## Invariants & gotchas
- **Auth tokens are scoped per portal** (`'hhah'` vs `'pg'` passed to `getAuthToken`/`setAuthToken`/`clearAuthToken`/`logout`/`getSession`) — the two portals can be signed in simultaneously in one browser without clobbering each other.
- **Wrong-portal login is actively discarded**: `LoginPanel` stores the token first (`setAuthToken`), THEN fires `logout(scope)` so the server session is killed, and shows "use the other portal" — don't "simplify" by skipping the store, the logout call needs the token to be sent.
- `checkingSession` initial state is `!!getAuthToken(scope)` — no token means no spinner flash; a stale token shows a full-screen loader until `getSession` resolves or clears it.
- All HHAH data reads are scoped by `hhahId: agencyId` from the session user; there is no HHAH picker (unlike older builds). Notifications are matched by `n.hhah_id === agencyId || n.hhah_name === agencyName` (name fallback for legacy rows).
- `fetchAreaIntakeStatus().catch(() => [])` — area/notification failures must never break the patients/orders load.
- Upload form: only the workbook is required; either ZIP may be omitted. Order-number uniqueness across the two ZIPs is a data convention, not validated client-side. See [bulk upload route](../../backend/routes/bulk-upload.md).
- The "Orders" metric card prefers `orders.length` and falls back to summed `patient.order_count`.
- BulkSign clears the selection `Set` on every refresh; `toggleAll` selects only currently listed orders. `pgId` comes solely from the session — the PG "picker" is a read-only box.
- Eligible/billable semantics are computed server-side (`computeEpisodeAssessment`); chips just map status strings — do not re-derive eligibility here. See [eligibility & billing](../../business/eligibility-billing.md).
- Selecting an order clears the selected patient/tree and vice versa — the right pane shows exactly one of: order detail, patient tree, empty-state, or tree-loading spinner.

## Change recipes
1. **Add a field to the bulk-upload form**: add state + a `<label>` block in `HhhLogin`, pass it through `startBulkUploadRun` in `src/lib/workflowApi.js`, then accept it in `api/workflows/bulk-upload/start.js` (multipart field names matter — see [bulk upload route](../../backend/routes/bulk-upload.md)).
2. **Add a column to the Bulk Sign table**: update BOTH `grid-cols-[44px_1.1fr_1.2fr_1fr_1fr_1fr_92px]` class strings (header + row) in `PgLogin.jsx` and add the cell; the field must exist on `fetchPgUnsignedOrders` rows ([data reads](../../backend/routes/data-reads.md)).
3. **Give PG admins a real dashboard**: replace `ComingSoonDashboard` in `PgLogin.jsx`; keep the `isPractitioner` fork in the default export's `<main>`.
4. **Change what a status chip means**: edit `EligibilityChips` in `HhhLogin.jsx` — but the truth lives in the server's episode status ([eligibility & billing](../../business/eligibility-billing.md)); the chip only reads `latest_episode_status` / `episode_status`.
5. **Add a new portal user type**: extend the `userType` checks in both `LoginPanel`s and the session-restore effects (`data.user?.userType === ...`), plus creation on the admin side ([admin pages](admin.md)) and server auth ([auth model](../../business/auth-model.md)).

## Related
- [auth model](../../business/auth-model.md) — external users, sessions, portal scoping rules
- [admin pages](admin.md) — where these portal accounts are created
- [frontend lib](../lib.md) — `authApi.js`/`workflowApi.js` fetcher contracts
- [bulk upload route](../../backend/routes/bulk-upload.md) — what the upload form POSTs into
- [orders & signing](../../business/orders-and-signing.md) — bulk-sign semantics, overdue auto-resolve
- [intake pipeline](../../business/intake-pipeline.md) — the wf7 run an upload starts
