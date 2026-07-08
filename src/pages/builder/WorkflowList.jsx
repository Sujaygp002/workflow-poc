// Workflow page: builder-authored workflows (Edit / Run / Delete) on top,
// system workflows (read-only trigger chain) below, plus a New Workflow button
// that opens the WorkflowBuilder editor in place. Shows a warning banner when
// more than one active builder workflow shares the document_upload trigger
// (one HHAH upload would start a run of EACH).
import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  GitBranch,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {
  dbWorkflowToWorkflow,
  deleteWorkflow,
  fetchWorkflowDefinitions,
  startWorkflow,
} from '../../lib/workflowApi';
import {
  triggerLabel,
  TriggerChainConnector,
  WorkflowLane,
} from '../../components/WorkflowDefinitionFlow';
import WorkflowBuilder from './WorkflowBuilder';

// Trigger number and colour for each system workflow id in the chain.
const TRIGGER_META = {
  'wf-area-onboarding': { num: 1, color: 'violet' },
};

const TRIGGER_COLOR = {
  violet:  { badge: 'bg-violet-100 text-violet-700 border-violet-200', ring: 'border-violet-200' },
  sky:     { badge: 'bg-sky-100 text-sky-700 border-sky-200',          ring: 'border-sky-200' },
  emerald: { badge: 'bg-emerald-100 text-emerald-700 border-emerald-200', ring: 'border-emerald-200' },
  amber:   { badge: 'bg-amber-100 text-amber-700 border-amber-200',    ring: 'border-amber-200' },
};

function FlowBody({ wf, accent = 'slate' }) {
  // One titled, cohesive workflow lane (START · trigger → steps → END). tasks=[]
  // is a static definition view (no live run counts).
  return (
    <div className="border-t border-slate-100 bg-slate-50/40 overflow-x-auto p-4">
      <WorkflowLane definition={wf} tasks={[]} accent={accent} />
    </div>
  );
}

function FlowToggle({ showFlow, onToggle }) {
  return (
    <button
      onClick={onToggle}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${showFlow ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-slate-600 border-slate-200 hover:border-violet-300'}`}
    >
      <GitBranch size={13} /> Flow {showFlow ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
    </button>
  );
}

// ── System (read-only) workflow card ──────────────────────────────────────────
function SystemWorkflowCard({ wf }) {
  const [showFlow, setShowFlow] = useState(true);
  const steps = wf.steps || [];
  const meta = TRIGGER_META[wf.id];
  const col = meta ? TRIGGER_COLOR[meta.color] : null;

  return (
    <div className={`bg-white rounded-xl border shadow-sm overflow-hidden ${col?.ring || 'border-slate-200'}`}>
      <div className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {meta && (
                <span className={`text-[10px] font-black uppercase tracking-wide border rounded-full px-2 py-0.5 ${col.badge}`}>
                  Trigger {meta.num}
                </span>
              )}
              <span className="font-semibold text-slate-800">{wf.name}</span>
              <span className="font-mono text-[11px] text-slate-400">{wf.id}</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 font-medium">
                System · read-only
              </span>
            </div>
            {wf.description && <p className="text-sm text-slate-500 mt-1">{wf.description}</p>}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className="text-xs text-slate-400">{steps.length} steps</span>
              {wf.trigger?.type && (
                <span className="text-[11px] font-mono text-slate-400">trigger: {wf.trigger.type}</span>
              )}
            </div>
          </div>
          <FlowToggle showFlow={showFlow} onToggle={() => setShowFlow((v) => !v)} />
        </div>
      </div>
      {showFlow && <FlowBody wf={wf} />}
    </div>
  );
}

// ── Builder workflow card: kind badge + Edit / Run / Delete ──────────────────
function BuilderWorkflowCard({ wf, onEdit, onDeleted }) {
  // Default OPEN: a builder workflow should read as one cohesive flow at a glance,
  // not a collapsed "N steps" card.
  const [showFlow, setShowFlow] = useState(true);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState('');
  const [runErr, setRunErr] = useState('');
  const [deleting, setDeleting] = useState(false);
  const steps = wf.steps || [];

  async function handleRun() {
    setRunning(true);
    setRunMsg('');
    setRunErr('');
    try {
      const body = await startWorkflow({ workflowId: wf.id });
      setRunMsg(`Run started (${body.run?.status || 'running'}) — watch it in the Orchestrator.`);
    } catch (error) {
      setRunErr(error.message);
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete workflow "${wf.name}"? Existing runs are kept; the definition is deactivated.`)) return;
    setDeleting(true);
    setRunErr('');
    try {
      await deleteWorkflow(wf.id);
      onDeleted();
    } catch (error) {
      setRunErr(error.message);
      setDeleting(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-violet-200 shadow-sm overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-black uppercase tracking-wide border rounded-full px-2 py-0.5 bg-violet-100 text-violet-700 border-violet-200">
                Builder
              </span>
              <span className="font-semibold text-slate-800">{wf.name}</span>
              <span className="font-mono text-[11px] text-slate-400">{wf.id}</span>
              {wf.version && <span className="font-mono text-[11px] text-slate-400">v{wf.version}</span>}
            </div>
            {wf.description && <p className="text-sm text-slate-500 mt-1">{wf.description}</p>}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className="text-xs text-slate-400">{steps.length} steps</span>
              <span className="text-[11px] font-mono text-slate-400">trigger: {triggerLabel(wf.trigger)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <FlowToggle showFlow={showFlow} onToggle={() => setShowFlow((v) => !v)} />
            <button
              onClick={() => onEdit(wf)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border bg-white text-slate-600 border-slate-200 hover:border-violet-300"
            >
              <Pencil size={13} /> Edit
            </button>
            <button
              onClick={handleRun}
              disabled={running}
              title="Start a run now (manual trigger)"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold border bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700 disabled:opacity-60"
            >
              {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Run
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border bg-white text-rose-600 border-rose-200 hover:bg-rose-50 disabled:opacity-60"
            >
              {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Delete
            </button>
          </div>
        </div>
        {runMsg && <div className="mt-2 text-xs font-semibold text-emerald-700">{runMsg}</div>}
        {runErr && <div className="mt-2 text-xs font-semibold text-rose-600">{runErr}</div>}
      </div>
      {showFlow && <FlowBody wf={wf} accent="violet" />}
    </div>
  );
}

// Chain order for the system section. Only the area monitor remains a system
// workflow (wf7/wf-signing/wf-billing-monitor were removed); the daily intake
// pipeline is now a builder workflow shown in the "Your workflows" section.
const CHAIN_ORDER = ['wf-area-onboarding'];
const INDEPENDENT_ORDER = [];
const CHAIN_CONNECTOR = {};
// Workflows that begin a new standalone chain (shown with a section divider, not a connector).
const STANDALONE_HEADER = {};

export default function WorkflowList() {
  const [workflows, setWorkflows] = useState([]);
  const [dbError, setDbError] = useState(null);
  const [loading, setLoading] = useState(false);
  // editor: null = list view; { workflow: null } = new; { workflow: wf } = edit.
  const [editor, setEditor] = useState(null);

  async function refresh() {
    setLoading(true);
    try {
      const rows = await fetchWorkflowDefinitions();
      setWorkflows(rows.map((row) => ({
        ...dbWorkflowToWorkflow(row),
        kind: row.kind || (row.definition?.builder ? 'builder' : 'system'),
      })));
      setDbError(null);
    } catch (error) {
      setWorkflows([]);
      setDbError(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  if (editor) {
    return (
      <WorkflowBuilder
        workflow={editor.workflow}
        existingWorkflows={workflows}
        onDone={() => { setEditor(null); refresh(); }}
      />
    );
  }

  const builders = workflows.filter((wf) => wf.kind === 'builder');
  const systemById = Object.fromEntries(workflows.filter((wf) => wf.kind !== 'builder').map((wf) => [wf.id, wf]));
  const chained = CHAIN_ORDER.map((id) => systemById[id]).filter(Boolean);
  const independent = INDEPENDENT_ORDER.map((id) => systemById[id]).filter(Boolean);
  const visibleWorkflowIds = new Set([...CHAIN_ORDER, ...INDEPENDENT_ORDER]);
  const extras = workflows.filter((wf) => wf.kind !== 'builder' && !visibleWorkflowIds.has(wf.id));

  // Owner request: warn when >1 active builder workflow shares document_upload —
  // a single HHAH upload starts a run of EACH of them.
  const docUploadBuilders = builders.filter((wf) => wf.trigger?.type === 'document_upload');

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Workflows</h1>
          <p className="text-sm text-slate-500 mt-1">Build your own workflows; system workflows run the built-in intake chain.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refresh} className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            onClick={() => setEditor({ workflow: null })}
            className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-white bg-violet-600 rounded-lg hover:bg-violet-700"
          >
            <Plus size={15} /> New workflow
          </button>
        </div>
      </div>

      {dbError && (
        <div className="mb-5 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm">
          DB workflows unavailable: {dbError}.
        </div>
      )}

      {docUploadBuilders.length > 1 && (
        <div className="mb-5 flex items-start gap-2.5 px-4 py-3 bg-amber-50 border-2 border-amber-300 rounded-xl text-amber-900 text-sm">
          <AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-600" />
          <div>
            <span className="font-bold">{docUploadBuilders.length} active builder workflows share the Document upload trigger</span>
            {' '}— a single HHAH upload will start a run of <span className="font-bold">each</span> of them:
            {' '}{docUploadBuilders.map((wf) => wf.name).join(', ')}. Edit or delete the extras if that is not intended.
          </div>
        </div>
      )}

      {/* ── Builder workflows ── */}
      <div className="mb-3 flex items-center gap-2">
        <span className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-[11px] font-black uppercase tracking-wide text-violet-700">
          Your workflows
        </span>
        <span className="text-[11px] text-slate-400">built here · editable · run on their trigger or the Run button</span>
      </div>
      {builders.length === 0 ? (
        <div className="mb-8 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-400">
          No builder workflows yet — click <span className="font-bold text-violet-600">New workflow</span> to create one.
        </div>
      ) : (
        <div className="mb-8 grid gap-4">
          {builders.map((wf) => (
            <BuilderWorkflowCard
              key={wf.id}
              wf={wf}
              onEdit={(target) => setEditor({ workflow: target })}
              onDeleted={refresh}
            />
          ))}
        </div>
      )}

      {/* ── System workflows (read-only trigger chain) ── */}
      {(chained.length > 0 || independent.length > 0 || extras.length > 0) && (
        <div>
          <div className="mb-3 flex items-center gap-2">
            <span className="rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-[11px] font-black uppercase tracking-wide text-slate-600">
              System workflows
            </span>
            <span className="text-[11px] text-slate-400">built-in intake / signing / billing chain — read-only</span>
          </div>

          {chained.map((wf) => (
            <div key={wf.id}>
              {STANDALONE_HEADER[wf.id] && (
                <div className="mt-8 mb-3 flex items-center gap-2">
                  <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-[11px] font-black uppercase tracking-wide text-sky-700">
                    Trigger {STANDALONE_HEADER[wf.id].triggerNum} · {STANDALONE_HEADER[wf.id].label}
                  </span>
                  <span className="text-[11px] text-slate-400">{STANDALONE_HEADER[wf.id].note}</span>
                </div>
              )}
              {CHAIN_CONNECTOR[wf.id] && (
                <TriggerChainConnector
                  triggerNum={CHAIN_CONNECTOR[wf.id].triggerNum}
                  label={CHAIN_CONNECTOR[wf.id].label}
                />
              )}
              <SystemWorkflowCard wf={wf} />
            </div>
          ))}

          {independent.length > 0 && (
            <div className="mt-8">
              <div className="mb-3 flex items-center gap-2">
                <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-black uppercase tracking-wide text-amber-700">
                  Independent monitors
                </span>
                <span className="text-[11px] text-slate-400">run on their own schedule, outside the upload/signing chain</span>
              </div>
              <div className="grid gap-4">
                {independent.map((wf) => <SystemWorkflowCard key={wf.id} wf={wf} />)}
              </div>
            </div>
          )}

          {/* Any extra system workflows outside the main chain */}
          {extras.length > 0 && (
            <div className="mt-4 grid gap-3">
              {extras.map((wf) => <SystemWorkflowCard key={wf.id} wf={wf} />)}
            </div>
          )}
        </div>
      )}

      {workflows.length === 0 && !dbError && (
        <div className="text-center py-16 text-slate-400">
          <GitBranch size={40} className="mx-auto mb-3 opacity-30" />
          <p>No DB workflow definition is available.</p>
        </div>
      )}
    </div>
  );
}
