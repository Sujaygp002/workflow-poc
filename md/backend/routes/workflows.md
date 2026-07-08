# Workflows Route — list definitions + builder save/delete/catalog

**Source:** `api/workflows/index.js`
**Read this when:** changing how workflow definitions are listed, how builder workflows are saved/versioned/deleted, or what the builder palette (`catalog`) returns.

## What it does
Single serverless handler for `/api/workflows`. `GET` returns every ACTIVE workflow definition (first re-upserting any missing system definitions, so the list survives DB wipes). `POST` is an action dispatcher for the builder UI: `saveWorkflow` (validate graph → compile to steps → write a new version as the single active one), `deleteWorkflow` (builder-only soft delete), and `catalog` (builder palette blocks + active employees for assignee dropdowns). No auth is enforced on this route.

## Key functions / exports
| name | signature (params -> return) | behavior in one line | called by |
|---|---|---|---|
| `handler` (default) | `(req, res) -> JSON` | GET list / POST action dispatch, errors via `handleError` | Vercel runtime |
| `saveWorkflow` | `(body{id?, name, description?, graph, trigger?}) -> {workflow, steps, conditions}` | validate + compile graph, bump version, deactivate old versions, upsert as `kind:'builder'` | POST `action:'saveWorkflow'` |
| `deleteWorkflow` | `({id}) -> {ok:true}` | 404 if missing, 400 unless `kind==='builder'`, then `deactivateWorkflowDefinition(id)` | POST `action:'deleteWorkflow'` |
| (inline) catalog case | `() -> {...builderCatalog(), employees}` | palette + active employees mapped to `{id, username, display_name, job_role}` | POST `action:'catalog'` |

Repo dependencies (in `api/_lib/repositories.js`): `ensureSystemDefinitions`, `listActiveWorkflowDefinitions`, `getActiveWorkflow`, `getWorkflowMaxVersion`, `deactivateWorkflowDefinition`, `upsertWorkflowDefinition`. Compiler: `validateGraph` / `compileGraph` in `api/_lib/builderCompiler.js`. Palette: `builderCatalog()` in `api/_lib/builderCatalog.js`. Employees: `listEmployees` in `api/_lib/identityRepo.js`.

## Data shapes
`GET /api/workflows` → `{ workflows: [row] }`, each row a `workflow_definitions` DB row:
```json
{ "id": "wf7", "version": 1, "name": "...", "description": "...",
  "definition": { "id", "name", "trigger", "steps": [...], "conditions": {...}, "megaTask?": {}, "megaGroups?": [] },
  "kind": "system" | "builder", "created_by": null, "created_at": "...", "updated_at": "..." }
```
`POST action:'saveWorkflow'` body:
```json
{ "action": "saveWorkflow", "id": "cc-...(optional)", "name": "My WF", "description": "",
  "trigger": { "type": "time_interval" | "document_upload" | "manual", ... },
  "graph": { "entry": "<nodeId>", "nodes": { "<nodeId>": {...} }, "trigger?": {...} } }
```
Trigger resolution: `body.trigger || graph.trigger || null`. The persisted `definition` is `{ id, name, description, builder:true, trigger, graph:{entry,nodes}, steps, conditions }` — the compiled `steps`/`conditions` sit next to the raw graph so the engine never needs the compiler at run time.
Validation failure → `400 { error: "Workflow validation failed", messages: [...] }` (messages array via `httpError` details).
`POST action:'catalog'` → `{ blocks/..., employees: [{id, username, display_name, job_role}] }` (only `active` employees).

## Invariants & gotchas
- **One active version per id**: the DB constraint `workflow_definitions_one_active` allows at most one active row per id. `saveWorkflow` deactivates first (`deactivateWorkflowDefinition(id, { keepVersion: newVersion })`) then upserts — do not reorder these calls.
- Old versions stay in the table (inactive) because runs pin `workflow_version`; `getRunWithDefinition` joins on `(workflow_id, workflow_version)`.
- New builder id format is `cc-${Date.now()}` when `body.id` is absent; passing an existing `id` re-versions that workflow.
- System workflows (`kind !== 'builder'`) cannot be edited (`saveWorkflow` 400s) or deleted (`deleteWorkflow` 400s). They are re-created by `ensureSystemDefinitions()` on every GET if missing — deleting a system def only lasts until the next list call.
- `deleteWorkflow` is a soft delete (`deactivateWorkflowDefinition(id)` sets `active=false` on the currently active version only; already-inactive historical versions are untouched); rows and past runs remain intact.
- Unknown `body.action` → `400 { error: 'Unsupported workflows action.' }`.

## Change recipes
1. **Add a new POST action**: add a `case` in the `switch (body.action)` in `api/workflows/index.js` handler; keep 400 default; return via `sendJson`.
2. **Change what the builder palette exposes**: edit `builderCatalog()` in `api/_lib/builderCatalog.js`; the route spreads it verbatim and appends `employees` — see [builder-catalog](../lib/builder-catalog.md).
3. **Change versioning/soft-delete semantics**: edit `saveWorkflow` here plus `getWorkflowMaxVersion` / `deactivateWorkflowDefinition` / `upsertWorkflowDefinition` in `api/_lib/repositories.js`; mind the one-active constraint in [schema](../../db/schema.md).
4. **Add validation rules for builder graphs**: edit `validateGraph` in `api/_lib/builderCompiler.js` — the route surfaces `messages` untouched; the frontend save form in `src/pages/builder/WorkflowBuilder.jsx` renders them ([builder page](../../frontend/pages/builder.md)).
5. **Lock this route behind auth**: wrap handlers with `requireSession` from `api/_lib/auth.js` like `api/work-items/index.js` does — see [auth](../lib/auth.md).

## Related
- [builder-compiler](../lib/builder-compiler.md) — validate/compile graph contract
- [builder-catalog](../lib/builder-catalog.md) — palette blocks + human actions
- [workflow-definitions](../lib/workflow-definitions.md) — system defs re-upserted on GET
- [repositories](../lib/repositories.md) — definition CRUD SQL
- [builder-workflows business rules](../../business/builder-workflows.md) — why versioning works this way
- [frontend builder pages](../../frontend/pages/builder.md) — the caller of every action here
