import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, GitBranch, Clock, Edit2, Zap, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import WorkflowFlowChart, { nodesFromWorkflow } from '../../components/WorkflowFlowChart';
import { getWorkflows, deleteWorkflow, getTriggers, getUnmappedTriggers } from '../../store';

const typeBadgeCls = {
  task:        'bg-violet-100 text-violet-700',
  conditional: 'bg-amber-100 text-amber-700',
  loop:        'bg-purple-100 text-purple-700',
};
const typeIcon = { task: '▸', conditional: '◆', loop: '↻' };

function WorkflowCard({ wf, trigger, onEdit, onDelete }) {
  const [showFlow, setShowFlow] = useState(false);
  const steps = wf.steps || wf.tasks || [];
  const counts = steps.reduce((acc, s) => {
    const t = s.type || 'task';
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm hover:shadow-md transition-shadow overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-slate-800">{wf.name}</span>
              {trigger && (
                <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-violet-50 text-violet-600 font-medium">
                  <Zap size={10} /> {trigger.name}
                </span>
              )}
            </div>
            {wf.description && <p className="text-sm text-slate-500 mt-1 line-clamp-1">{wf.description}</p>}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className="text-xs text-slate-400">{steps.length} step{steps.length !== 1 ? 's' : ''}</span>
              {['task', 'conditional', 'loop'].filter(t => counts[t]).map(t => (
                <span key={t} className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${typeBadgeCls[t]}`}>
                  {typeIcon[t]} {counts[t]}
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
          <div className="flex gap-2 ml-3 shrink-0">
            <button onClick={() => setShowFlow(f => !f)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${showFlow ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-slate-600 border-slate-200 hover:border-violet-300'}`}>
              <GitBranch size={13} /> Flow {showFlow ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            <button onClick={() => onEdit(wf)}
              className="p-2 rounded-lg hover:bg-violet-50 text-slate-400 hover:text-violet-500">
              <Edit2 size={15} />
            </button>
            <button onClick={() => onDelete(wf.id)}
              className="p-2 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-500">
              <Trash2 size={15} />
            </button>
          </div>
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
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState(getWorkflows);
  const triggers = getTriggers();
  const unmapped = getUnmappedTriggers();

  function handleDelete(id) {
    deleteWorkflow(id);
    setWorkflows(getWorkflows());
  }

  function triggerFor(wf) {
    return triggers.find(t => t.id === wf.triggerId || t.workflowId === wf.id);
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Workflows</h1>
          <p className="text-sm text-slate-500 mt-1">Each workflow is the response to a trigger. Fire it from the Triggers page.</p>
        </div>
        <button onClick={() => navigate('/builder/create')}
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 text-sm font-medium">
          <Plus size={16} /> New Workflow
        </button>
      </div>

      {/* Triggers needing a workflow */}
      {unmapped.length > 0 && (
        <div className="mb-5 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl">
          <div className="flex items-center gap-2 text-amber-800 text-sm font-semibold mb-2">
            <AlertCircle size={14} /> {unmapped.length} trigger{unmapped.length > 1 ? 's' : ''} without a workflow
          </div>
          <div className="flex flex-wrap gap-2">
            {unmapped.map(t => (
              <button key={t.id} onClick={() => navigate('/builder/create', { state: { presetTriggerId: t.id } })}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-amber-200 rounded-lg text-xs font-medium text-amber-700 hover:bg-amber-100">
                <Zap size={12} /> {t.name} — {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {workflows.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <GitBranch size={40} className="mx-auto mb-3 opacity-30" />
          <p className="mb-4">No workflows yet.</p>
          <button onClick={() => navigate('/builder/create')}
            className="px-5 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 text-sm">
            Create your first workflow
          </button>
        </div>
      ) : (
        <div className="grid gap-3">
          {workflows.map(wf => (
            <WorkflowCard
              key={wf.id}
              wf={wf}
              trigger={triggerFor(wf)}
              onEdit={w => navigate('/builder/create', { state: { workflow: w } })}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
