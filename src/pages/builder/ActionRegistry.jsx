import { useState } from 'react';
import { Zap } from 'lucide-react';
import Badge from '../../components/Badge';
import { getActions, getUsers } from '../../store';

export default function ActionRegistry() {
  const [actions] = useState(getActions);
  const users = getUsers();

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Action Registry</h1>
        <p className="text-sm text-slate-500 mt-1">Reusable actions available to attach to tasks</p>
      </div>

      {actions.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <Zap size={40} className="mx-auto mb-3 opacity-30" />
          <p>No actions in the registry.</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {actions.map(a => {
            const user = users.find(u => u.id === a.assignedTo);
            return (
              <div key={a.id} className="bg-white rounded-xl border border-slate-100 p-4 shadow-sm">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-slate-800">{a.name}</span>
                  <Badge label={a.executorType} type={a.executorType?.split('+')[0]} />
                  {user && <span className="text-xs text-slate-500">→ {user.name}</span>}
                </div>
                {a.description && <p className="text-sm text-slate-500 mt-1">{a.description}</p>}
                {(a.executorType === 'ai' || a.executorType === 'ai+system' || a.executorType === 'human+ai') && a.prompt && (
                  <p className="text-xs text-slate-400 mt-1 italic">Prompt: {a.prompt}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
