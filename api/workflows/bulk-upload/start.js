import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { parseMultipart } from '../../_lib/multipart.js';
import { orderNumberFromPdfName, uploadPdfBufferToBlob, uploadPdfToBlob, withPdfOrderKey } from '../../_lib/blobStore.js';
import { parseWorkflowWorkbook } from '../../_lib/excelParser.js';
import { handleError, methodNotAllowed, readJson, sendJson } from '../../_lib/http.js';
import {
  countWorkflowItems,
  createPgFromPayload,
  createPractitionerFromPayload,
  createTaskRunsForItem,
  createWorkflowItem,
  createWorkflowRun,
  ensureSystemDefinitions,
  findHhahByName,
  findPgByName,
  findPractitionerByNpi,
  findStatisticalAreaByName,
  findWorkflowRunBySourceLabel,
  getHhahById,
  getRunItems,
  getRunWithDefinition,
  insertUploadedDocument,
  listActiveBuilderWorkflowsByTrigger,
  listTaskRunsForRun,
  mapPgToPractitioner,
  resolveOpenAgencyAskTaskForRun,
} from '../../_lib/repositories.js';
import { runWorkflowAutomation } from '../../_lib/workflowEngine.js';
import { dailySourceLabel, nowPartsInTz } from '../../_lib/dailyBucket.js';
import { httpError, requireSession } from '../../_lib/auth.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

// Upload routing: the daily_time builder workflow(s) are the intake pipeline.
// An HHAH upload appends one item per parsed workbook row to TODAY's daily run
// (created on demand if the noon tick hasn't fired yet). There is no wf7
// fallback — wf7/wf-signing/wf-billing-monitor were removed.
async function dailyWorkflows() {
  await ensureSystemDefinitions();
  return listActiveBuilderWorkflowsByTrigger('daily_time');
}

// The HHAH portal must be signed in: bearer session of an external hhah user.
async function requireHhahUser(req) {
  const { externalUser } = await requireSession(req, { type: 'external' });
  if (externalUser.user_type !== 'hhah') {
    throw httpError(403, 'An HHAH portal login is required to upload documents');
  }
  return externalUser;
}

function firstField(value, fallback = '') {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

// hhahId comes from the session user; form/JSON fields stay as a fallback for
// area scope + script-mode compatibility.
async function resolveAreaUploadContext(hhahUser, fields = {}, body = {}) {
  const areaId = firstField(fields.areaId, body.areaId || null);
  const areaName = firstField(fields.areaName, body.areaName || '');
  const areaType = firstField(fields.areaType, body.areaType || 'micro_statistical_area');
  const fallbackHhahId = firstField(fields.hhahId, body.hhahId || null);
  const fallbackHhahName = firstField(fields.hhahName, body.hhahName || '');
  const area = areaId ? { id: areaId } : areaName ? await findStatisticalAreaByName(areaName, areaType) : null;
  const hhah = hhahUser?.agency_id
    ? await getHhahById(hhahUser.agency_id)
    : fallbackHhahId
      ? await getHhahById(fallbackHhahId)
      : fallbackHhahName ? await findHhahByName(fallbackHhahName) : null;
  return {
    areaId: area?.id || null,
    hhahId: hhah?.id || null,
    areaName: area?.name || areaName || null,
    hhahName: hhah?.name || fallbackHhahName || null,
    // Carried so an appended daily item's reference_payload.HHAH.contact matches
    // the native daily item shape (email_agency reads contact.email).
    contact: hhah?.contact_info || {},
  };
}

// The authenticated portal agency is authoritative for every row of the upload:
// stamp it over whatever the workbook's Agencyname column said (or left blank),
// so patients/orders land under the real Entity-page agency (hhah_name AND
// agency_id resolve) instead of spawning phantom / "Unknown agency" records.
//
// It ALSO sets HHAH.id + HHAH.contact on the reference payload — a row item
// flows through the daily workflow's n1 (agency.checkUploadedToday matches on
// HHAH.id) and, if the false-branch email were ever reached, email_agency reads
// HHAH.contact.email. This extends (not replaces) the Coverage-Map session
// stamping: name + data_tags are preserved exactly as before.
function stampSessionAgency(referencePayload, areaContext) {
  if (!areaContext?.hhahId || !areaContext?.hhahName) return referencePayload || {};
  const ref = referencePayload || {};
  return {
    ...ref,
    HHAH: {
      ...(ref.HHAH || {}),
      id: areaContext.hhahId,
      name: areaContext.hhahName,
      contact: areaContext.contact || {},
      data_tags: {
        ...(ref.HHAH?.data_tags || {}),
        source: 'session_agency',
        match_key: `hhah_id:${areaContext.hhahId}`,
        validated_by: 'session',
        confidence: 'confirmed',
      },
    },
  };
}

// Auto-create PGs and practitioners referenced by the upload rows so that
// patient/order writes can resolve real PG ids (and the Coverage Map / Entity
// pages show them) even when the agency never onboarded them explicitly.
//
// Best-effort: every step is wrapped so a failure NEVER blocks the upload.
// - PG key: referencePayload.PG.name (from the workbook "pg name" column).
// - Practitioner key: referencePayload.practitioner.NPI (from the order row NPI).
// Created rows are tagged raw_data.source='auto_upload', onboarded:false so the
// UI can distinguish auto-created (non-onboarded) entities. Resolved PG ids are
// stamped back onto each row's referencePayload.PG.id for the item writers.
async function autoUpsertPgsAndPractitioners(rows) {
  const stats = { pgCreated: 0, pgFound: 0, pgSkipped: 0, practCreated: 0, practFound: 0, practSkipped: 0, mapped: 0 };
  if (!Array.isArray(rows) || !rows.length) return stats;

  const digitsOnly = (v) => String(v ?? '').replace(/\D/g, '');
  const pgIdByName = new Map();       // normalized-ish key (raw name) -> pg id
  const practIdByNpi = new Map();     // npi digits -> practitioner id

  // 1) Resolve/create every unique PG name.
  for (const row of rows) {
    const pgName = (row?.referencePayload?.PG?.name || '').trim();
    if (!pgName) { stats.pgSkipped += 1; continue; }
    if (pgIdByName.has(pgName)) continue;
    try {
      let pg = await findPgByName(pgName);
      if (pg) {
        stats.pgFound += 1;
      } else {
        const pgNpi = row.referencePayload.PG.NPI || row.referencePayload.PG.npi || '';
        pg = await createPgFromPayload({
          PG: {
            name: pgName,
            NPI: pgNpi || '',
            raw_data: { source: 'auto_upload', onboarded: false },
            contact_info: { physician_ids: [] },
          },
        });
        stats.pgCreated += 1;
      }
      if (pg?.id) pgIdByName.set(pgName, pg.id);
    } catch (err) {
      console.error('[autoUpsert] PG upsert failed for', pgName, err?.message || err);
    }
  }

  // 2) Resolve/create every unique practitioner NPI (order-row NPI).
  for (const row of rows) {
    const pract = row?.referencePayload?.practitioner || {};
    const npi = digitsOnly(pract.NPI || pract.npi);
    if (!npi) { stats.practSkipped += 1; continue; }
    if (practIdByNpi.has(npi)) continue;
    try {
      let existing = await findPractitionerByNpi(npi);
      if (existing) {
        stats.practFound += 1;
      } else {
        const practitionerName = (pract.physician_name || pract.name || '').trim();
        existing = await createPractitionerFromPayload({
          practitioner: {
            physician_name: practitionerName || 'Unknown',
            NPI: npi,
            raw_data: { source: 'auto_upload', onboarded: false },
            history: { PG_names: [] },
          },
        });
        stats.practCreated += 1;
      }
      if (existing?.id) practIdByNpi.set(npi, existing.id);
    } catch (err) {
      console.error('[autoUpsert] practitioner upsert failed for npi', npi, err?.message || err);
    }
  }

  // 3) Auto-map PG <-> practitioner when a row carries both. mapPgToPractitioner
  //    is idempotent (dedupes physician_ids / PG_names), so re-mapping is safe.
  const mappedPairs = new Set();
  for (const row of rows) {
    const pgName = (row?.referencePayload?.PG?.name || '').trim();
    const npi = digitsOnly(row?.referencePayload?.practitioner?.NPI || row?.referencePayload?.practitioner?.npi);
    const pgId = pgName ? pgIdByName.get(pgName) : null;
    const practitionerId = npi ? practIdByNpi.get(npi) : null;
    if (!pgId || !practitionerId) continue;
    const pairKey = `${pgId}|${practitionerId}`;
    if (mappedPairs.has(pairKey)) continue;
    mappedPairs.add(pairKey);
    try {
      await mapPgToPractitioner({ pgId, practitionerId });
      stats.mapped += 1;
    } catch (err) {
      console.error('[autoUpsert] mapPgToPractitioner failed for', pairKey, err?.message || err);
    }
  }

  // 4) Stamp the resolved PG id back onto each row so the item writers use it.
  for (const row of rows) {
    const pgName = (row?.referencePayload?.PG?.name || '').trim();
    const pgId = pgName ? pgIdByName.get(pgName) : null;
    if (pgId && row.referencePayload?.PG) row.referencePayload.PG.id = pgId;
  }

  return stats;
}

async function pdfsFromZip(zipFile, signed = false) {
  const zipBuffer = await fs.readFile(zipFile.filepath);
  const zip = await JSZip.loadAsync(zipBuffer);
  const extracted = [];

  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !name.toLowerCase().endsWith('.pdf')) continue;
    const buffer = await entry.async('nodebuffer');
    extracted.push({
      buffer,
      originalFilename: name.split('/').pop(),
      mimetype: 'application/pdf',
      size: buffer.byteLength,
      sourceZip: zipFile.originalFilename || (signed ? 'signed.zip' : 'orders.zip'),
      signed,
    });
  }

  return extracted;
}

function pdfMetadataForItem(orderPayload, pdfsByOrderNumber) {
  const orderNumber = orderPayload?.order_info?.order_number;
  const pdf = orderNumber ? pdfsByOrderNumber[orderNumberFromPdfName(`${orderNumber}.pdf`)] : null;
  if (!pdf) return {};
  // Order numbers are unique, so each order's PDF is in EITHER the signed or the
  // unsigned ZIP. `signed` flags which one matched.
  return {
    fileName: pdf.fileName,
    blobUrl: pdf.blobUrl,
    blobPath: pdf.blobPath,
    documentId: pdf.document?.id || null,
    sourceZip: pdf.sourceZip || null,
    signed: !!pdf.signed,
  };
}

// Upload + register this run's PDFs (loose pdf fields + unsigned/signed ZIPs),
// anchoring each uploaded_documents row to the DAILY run + the uploading agency
// (hhahId), so agency.checkUploadedToday sees the upload for that agency + day.
async function registerRunDocuments({ runId, hhahId, pdfs, zipPdfs }) {
  const uploadedPdfs = [];
  for (const pdf of pdfs) {
    const uploaded = await uploadPdfToBlob(pdf, runId);
    const document = await insertUploadedDocument({
      runId,
      hhahId,
      fileName: pdf.originalFilename || 'document.pdf',
      contentType: pdf.mimetype || 'application/pdf',
      sizeBytes: pdf.size || uploaded.buffer?.byteLength,
      blobUrl: uploaded.blobUrl,
      blobPath: uploaded.blobPath,
    });
    uploadedPdfs.push(withPdfOrderKey({ ...uploaded, fileName: pdf.originalFilename, document }));
  }

  for (const pdf of zipPdfs) {
    const uploaded = await uploadPdfBufferToBlob(pdf, runId);
    const document = await insertUploadedDocument({
      runId,
      hhahId,
      fileName: pdf.originalFilename || 'document.pdf',
      contentType: pdf.mimetype || 'application/pdf',
      sizeBytes: pdf.size || uploaded.buffer?.byteLength,
      blobUrl: uploaded.blobUrl,
      blobPath: uploaded.blobPath,
    });
    uploadedPdfs.push(withPdfOrderKey({
      ...uploaded,
      fileName: pdf.originalFilename,
      sourceZip: pdf.sourceZip,
      signed: pdf.signed,
      document,
    }));
  }
  return uploadedPdfs;
}

// Ensure TODAY's daily run exists for a daily_time workflow, creating it on
// demand (canonical sourceLabel) with NO base items when the noon tick hasn't
// fired yet. Items for OTHER agencies are NOT pre-created — the tick fills
// silent agencies later (R3). Returns { run, definition, dayBucket, tz }.
async function ensureDailyRun(workflow) {
  const trigger = workflow.definition?.trigger || {};
  const tz = trigger.tz || 'America/Chicago';
  const { dayBucket } = await nowPartsInTz(tz);
  const sourceLabel = dailySourceLabel(workflow.id, dayBucket);

  let run = await findWorkflowRunBySourceLabel(workflow.id, sourceLabel);
  if (!run) {
    run = await createWorkflowRun({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      sourceLabel,
      totalItems: 0,
      inputSummary: { trigger: 'daily_time', dayBucket, tz, workflowName: workflow.name, createdBy: 'upload' },
    });
  }
  const withDefinition = await getRunWithDefinition(run.id);
  return {
    run,
    definition: withDefinition?.definition || workflow.definition,
    dayBucket,
    tz,
  };
}

// Append one item per joined workbook row to the DAILY run for one workflow.
// Each row item carries patient/order payloads from the row, the session-stamped
// HHAH (id + name + contact), and a unique appendKey so a re-upload the same day
// dedupes. Then it auto-resolves the agency's open contact task and runs the
// automation so row items flow n1(FALSE branch)..n7.
async function appendRowsToDailyRun({ workflow, parsed, areaContext, uploadedPdfs, pdfsByOrderNumber }) {
  const { run, definition, dayBucket, tz } = await ensureDailyRun(workflow);
  const steps = definition?.steps || [];

  const existingItems = await getRunItems(run.id);
  const existingAppendKeys = new Set(existingItems.map((it) => it.extraction_payload?.appendKey).filter(Boolean));
  let itemIndex = await countWorkflowItems(run.id);

  const appended = [];
  let rowIndex = 0;
  for (const row of parsed.joined) {
    const orderNumber = row.orderPayload?.order_info?.order_number || '';
    // appendKey unique per (agency, order/row, day). order_number when present,
    // else patientKey|rowIndex so patient-only / order-only rows never collide
    // and a same-day re-upload of the same workbook dedupes exactly.
    const rowKey = orderNumber
      ? `ord:${orderNumber}`
      : `row:${row.patientPayload?.patient_info?.name || ''}|${rowIndex}`;
    const appendKey = `row:${areaContext.hhahId}:${rowKey}:${dayBucket}`;
    rowIndex += 1;
    if (existingAppendKeys.has(appendKey)) continue;

    const created = await createWorkflowItem({
      runId: run.id,
      itemIndex,
      patientPayload: row.patientPayload,
      orderPayload: row.orderPayload,
      referencePayload: stampSessionAgency(row.referencePayload, areaContext),
      extractionPayload: {
        sourceRows: row.sourceRows,
        pdf: pdfMetadataForItem(row.orderPayload, pdfsByOrderNumber),
        appendedFromUpload: true,
        dayBucket,
        tz,
        appendKey,
      },
    });
    await createTaskRunsForItem({ runId: run.id, itemId: created.id, steps });
    existingAppendKeys.add(appendKey);
    appended.push(created.id);
    itemIndex += 1;
  }

  // Auto-complete the uploading agency's open contact task on this run
  // (idempotent — the WHERE status='active' clause matches zero rows on a second
  // same-day upload).
  const resolved = await resolveOpenAgencyAskTaskForRun(run.id, areaContext.hhahId);

  // Advance the run so row items flow n1 (now sees the upload) .. n7 natively;
  // system steps auto-run and fill/review human tasks land in the worker bucket.
  await runWorkflowAutomation({
    runId: run.id,
    definition,
    context: { pdfs: uploadedPdfs, pdfsByOrderNumber },
  });

  const refreshed = await getRunWithDefinition(run.id);
  const tasks = await listTaskRunsForRun(run.id);
  return {
    run: refreshed,
    tasks,
    workflowId: workflow.id,
    dayBucket,
    appendedItemIds: appended,
    resolvedTaskIds: resolved?.resolved || [],
  };
}

async function startFromMultipart(req, hhahUser) {
  const { fields, workbook, pdfs, unsignedZips, signedZips } = await parseMultipart(req);
  if (!workbook) throw new Error('Upload requires a .xlsx workbook field named "workbook".');

  const workflows = await dailyWorkflows();
  if (!workflows.length) throw new Error('No active daily-intake workflow accepts document uploads.');
  const areaContext = await resolveAreaUploadContext(hhahUser, fields);
  if (!areaContext.hhahId) throw httpError(400, 'Upload requires a resolvable HHAH agency for the session.');
  const parsed = await parseWorkflowWorkbook(workbook.filepath);

  const zipPdfs = [];
  const zipSets = [
    ...unsignedZips.map((zip) => ({ zip, signed: false })),
    ...signedZips.map((zip) => ({ zip, signed: true })),
  ];
  for (const { zip, signed } of zipSets) {
    zipPdfs.push(...await pdfsFromZip(zip, signed));
  }

  return runDailyAppend({ workflows, parsed, areaContext, pdfs, zipPdfs });
}

async function startFromJson(req, hhahUser) {
  const body = await readJson(req);
  if (!Array.isArray(body.items)) {
    throw new Error('JSON start requires an items array of { patientPayload, orderPayload, referencePayload }.');
  }
  const workflows = await dailyWorkflows();
  if (!workflows.length) throw new Error('No active daily-intake workflow accepts document uploads.');
  const areaContext = await resolveAreaUploadContext(hhahUser, {}, body);
  if (!areaContext.hhahId) throw httpError(400, 'Upload requires a resolvable HHAH agency for the session.');

  // Reshape the JSON items into the same joined-row shape the workbook path
  // uses (manual test kit / Sunrise path → R5), so both flow identically.
  const parsed = {
    joined: body.items.map((item) => ({
      patientPayload: item.patientPayload || {},
      orderPayload: item.orderPayload || {},
      referencePayload: item.referencePayload || {},
      sourceRows: item.extractionPayload?.sourceRows || {},
    })),
    summary: { joinedRows: body.items.length, mode: 'json' },
  };

  return runDailyAppend({ workflows, parsed, areaContext, pdfs: [], zipPdfs: [] });
}

// Common flow for multipart + JSON: register documents once per (agency, day)
// then append the parsed rows to each active daily workflow's run.
async function runDailyAppend({ workflows, parsed, areaContext, pdfs, zipPdfs }) {
  // Best-effort auto-creation of the PGs + practitioners the rows reference, and
  // stamp resolved PG ids back onto parsed.joined BEFORE items are created.
  // Never throws — auto-creation must not block the upload.
  try {
    const stats = await autoUpsertPgsAndPractitioners(parsed.joined);
    console.log('[autoUpsert] pgs/practitioners:', JSON.stringify(stats));
  } catch (err) {
    console.error('[autoUpsert] skipped — auto-creation failed:', err?.message || err);
  }

  const results = [];
  for (const workflow of workflows) {
    // Register documents against THIS workflow's daily run so
    // agency.checkUploadedToday (which reads uploaded_documents by hhah_id+day)
    // sees the upload before the row items' n1 step runs.
    const { run } = await ensureDailyRun(workflow);
    const uploadedPdfs = await registerRunDocuments({
      runId: run.id,
      hhahId: areaContext.hhahId,
      pdfs,
      zipPdfs,
    });
    const pdfsByOrderNumber = Object.fromEntries(
      uploadedPdfs.map((pdf) => [orderNumberFromPdfName(pdf.fileName), pdf]),
    );
    results.push(await appendRowsToDailyRun({ workflow, parsed, areaContext, uploadedPdfs, pdfsByOrderNumber }));
  }
  const [first] = results;
  return {
    result: {
      run: first?.run || null,
      tasks: first?.tasks || [],
      runs: results.map((r) => r.run).filter(Boolean),
      dailyAppend: results.map((r) => ({
        workflowId: r.workflowId,
        runId: r.run?.id,
        dayBucket: r.dayBucket,
        appendedItems: r.appendedItemIds.length,
        resolvedTaskIds: r.resolvedTaskIds,
      })),
      inputSummary: { ...parsed.summary },
    },
    areaContext,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const hhahUser = await requireHhahUser(req);
    const contentType = req.headers['content-type'] || '';
    const { result } = contentType.includes('multipart/form-data')
      ? await startFromMultipart(req, hhahUser)
      : await startFromJson(req, hhahUser);
    return sendJson(res, 201, result);
  } catch (error) {
    return handleError(res, error);
  }
}
