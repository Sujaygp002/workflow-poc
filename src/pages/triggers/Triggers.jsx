import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, Play, AlertCircle, ArrowRight, CheckCircle2 } from 'lucide-react';
import { getTriggers, getWorkflows, getWorkflowForTrigger, launchWorkflow } from '../../store';

export default function Triggers() {
  const navigate = useNavigate();
  const triggers = getTriggers();
  const [workflows] = useState(getWorkflows);
  const [fired, setFired] = useState(null);

  function workflowFor(t) {
    if (!t.workflowId) return null;
    return workflows.find(w => w.id === t.workflowId) || null;
  }

  function handleFire(t) {
    const wf = getWorkflowForTrigger(t.id);
    if (!wf) return;
    const inst = launchWorkflow(wf.id);
    if (inst) {
      setFired(`${t.name} — ${wf.name}`);
      setTimeout(() => setFired(null), 3500);
    }
  }

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-violet-600 flex items-center justify-center">
          <Zap size={20} className="text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Triggers</h1>
          <p className="text-sm text-slate-500">Fire a trigger to launch its workflow. The orchestrator routes & assigns the tasks.</p>
        </div>
      </div>

      {fired && (
        <div className="my-4 px-4 py-3 bg-green-50 border border-green-200 rounded-xl text-green-700 text-sm font-medium flex items-center gap-2">
          <Play size={14} /> «{fired}» fired! See the Orchestrator for the live run.
        </div>
      )}

      <div className="grid gap-3 mt-4">
        {triggers.map(t => {
          const wf = workflowFor(t);
          return (
            <div key={t.id}
              className={`rounded-2xl border p-4 shadow-sm flex items-center gap-4 ${wf ? 'bg-white border-slate-100' : 'bg-amber-50 border-amber-200'}`}>
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${wf ? 'bg-violet-100' : 'bg-amber-100'}`}>
                <Zap size={18} className={wf ? 'text-violet-600' : 'text-amber-600'} />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-slate-800">{t.name}</span>
                  <span className="text-sm text-slate-500">{t.label}</span>
                </div>
                <div className="text-xs text-slate-400 mt-0.5">{t.description}</div>
                <div className="mt-1.5 text-xs">
                  {wf ? (
                    <span className="inline-flex items-center gap-1 text-slate-500">
                      <CheckCircle2 size={11} className="text-green-500" /> workflow:
                      <span className="font-medium text-slate-700">{wf.name}</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 font-medium text-amber-700">
                      <AlertCircle size={11} /> no workflow yet
                    </span>
                  )}
                </div>
              </div>

              {wf ? (
                <button onClick={() => handleFire(t)}
                  className="flex items-center gap-1.5 px-4 py-2 bg-violet-600 text-white rounded-lg text-sm font-semibold hover:bg-violet-700 transition-colors shrink-0">
                  <Play size={14} /> Fire
                </button>
              ) : (
                <button onClick={() => navigate('/builder/create', { state: { presetTriggerId: t.id } })}
                  className="flex items-center gap-1.5 px-4 py-2 bg-white border border-amber-300 text-amber-700 rounded-lg text-sm font-semibold hover:bg-amber-100 transition-colors shrink-0">
                  Set up workflow <ArrowRight size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
