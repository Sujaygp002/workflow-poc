# End-to-End Test Guide — Agency Bulk Upload — Daily Intake

How to manually test the daily agency-intake workflow, end to end, covering every
branch and edge case. Everything below works on the deployed AWS site and locally.

**Live site**: `http://cc-poc-alb-1955710851.eu-north-1.elb.amazonaws.com`
(plain HTTP — no TLS yet; don't type `https://`). The app runs as a container on
**AWS ECS** behind an ALB; order PDFs and preload fixtures live in a **private S3
bucket** served through the app's `/api/blobs/*` proxy. See §13 for operations.

## 1. What is live

**One active workflow**: `Agency Bulk Upload — Daily Intake` (builder-made, id
`cc-1783522521545`, daily trigger 12:00 America/Chicago, one item per onboarded
agency; 34 steps / 4 megaGroups). Note: it reads **version 1** on this fresh AWS
database — the content is identical to the old v7 definition.

- Agency **didn't upload today** → human task **TASK-Contact Agency to Upload
  Documents** (actions: Call / SMS route through `api/_lib/twilio.js`, Email via
  SMTP). Twilio is env-only and unset here, so Call/SMS degrade to a logged skip
  (`twilio_not_configured`) and the task still completes; the outcome is surfaced.
- Agency **uploaded** → each workbook row becomes an **item in the same daily run**,
  flowing through **TASK-Update / Create Patient Model**: AI extraction (multi-signal
  PDF↔order match; ambiguous → a *Confirm order document* action on the fill task) →
  (manual fill if extraction incomplete) → patient update/create → admission →
  episode → order create/skip-duplicate → human review.
- After review, **TASK-Post-Model Billing Gates** runs: episode eligible → *make
  billable/claimable*; not eligible → 485+F2F documents / patient-data / signature
  gates, each routing an async remediation task (Get missing documents / Get and fill
  patient data / Send for signature). These do NOT change run-completion semantics —
  the next daily run re-evaluates each gate fresh and the tick auto-resolves any
  prior-day remediation task whose gate now passes.
- After *make billable/claimable*, **TASK-CCN, Audit & Submit Claim** runs — see §9.
- An agency uploading **mid-run** updates the SAME run live: its contact task
  auto-resolves and its rows append as new items. Re-uploads the same day do not
  duplicate rows.
- The old system workflows (update patients objects / Send To Physician / Make
  Patients Billable) are **removed** — uploads no longer spawn separate runs.

## 2. URLs and logins

| Surface | Path | Username | Password |
|---|---|---|---|
| Admin (Workflow / Orchestrator / Entity) | `/` | — (open) | — |
| Agency portal — preloaded, real data | `/hhh-login` | `nightingale-test` | `TestAgency!2026` |
| Agency portal — manual kit | `/hhh-login` | `sunrise-test` | `TestAgency!2026` |
| Agency portal — never uploads | `/hhh-login` | `willow-test` | `TestAgency!2026` |
| Worker portal (complete tasks) | `/worker` | `demo-rcm-coordinator` | `DemoWorker!2026` |
| PG portal (Bulk Sign — Lakeside) | `/pg-login` | `lakeside-test` | `TestPg!2026` |
| PG portal (Bulk Sign — Prima Care / Dr. Labib) | `/pg-login` | `prima-care-test` | `TestPg!2026` |

Worker login is **password only** — 2FA/TOTP has been removed; there is no second
step after the password. All six logins above are verified working on the live site.

Local: `npm run build && node scripts/dev-full-server.mjs` then open the printed port.

**Agencies in the DB**: Nightingale Visiting Nurses-Taunton (TEST) — preloaded with
the real 11-patient / 20-order dataset; Sunrise Meadows Home Health (TEST) — for
manual uploads with the test kit; Willow Creek Home Health (TEST) — stays empty.
Three **legacy demo agencies** (Boise Home Health, Sunrise Skilled Home Health,
Treasure Valley Hospice) are also present *and active* — they each get a
contact-agency item on every daily tick. Prima Care and Lakeside Family Practice are
the PGs; Dr. Labib Ossama W. (NPI 1225033673) is mapped to Prima Care.

## 3. Scenario A — one-click preloaded upload (Nightingale)

1. Log into `/hhh-login` as `nightingale-test`.
2. The Bulk Upload form is **already filled** — ✓ hints show workbook.xlsx and the
   signed/unsigned order zips (fetched from S3 through the `/api/blobs/*` proxy;
   nothing to pick).
3. Click **Start Upload**. The parse + append takes ~60 s (11 patient rows / 20
   order rows joined into 20 items) — wait for the success response.
4. Open the **Orchestrator**: today's daily run (created on demand if the noon tick
   hasn't fired) now contains 20 row items inside **TASK-Update / Create Patient
   Model**. The `(n)` counts on the TASK boxes climb as system steps execute.
5. The Gemini key is dead (**expected**), so extraction runs the regex tier only —
   but the Tier-1 PDF-regex patterns are tuned to the Nightingale document layouts
   and fill the fields offline, so all 20 rows typically go **straight to Review
   record** tasks with no manual-fill step. A *Manually fill missing data* task only
   appears when a row genuinely lacks data in both the workbook and the PDF.
6. Log into `/worker` as `demo-rcm-coordinator` (password only): tasks appear in
   **Untouched**; opening one moves it to **Processing**; approve the review →
   **Done**.
7. Verify objects: normally done on the patient pages / Coverage Map — **currently
   broken on AWS** (see §12 Known issues). Until fixed, verify through the worker
   task's context panel (patient/admission/episode/order fields) instead.

**Edge case check**: log out, log back in, upload again — the run gains **no
duplicate items** (per-row idempotency keys; verified live: `appendedItems: 0`).

## 4. Scenario B — agency never uploads (Willow Creek)

1. The daily tick fires three ways: the **EventBridge rule `cc-poc-daily-tick`** at
   **17:00 UTC** daily (runs a one-off ECS task that hits
   `GET /api/workflow-runs?action=tick`); the **Orchestrator page poll** while the
   tab is open; or manually for testing:
   `curl "http://cc-poc-alb-1955710851.eu-north-1.elb.amazonaws.com/api/workflow-runs?action=tick"`.
2. The tick appends one base item per **silent active agency** — on this DB that is
   up to 5 (Willow Creek, Sunrise Meadows if it hasn't uploaded, plus the 3 legacy
   demo agencies). Each shows blocked on **TASK-Contact Agency to Upload Documents**
   (pink = human).
3. In `/worker`: open Willow Creek's task — three actions: **Call** and **SMS**
   complete as skips (`twilio_not_configured` — **expected**); **Email** is prefilled
   with the agency's contact address but SMTP creds are dead, so completion shows an
   amber **"Task completed, but the email was NOT sent"** notice (**expected** — send
   is best-effort and never blocks).
4. Complete all three → task Done → item completes.

**The live-update moment**: while the contact task is still open, log into
`/hhh-login` as that agency and upload — watch the Orchestrator: the contact task
auto-resolves ("agency uploaded") and the rows append to the **same run**.

## 5. Scenario C — manual upload with edge-case kit (Sunrise Meadows)

Files: `docs/manual-test-kit/` (TestKit_upload.xlsx + orders_unsigned.zip +
orders_signed.zip). Log in as `sunrise-test`, attach all three manually, upload.

| Row | Patient | What it exercises | Expect |
|---|---|---|---|
| a | Margaret Sullivan | Happy path | straight to Review |
| b | Harold Jennings | Missing SOC/SOE/EOE | **Enter admission dates** then **Enter episode dates** tasks |
| c | Beatrice Coleman | Sparse row, data only in PDF | regex extraction **back-fills** sex/address/order type |
| d | Walter Nakamura | Same order number twice | second hits **Skip duplicate order** |
| e | Dorothy Fitzgerald | Unsigned 485 + signed F2F | both orders created; F2F carries signed date |

## 6. What to watch in each surface

- **Workflow page**: the daily-intake card — START cap "For each onboarded agency ·
  check if uploaded", the `agency not uploaded?` diamond, TASK- boxes with (n)
  counts and **View** buttons that expand the inner mini-workflows. **Edit** opens
  the builder showing the task groups.
- **Orchestrator**: ONE daily run per day, growing live (2.5 s poll). Item counts,
  manual-backlog badges, decision diamonds with YES/else arms.
- **Worker buckets**: Untouched → (open) → Processing → (complete) → Done.
  Auto-resolved contact tasks appear in Done without worker action.
- **PG portal** (`lakeside-test` or `prima-care-test`): Bulk Sign lists unsigned
  orders for the mapped practitioner; signing updates order status. This is the
  **signature** leg of the post-model gates — a *Send for signature* remediation
  task points the worker here.
- **RCM tables** (HHAH/PG portal patients + billing views): **currently broken on
  AWS** — see §12.

## 7. Resetting for a fresh demo

- Delete today's daily run in the Orchestrator (trash icon) — the poll re-ticks
  within seconds and recreates it fresh (uploads that day still count as "uploaded
  today" for agencies that already uploaded — that state lives on the stored
  documents, not the run).
- For a fully clean slate: `npm run db:wipe` then re-run the provisioning scripts
  (`/Users/sujaygp/Desktop/data/provision.mjs` — kept outside the repo because the
  fixtures contain patient-like data and the repo is public). The RDS database is
  **private** — run these via `aws ecs run-task` with a command override (§13), not
  from a laptop.

## 8. Known environment caveats

All of these are **expected** on the current deployment — none block a task from
completing:

1. **GEMINI_API_KEY is invalid** (401) — extraction uses the regex tier only. The
   Tier-1 patterns are tuned to the Nightingale + test-kit PDFs, so most rows still
   extract completely; genuinely sparse rows produce manual-fill tasks. Rotate the
   key (ECS task env / `api/_lib/config.js`) to enable the Gemini tier.
2. **SMTP credentials are rejected** — email actions complete with an amber "not
   sent" notice (`email_skipped`) instead of sending. Rotate `SMTP_USER`/`SMTP_PASS`
   to send for real.
3. **Twilio is not configured** — `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/
   `TWILIO_FROM_NUMBER` are absent. Call and SMS worker actions degrade to
   `{ sent:false, skipped:true, reason:'twilio_not_configured' }` and never throw.
   To enable: set all three env vars (E.164 `FROM_NUMBER`); set `TWILIO_TO_OVERRIDE`
   to redirect every outbound call/SMS to one safe number during demos.
4. The EventBridge tick fires at **17:00 UTC** (noon CDT); during winter (CST)
   that's 11:00 — the Orchestrator poll path fires correctly at noon local
   regardless, while the tab is open.
5. The builder UI has no input fields for the daily trigger's hour/minute/tz —
   those ride through on save (defaults 12:00 America/Chicago).
6. **HTTP only** — the ALB has no TLS listener yet; browsers may warn "not secure".

## 9. CCN, audit, and submit-claim gates

After a row reaches **make billable/claimable** the workflow enters the
**TASK-CCN, Audit & Submit Claim** group. Because two DAG arms (eligible arm n10a
and signature-pass arm n10b) each trigger the group, the steps are duplicated
with suffix a/b — both are idempotent.

1. **CCN generation** (`run_ccn_service`): calls `runAiService` under the hood.
   With Gemini dead (**expected**), every billable CPO month fails to generate a CC
   note → `ccn_failed = true` → human task **Create CCN manually** becomes active
   in the worker bucket. The task stays open until CC notes appear for those months
   in `cpo_months.reason.ccNotes` (the async gate: tick re-evaluates and
   auto-resolves once notes are present). With Gemini alive, months with no
   billable work produce `ccn_ok` directly.

2. **Audit cycle** (`run_audit_cycle`): runs `auditRcm → reworkAudits (≤5 cycles)
   → auditRcm`. Pass rate = passed / total records; vacuous pass (1.0) when 0
   records. `audit_pass_98 = passRate >= 0.98`.
   - If pass rate < 98%: human **Resolve audit failures** → `re_audit` (1 cycle).
     This task also has an async gate: the daily tick auto-resolves it once a
     bounded re-audit cycle passes ≥ 98%.
   - If pass rate ≥ 98%: skip straight to Submit claim.

3. **Submit claim** (human gate, confirm-only): worker confirms in the portal.
   On completion: sums the agency's `rcm_records` charges, flips them to
   `status='submitted'`, stamps `claim_submitted_at` + `claim_amount_cents` on the
   workflow item. **Nothing is transmitted to any payer or clearinghouse** — this
   is a human-gated record-keeping action only.

**Remediation auto-resolve**: the daily tick's `resolveSettledGateTasks()` re-
evaluates every still-active gate remediation task (Create CCN manually, Resolve
audit failures, and the post-model billing gates) against the item's current DB
state, completing any whose gate now passes with the note "Resolved by re-evaluation
— the gate now passes." To test the auto-resolve: leave a remediation task active,
update the underlying data (add CC notes, or rerun the audit externally), then
trigger the tick manually (§4 step 1) or wait for the 17:00 UTC EventBridge fire.

## 10. Time-travel simulator

The **SimTimeControl** widget in the Orchestrator toolbar lets you advance the
business date for demos without waiting for real calendar days.

- **Controls**: `+1 Day`, `+1 Month`, `Reset to real time` — buttons in the
  Orchestrator page header (clock icon; violet when simulated, grey when real).
- **What it moves**: the "business clock" (`api/_lib/clock.js`) — a signed
  millisecond offset stored in `app_settings.sim_offset_ms` (migration 005,
  additive/idempotent). All date math that matters for demos flows through
  `businessNow()` / `businessToday()`: daily-tick fire time + day bucket, CPO
  month derivation, eligibility/F2F windows, area-intake "today".
- **What it does NOT move**: wall-clock timestamps (`created_at`, audit
  change-log stamps, session expiry, blob paths) — those always use real time.
- **How to use**: advance +1 day past today's noon to force a new daily run.
  The Orchestrator poll (or the EventBridge tick) will see a new `dayBucket` and
  create a fresh daily run. Advance +1 month to age episodes past their EOE
  (testing eligibility re-evaluation, CPO month boundaries, derive-patient-status
  Active vs Inactive).
- **Reset**: the Reset button clears `sim_offset_ms = 0` and the business clock
  returns to real wall time immediately (5-second cache then flushes).
- **Server path**: `GET /api/workflow-runs?action=simTime` returns current state;
  `POST { action:'simulateTime', op:'+1d'|'+1m'|'reset' }` applies the offset.

## 11. MSA Coverage Map

The Coverage Map (`/map`) renders agency and physician-group balls **inside a
stylized MSA polygon backdrop** representing the Taunton–Bristol County, MA area
(the live TEST agencies' actual geography).

> **Currently degraded on AWS**: the map's data feed is `/api/patients`, which
> returns 500 on this deployment (§12) — expect the map to render without patient
> edges until the fix lands.

- **MSA polygon**: a client-side constant in `src/pages/map/msa.js` — NOT a
  survey-accurate boundary; a recognizable region silhouette in the SVG 960×600
  view box. Agencies and PGs are deterministically seeded inside the polygon ring
  via `seedInside()` so the layout is stable across live polls.
- **Drilldown**: clicking an agency ball expands PG balls; clicking the patient-
  count edge ball drills into Admissions → Current/Past admission →
  Episodes → Current/Past episode → Orders → signed/unsigned + 485/F2F/other
  leaves.
- **Live toggle**: the Live/Paused toggle drives a 2.5s poll that calls `setData`
  only when no cluster is open (`isIdle()`), so a drilldown is never interrupted
  mid-exploration.
- **Agency balls come ONLY from Entity-page reference agencies** — workbook-
  invented agency names never create phantom balls (edges whose `hhah_name` has no
  reference match are dropped by `buildGraph`).

## 12. Known issues (AWS deployment)

1. **`GET /api/patients` and `GET /api/patients?view=rcm` return HTTP 500**
   (`syntax error at or near "$3"` / `"$1"`). Root cause: the AWS pg shim
   `makePgSql()` in `api/_lib/db.js` converts every tagged-template value into a
   `$N` bind parameter, but three queries embed **nested `sql\`\`` fragments** —
   `listPatients` (`api/_lib/repositories.js:1412`), `listRcmPatients` (`:2723-2724`),
   and `listRcmBilling` (`:2793-2794`, same pattern, so `?view=rcm-billing` fails
   too). Neon's composable driver flattened these into query text; node-postgres
   against RDS passes them as parameters, producing invalid SQL.
   **Affected surfaces**: HHAH/PG portal patient lists, the Coverage Map data feed,
   and the RCM patients + billing tables. **Fix**: teach the shim to flatten
   fragment values, or replace the conditional fragments with parameterized
   OR-null predicates like the `hhahId` clause at `repositories.js:1411`.
2. Because of #1, the seeded-patient-count assertion ("demo hierarchy shows ≥1
   patient") could not be verified on this deployment.

Everything else passed live verification: all 10 page routes serve 200 HTML with
distinct index/worker bundles, all 6 logins mint sessions, the workflow definition
and reference data match spec, the Nightingale preload blobs stream from S3, a full
upload → tick → worker-complete pipeline ran clean (including idempotent re-upload
and a completed contact task), and `/api/health` returns `{"ok":true}`.

## 13. AWS operations appendix

- **Redeploy**: push to `main` on `Sujaygp002/workflow-poc` → GitHub Actions
  (`.github/workflows/deploy-aws.yml`) builds the Docker image → pushes to ECR
  repo `cc-poc` → ECS rolling deploy on cluster `cc-poc`, service
  `cc-poc-service` (~5 min end to end).
- **Force redeploy** (no code change):
  `aws ecs update-service --cluster cc-poc --service cc-poc-service --force-new-deployment --region eu-north-1`
- **View logs**: `aws logs tail /ecs/cc-poc --follow --region eu-north-1`
- **Manual daily tick**:
  `curl "http://cc-poc-alb-1955710851.eu-north-1.elb.amazonaws.com/api/workflow-runs?action=tick"`
  (scheduled fire: EventBridge rule `cc-poc-daily-tick`, 17:00 UTC daily, runs a
  one-off ECS task that hits the same URL).
- **Database**: RDS Postgres in a private subnet — no direct laptop access. For
  one-off admin (migrate / wipe / seed / provision), use `aws ecs run-task` with a
  command override on the app task definition.
- **Storage**: private S3 bucket; the app proxies objects at `/api/blobs/*`
  (`server.js`), so stored blob URLs resolve for both browsers and server-side
  fetch. The bucket never needs public access.
- **Health check**: `GET /api/health` → `{"ok":true}` (the ALB target-group check).
