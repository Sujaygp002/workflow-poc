import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { parseMultipart } from '../../_lib/multipart.js';
import { orderNumberFromPdfName, uploadPdfBufferToBlob, uploadPdfToBlob, withPdfOrderKey } from '../../_lib/blobStore.js';
import { parseWorkflowWorkbook } from '../../_lib/excelParser.js';
import { handleError, methodNotAllowed, readJson, sendJson } from '../../_lib/http.js';
import {
  createTaskRunsForItem,
  createWorkflowItem,
  createWorkflowRun,
  ensureSystemDefinitions,
  findHhahByName,
  findStatisticalAreaByName,
  getActiveWorkflow,
  getHhahById,
  getRunWithDefinition,
  insertUploadedDocument,
  listActiveBuilderWorkflowsByTrigger,
  listTaskRunsForRun,
} from '../../_lib/repositories.js';
import { runWorkflowAutomation } from '../../_lib/workflowEngine.js';
import { httpError, requireSession } from '../../_lib/auth.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

// Builder trigger routing: if ≥1 active builder workflow declares a
// document_upload trigger, the upload starts a run of EACH of them (one item
// per parsed row). Otherwise it falls back to the system wf7 intake run.
async function targetWorkflows() {
  await ensureSystemDefinitions();
  const builderWorkflows = await listActiveBuilderWorkflowsByTrigger('document_upload');
  if (builderWorkflows.length) return builderWorkflows;
  const wf7 = await getActiveWorkflow('wf7');
  return wf7 ? [wf7] : [];
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
  };
}

// The authenticated portal agency is authoritative for every row of the upload:
// stamp it over whatever the workbook's Agencyname column said (or left blank),
// so patients/orders land under the real Entity-page agency (hhah_name AND
// agency_id resolve) instead of spawning phantom / "Unknown agency" records.
function stampSessionAgency(referencePayload, areaContext) {
  if (!areaContext?.hhahId || !areaContext?.hhahName) return referencePayload || {};
  const ref = referencePayload || {};
  return {
    ...ref,
    HHAH: {
      ...(ref.HHAH || {}),
      name: areaContext.hhahName,
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

function pdfMetadataForItem(item, pdfsByOrderNumber) {
  const orderNumber = item.orderPayload?.order_info?.order_number;
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

// Upload + register this run's PDFs (loose pdf fields + unsigned/signed ZIPs).
async function registerRunDocuments({ run, pdfs, zipPdfs }) {
  const uploadedPdfs = [];
  for (const pdf of pdfs) {
    const uploaded = await uploadPdfToBlob(pdf, run.id);
    const document = await insertUploadedDocument({
      runId: run.id,
      fileName: pdf.originalFilename || 'document.pdf',
      contentType: pdf.mimetype || 'application/pdf',
      sizeBytes: pdf.size || uploaded.buffer?.byteLength,
      blobUrl: uploaded.blobUrl,
      blobPath: uploaded.blobPath,
    });
    uploadedPdfs.push(withPdfOrderKey({ ...uploaded, fileName: pdf.originalFilename, document }));
  }

  for (const pdf of zipPdfs) {
    const uploaded = await uploadPdfBufferToBlob(pdf, run.id);
    const document = await insertUploadedDocument({
      runId: run.id,
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

async function startRunForWorkflow({ workflow, parsed, areaContext, sourceLabel, pdfs, zipPdfs }) {
  const run = await createWorkflowRun({
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    sourceLabel,
    totalItems: parsed.joined.length,
    inputSummary: { ...parsed.summary, area: areaContext, workflowName: workflow.name },
    areaId: areaContext.areaId,
    hhahId: areaContext.hhahId,
  });

  const uploadedPdfs = await registerRunDocuments({ run, pdfs, zipPdfs });
  const pdfsByOrderNumber = Object.fromEntries(uploadedPdfs.map((pdf) => [orderNumberFromPdfName(pdf.fileName), pdf]));

  let itemIndex = 0;
  for (const item of parsed.joined) {
    const created = await createWorkflowItem({
      runId: run.id,
      itemIndex,
      patientPayload: item.patientPayload,
      orderPayload: item.orderPayload,
      referencePayload: stampSessionAgency(item.referencePayload, areaContext),
      extractionPayload: {
        sourceRows: item.sourceRows,
        pdf: pdfMetadataForItem(item, pdfsByOrderNumber),
      },
    });
    await createTaskRunsForItem({
      runId: run.id,
      itemId: created.id,
      steps: workflow.definition.steps,
    });
    itemIndex += 1;
  }

  await runWorkflowAutomation({
    runId: run.id,
    definition: workflow.definition,
    context: {
      pdfs: uploadedPdfs,
      pdfsByOrderNumber,
    },
  });
  const refreshed = await getRunWithDefinition(run.id);
  const tasks = await listTaskRunsForRun(run.id);
  return { run: refreshed, tasks };
}

async function startFromMultipart(req, hhahUser) {
  const { fields, workbook, pdfs, unsignedZips, signedZips } = await parseMultipart(req);
  if (!workbook) throw new Error('Upload requires a .xlsx workbook field named "workbook".');

  const workflows = await targetWorkflows();
  if (!workflows.length) throw new Error('No active workflow accepts document uploads.');
  const areaContext = await resolveAreaUploadContext(hhahUser, fields);
  const parsed = await parseWorkflowWorkbook(workbook.filepath);
  const sourceLabel = String(firstField(fields.sourceLabel, workbook.originalFilename || 'Excel upload'));

  const zipPdfs = [];
  const zipSets = [
    ...unsignedZips.map((zip) => ({ zip, signed: false })),
    ...signedZips.map((zip) => ({ zip, signed: true })),
  ];
  for (const { zip, signed } of zipSets) {
    zipPdfs.push(...await pdfsFromZip(zip, signed));
  }

  const results = [];
  for (const workflow of workflows) {
    results.push(await startRunForWorkflow({ workflow, parsed, areaContext, sourceLabel, pdfs, zipPdfs }));
  }
  const [first] = results;
  return {
    run: first.run,
    tasks: first.tasks,
    runs: results.map((result) => result.run),
    inputSummary: { ...parsed.summary },
  };
}

async function startFromJson(req, hhahUser) {
  const body = await readJson(req);
  if (!Array.isArray(body.items)) {
    throw new Error('JSON start requires an items array of { patientPayload, orderPayload, referencePayload }.');
  }
  const workflows = await targetWorkflows();
  if (!workflows.length) throw new Error('No active workflow accepts document uploads.');
  const areaContext = await resolveAreaUploadContext(hhahUser, {}, body);

  const results = [];
  for (const workflow of workflows) {
    const run = await createWorkflowRun({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      sourceLabel: body.sourceLabel || 'JSON upload',
      totalItems: body.items.length,
      inputSummary: { joinedRows: body.items.length, mode: 'json', area: areaContext, workflowName: workflow.name },
      areaId: areaContext.areaId,
      hhahId: areaContext.hhahId,
    });

    for (let i = 0; i < body.items.length; i += 1) {
      const item = body.items[i];
      const created = await createWorkflowItem({
        runId: run.id,
        itemIndex: i,
        patientPayload: item.patientPayload,
        orderPayload: item.orderPayload,
        referencePayload: stampSessionAgency(item.referencePayload, areaContext),
        extractionPayload: item.extractionPayload || {},
      });
      await createTaskRunsForItem({
        runId: run.id,
        itemId: created.id,
        steps: workflow.definition.steps,
      });
    }

    await runWorkflowAutomation({ runId: run.id, definition: workflow.definition });
    const refreshed = await getRunWithDefinition(run.id);
    const tasks = await listTaskRunsForRun(run.id);
    results.push({ run: refreshed, tasks });
  }
  const [first] = results;
  return {
    run: first.run,
    tasks: first.tasks,
    runs: results.map((result) => result.run),
    inputSummary: { joinedRows: body.items.length, mode: 'json' },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const hhahUser = await requireHhahUser(req);
    const contentType = req.headers['content-type'] || '';
    const result = contentType.includes('multipart/form-data')
      ? await startFromMultipart(req, hhahUser)
      : await startFromJson(req, hhahUser);
    return sendJson(res, 201, result);
  } catch (error) {
    return handleError(res, error);
  }
}
