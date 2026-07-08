# Builder Compiler — validate a builder graph & compile it to engine `steps[]`

**Source:** `api/_lib/builderCompiler.js`
**Read this when:** changing how builder graphs are validated, how the visual graph turns into the linear `steps[]` the engine runs, how if/else branches compile, or what validation messages the builder shows.

## What it does
Two exported functions turn the editable builder graph (nodes + `next`/`ifTrue`/`ifFalse`/`join` pointers) into the exact `steps[]` shape `workflowEngine` already executes for wf7. `validateGraph` returns a list of human messages (empty = valid). `compileGraph` re-validates (throws `httpError(400)` if invalid), walks the graph, and emits `{ steps, conditions }`. A **condition node emits NO step** — instead its true-chain head gets `condition: conditionKey`, its false-chain head gets the negation, and the join step's `preReq` is `[tail(ifTrue), tail(ifFalse)]`. Because the engine treats `skipped` as satisfying preReqs, the untaken branch never blocks the join. This is the same fan-out/join pattern wf7 uses by hand.

## Key functions / exports
| name | signature (params -> return) | behavior | called by |
|---|---|---|---|
| `validateGraph` | `async (graph, trigger) -> string[]` | trigger present + valid; ≥1 node; unique ids; entry exists; per-kind checks; assignee employee exists+active; cycle/reachability walk; returns messages (empty=ok) | `compileGraph`, `saveWorkflow` route |
| `compileGraph` | `async (graph, trigger) -> { steps, conditions }` | validates (throws 400), walks from `entry` via `compileChain`, builds `conditions` map | `saveWorkflow` in `api/workflows/index.js` |
| `compileChain` (internal) | `({startId, stopId, byId, steps, preReq, condition}) -> {tails}` | recursive chain walker; conditions recurse into ifTrue/ifFalse and re-merge tails at join | `compileGraph`, itself |

## Data shapes
Input graph (from the builder UI, stored in `definition.graph`):
```js
{ entry: 'n1',
  nodes: [
    { id:'n1', kind:'system', name:'Create order', actionKey:'create_order', next:'c1' },
    { id:'c1', kind:'condition', name:'Patient exists?', conditionKey:'patient_exists',
      ifTrue:'n2', ifFalse:'n3', join:'n4' },
    { id:'n2', kind:'system', actionKey:'update_patient', next:null },   // true head
    { id:'n3', kind:'system', actionKey:'create_patient', next:null },   // false head
    { id:'n4', kind:'task', name:'Send Orders To Physician',
      assigneeEmployeeId:'<uuid>',
      actions:[ { id:'a1', actionKey:'send_email_to_physician', label:'…', params:{} } ], next:null } ] }
```
Compiled output (spliced next to the raw graph in the saved `definition`):
```js
{ steps: [
    { id, name, description, preReq:[…], condition?:'patient_exists',
      actor:'system'|'ai', taskKey:'patient.create', actionKey:'create_patient' },   // system
    { id, name, preReq:[…], actor:'human', taskKey:'human.performActions',
      assigneeEmployeeId, actions:[{id,actionKey,label,params}] } ],                  // task
  conditions: { patient_exists:'…desc…', patient_not_exists:'…desc…' },
  // Present only when graph.groups was authored and ≥1 group has member steps:
  megaGroups?: [{ id:'g1', name:'Update Object Module', info:'…desc…', stepIds:['n2','n3'] }] }
```

## TASK groups → megaGroups

`graph.groups` is optional authoring metadata. When present, `validateGraph` checks:
- `graph.groups` is an array (if the field exists at all).
- Every group has a non-empty `id` (no duplicates) and a non-empty `name`.
- Every `nodeId` in a group's `nodeIds` references an existing node and is NOT a condition node (condition nodes emit no step, so they cannot be group members).

`compileGraph` runs a **post-pass** after `compileChain` finishes:
1. Walks `steps[]` (already compiled, byte-for-byte identical whether or not groups are authored).
2. For each `graph.groups` entry, maps `nodeIds` → keep only ids that produced a step (filtering out condition/missing references with `stepById.has(id)`).
3. Drops empty groups; omits `megaGroups` entirely when none remain.
4. Returns `{ steps, conditions, ...(megaGroups.length ? { megaGroups } : {}) }`.

`megaGroups` is **presentation-only**: the engine never reads it. It is saved alongside the compiled `steps` in `workflow_definitions.definition` and consumed by the renderer (`MegaGroupFlow` in `WorkflowDefinitionFlow.jsx`).

## Invariants & gotchas
- **A condition node never becomes a step.** It only stamps `condition`/negation onto branch heads and merges branch tails into the join's preReq. If you look for a step whose `id` == a condition node id, you won't find one.
- **`join` defaults to `stopId`** when absent; a branch with no `join` ends as `null` (flows to the parent chain's stop). Mis-set `join` pointers silently reshape the flow — the flowchart is your check.
- `validateGraph` accepts `graph.nodes` as an **array**; `compileGraph` builds `byId` from that array. The saved `definition.graph.nodes` may be serialized as an object keyed by id by the frontend — the route passes whatever the builder sends, so keep the builder and this file agreeing on array-vs-map (see [builder page](../../frontend/pages/builder.md)).
- Assignee validation calls `getEmployee(...)` — an inactive or deleted employee fails validation, so **deactivating an employee can make a previously-valid workflow fail to re-save**.
- `time_interval` triggers require `intervalSeconds >= 5` (also clamped at run time in the tick handler).
- Unknown `actionKey`/`conditionKey`/`kind` are validation errors — the source of truth for valid keys is [builder-catalog](./builder-catalog.md) (`ACTIONS`, `HUMAN_ACTIONS`, `CONDITIONS`, `TRIGGERS`).
- The cycle check is a reachability walk from `entry` with a `visited` set; it reports the first revisited node. Unreachable nodes are simply never compiled (not an error).
- **Groups are additive and invisible to the engine.** Adding or removing `graph.groups` produces zero change to `steps[]` or `conditions`. The compiled `megaGroups` array (in the saved definition) is strictly for the renderer.

## Change recipes
1. **Add a new node kind:** handle it in `validateGraph`'s per-node `if/else`, in `compileChain`'s walk, and give it a `steps[]` emission; then teach the builder UI to create it ([builder page](../../frontend/pages/builder.md)).
2. **Change branch/join semantics:** edit `compileChain`'s condition branch (the `trueBranch`/`falseBranch`/`tails` merge). The engine's `skipped`-satisfies-preReq behavior lives in [workflow-engine](./workflow-engine.md) — keep them consistent.
3. **Add a validation rule:** push a message in `validateGraph`; it surfaces verbatim as `messages[]` in the `saveWorkflow` 400 and renders in the builder.
4. **Add/rename an action or condition:** edit [builder-catalog](./builder-catalog.md) — this file only reads its maps.

## Related
- [builder-catalog](./builder-catalog.md) — `ACTIONS`/`HUMAN_ACTIONS`/`CONDITIONS`/`TRIGGERS` this file validates against
- [workflows route](../routes/workflows.md) — calls `validateGraph`/`compileGraph` in `saveWorkflow`
- [workflow-engine](./workflow-engine.md) — executes the compiled `steps[]` (skipped-satisfies-preReq)
- [builder workflows business rules](../../business/builder-workflows.md) — why the graph-vs-steps split exists
- [identity-repo](./identity-repo.md) — `getEmployee` used for assignee validation
- [auth](./auth.md) — `httpError` used for the 400
