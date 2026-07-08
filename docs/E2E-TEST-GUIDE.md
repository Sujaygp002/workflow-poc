# End-to-End Test Guide — Agency Bulk Upload (Phase 1)

How to manually test the daily agency-intake workflow, end to end, covering every
branch and edge case. Everything below works on the deployed Vercel site and locally.

## 1. What is live

**One active workflow**: `Agency Bulk Upload — Daily Intake (Phase 1)` (builder-made,
daily trigger 12:00 America/Chicago, one item per onboarded agency).

- Agency **didn't upload today** → human task **TASK-Contact Agency to Upload
  Documents** (actions: Call *(coming soon)*, SMS *(coming soon)*, Email *(real)*).
- Agency **uploaded** → each workbook row becomes an **item in the same daily run**,
  flowing through **TASK-Update Object Module**: AI extraction → (manual fill if
  extraction incomplete) → patient update/create → admission → episode → order
  create/skip-duplicate → human review.
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
   hasn't fired) now contains ~20 row items inside **TASK-Update Object Module**.
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

- **Workflow page**: the phase-1 card — START cap "For each onboarded agency ·
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
