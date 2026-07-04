# Shared Components — flowchart renderer, record/hierarchy views, Badge, Modal

**Source:** `src/components/WorkflowDefinitionFlow.jsx`, `src/components/PatientHierarchyView.jsx`, `src/components/RecordView.jsx`, `src/components/Badge.jsx`, `src/components/Modal.jsx`
**Read this when:** changing how workflow flowcharts render (Orchestrator, Workflow list, builder preview), the patient hierarchy tree, an order/record card, or the shared Badge/Modal.

## What each provides
- **`WorkflowDefinitionFlow.jsx`** — the shared flowchart renderer used by the Orchestrator, the Workflow list, AND the builder's live preview. Turns a definition's `steps[]` (+ `conditions`, `megaTask`/`megaGroups`) into a top-down flow: SYS/AI/HUMAN step boxes, amber if/else decision diamonds, mega-task boxes, trigger-chain connectors. Actor coloring: system=sky, AI=violet, human=pink, conditions=amber.
- **`PatientHierarchyView.jsx`** — renders the nested patient tree (`getPatientTree` output): unit → records → admissions → episodes → orders, with eligible/billable chips.
- **`RecordView.jsx`** — a patient/order record card (`RecordView` default + `OrderView` named export) showing demographics, admission/episode, order status.
- **`Badge.jsx`** — small labeled pill (`{label, type}`).
- **`Modal.jsx`** — overlay dialog (`{title, onClose, children, wide}`).

## Key exports (WorkflowDefinitionFlow.jsx)
| export | signature | behavior |
|---|---|---|
| `ACTOR` | const map | actor → tone/label (system/ai/human) |
| `actorOf(step)` | `(step)->'system'\|'ai'\|'human'` | derives actor for coloring |
| `stepStats(tasks, stepId)` | `(tasks, stepId)->{ran, …}` | per-step run counts (the `(n)` badge) |
| `conditionLabel(condition)` / `triggerLabel(trigger)` | formatters | human labels for a condition key / trigger |
| `DecisionDiamond({condition, downLabel, rightLabel})` | JSX | the rotated-square if/else diamond |
| `StepInfo({step})` / `StepNode({step, stats})` | JSX | ⓘ popover / a single step box |
| `Connector()` | JSX | vertical connector between nodes |
| `WorkflowFlow({definition, tasks, steps})` | JSX | the main renderer; `steps` overrides `definition.steps` (used by the builder preview) |
| `MegaTaskNode({definition, tasks, megaTask, name, info, steps})` | JSX | collapses a step group into one box with a View expander |
| `MegaGroupFlow({definition, tasks})` | JSX | renders a `megaGroups` definition as a vertical chain of mega-tasks |
| `runObjectStats(run)` / `RunObjectSidebar({run})` | fn / JSX | per-run created/updated object counts sidebar |
| `TriggerChainConnector({triggerNum, label})` | JSX | violet "after end → Trigger N" pill |

## Data shapes
`WorkflowFlow` consumes a definition shaped like a `workflow_definitions.definition`:
```js
{ id, name, trigger, steps:[{ id, name, actor, taskKey, condition?, preReq:[], actions? }],
  conditions:{ [key]: description }, megaTask?:{}, megaGroups?:[{ name, stepIds:[] }] }
```
For the **builder preview**, pass the freshly compiled `steps` via the `steps` prop (the server returns `{workflow, steps, conditions}` from `saveWorkflow`) so it renders before persistence.
`tasks` is the run's `workflow_task_runs[]` (drives `(n)` counts + human "to do" badges).

## Invariants & gotchas
- **Conditions render as if/else diamonds** with down/right exits labeled by the ACTUAL branch truth (a step's `condition` key + its negation), not a hardcoded YES/NO — see `DecisionDiamond`/`BranchArm`. A builder condition compiles to `condition` on branch-head steps (no separate node); this renderer reconstructs the diamond from those.
- **`megaGroups[].stepIds` must list EVERY step id** in the group or the flowchart silently drops the missing step. wf7's non-contiguous ids (`wf7-s22/s23` retired) are a classic trap.
- The same file backs three surfaces — a change to `StepNode`/`DecisionDiamond` affects Orchestrator, Workflow list, AND builder preview simultaneously.
- `stepStats` counts distinct items that ran a step (instances), not raw step-runs — the `(n)` on a mega box is "items processed."
- Actor colors are the app-wide convention (system=sky, human=pink, condition=amber); match it if you add a node type.

## Change recipes
1. **Change flowchart appearance/behavior:** edit `StepNode`/`DecisionDiamond`/`Connector`/`WorkflowFlow` in `WorkflowDefinitionFlow.jsx` — verify all three consumers ([monitoring](pages/monitoring.md), [builder](pages/builder.md)).
2. **Add a new step/actor rendering:** extend `ACTOR` + `actorOf` + `StepNode`.
3. **Change the patient tree display:** edit `PatientHierarchyView.jsx` (fed by `getPatientTree`, see [data-reads](../backend/routes/data-reads.md)).
4. **Change a record/order card:** edit `RecordView.jsx`.

## Related
- [monitoring pages](pages/monitoring.md) — Orchestrator renders runs via `WorkflowFlow`/`MegaGroupFlow`
- [builder pages](pages/builder.md) — the builder preview uses `WorkflowFlow` with a `steps` override
- [builder-compiler](../backend/lib/builder-compiler.md) — produces the `steps`/`conditions` this renders
- [workflow-definitions](../backend/lib/workflow-definitions.md) — system defs' `megaTask`/`megaGroups`
- [app shell](app-shell.md) — where these pages mount
