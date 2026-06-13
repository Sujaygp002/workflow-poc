import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, GitBranch, RefreshCw } from 'lucide-react';
import { dbWorkflowToWorkflow, fetchWorkflowDefinitions } from '../../lib/workflowApi';
import {
  Connector,
  MegaGroupFlow,
  MegaTaskNode,
  TriggerChainConnector,
  WorkflowFlow,
} from '../../components/WorkflowDefinitionFlow';

// Trigger number and colour for each workflow id in the chain.
const TRIGGER_META = {
  'wf-area-onboarding': { num: 1, color: 'violet' },
  'wf7':                { num: 2, color: 'sky' },
  'wf-signing':         { num: 3, color: 'emerald' },
};

const TRIGGER_COLOR = {
  violet:  { badge: 'bg-violet-100 text-violet-700 border-violet-200', ring: 'border-violet-200' },
  sky:     { badge: 'bg-sky-100 text-sky-700 border-sky-200',          ring: 'border-sky-200' },
  emerald: { badge: 'bg-emerald-100 text-emerald-700 border-emerald-200', ring: 'border-emerald-200' },
};

function WorkflowCard({ wf }) {
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
              <span className="text-xs px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-100 font-medium">
                DB saved
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
          <button
            onClick={() => setShowFlow((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${showFlow ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-slate-600 border-slate-200 hover:border-violet-300'}`}
          >
            <GitBranch size={13} /> Flow {showFlow ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
      </div>

      {showFlow && (
        <div className="border-t border-slate-100 bg-slate-50/40 overflow-x-auto p-4">
          <div className="mx-auto w-fit rounded-full border-2 border-slate-300 bg-slate-50 px-4 py-1 text-xs font-black text-slate-600">
            START · {wf.trigger?.id || wf.trigger?.type || 'trigger'}
          </div>
          <Connector />
          {/* tasks=[] → static definition view with no live run counts */}
          {wf.megaGroups ? (
            <MegaGroupFlow definition={wf} tasks={[]} />
          ) : wf.megaTask ? (
            <MegaTaskNode definition={wf} tasks={[]} megaTask={wf.megaTask} />
          ) : (
            <WorkflowFlow definition={wf} tasks={[]} />
          )}
          <Connector />
          <div className="mx-auto mt-1 w-fit rounded-full border-2 border-slate-300 bg-slate-50 px-4 py-1 text-xs font-black text-slate-600">END</div>
        </div>
      )}
    </div>
  );
}

// Chain order for the Workflows page.
// Trigger 1 (area monitor) is NOT chained to Trigger 2 — it runs independently
// and only notifies HHAHs. Trigger 2 → Trigger 3 remains a real chain.
const CHAIN_ORDER = ['wf-area-onboarding', 'wf7', 'wf-signing'];
const CHAIN_CONNECTOR = {
  'wf-signing': { triggerNum: 3, label: 'Document Signing Follow-up' },
};
// Workflows that begin a new standalone chain (shown with a section divider, not a connector).
const STANDALONE_HEADER = {
  'wf7': { triggerNum: 2, label: 'HHAH Uploads Documents', note: 'fires independently when an HHAH uploads' },
};

export default function WorkflowList() {
  const [workflows, setWorkflows] = useState([]);
  const [dbError, setDbError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const dbWorkflows = await fetchWorkflowDefinitions();
      setWorkflows(dbWorkflows.map(dbWorkflowToWorkflow));
      setDbError(null);
    } catch (error) {
      setWorkflows([]);
      setDbError(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  const byId = Object.fromEntries(workflows.map((wf) => [wf.id, wf]));
  const chained = CHAIN_ORDER.map((id) => byId[id]).filter(Boolean);
  const extras = workflows.filter((wf) => !CHAIN_ORDER.includes(wf.id));

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Workflows</h1>
          <p className="text-sm text-slate-500 mt-1">DB-saved workflow definitions shown as the trigger chain.</p>
        </div>
        <button onClick={refresh} className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {dbError && (
        <div className="mb-5 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm">
          DB workflows unavailable: {dbError}.
        </div>
      )}

      {workflows.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <GitBranch size={40} className="mx-auto mb-3 opacity-30" />
          <p>No DB workflow definition is available.</p>
        </div>
      ) : (
        <div>
          {/* Trigger 1 standalone · Trigger 2 → Trigger 3 chain */}
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
              <WorkflowCard wf={wf} />
            </div>
          ))}

          {/* Any extra workflows outside the main chain */}
          {extras.length > 0 && (
            <div className="mt-4 grid gap-3">
              {extras.map((wf) => <WorkflowCard key={wf.id} wf={wf} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
