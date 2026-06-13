import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { parseMultipart } from '../../_lib/multipart.js';
import { orderNumberFromPdfName, uploadPdfBufferToBlob, uploadPdfToBlob, withPdfOrderKey } from '../../_lib/blobStore.js';
import { parseWorkflowWorkbook } from '../../_lib/excelParser.js';
import { handleError, methodNotAllowed, readJson, sendJson } from '../../_lib/http.js';
import { SEEDED_USERS, WF7_DEFINITION } from '../../_lib/workflowDefinition.js';
import {
  createTaskRunsForItem,
  createWorkflowItem,
  createWorkflowRun,
  findHhahByName,
  findStatisticalAreaByName,
  getActiveWorkflow,
  getRunWithDefinition,
  insertUploadedDocument,
  listTaskRunsForRun,
  upsertUser,
  upsertWorkflowDefinition,
} from '../../_lib/repositories.js';
import { runWorkflowAutomation } from '../../_lib/workflowEngine.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

async function ensureWorkflow() {
  let workflow = await getActiveWorkflow('wf7');
  if (!workflow) {
    for (const user of SEEDED_USERS) await upsertUser(user);
    await upsertWorkflowDefinition(WF7_DEFINITION, 1);
    workflow = await getActiveWorkflow('wf7');
  }
  return workflow;
}

function firstField(value, fallback = '') {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

async function resolveAreaUploadContext(fields = {}, body = {}) {
  const areaId = firstField(fields.areaId, body.areaId || null);
  const hhahId = firstField(fields.hhahId, body.hhahId || null);
  const areaName = firstField(fields.areaName, body.areaName || '');
  const areaType = firstField(fields.areaType, body.areaType || 'micro_statistical_area');
  const hhahName = firstField(fields.hhahName, body.hhahName || '');
  const area = areaId ? { id: areaId } : areaName ? await findStatisticalAreaByName(areaName, areaType) : null;
  const hhah = hhahId ? { id: hhahId } : hhahName ? await findHhahByName(hhahName) : null;
  return {
    areaId: area?.id || null,
    hhahId: hhah?.id || null,
    areaName: area?.name || areaName || null,
    hhahName: hhah?.name || hhahName || null,
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

async function startFromMultipart(req) {
  const { fields, workbook, pdfs, unsignedZips, signedZips } = await parseMultipart(req);
  if (!workbook) throw new Error('Upload requires a .xlsx workbook field named "workbook".');

  const workflow = await ensureWorkflow();
  const areaContext = await resolveAreaUploadContext(fields);
  const parsed = await parseWorkflowWorkbook(workbook.filepath);
  const run = await createWorkflowRun({
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    sourceLabel: String(firstField(fields.sourceLabel, workbook.originalFilename || 'Excel upload')),
    totalItems: parsed.joined.length,
    inputSummary: { ...parsed.summary, area: areaContext },
    areaId: areaContext.areaId,
    hhahId: areaContext.hhahId,
  });

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

  // Unsigned ZIP(s) = order PDFs to be sent for signature; signed ZIP(s) = already
  // signed PDFs. Order numbers are unique, so an order's PDF is in only one of them.
  const zipSets = [
    ...unsignedZips.map((zip) => ({ zip, signed: false })),
    ...signedZips.map((zip) => ({ zip, signed: true })),
  ];
  for (const { zip, signed } of zipSets) {
    const extractedPdfs = await pdfsFromZip(zip, signed);
    for (const pdf of extractedPdfs) {
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
  }

  const pdfsByOrderNumber = Object.fromEntries(uploadedPdfs.map((pdf) => [orderNumberFromPdfName(pdf.fileName), pdf]));
  let itemIndex = 0;
  for (const item of parsed.joined) {
    const created = await createWorkflowItem({
      runId: run.id,
      itemIndex,
      patientPayload: item.patientPayload,
      orderPayload: item.orderPayload,
      referencePayload: item.referencePayload,
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
  return { run: refreshed, tasks, inputSummary: { ...parsed.summary } };
}

async function startFromJson(req) {
  const body = await readJson(req);
  if (!Array.isArray(body.items)) {
    throw new Error('JSON start requires an items array of { patientPayload, orderPayload, referencePayload }.');
  }
  const workflow = await ensureWorkflow();
  const areaContext = await resolveAreaUploadContext({}, body);
  const run = await createWorkflowRun({
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    sourceLabel: body.sourceLabel || 'JSON upload',
    totalItems: body.items.length,
    inputSummary: { joinedRows: body.items.length, mode: 'json', area: areaContext },
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
      referencePayload: item.referencePayload,
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
  return { run: refreshed, tasks, inputSummary: { joinedRows: body.items.length, mode: 'json' } };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const contentType = req.headers['content-type'] || '';
    const result = contentType.includes('multipart/form-data')
      ? await startFromMultipart(req)
      : await startFromJson(req);
    return sendJson(res, 201, result);
  } catch (error) {
    return handleError(res, error);
  }
}
