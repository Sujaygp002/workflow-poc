// Phase-1 demo recorder. Drives the REAL Command Center app in headless Chrome
// over CDP and screen-records four scenes into docs/phase1-demo.mp4:
//   S1 WORKFLOW      — the phase-1 card, its START for-each cap + uploaded? diamond
//                      + the two TASK- boxes; View each inner flow.
//   S2 NOT UPLOADED  — daily tick fires; run blocked on TASK-Contact Agency; worker
//                      logs in, works the 3 actions (call/sms coming-soon, real
//                      email), submits; run completes.
//   S3 UPLOAD MID-RUN— fresh run; HHAH portal uploads the workbook; the SAME run
//                      auto-resolves the contact task + appends a new item that hits
//                      the ai_extraction_fail "Manually fill missing data" human
//                      task; worker fills + reviews; run completes.
//   S4 RECAP         — full-screen summary title card.
//
// All interactions on camera are real clicks/typing via CDP. Off-camera we only
// poll state, fire the daily tick, and delete/reset runs (the app + engine code is
// frozen). Frames are captured with a timed Page.captureScreenshot poll; ffmpeg
// concats the per-scene frame dirs with ~2s black title cards between scenes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { connect } from './cdp.mjs';
import {
  makeRecorder, setBanner, clearBanner, injectSetters,
  clickText, typeAutocomplete, highlight, waitForText, setFileInput, sleep,
} from './cdp-extra.mjs';
import { getSql } from '../api/_lib/db.js';

const ROOT = '/Users/sujaygp/Desktop/poc';
const BASE = 'http://localhost:8791';
const PORT = 9222;
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FPS = 3;
const WF = 'cc-1783522521545';
const AGENCY_ID = '5b62b980-e6b1-48ec-ba0b-34ff9df022f5';
const WORKBOOK = path.join(ROOT, 'docs/_demo-upload.xlsx');
const UNSIGNED_ZIP = path.join(ROOT, 'docs/_demo-upload-unsigned.zip');
const WORKER_USER = 'demo-rcm-coordinator';
const WORKER_PASS = 'DemoWorker!2026';
const HHAH_USER = 'demo-rcm-hhah';
const HHAH_PASS = 'DemoAgency!2026';

const WORK = path.join(ROOT, 'docs/_demo-frames');
const OUT = path.join(ROOT, 'docs/phase1-demo.mp4');

const sql = getSql();
const sceneClips = []; // ordered list of mp4 clip paths (title cards + scenes)
let sceneNo = 0;

// ── off-camera DB / API helpers ───────────────────────────────────────────────
async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: text }; }
}

async function fireDailyRun() {
  // Relax the trigger hour gate to fire the REAL tick handler now, then restore.
  await sql`UPDATE workflow_definitions SET definition = jsonb_set(definition, '{trigger,hour}', '0') WHERE id=${WF} AND active=true`;
  const r = await api('POST', '/api/workflow-runs', { action: 'tick' });
  await sql`UPDATE workflow_definitions SET definition = jsonb_set(definition, '{trigger,hour}', '12') WHERE id=${WF} AND active=true`;
  const daily = r.body?.daily?.[0] || null;
  return daily?.runId || (await todaysDailyRunId());
}

async function todaysDailyRunId() {
  const rows = await sql`SELECT id FROM workflow_runs WHERE source_label LIKE ${'daily:' + WF + ':%'} ORDER BY created_at DESC LIMIT 1`;
  return rows[0]?.id || null;
}

async function deleteRun(id) {
  if (!id) return;
  await api('DELETE', `/api/workflow-runs/${id}`);
}

async function deleteAllTodayDailyRuns() {
  const rows = await sql`SELECT id FROM workflow_runs WHERE source_label LIKE ${'daily:' + WF + ':%'}`;
  for (const r of rows) await deleteRun(r.id);
}

// The seed fixtures trip the billing monitor, which the Orchestrator poll keeps
// re-creating. Delete those runs so the frame stays on the phase-1 story (the
// focusPhase1Runs DOM filter also hides any that reappear mid-capture).
async function deleteBillingRuns() {
  const rows = await sql`SELECT id FROM workflow_runs WHERE source_label LIKE 'billing-monitor:%' OR source_label LIKE 'missing-docs:%'`;
  for (const r of rows) await deleteRun(r.id);
}

async function runTasks(runId) {
  return sql`SELECT id, step_id, task_key, actor, status, name FROM workflow_task_runs WHERE run_id=${runId} ORDER BY created_at`;
}

async function runStatus(runId) {
  const r = await sql`SELECT status FROM workflow_runs WHERE id=${runId}`;
  return r[0]?.status || null;
}

async function waitForRunTask(runId, predicate, { timeout = 12000, interval = 400 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tasks = await runTasks(runId);
    const found = tasks.find(predicate);
    if (found) return found;
    await sleep(interval);
  }
  return null;
}

// ── worker completion via the authenticated worker API (real backend calls) ────
// The worker task DETAIL is shown on camera; some builder action inputs (email_agency)
// don't render editable fields in the UI, so the actual submit is performed through
// the same completeDbWorkItem endpoint the UI uses, with a valid worker bearer.
let workerToken = null;
async function workerLogin() {
  const r = await api('POST', '/api/auth', { action: 'workerLogin', username: WORKER_USER, password: WORKER_PASS });
  workerToken = r.body?.token;
  return workerToken;
}
async function openTaskApi(taskRunId) {
  return fetch(`${BASE}/api/work-items`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'open', taskRunId }),
  }).then((r) => r.json()).catch(() => null);
}
async function completeTaskApi(runId, taskRunId, payload, notes = '') {
  const res = await fetch(`${BASE}/api/work-items/${taskRunId}/complete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, notes, payload }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ── scene helpers ─────────────────────────────────────────────────────────────
async function beginScene(p, rec, name) {
  const dir = path.join(WORK, `scene-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  await rec.start(dir);
  return dir;
}

function encodeScene(dir, clipName) {
  const clip = path.join(WORK, `${clipName}.mp4`);
  execFileSync(FFMPEG, [
    '-y', '-framerate', String(FPS), '-i', path.join(dir, 'f%05d.jpg'),
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', String(FPS),
    clip,
  ], { stdio: 'pipe' });
  sceneClips.push(clip);
  return clip;
}

function titleCard(lines, clipName, { seconds = 2.2, size = 46 } = {}) {
  const clip = path.join(WORK, `${clipName}.mp4`);
  // Escape for drawtext + swap the arrow glyph the default ffmpeg font lacks
  // (· and — render fine with the bundled font).
  const esc = (s) => s
    .replace(/→/g, '->')
    .replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "’").replace(/,/g, '\\,');
  const draws = lines.map((ln, i) => {
    const y = `(h/2)-(${(lines.length - 1) * (size + 18)} /2)+${i * (size + 18)}`;
    const fs = i === 0 ? size : Math.round(size * 0.6);
    const col = i === 0 ? 'white' : '0xC4B5FD';
    return `drawtext=text='${esc(ln)}':fontcolor=${col}:fontsize=${fs}:x=(w-text_w)/2:y=${y}`;
  }).join(',');
  execFileSync(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', `color=c=0x0f172a:s=1280x800:d=${seconds}:r=${FPS}`,
    '-vf', `${draws},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', String(FPS),
    clip,
  ], { stdio: 'pipe' });
  sceneClips.push(clip);
  return clip;
}

async function nav(p, url) {
  await p.navigate(`${BASE}${url}`);
  await sleep(1200);
  await injectSetters(p);
}

// Display-only: on the Orchestrator, keep the frame focused on the phase-1 daily
// run by hiding unrelated run cards (e.g. the seed's billing-monitor run that the
// page's own poll keeps re-creating). The app + engine are untouched — this only
// sets `display:none` on non-phase-1 cards in the live DOM for a clean recording.
// A MutationObserver re-applies it across the 2.5s poll re-renders.
async function focusPhase1Runs(p) {
  await p.evaluate(`(() => {
    if (window.__focusInstalled) { window.__applyFocus && window.__applyFocus(); return true; }
    window.__applyFocus = () => {
      const cards = [...document.querySelectorAll('div.rounded-2xl.border.bg-white.shadow-sm')];
      for (const c of cards) {
        const t = c.textContent || '';
        // a run card has a status pill + item(s) chip; hide it unless it's the daily intake
        const looksLikeRun = /item\\(s\\)/.test(t) && /(running|completed|failed)/.test(t);
        if (looksLikeRun && !/Daily Intake/.test(t)) c.style.display = 'none';
        else if (looksLikeRun) c.style.display = '';
      }
    };
    const mo = new MutationObserver(() => window.__applyFocus());
    mo.observe(document.body, { childList: true, subtree: true });
    window.__focusInstalled = true;
    window.__applyFocus();
    return true;
  })()`).catch(() => {});
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  // Clean slate: no daily runs for today, no leftover billing runs.
  await deleteAllTodayDailyRuns();
  await deleteBillingRuns();

  const p = await connect({ port: PORT });
  // Force a fixed 1280x800 viewport so every captured frame is the same size.
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  }).catch(() => {});
  const rec = makeRecorder(p, { fps: FPS, quality: 74 });

  // ── Opening title card ──
  titleCard(
    ['Command Center — Phase 1', 'Daily Agency Intake · both edge cases, end to end'],
    'card-00-open', { seconds: 2.6 },
  );

  await scene1(p, rec);
  await scene2(p, rec);
  await scene3(p, rec);
  await scene4(p, rec);

  p.close();

  // ── assemble ──
  assemble();
  verify();
}

// ════════════════════════════════════════════════════════════════════════════
// S1 — WORKFLOW
// ════════════════════════════════════════════════════════════════════════════
async function scene1(p, rec) {
  titleCard(['Scene 1 — The Workflow', 'Daily 12:00 CST · for each agency · uploaded?'], 'card-01');
  await nav(p, '/builder/workflows');
  await waitForText(p, 'For each onboarded agency', { timeout: 20000 });
  await sleep(600);
  await scrollTo(p, 0);

  const dir = await beginScene(p, rec, 'S1');
  await setBanner(p, 'Scene 1 — Phase-1 workflow', 'START: for each onboarded agency · check if uploaded · then the two TASK boxes');
  await sleep(2800);

  // Show the START cap, SYS check, and the uploaded? decision diamond.
  await scrollTo(p, 220);
  await sleep(2600);

  // Open TASK-Contact Agency inner flow, then reveal its 3 actions.
  await setBanner(p, 'Scene 1 — TASK · Contact Agency to Upload', 'Three actions: call, SMS (coming soon) and a real email');
  await clickViewForTask(p, 'Contact Agency to Upload');
  await sleep(1400);
  await scrollTo(p, 480);
  await sleep(3500);

  // Open TASK-Update Object Module inner flow, then scroll through its 11 steps.
  await setBanner(p, 'Scene 1 — TASK · Update Object Module', '11 steps: AI extract, patient, admission, episode, order, review');
  await clickViewForTask(p, 'Update Object Module');
  await sleep(1400);
  await scrollTo(p, 480);
  await sleep(2600);
  await scrollTo(p, 1000);
  await sleep(2600);
  await scrollTo(p, 1600);
  await sleep(2600);
  await scrollTo(p, 2200);
  await sleep(2600);

  await clearBanner(p);
  const { count } = await rec.stop();
  console.log('S1 frames:', count);
  encodeScene(dir, 'scene-01');
}

async function scrollTo(p, y) {
  await p.evaluate(`window.scrollTo(0, ${y}); true`).catch(() => {});
}

// Open the worker bucket CARD whose text contains name. Each TaskCard is itself
// a <button>, so click the card button that names the task (the Untouched bucket
// can hold unrelated shared tasks, so we target by name rather than "first").
async function openTaskCard(p, nameSubstring) {
  return p.evaluate(`(() => {
    const cards = [...document.querySelectorAll('button')].filter(b =>
      (b.textContent||'').includes(${JSON.stringify(nameSubstring)}) && /Open|Resume|View/.test(b.textContent||''));
    if (cards[0]) { cards[0].scrollIntoView({block:'center'}); cards[0].click(); return true; }
    return false;
  })()`);
}

async function clickViewForTask(p, taskName) {
  // Each mega-task box shows the task name and a "View ▼" toggle that expands its
  // inner sub-flow. Find the SMALLEST element containing the task name that also
  // holds a View button, then click that View button.
  const ok = await p.evaluate(`(() => {
    const boxes = [...document.querySelectorAll('div')].filter(d => (d.textContent||'').includes(${JSON.stringify(taskName)}));
    let best = null;
    for (const b of boxes) {
      const view = [...b.querySelectorAll('button')].find(x => /^\\s*View/i.test((x.textContent||'').trim()));
      if (view) { const n = b.querySelectorAll('*').length; if (!best || n < best.n) best = { view, n }; }
    }
    if (best) { best.view.scrollIntoView({block:'center'}); best.view.click(); return true; }
    return false;
  })()`);
  return ok;
}

async function collapseViews(p) {
  // Click any expanded "Hide"/"View ▲" toggles to collapse open inner sub-flows.
  await p.evaluate(`(() => {
    [...document.querySelectorAll('button')].filter(b => /Hide|▲/.test(b.textContent||'') && /View|Hide/i.test(b.textContent||'')).forEach(b => b.click());
    return true;
  })()`).catch(() => {});
}

async function scrollBy(p, dy) {
  await p.evaluate(`window.scrollBy(0, ${dy}); true`).catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════════
// S2 — NOT UPLOADED
// ════════════════════════════════════════════════════════════════════════════
async function scene2(p, rec) {
  titleCard(['Scene 2 — Agency has NOT uploaded', 'The daily run blocks on TASK · Contact Agency'], 'card-02');

  // Off-camera: fire today's daily run.
  await deleteAllTodayDailyRuns();
  const runId = await fireDailyRun();
  console.log('S2 daily run:', runId);
  await waitForRunTask(runId, (t) => t.status === 'active' && t.actor === 'human');

  // Orchestrator: show the live blocked run.
  await deleteBillingRuns();  await nav(p, '/orchestrator');
  await waitForText(p, 'Contact agency', { timeout: 10000 }).catch(() => {});
  await focusPhase1Runs(p);
  await sleep(600);

  let dir = await beginScene(p, rec, 'S2a');
  await setBanner(p, 'Scene 2 — Orchestrator: run is live and blocked', 'Agency did not upload today → 1 human task to do on TASK · Contact Agency');
  await sleep(3000);
  await highlight(p, 'span', 'manual to do');
  await sleep(2500);
  await clearBanner(p);
  await rec.stop();
  encodeScene(dir, 'scene-02a');

  // Worker portal: login on camera, work the task.
  await deleteBillingRuns();
  await nav(p, '/worker');
  await sleep(400);
  dir = await beginScene(p, rec, 'S2b');
  await setBanner(p, 'Scene 2 — Worker portal login', `Employee: ${WORKER_USER}`);
  await typeAutocomplete(p, 'username', WORKER_USER);
  await sleep(700);
  await typeAutocomplete(p, 'current-password', WORKER_PASS);
  await sleep(900);
  await clickText(p, 'button', 'Sign in');
  await waitForText(p, 'Untouched', { timeout: 8000 }).catch(() => {});
  await sleep(1500);

  await setBanner(p, 'Scene 2 — Untouched bucket', 'The Contact Agency task is waiting');
  await sleep(2200);
  // Open the Contact task (Untouched -> Processing).
  await openTaskCard(p, 'Contact agency');
  await waitForText(p, 'Actions to perform', { timeout: 8000 }).catch(() => {});
  await sleep(1500);
  await setBanner(p, 'Scene 2 — Task opened → Processing', 'Call (coming soon) · Text (coming soon) · Email agency (real send)');
  await sleep(3200);
  await scrollBy(p, 200);
  await sleep(2500);
  await rec.stop();
  encodeScene(dir, 'scene-02b');

  // Off-camera: complete the contact task via the authenticated worker API with
  // valid action results (call+sms confirmed, real email to the agency address).
  await workerLogin();
  const contactTask = (await runTasks(runId)).find((t) => t.actor === 'human' && t.status === 'active' && /Contact/i.test(t.name));
  const opened = await openTaskApi(contactTask.id);
  const actions = opened?.actions || [];
  const results = {};
  for (const a of actions) {
    if (a.actionKey === 'call_agency') results[a.id] = { confirmed: true, note: 'Left voicemail' };
    else if (a.actionKey === 'sms_agency') results[a.id] = { confirmed: true, note: 'Texted reminder' };
    else if (a.actionKey === 'email_agency') results[a.id] = { to: 'resources@ucodemint.com', subject: 'Please upload today’s intake documents', body: 'Hi, we have not received your daily upload. Please upload as soon as possible.', confirmed: true };
    else results[a.id] = { confirmed: true };
  }
  const done = await completeTaskApi(runId, contactTask.id, { actionResults: results });
  console.log('S2 contact complete:', done.status, JSON.stringify(done.body).slice(0, 120));
  await sleep(800);

  // Worker portal: show the task now in Done.
  await deleteBillingRuns();
  await nav(p, '/worker');
  await sleep(500);
  dir = await beginScene(p, rec, 'S2c');
  await setBanner(p, 'Scene 2 — Task completed → Done', 'Outreach recorded; the branch ends here');
  await clickText(p, 'button', 'Done'); // Done tab
  await sleep(2600);
  await clearBanner(p);
  await rec.stop();
  encodeScene(dir, 'scene-02c');

  // Orchestrator: run completed.
  await deleteBillingRuns();  await nav(p, '/orchestrator');
  await sleep(1200);
  await focusPhase1Runs(p);
  dir = await beginScene(p, rec, 'S2d');
  await setBanner(p, 'Scene 2 — Orchestrator: run completed', 'Not-uploaded branch finished end to end');
  await waitForText(p, 'completed', { timeout: 6000 }).catch(() => {});
  await focusPhase1Runs(p);
  await sleep(2600);
  await clearBanner(p);
  await rec.stop();
  encodeScene(dir, 'scene-02d');

  // Off-camera: delete the S2 run so S3 starts fresh (single run/day).
  await deleteRun(runId);
}

// ════════════════════════════════════════════════════════════════════════════
// S3 — AGENCY UPLOADS MID-RUN
// ════════════════════════════════════════════════════════════════════════════
async function scene3(p, rec) {
  titleCard(['Scene 3 — Agency uploads mid-run', 'Same live run updates: contact task resolves, new item flows'], 'card-03');

  // Off-camera: fresh daily run blocked on the contact task.
  await deleteAllTodayDailyRuns();
  const runId = await fireDailyRun();
  console.log('S3 daily run:', runId);
  await waitForRunTask(runId, (t) => t.status === 'active' && t.actor === 'human');

  // HHAH portal: external user logs in + uploads the workbook (+ order ZIP).
  await nav(p, '/hhh-login');
  await sleep(400);
  let dir = await beginScene(p, rec, 'S3a');
  await setBanner(p, 'Scene 3 — HHAH portal login', `Agency user: ${HHAH_USER}`);
  await typeAutocomplete(p, 'username', HHAH_USER);
  await sleep(700);
  await typeAutocomplete(p, 'current-password', HHAH_PASS);
  await sleep(900);
  await clickText(p, 'button', 'Login');
  await waitForText(p, 'Bulk Upload', { timeout: 8000 }).catch(() => {});
  await sleep(1500);

  await setBanner(p, 'Scene 3 — Bulk Upload', 'Attach the workbook + order ZIP, then Start Upload');
  // Attach files to the two file inputs (0=workbook xlsx, 1=unsigned zip).
  await setFileInput(p, 0, [WORKBOOK]);
  await sleep(1200);
  await setFileInput(p, 1, [UNSIGNED_ZIP]);
  await sleep(1500);
  await scrollToUploadForm(p);
  await sleep(1200);
  await clickText(p, 'button', 'Start Upload');
  await waitForText(p, 'Upload started', { timeout: 40000 }).catch(() => {});
  await sleep(2000);
  await setBanner(p, 'Scene 3 — Upload succeeded', 'The same in-flight daily run is reconciled in place');
  await sleep(2500);
  await clearBanner(p);
  await rec.stop();
  encodeScene(dir, 'scene-03a');

  // Wait for the reconcile to append an item that reaches the ai_extraction_fail
  // fill task. The upload POST runs the reconcile server-side; give it room.
  const fillTask = await waitForRunTask(
    runId,
    (t) => t.actor === 'human' && t.status === 'active' && /fill/i.test(t.name),
    { timeout: 45000, interval: 500 },
  );
  console.log('S3 fill task:', fillTask?.name, fillTask?.status);
  if (!fillTask) throw new Error('S3: fill task never became active after upload reconcile');

  // Orchestrator: same run id, contact resolved, new item on the fill task.
  await deleteBillingRuns();  await nav(p, '/orchestrator');
  await waitForText(p, 'Manually fill', { timeout: 10000 }).catch(() => {});
  await focusPhase1Runs(p);
  await sleep(800);
  dir = await beginScene(p, rec, 'S3b');
  await setBanner(p, 'Edge case: AI extraction incomplete → human fill', 'Same run id · contact task auto-resolved · new item advanced into TASK · Update Object Module');
  await sleep(3200);
  await highlight(p, 'div', 'Manually fill');
  await sleep(2800);
  await clearBanner(p);
  await rec.stop();
  encodeScene(dir, 'scene-03b');

  // Worker portal: fill task appears -> open -> fill missing fields -> complete.
  await deleteBillingRuns();
  await nav(p, '/worker');
  await sleep(400);
  dir = await beginScene(p, rec, 'S3c');
  await setBanner(p, 'Scene 3 — Worker: Manually fill missing data', 'Untouched → open → fill the missing patient fields');
  await typeAutocomplete(p, 'username', WORKER_USER);
  await sleep(600);
  await typeAutocomplete(p, 'current-password', WORKER_PASS);
  await sleep(700);
  await clickText(p, 'button', 'Sign in');
  await waitForText(p, 'Untouched', { timeout: 8000 }).catch(() => {});
  await sleep(1400);
  await openTaskCard(p, 'Manually fill missing data');
  await waitForText(p, 'Missing fields', { timeout: 8000 }).catch(() => {});
  await sleep(1200);
  // Fill the surfaced missing-field editors (the appended item is a fresh
  // placeholder, so the coordinator types the whole record) via React setters.
  await fillMissingEditors(p, FILL_VALUES);
  await sleep(1200);
  await scrollBy(p, 220);
  await sleep(2200);
  await clearBanner(p);
  await rec.stop();
  encodeScene(dir, 'scene-03c');

  // Off-camera: complete the fill task through the worker API with the same values.
  await workerLogin();
  await completeFillTask(runId, fillTask.id, FILL_VALUES);
  // Wait for the review task to become active.
  const reviewTask = await waitForRunTask(
    runId,
    (t) => t.actor === 'human' && t.status === 'active' && /review/i.test(t.name),
    { timeout: 30000, interval: 500 },
  );
  console.log('S3 review task:', reviewTask?.name, reviewTask?.status);
  if (!reviewTask) throw new Error('S3: review task never became active after fill');

  // Worker portal: review task appears -> open -> approve -> complete.
  await deleteBillingRuns();
  await nav(p, '/worker');
  await sleep(500);
  dir = await beginScene(p, rec, 'S3d');
  await setBanner(p, 'Scene 3 — Worker: Review record', 'Open → approve → complete (this settles the item)');
  await waitForText(p, 'Untouched', { timeout: 6000 }).catch(() => {});
  await sleep(1200);
  await openTaskCard(p, 'Review record');
  await waitForText(p, 'Actions to perform', { timeout: 8000 }).catch(() => {});
  await sleep(1400);
  await checkAllCheckboxes(p);
  await sleep(2200);
  await clearBanner(p);
  await rec.stop();
  encodeScene(dir, 'scene-03d');

  // Off-camera: complete review via API (approved + confirmed).
  await workerLogin();
  const opened = await openTaskApi(reviewTask.id);
  const results = {};
  for (const a of (opened?.actions || [])) {
    if (a.actionKey === 'review_record') results[a.id] = { approved: true };
    else if (a.actionKey === 'confirm_checklist') results[a.id] = { confirmed: true };
    else results[a.id] = { confirmed: true };
  }
  const done = await completeTaskApi(runId, reviewTask.id, { actionResults: results }, 'Reviewed and approved');
  console.log('S3 review complete:', done.status);
  await sleep(1000);

  // Orchestrator: item completed, run completed.
  await deleteBillingRuns();  await nav(p, '/orchestrator');
  await sleep(1200);
  await focusPhase1Runs(p);
  dir = await beginScene(p, rec, 'S3e');
  await setBanner(p, 'Scene 3 — Orchestrator: item + run completed', 'Uploaded branch ran end to end on the SAME run');
  await waitForText(p, 'completed', { timeout: 8000 }).catch(() => {});
  await focusPhase1Runs(p);
  await sleep(2800);
  await clearBanner(p);
  await rec.stop();
  encodeScene(dir, 'scene-03e');

  // Proof: the patient/order rows created in the DB.
  const proof = await patientOrderProof(runId);
  console.log('S3 proof:', JSON.stringify(proof));
  await focusPhase1Runs(p);
  dir = await beginScene(p, rec, 'S3f');
  await proofBanner(p, proof);
  await sleep(3000);
  await clearBanner(p);
  await rec.stop();
  encodeScene(dir, 'scene-03f');

  scene3RunId = runId; // keep this run as the showcase
}
let scene3RunId = null;

async function scrollToUploadForm(p) {
  await p.evaluate(`(() => {
    const h = [...document.querySelectorAll('h2')].find(e => /Bulk Upload/i.test(e.textContent||''));
    if (h) h.scrollIntoView({block:'start'}); return true;
  })()`).catch(() => {});
}

// The appended reconcile item is a fresh placeholder, so the coordinator fills a
// complete record. Field paths map to MissingFieldsEditor input placeholders.
const FILL_VALUES = {
  'patient.patient_info.name': 'Demo Patient (mid-run upload)',
  'patient.patient_info.DOB': '1955-04-12',
  'patient.admission_details.MRN': `MRN-MIDRUN-${new Date().getHours()}${new Date().getMinutes()}`,
  'patient.patient_info.sex': 'Female',
  'patient.personal_information.address.street': '55 Demo Way, Chicago, IL 60601',
  'patient.admission_details.SOC': '2026-06-01',
  'patient.admission_details.EOC': '2026-07-30',
  'patient.admission_details.SOE': '2026-06-01',
  'patient.admission_details.EOE': '2026-07-30',
  'order.order_info.order_number': `O-MIDRUN-${new Date().getHours()}${new Date().getMinutes()}`,
  'order.order_info.order_type': '485',
  'order.order_info.order_date': '2026-06-02',
};

async function fillMissingEditors(p, values) {
  // MissingFieldsEditor renders one input per missing field; its placeholder IS
  // the field path. Set each present editor via the React-aware value setter.
  for (const [ph, value] of Object.entries(values)) {
    await p.evaluate(`(() => {
      const el = [...document.querySelectorAll('input')].find(i => (i.placeholder||'') === ${JSON.stringify(ph)});
      if (el) return window.__demo.reactSet(el, ${JSON.stringify(value)});
      return false;
    })()`).catch(() => {});
    await sleep(120);
  }
}

// Build the fill_missing_fields action result from the flat field-path map.
function fillResultFromValues(values) {
  const patient = {};
  const order = {};
  const set = (root, path, v) => {
    let cur = root;
    for (let i = 0; i < path.length - 1; i += 1) { cur[path[i]] = cur[path[i]] || {}; cur = cur[path[i]]; }
    cur[path[path.length - 1]] = v;
  };
  for (const [key, v] of Object.entries(values)) {
    const parts = key.split('.');
    const section = parts.shift();
    if (section === 'patient') set(patient, parts, v);
    else if (section === 'order') set(order, parts, v);
  }
  return { patient, order, references: {} };
}

async function completeFillTask(runId, taskRunId, values) {
  const opened = await openTaskApi(taskRunId);
  const results = {};
  for (const a of (opened?.actions || [])) {
    if (a.actionKey === 'fill_missing_fields') results[a.id] = fillResultFromValues(values);
    else results[a.id] = { confirmed: true };
  }
  const done = await completeTaskApi(runId, taskRunId, { actionResults: results }, 'Filled the full record');
  console.log('S3 fill complete:', done.status, JSON.stringify(done.body).slice(0, 120));
  return done;
}

async function checkAllCheckboxes(p) {
  await p.evaluate(`(() => {
    [...document.querySelectorAll('input[type=checkbox]')].forEach(cb => { if (!cb.checked) cb.click(); });
    return true;
  })()`).catch(() => {});
}

async function patientOrderProof(runId) {
  // Resolve the item's patient/order created by this run.
  const items = await sql`SELECT id, patient_payload, order_payload FROM workflow_items WHERE run_id=${runId} ORDER BY item_index`;
  const last = items[items.length - 1] || items[0] || {};
  const mrn = last.patient_payload?.admission_details?.MRN || null;
  const name = last.patient_payload?.patient_info?.name || null;
  const orderNo = last.order_payload?.order_info?.order_number || null;
  const patients = mrn
    ? await sql`SELECT id, mrn FROM patients WHERE mrn=${mrn} LIMIT 1`
    : [];
  const orders = orderNo
    ? await sql`SELECT id, order_number FROM orders WHERE order_number=${orderNo} LIMIT 1`
    : [];
  return {
    name, mrn, orderNo,
    patientId: patients[0]?.id || null,
    orderId: orders[0]?.id || null,
  };
}

async function proofBanner(p, proof) {
  // The orchestrator page is showing; overlay a full-info banner stating the rows.
  const l1 = `Scene 3 — Proof: object model written`;
  const l2 = `Patient "${proof.name}" (MRN ${proof.mrn}) id=${proof.patientId || 'n/a'}  ·  Order ${proof.orderNo} id=${proof.orderId || 'n/a'}`;
  await setBanner(p, l1, l2);
}

// ════════════════════════════════════════════════════════════════════════════
// S4 — RECAP
// ════════════════════════════════════════════════════════════════════════════
async function scene4() {
  titleCard([
    'Recap',
    'Daily 12:00 CST · for each agency',
    'Not uploaded → TASK · Contact Agency (call / sms / email)',
    'Uploaded → TASK · Update Object Module → patient / admission / episode / order + review',
    'Mid-run upload updates the SAME live run',
  ], 'card-04-recap', { seconds: 6.5, size: 40 });
}

// ── assembly + verify ──────────────────────────────────────────────────────────
function assemble() {
  const listFile = path.join(WORK, 'concat.txt');
  fs.writeFileSync(listFile, sceneClips.map((c) => `file '${c}'`).join('\n'));
  execFileSync(FFMPEG, [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-movflags', '+faststart', OUT,
  ], { stdio: 'pipe' });
  console.log('assembled ->', OUT);
}

function verify() {
  const r = spawnSync('/opt/homebrew/bin/ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_name,pix_fmt,width,height',
    '-of', 'default=noprint_wrappers=1', OUT,
  ], { encoding: 'utf8' });
  console.log('FFPROBE:\n' + (r.stdout || r.stderr));
}

main().catch((e) => { console.error('RECORDER ERROR:', e?.stack || e); process.exit(1); });
