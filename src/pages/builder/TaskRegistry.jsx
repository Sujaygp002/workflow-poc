import { useState } from 'react';
import { Plus, Trash2, Edit2, ListTodo, X, ChevronDown, ChevronUp } from 'lucide-react';
import Modal from '../../components/Modal';
import Badge from '../../components/Badge';
import { getTasks, saveTask, deleteTask, getActions, getUsers } from '../../store';

const CONDITION_TYPES = ['none', 'if/else', 'switch', 'loop'];

function ActionPicker({ selected, onChange }) {
  const actions = getActions();
  const users = getUsers();
  const [open, setOpen] = useState(false);

  function toggle(action) {
    const exists = selected.find(a => a.id === action.id);
    if (exists) {
      onChange(selected.filter(a => a.id !== action.id));
    } else {
      onChange([...selected, { ...action }]);
    }
  }

  function updateAssign(actionId, userId) {
    onChange(selected.map(a => a.id === actionId ? { ...a, assignedTo: userId } : a));
  }

  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-sm text-violet-600 hover:text-violet-700 font-medium">
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        {open ? 'Hide action picker' : 'Pick actions from registry'}
      </button>

      {open && (
        <div className="mt-2 border border-slate-200 rounded-lg overflow-hidden">
          {actions.length === 0 && (
            <div className="p-3 text-sm text-slate-400 text-center">No actions in registry. Create some first.</div>
          )}
          {actions.map(a => {
            const picked = selected.find(s => s.id === a.id);
            return (
              <div key={a.id} className={`flex items-center gap-3 px-3 py-2 border-b border-slate-100 last:border-0 ${picked ? 'bg-violet-50' : 'hover:bg-slate-50'}`}>
                <input type="checkbox" checked={!!picked} onChange={() => toggle(a)} className="accent-violet-600" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-700">{a.name}</span>
                    <Badge label={a.executorType} type={a.executorType?.split('+')[0]} />
                  </div>
                </div>
                {picked && (a.executorType === 'human' || a.executorType === 'human+ai') && (
                  <select className="text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-violet-400"
                    value={picked.assignedTo || ''} onChange={e => updateAssign(a.id, e.target.value)}>
                    <option value="">— assign to —</option>
                    {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      )}

      {selected.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {selected.map(a => (
            <span key={a.id} className="inline-flex items-center gap-1 bg-violet-100 text-violet-700 text-xs px-2 py-1 rounded-full">
              {a.name}
              <button onClick={() => toggle(a)}><X size={10} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskForm({ initial, onSave, onClose }) {
  const [form, setForm] = useState(initial || {
    name: '', description: '', condition: 'none', conditionExpr: '', actions: [],
  });

  function set(k, v) { setForm(f => ({ ...f, [k]: v })); }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Task Name *</label>
        <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
          value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Approve Invoice" />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
        <textarea className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 resize-none"
          rows={2} value={form.description} onChange={e => set('description', e.target.value)} />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-2">Control Flow</label>
        <div className="flex flex-wrap gap-2">
          {CONDITION_TYPES.map(c => (
            <button key={c} onClick={() => set('condition', c)}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${form.condition === c ? 'bg-violet-600 text-white border-violet-600' : 'border-slate-200 text-slate-600 hover:border-violet-300'}`}>
              {c}
            </button>
          ))}
        </div>
        {form.condition !== 'none' && (
          <input className="mt-2 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
            value={form.conditionExpr} onChange={e => set('conditionExpr', e.target.value)}
            placeholder={form.condition === 'loop' ? 'e.g. repeat 3 times' : 'e.g. amount > 1000'} />
        )}
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-2">Actions</label>
        <ActionPicker selected={form.actions} onChange={v => set('actions', v)} />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">Cancel</button>
        <button onClick={() => form.name && onSave(form)}
          className="px-4 py-2 text-sm bg-violet-600 text-white rounded-lg hover:bg-violet-700"
          disabled={!form.name}>
          Save Task
        </button>
      </div>
    </div>
  );
}

function TaskCard({ task, onEdit, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const users = getUsers();

  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm">
      <div className="flex items-start justify-between p-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-800">{task.name}</span>
            {task.condition !== 'none' && <Badge label={task.condition} />}
          </div>
          {task.description && <p className="text-sm text-slate-500 mt-1">{task.description}</p>}
          {task.actions?.length > 0 && (
            <button onClick={() => setExpanded(e => !e)} className="mt-2 text-xs text-violet-600 hover:text-violet-700 flex items-center gap-1">
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {task.actions.length} action{task.actions.length !== 1 ? 's' : ''}
            </button>
          )}
        </div>
        <div className="flex gap-1 ml-3 shrink-0">
          <button onClick={() => onEdit(task)} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400"><Edit2 size={15} /></button>
          <button onClick={() => onDelete(task.id)} className="p-2 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
        </div>
      </div>
      {expanded && task.actions?.length > 0 && (
        <div className="border-t border-slate-100 px-4 pb-3">
          {task.actions.map(a => {
            const user = users.find(u => u.id === a.assignedTo);
            return (
              <div key={a.id} className="flex items-center gap-2 py-1.5 text-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />
                <span className="text-slate-700">{a.name}</span>
                <Badge label={a.executorType} type={a.executorType?.split('+')[0]} />
                {user && <span className="text-slate-400 text-xs">→ {user.name}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function TaskRegistry() {
  const [tasks, setTasks] = useState(getTasks);
  const [modal, setModal] = useState(null);

  function handleSave(form) {
    saveTask(form);
    setTasks(getTasks());
    setModal(null);
  }

  function handleDelete(id) {
    deleteTask(id);
    setTasks(getTasks());
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Task Registry</h1>
          <p className="text-sm text-slate-500 mt-1">Reusable tasks with actions attached</p>
        </div>
        <button onClick={() => setModal('new')}
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 text-sm font-medium">
          <Plus size={16} /> New Task
        </button>
      </div>

      {tasks.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <ListTodo size={40} className="mx-auto mb-3 opacity-30" />
          <p>No tasks yet. Create your first task.</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {tasks.map(t => (
            <TaskCard key={t.id} task={t} onEdit={setModal} onDelete={handleDelete} />
          ))}
        </div>
      )}

      {modal && (
        <Modal title={modal === 'new' ? 'New Task' : 'Edit Task'} onClose={() => setModal(null)}>
          <TaskForm initial={modal !== 'new' ? modal : null} onSave={handleSave} onClose={() => setModal(null)} />
        </Modal>
      )}
    </div>
  );
}
