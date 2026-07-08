// Workflow definitions: GET lists (re-upserting missing system defs), POST
// dispatches builder actions — saveWorkflow (validate + compile + version),
// deleteWorkflow (builder-only soft delete), catalog (builder palette).
import { handleError, methodNotAllowed, readJson, sendJson } from '../_lib/http.js';
import {
  deactivateWorkflowDefinition,
  ensureSystemDefinitions,
  getActiveWorkflow,
  getWorkflowMaxVersion,
  listActiveWorkflowDefinitions,
  upsertWorkflowDefinition,
} from '../_lib/repositories.js';
import { compileGraph, validateGraph } from '../_lib/builderCompiler.js';
import { builderCatalog } from '../_lib/builderCatalog.js';
import { listEmployees } from '../_lib/identityRepo.js';
import { httpError } from '../_lib/auth.js';

async function saveWorkflow(body) {
  const { id, name, description = '', graph } = body;
  const trigger = body.trigger || graph?.trigger || null;
  if (!name || !String(name).trim()) throw httpError(400, 'Workflow name is required');

  const messages = await validateGraph(graph, trigger);
  if (messages.length) throw httpError(400, 'Workflow validation failed', { messages });
  const { steps, conditions, megaGroups } = await compileGraph(graph, trigger);

  const workflowId = id || `cc-${Date.now()}`;
  if (id) {
    const existing = await getActiveWorkflow(id);
    if (existing && existing.kind !== 'builder') {
      throw httpError(400, 'System workflows cannot be edited');
    }
  }

  const definition = {
    id: workflowId,
    name: String(name).trim(),
    description,
    builder: true,
    trigger,
    // Persist graph.groups (when authored) so the editor round-trips group
    // membership; nodes/entry are unchanged. groups is authoring metadata only.
    graph: { entry: graph.entry, nodes: graph.nodes, ...(graph.groups ? { groups: graph.groups } : {}) },
    steps,
    conditions,
    // megaGroups rides alongside steps/conditions as pure presentation metadata
    // (same as wf7). The engine never reads it; only the flowchart renderer does.
    ...(megaGroups ? { megaGroups } : {}),
  };

  // Same id => new version becomes the single active one (older versions stay
  // for runs already pinned to them). Deactivate first: the schema enforces at
  // most one active row per id (workflow_definitions_one_active).
  const version = (await getWorkflowMaxVersion(workflowId)) + 1;
  await deactivateWorkflowDefinition(workflowId, { keepVersion: version });
  const workflow = await upsertWorkflowDefinition(definition, version, { kind: 'builder' });
  return { workflow, steps, conditions };
}

async function deleteWorkflow({ id }) {
  if (!id) throw httpError(400, 'Workflow id is required');
  const workflow = await getActiveWorkflow(id);
  if (!workflow) throw httpError(404, 'Workflow not found');
  if (workflow.kind !== 'builder') throw httpError(400, 'Only builder workflows can be deleted');
  await deactivateWorkflowDefinition(id);
  return { ok: true };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      await ensureSystemDefinitions();
      const workflows = await listActiveWorkflowDefinitions();
      return sendJson(res, 200, { workflows });
    }
    if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

    const body = await readJson(req);
    switch (body.action) {
      case 'saveWorkflow':
        return sendJson(res, 200, await saveWorkflow(body));
      case 'deleteWorkflow':
        return sendJson(res, 200, await deleteWorkflow(body));
      case 'catalog': {
        const employees = await listEmployees();
        return sendJson(res, 200, {
          ...builderCatalog(),
          employees: employees
            .filter((employee) => employee.active)
            .map(({ id, username, display_name, job_role }) => ({ id, username, display_name, job_role })),
        });
      }
      default:
        return sendJson(res, 400, { error: 'Unsupported workflows action.' });
    }
  } catch (error) {
    return handleError(res, error);
  }
}
