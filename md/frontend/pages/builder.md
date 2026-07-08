# Builder Pages — workflow list + n8n-style visual workflow editor

**Source:** `src/pages/builder/WorkflowList.jsx`, `src/pages/builder/WorkflowBuilder.jsx`
**Read this when:** changing the Workflows screen (builder cards, system trigger-chain display), the visual editor (node kinds, trigger picker, save/validate flow), the client-side compile preview, or how builder graphs are converted to/from the server graph shape.

## What it does
`WorkflowList` is the `/workflows` screen: builder-authored workflows on top (Edit / Run / Delete), the read-only system trigger chain below (T1 area → T2 wf7 → T3 signing, T4 billing as an "independent monitor"), plus a **New workflow** button that swaps the whole page for the `WorkflowBuilder` editor in place (no route change). `WorkflowBuilder` edits a NESTED sequence model (ordered node list; condition nodes hold their own `ifTrue`/`ifFalse` sub-sequences that implicitly re-join at the next node) and on save flattens it to the server's flat graph (`{ entry, nodes[] }` with `next`/`ifTrue`/`ifFalse`/`join` pointers) via `saveWorkflow`. A client-side compile mirror feeds a live flowchart preview; after a successful save the preview switches to the server-compiled steps until the next edit.

## Key functions / exports
| name | signature (params -> return) | behavior in one line | called by |
|---|---|---|---|
| `WorkflowList` (default) | `() -> JSX` | Fetch + partition workflows, render builder/system sections or the editor | route in `src/App.jsx` |
| `BuilderWorkflowCard` | `({ wf, onEdit, onDeleted }) -> JSX` | Card with Flow toggle, Edit, Run (`startWorkflow`), Delete (`deleteWorkflow` + confirm) | `WorkflowList` |
| `SystemWorkflowCard` | `({ wf }) -> JSX` | Read-only card; Trigger N badge from `TRIGGER_META`, flow open by default | `WorkflowList` |
| `FlowBody` | `({ wf }) -> JSX` | START/END caps + static definition flow (`MegaGroupFlow`/`MegaTaskNode`/`WorkflowFlow`, `tasks=[]`) | both cards |
| `WorkflowBuilder` (default) | `({ workflow=null, existingWorkflows=[], onDone }) -> JSX` | Full editor page; `workflow=null` = new, mapped row = edit | `WorkflowList` |
| `graphToSeq` / `chainToSeq` | `(graph) -> seq[]` | Rebuild nested editor model from saved `definition.graph` (walks `next`, recurses branches until `join`, cycle-guarded); hydrates `groupId` on system/task nodes from `graph.groups` via `groupOfNode` map | `WorkflowBuilder` init |
| `graphToGroups` | `(graph) -> [{id,name,info}]` | Extract group metadata list from `graph.groups`; keeps only id/name/info (not nodeIds, which are reconstructed from node.groupId at save time) | `WorkflowBuilder` init |
| `seqToGraph` / `seqToNodes` | `(seq, catalog, groups) -> { entry, nodes[], groups? }` | Flatten nested model + collect group membership via `collectGroupMembers`; condition `join` = next node in same sequence; branch tails end `next:null`; emits `graph.groups` only when ≥1 group has members | `handleSave` |
| `collectGroupMembers` | `(seq, membersByGroup)` | Recursively walks seq (including condition branches) accumulating node ids per groupId into `membersByGroup` Map | `seqToGraph`, `previewMegaGroups` memo |
| `clearGroupFromSeq` | `(seq, groupId) -> seq` | Recursively clears `groupId` from every node that was assigned to a deleted group (returns new seq, recurses into condition branches) | `GroupsPanel.removeGroup` |
| `memberCounts` | `(seq, counts?) -> {[groupId]: n}` | Counts system/task nodes per group (recursive); feeds the "N steps" badge in `GroupsPanel` | `GroupsPanel` |
| `compilePreview` | `(seq, catalog) -> steps[]` | Client mirror of the server compiler for the live preview (NOT authoritative) | `useMemo` in builder |
| `clientValidate` | `({ name, seq }) -> string[]` | Minimal pre-save checks: name set, ≥1 node, every task named, every condition has ≥1 TRUE node | `handleSave` |
| `makeNode` / `makeAction` | `(kind, catalog) -> node` | New node/action seeded with first catalog key; ids from `newId(prefix)` (Date.now base36 + counter); system/task nodes get `groupId: null` | `InsertPoint`, `TaskNodeCard` |
| `SequenceEditor` | `({ seq, onChange, catalog, emptyHint, groups }) -> JSX` | Recursive node-card list with an `InsertPoint` (+ popover: system/task/condition) before/after every node; passes `groups` down to `NodeCard` for the `GroupControl` selector | builder Flow panel + `ConditionNodeCard` branches |
| `GroupsPanel` | `({ groups, seq, onChange, onSeqChange }) -> JSX` | Authors TASK containers: add/rename/describe/delete groups; `onChange` mutates the `groups` array, `onSeqChange` clears membership on delete | builder editor column |
| `GroupControl` | `({ node, groups, onChange }) -> JSX` | Group-membership pill + dropdown for system/task nodes (condition nodes never get this); displayed in the NodeShell header; tint cycles via `GROUP_TINTS` | `SystemNodeCard`, `TaskNodeCard` |
| `TriggerCard` | `({ trigger, onChange, catalog, docUploadClash }) -> JSX` | Radio list from `catalog.triggers`; `time_interval` gets an `intervalSeconds` input (min 5, default 60); `daily_time` has no extra param inputs (hour/minute/tz set programmatically only) | builder |

## Data shapes
Editor nested node model (client-only):
```js
{ id, kind: 'system', name, actionKey, groupId: '<groupId>|null' }        // name '' -> catalog label at flatten
{ id, kind: 'task', name, assigneeEmployeeId, actions: [{ id, actionKey, label, params }], groupId: '<groupId>|null' }
{ id, kind: 'condition', conditionKey, ifTrue: [node...], ifFalse: [node...] }  // no groupId; conditions emit no step
```
Groups state (parallel to seq; managed by `GroupsPanel`):
```js
[{ id: 'g<id>', name: 'Update Object Module', info: 'What this TASK does' }]
```
Server graph (what `saveWorkflow` sends, what `workflow.graph` holds on edit):
```js
{ entry: '<nodeId>|null', nodes: [
  { id, kind:'system', name, actionKey, next },
  { id, kind:'task', name, assigneeEmployeeId, actions:[{id, actionKey, label, params}], next },
  { id, kind:'condition', name:conditionKey, conditionKey, ifTrue:'<id>|null', ifFalse:'<id>|null', join:'<id>|null' },
],
// present only when ≥1 group has member nodes:
groups?: [{ id:'g1', name:'Update Object Module', info:'…', nodeIds:['n2','n3'] }] }
```
Builder catalog (`fetchBuilderCatalog()` → `POST /api/workflows {action:'catalog'}`):
```js
{ triggers:[{key,label,description}], conditions:[{key,label,description,negation}],
  actions:{ system:[{key,label}], human:[{key,label,inputs:[...]}] },
  employees:[{id, display_name, username, job_role}] }
```
`compilePreview` step (matches server compiled step shape, rendered by `WorkflowFlow`): `{ id, preReq:[ids], condition?, name, actor:'system'|'ai'|'human', taskKey, description? }` — task nodes compile to `actor:'human'`, `taskKey:'human.performActions'`; a system node compiles to `actor:'ai'` only when `actionKey === 'ai_extract_pdf_fields'`. FALSE-branch condition name = `catalog condition.negation || `not_${key}``.
`saveWorkflow` response: `{ workflow:{ id, version, ... }, steps:[...] }`; error carries `error.messages[]` (server `validateGraph` output, rendered as a bullet list). `startWorkflow` response: `{ run:{ status, ... } }`.
Extra per-action param inputs come from `ACTION_PARAM_FIELDS` (currently only `subjectTemplate` for `send_email_to_physician` / `send_email_to_hhah`).

## Invariants & gotchas
- **`graphToSeq` and `seqToGraph` must stay symmetric.** The join is implicit — a condition's `join` pointer is simply the next node in its parent sequence; branch tail nodes keep `next:null` because the server compiler stops branch walks at the join id. An empty FALSE branch means `ifFalse:null` = skip straight to join (`emptyHint="optional — skips to join"`); an empty TRUE branch is a validation error (client AND server). Groups survive the round-trip: `graphToSeq` reads `graph.groups` into a `groupOfNode` map and sets `node.groupId`; `seqToGraph` calls `collectGroupMembers` to rebuild `graph.groups[].nodeIds`.
- **`compilePreview` is a mirror, not the truth.** The server compiler (`builderCompiler.js`) is authoritative; drift only becomes visible after save when `serverSteps` replaces the preview (badge flips "draft" → "server-compiled ✓"). Any change to server compile semantics (negation naming, join/preReq fan-in, ai actor detection) must be replicated here or the preview lies. `compilePreview` does NOT output `megaGroups` — those are derived separately via `previewMegaGroups` memo.
- **`previewMegaGroups`** is a `useMemo` over `[groups, seq, displaySteps]` that mirrors the server's post-pass: maps each group's member node ids → keep only ids present in `displaySteps`. When non-null, the preview renders via `WorkflowLane` → `MegaGroupFlow` (identical to the list card + Orchestrator). A purely flat workflow (no groups) renders via the plain `WorkflowFlow` path.
- **Any edit invalidates the last save**: a `useEffect` on `[seq, groups, trigger, name, description]` clears `serverSteps` + `savedInfo`, so touching anything after save reverts the preview to the client compile.
- `editingId` is set from the save response, so a "new" workflow's second save UPDATES (same id, version bump) instead of duplicating. Ids of saved nodes survive round-trips (`graphToSeq` reuses them); only newly inserted nodes get `newId` ids.
- Workflow `kind` fallback: `row.kind || (row.definition?.builder ? 'builder' : 'system')` — old rows without a `kind` column rely on the `definition.builder` flag.
- **document_upload clash is advisory only.** Both `WorkflowList` (banner) and `TriggerCard` (inline warning, excludes `editingId`) warn when >1 active builder workflow uses `trigger.type === 'document_upload'` — one HHAH upload starts a run of EACH. The server does not block this.
- The `intervalSeconds` input has `onClick={(e) => e.preventDefault()}` to stop the wrapping radio `<label>` from re-firing the trigger change — keep it if you restructure `TriggerCard`. The `daily_time` trigger has no param inputs in the UI; hour/minute/tz can only be set programmatically via the same `saveWorkflow` endpoint.
- A task always has ≥1 action: `makeNode` seeds one, `removeAction` refuses at length 1. Blank SYSTEM names are fine (default to catalog label in `seqToNodes`); blank TASK names fail `clientValidate` ("it is what the employee sees in their bucket"). Blank assignee is caught by the server, plus an inline amber hint when `catalog.employees` is empty.
- `Delete` deactivates the definition and keeps existing runs (confirm text promises this — the server route enforces it).
- System-section layout is hardcoded id lists: `CHAIN_ORDER`, `INDEPENDENT_ORDER`, `CHAIN_CONNECTOR` (connector before `wf-signing`), `STANDALONE_HEADER` (section header before `wf7`), `TRIGGER_META` (badge number/color). Unknown system workflows fall into `extras` at the bottom.
- **Deleting a group** calls `clearGroupFromSeq` to orphan all member nodes back to ungrouped before removing the group from state — prevents stale `groupId` references in the seq.

## Change recipes
1. **Add a new human action type**: add it to the server catalog (`api/_lib/builderCatalog.js`) so it appears in the task-action dropdown automatically; if it needs builder-time params add an entry to `ACTION_PARAM_FIELDS` in `WorkflowBuilder.jsx`; then add its worker input + prefill in `WorkerTaskDetail.jsx` (`BuilderActionInput` + `initialActionResult` — see [worker](worker.md)) and its execution/validation server-side in `taskRegistry.js`.
2. **Add a new trigger type**: add to the server catalog and trigger firing logic (`api/workflows` / engine); `TriggerCard` renders it from `catalog.triggers` automatically — add a per-type param block (like the `time_interval` seconds input) only if it needs config; update `triggerLabel` in `src/components/WorkflowDefinitionFlow.jsx` for the START cap text.
3. **Add a new node kind to the editor**: extend `makeNode`, `NodeCard` (new card component), `chainToSeq`/`seqToNodes`, `compilePreview.walk`, and `clientValidate` in `WorkflowBuilder.jsx`, then mirror it in the server `validateGraph`/compiler ([builder-compiler](../../backend/lib/builder-compiler.md)) — the preview and server compile must agree. If the new kind can be grouped, add a `groupId` field and teach `collectGroupMembers` + `clearGroupFromSeq` to handle it.
4. **Change how the system chain displays**: edit `CHAIN_ORDER` / `INDEPENDENT_ORDER` / `CHAIN_CONNECTOR` / `STANDALONE_HEADER` / `TRIGGER_META` at the top of `WorkflowList.jsx`; nothing else reads them.
5. **Add a pre-save client check**: extend `clientValidate` in `WorkflowBuilder.jsx` — keep it minimal (worst-late-feedback cases only); everything else belongs in the server `validateGraph`, whose `messages[]` already render in the same rose error banner.
6. **Add group-level validation or constraints**: group authoring rules (non-empty name, no condition members, no duplicate ids) live in `validateGraph` in `builderCompiler.js` — add a check there and it surfaces verbatim in the builder's error banner.

## Related
- [builder-workflows](../../business/builder-workflows.md) — graph/compile/trigger business rules
- [workflows route](../../backend/routes/workflows.md) — saveWorkflow/catalog/delete API server side
- [builder-compiler](../../backend/lib/builder-compiler.md) — authoritative validate + compile
- [builder-catalog](../../backend/lib/builder-catalog.md) — triggers/conditions/actions/employees palette
- [frontend lib](../lib.md) — `saveWorkflow`/`startWorkflow`/`dbWorkflowToWorkflow` client contracts
- [components](../components.md) — `WorkflowFlow`/`MegaGroupFlow`/`triggerLabel` renderers used here
- [worker](worker.md) — where saved builder tasks surface for employees
