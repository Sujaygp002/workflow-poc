import { useState } from 'react';
import { Users, GitBranch, ChevronDown, ChevronUp, Check, Save } from 'lucide-react';
import { getWorkflows, getUsers, saveWorkflow } from '../../store';

const AVATAR_COLORS = [
  'bg-violet-200 text-violet-700',
  'bg-sky-200 text-sky-700',
  'bg-emerald-200 text-emerald-700',
  'bg-amber-200 text-amber-700',
];

function UserPicker({ value, onChange, users, placeholder = '— unassigned —' }) {
  return (
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value || null)}
      className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 bg-white min-w-[130px]"
    >
      <option value="">{placeholder}</option>
      {users.map(u => (
        <option key={u.id} value={u.id}>{u.name}</option>
      ))}
    </select>
  );
}

function UserAvatar({ userId, users, size = 'sm' }) {
  const idx = users.findIndex(u => u.id === userId);
  const user = users[idx];
  if (!user) return null;
  const cls = AVATAR_COLORS[idx % AVATAR_COLORS.length];
  const dim = size === 'sm' ? 'w-6 h-6 text-xs' : 'w-8 h-8 text-sm';
  return (
    <div className={`${dim} ${cls} rounded-full flex items-center justify-center font-bold shrink-0`}>
      {user.name[0]}
    </div>
  );
}

function WorkflowRow({ wf, users, onSave }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(wf)));
  const [saved, setSaved] = useState(false);

  const owner = users.find(u => u.id === draft.owner);

  function setWorkflowOwner(userId) {
    setDraft(d => ({ ...d, owner: userId }));
  }

  function setActionAssignee(taskIdx, actionId, userId) {
    setDraft(d => {
      const tasks = d.tasks.map((t, ti) => {
        if (ti !== taskIdx) return t;
        return {
          ...t,
          actions: t.actions.map(a =>
            a.id === actionId ? { ...a, assignedTo: userId } : a
          ),
        };
      });
      return { ...d, tasks };
    });
  }

  function handleSave() {
    onSave(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const isDirty = JSON.stringify(draft) !== JSON.stringify(wf);

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      {/* Workflow header row */}
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="w-9 h-9 rounded-xl bg-violet-100 flex items-center justify-center shrink-0">
          <GitBranch size={16} className="text-violet-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-slate-800 text-sm">{draft.name}</div>
          <div className="text-xs text-slate-400 mt-0.5">{draft.tasks?.length || 0} tasks · {draft.tasks?.reduce((s, t) => s + (t.actions?.length || 0), 0) || 0} actions</div>
        </div>

        {/* Workflow owner picker */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-slate-500 font-medium">Owner</span>
          {owner && <UserAvatar userId={draft.owner} users={users} />}
          <UserPicker value={draft.owner} onChange={setWorkflowOwner} users={users} placeholder="— no owner —" />
        </div>

        <button
          onClick={() => setOpen(o => !o)}
          className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 shrink-0"
        >
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>

      {/* Expanded: per-task / per-action assignment */}
      {open && (
        <div className="border-t border-slate-100 bg-slate-50/40 px-5 py-4 space-y-4">
          {(draft.tasks || []).map((task, tIdx) => (
            <div key={task.id || tIdx} className="space-y-2">
              {/* Task label */}
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-violet-600 text-white text-xs font-bold flex items-center justify-center shrink-0">
                  {tIdx + 1}
                </div>
                <span className="font-medium text-slate-700 text-sm">{task.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${(task.executionMode || 'sequential') === 'parallel' ? 'bg-teal-100 text-teal-700' : 'bg-slate-100 text-slate-600'}`}>
                  {task.executionMode || 'sequential'}
                </span>
              </div>

              {/* Action rows */}
              <div className="ml-7 space-y-2">
                {(task.actions || []).map(action => {
                  const assignee = users.find(u => u.id === action.assignedTo);
                  return (
                    <div key={action.id} className="flex items-center gap-3 bg-white border border-slate-100 rounded-xl px-4 py-2.5">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-700 truncate">{action.name}</div>
                        <div className="text-xs text-slate-400 mt-0.5">{action.executorType}</div>
                      </div>
                      {assignee && <UserAvatar userId={action.assignedTo} users={users} />}
                      <UserPicker
                        value={action.assignedTo}
                        onChange={uid => setActionAssignee(tIdx, action.id, uid)}
                        users={users}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Save button */}
          <div className="flex justify-end pt-2">
            <button
              onClick={handleSave}
              disabled={!isDirty && !saved}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${saved ? 'bg-green-500 text-white' : isDirty ? 'bg-violet-600 text-white hover:bg-violet-700' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
            >
              {saved ? <><Check size={14} /> Saved!</> : <><Save size={14} /> Save Assignments</>}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Dispatcher() {
  const users = getUsers();
  const [workflows, setWorkflows] = useState(getWorkflows);

  function handleSave(updated) {
    saveWorkflow(updated);
    setWorkflows(getWorkflows());
  }

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-violet-600 flex items-center justify-center">
          <Users size={20} className="text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Dispatcher</h1>
          <p className="text-sm text-slate-500">Assign owners to workflows and assignees to every action</p>
        </div>
      </div>

      {/* Team roster */}
      <div className="flex items-center gap-2 mt-4 mb-6 flex-wrap">
        {users.map((u, i) => (
          <div key={u.id} className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${AVATAR_COLORS[i % AVATAR_COLORS.length]}`}>
            <div className="w-4 h-4 rounded-full bg-current opacity-30" />
            {u.name}
          </div>
        ))}
      </div>

      <div className="space-y-3">
        {workflows.map(wf => (
          <WorkflowRow key={wf.id} wf={wf} users={users} onSave={handleSave} />
        ))}
      </div>
    </div>
  );
}
