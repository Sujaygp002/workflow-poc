import { parseMultipart } from '../../_lib/multipart.js';
import { uploadPdfToBlob } from '../../_lib/blobStore.js';
import { parseWorkflowWorkbook } from '../../_lib/excelParser.js';
import { handleError, methodNotAllowed, readJson, sendJson } from '../../_lib/http.js';
import { SEEDED_USERS, WF7_DEFINITION } from '../../_lib/workflowDefinition.js';
import {
  createTaskRunsForItem,
  createWorkflowItem,
  createWorkflowRun,
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

async function startFromMultipart(req) {
  const { fields, workbook, pdfs } = await parseMultipart(req);
  if (!workbook) throw new Error('Upload requires a .xlsx workbook field named "workbook".');

  const workflow = await ensureWorkflow();
  const parsed = await parseWorkflowWorkbook(workbook.filepath);
  const run = await createWorkflowRun({
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    sourceLabel: String(fields.sourceLabel || workbook.originalFilename || 'Excel upload'),
    totalItems: parsed.joined.length,
    inputSummary: parsed.summary,
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
    uploadedPdfs.push({ ...uploaded, fileName: pdf.originalFilename, document });
  }

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
    context: { pdfs: uploadedPdfs },
  });

  const refreshed = await getRunWithDefinition(run.id);
  const tasks = await listTaskRunsForRun(run.id);
  return { run: refreshed, tasks, inputSummary: parsed.summary };
}

async function startFromJson(req) {
  const body = await readJson(req);
  if (!Array.isArray(body.items)) {
    throw new Error('JSON start requires an items array of { patientPayload, orderPayload, referencePayload }.');
  }
  const workflow = await ensureWorkflow();
  const run = await createWorkflowRun({
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    sourceLabel: body.sourceLabel || 'JSON upload',
    totalItems: body.items.length,
    inputSummary: { joinedRows: body.items.length, mode: 'json' },
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
