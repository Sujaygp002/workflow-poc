import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Clock, GitBranch, RefreshCw } from 'lucide-react';
import WorkflowFlowChart, { nodesFromWorkflow } from '../../components/WorkflowFlowChart';
import { dbWorkflowToWorkflow, fetchWorkflowDefinitions } from '../../lib/workflowApi';

const typeBadgeCls = {
  task: 'bg-violet-100 text-violet-700',
  conditional: 'bg-amber-100 text-amber-700',
  loop: 'bg-purple-100 text-purple-700',
};
const typeIcon = { task: '▸', conditional: '◆', loop: '↻' };

function WorkflowCard({ wf }) {
  const [showFlow, setShowFlow] = useState(true);
  const steps = wf.steps || [];
  const counts = steps.reduce((acc, step) => {
    const type = step.type || 'task';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-slate-800">{wf.name}</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-100 font-medium">
                DB saved
              </span>
            </div>
            {wf.description && <p className="text-sm text-slate-500 mt-1">{wf.description}</p>}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className="text-xs text-slate-400">{steps.length} steps</span>
              {['task', 'conditional', 'loop'].filter(type => counts[type]).map(type => (
                <span key={type} className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${typeBadgeCls[type]}`}>
                  {typeIcon[type]} {counts[type]}
                </span>
              ))}
              {wf.createdAt && (
                <span className="flex items-center gap-1 text-xs text-slate-400">
                  <Clock size={10} />
                  {new Date(wf.createdAt).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={() => setShowFlow((value) => !value)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${showFlow ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-slate-600 border-slate-200 hover:border-violet-300'}`}
          >
            <GitBranch size={13} /> Flow {showFlow ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
      </div>

      {showFlow && (
        <div className="border-t border-slate-100 bg-slate-50/40">
          <WorkflowFlowChart nodes={nodesFromWorkflow(wf)} />
        </div>
      )}
    </div>
  );
}

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

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Workflow</h1>
          <p className="text-sm text-slate-500 mt-1">DB-saved production workflow definition.</p>
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
        <div className="grid gap-3">
          {workflows.map((workflow) => <WorkflowCard key={`${workflow.id}-${workflow.version || 1}`} wf={workflow} />)}
        </div>
      )}
    </div>
  );
}
