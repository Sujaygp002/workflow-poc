import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Play, Trash2, GitBranch, Clock, Edit2 } from 'lucide-react';
import Badge from '../../components/Badge';
import { getWorkflows, deleteWorkflow, launchWorkflow, getUsers } from '../../store';

export default function WorkflowList() {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState(getWorkflows);
  const users = getUsers();
  const [launched, setLaunched] = useState(null);

  function handleDelete(id) {
    deleteWorkflow(id);
    setWorkflows(getWorkflows());
  }

  function handleLaunch(wf) {
    const inst = launchWorkflow(wf.id);
    if (inst) setLaunched(inst.workflowName);
    setTimeout(() => setLaunched(null), 3000);
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Workflows</h1>
          <p className="text-sm text-slate-500 mt-1">Create, manage and launch your workflows</p>
        </div>
        <button onClick={() => navigate('/builder/create')}
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 text-sm font-medium">
          <Plus size={16} /> New Workflow
        </button>
      </div>

      {launched && (
        <div className="mb-4 px-4 py-3 bg-green-50 border border-green-200 rounded-xl text-green-700 text-sm font-medium flex items-center gap-2">
          <Play size={14} /> «{launched}» launched successfully! Check the Work Bucket.
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
          {workflows.map(wf => {
            const owner = users.find(u => u.id === wf.owner);
            const taskCount = wf.tasks?.length || 0;
            const actionCount = wf.tasks?.reduce((s, t) => s + (t.actions?.length || 0), 0) || 0;
            return (
              <div key={wf.id} className="bg-white rounded-xl border border-slate-100 p-4 shadow-sm hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-800">{wf.name}</span>
                      <Badge label={wf.triggerType} type={wf.triggerType} />
                    </div>
                    {wf.description && <p className="text-sm text-slate-500 mt-1 line-clamp-1">{wf.description}</p>}
                    <div className="flex items-center gap-4 mt-2 text-xs text-slate-400">
                      {owner && <span>Owner: {owner.name}</span>}
                      <span>{taskCount} task{taskCount !== 1 ? 's' : ''}</span>
                      <span>{actionCount} action{actionCount !== 1 ? 's' : ''}</span>
                      {wf.createdAt && (
                        <span className="flex items-center gap-1">
                          <Clock size={10} />
                          {new Date(wf.createdAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 ml-3 shrink-0">
                    <button onClick={() => handleLaunch(wf)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 text-green-700 border border-green-200 rounded-lg text-sm font-medium hover:bg-green-100 transition-colors">
                      <Play size={13} /> Launch
                    </button>
                    <button onClick={() => navigate('/builder/create', { state: { workflow: wf } })}
                      className="p-2 rounded-lg hover:bg-violet-50 text-slate-400 hover:text-violet-500">
                      <Edit2 size={15} />
                    </button>
                    <button onClick={() => handleDelete(wf.id)}
                      className="p-2 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-500">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
