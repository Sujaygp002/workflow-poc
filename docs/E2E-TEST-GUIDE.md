# End-to-End Test Guide — Agency Bulk Upload — Daily Intake

How to manually test the daily agency-intake workflow, end to end, covering every
branch and edge case. Everything below works on the deployed Vercel site and locally.

## 1. What is live

**One active workflow**: `Agency Bulk Upload — Daily Intake` (builder-made,
daily trigger 12:00 America/Chicago, one item per onboarded agency).

- Agency **didn't upload today** → human task **TASK-Contact Agency to Upload
  Documents** (actions: Call / SMS route through `api/_lib/twilio.js`, Email *(real
  SMTP)*). Twilio is env-only and unset here, so Call/SMS degrade to a logged skip
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
- After *make billable/claimable*, **TASK-CCN, Audit & Submit Claim** runs: CCN
  generation for the billable months (Gemini is dead here → CCN "fails" for months
  with work to do → human **Create CCN manually**) → one bounded *audit → rework →
  re-audit* cycle (≤ 5 cycles) computing a pass rate → below 98% routes a human
  **Resolve audit failures** then a *re-audit* → a human **Submit claim** gate
  (confirm-only; records `submitted_at` + the summed claim amount and flips the
  agency's RCM records to `submitted`; **no external call**). Create CCN manually and
  Resolve audit failures are async remediation tasks too — the daily tick auto-resolves
  a prior-day one once its gate (notes present / audit now passes) is satisfied.
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
| PG portal (Bulk Sign) | `/pg-login` | `lakeside-test` | `TestPg!2026` |

Live site: `https://workflow-poc.vercel.app` (Vercel project `workflow-poc`).
Local: `npm run build && node scripts/dev-full-server.mjs` then open the printed port.

**Agencies in the DB**: Nightingale Visiting Nurses-Taunton (TEST) — preloaded with
the real 11-patient / 20-order dataset; Sunrise Meadows Home Health (TEST) — for
manual uploads with the test kit; Willow Creek Home Health (TEST) — stays empty;
Demo RCM Agency (DEMO-RCM) — leftover showcase fixtures.

## 3. Scenario A — one-click preloaded upload (Nightingale)

1. Log into `/hhh-login` as `nightingale-test`.
2. The Bulk Upload form is **already filled** — ✓ hints show workbook.xlsx and the
   signed/unsigned order zips (fetched from Vercel Blob; nothing to pick).
3. Click **Start Upload**.
4. Open the **Orchestrator**: today's daily run (created on demand if the noon tick
   hasn't fired) now contains ~20 row items inside **TASK-Update / Create Patient Model**.
   The `(n)` counts on the TASK boxes climb as system steps execute.
5. Because the Gemini key is not configured, extraction runs its **regex tier only**
   — rows with gaps produce **Manually fill missing data** tasks.
6. Log into `/worker` as `demo-rcm-coordinator`: tasks appear in **Untouched**;
   opening one moves it to **Processing**; complete the fill → a **Review record**
   task follows → approve it → **Done**.
7. Verify objects: the patient pages/coverage map now show the Nightingale patients,
   admissions, episodes, and orders (signed F2F/485s per the source data).

**Edge case check**: log out, log back in, upload again — the run gains **no
duplicate items** (per-row idempotency keys).

## 4. Scenario B — agency never uploads (Willow Creek)

1. After 12:00 America/Chicago, opening the Orchestrator fires the daily tick
   automatically (a Vercel cron also fires at 17:00 UTC). Before noon: delete
   today's daily run (trash icon) and let the poll re-tick.
2. The daily run shows Willow Creek's item blocked on **TASK-Contact Agency to
   Upload Documents** (pink = human).
3. In `/worker`: open the task — three actions: **Call** and **SMS** complete as
   "coming soon" placeholders; **Email** is prefilled with the agency's contact
   address (sends for real once SMTP creds are rotated; until then it completes
   with "skipped" status — by design, never blocks).
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
  check if uploaded", the `agency not uploaded?` diamond, two TASK- boxes with
  (n) counts and **View** buttons that expand the inner mini-workflows. **Edit**
  opens the builder showing the task groups.
- **Orchestrator**: ONE daily run per day, growing live (2.5 s poll). Item counts,
  manual-backlog badges, decision diamonds with YES/else arms.
- **Worker buckets**: Untouched → (open) → Processing → (complete) → Done.
  Auto-resolved contact tasks appear in Done without worker action.
- **PG portal** (`lakeside-test`): Bulk Sign lists unsigned orders for the mapped
  practitioner; signing updates order status.

## 7. Resetting for a fresh demo

- Delete today's daily run in the Orchestrator (trash icon) — the poll re-ticks
  within seconds and recreates it fresh (uploads that day will still count as
  "uploaded today" for agencies that already uploaded — that state lives on the
  stored documents, not the run).
- For a fully clean slate: `npm run db:wipe` then re-run the provisioning scripts
  (`/Users/sujaygp/Desktop/data/provision.mjs` — kept outside the repo because the
  fixtures contain patient-like data and the repo is public).

## 8. Known environment caveats

1. **GEMINI_API_KEY is invalid** (401) — extraction uses the regex tier only, so
   expect more manual-fill tasks. Rotate the key in `api/_lib/config.js` or Vercel
   env vars to enable the Gemini tier.
2. **SMTP credentials are rejected** — email actions complete with
   `email_skipped: true` instead of sending. Rotate `SMTP_USER`/`SMTP_PASS` to
   send for real.
3. The Vercel cron fires at **17:00 UTC** (noon CDT); during winter (CST) that's
   11:00 — the Orchestrator poll path fires correctly at noon local regardless.
4. The builder UI has no input fields for the daily trigger's hour/minute/tz —
   those ride through on save (defaults 12:00 America/Chicago).
5. **Twilio is not configured** — `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/
   `TWILIO_FROM_NUMBER` are absent in this environment. Call and SMS worker actions
   degrade to `{ sent:false, skipped:true, reason:'twilio_not_configured' }` and
   never throw; the task still completes and the outcome is surfaced in the action
   output. To enable: set all three env vars in Vercel (E.164 `FROM_NUMBER`, e.g.
   `+15551234567`). Set `TWILIO_TO_OVERRIDE` to a test number to redirect every
   outbound call/SMS to one safe destination during demos.

## 9. CCN, audit, and submit-claim gates

After a row reaches **make billable/claimable** the workflow enters the
**TASK-CCN, Audit & Submit Claim** group. Because two DAG arms (eligible arm n10a
and signature-pass arm n10b) each trigger the group, the steps are duplicated
with suffix a/b — both are idempotent.

1. **CCN generation** (`run_ccn_service`): calls `runAiService` under the hood.
   With Gemini dead, every billable CPO month fails to generate a CC note
   → `ccn_failed = true` → human task **Create CCN manually** becomes active
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
update the underlying data (add CC notes, or rerun the audit externally), then wait
for the next noon tick or manually trigger the Orchestrator poll.

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
  The Orchestrator poll (or Vercel cron) will see a new `dayBucket` and create
  a fresh daily run. Advance +1 month to age episodes past their EOE (testing
  eligibility re-evaluation, CPO month boundaries, derive-patient-status Active
  vs Inactive).
- **Reset**: the Reset button clears `sim_offset_ms = 0` and the business clock
  returns to real wall time immediately (5-second cache then flushes).
- **Server path**: `GET /api/workflow-runs?action=simTime` returns current state;
  `POST { action:'simulateTime', op:'+1d'|'+1m'|'reset' }` applies the offset.

## 11. MSA Coverage Map

The Coverage Map (`/map`) now renders agency and physician-group balls **inside a
stylized MSA polygon backdrop** representing the Taunton–Bristol County, MA area
(the live TEST agencies' actual geography).

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
