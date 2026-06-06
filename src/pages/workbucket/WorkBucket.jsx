import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { CheckCircle2, Clock, ChevronDown, ChevronUp, ArrowLeft, RefreshCw, Inbox } from 'lucide-react';
import { getUsers, getMyWorkItems, getMyCompletedItems, completeActionInstance } from '../../store';

function ActionCard({ item, onComplete }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleComplete() {
    setLoading(true);
    await new Promise(r => setTimeout(r, 250));
    onComplete(item, notes);
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-start gap-3 p-4">
        <div className="w-10 h-10 rounded-xl bg-violet-100 flex items-center justify-center shrink-0 mt-0.5">
          <CheckCircle2 size={16} className="text-violet-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-slate-800 leading-tight">{item.taskName}</div>
          <div className="text-xs text-slate-500 mt-0.5">
            <span className="font-medium text-slate-600">{item.workflowName}</span>
          </div>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="flex items-center gap-1 text-xs text-slate-400">
              <Clock size={10} />
              {new Date(item.launchedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
            </span>
          </div>
        </div>
        <button
          onClick={() => setOpen(o => !o)}
          className={`shrink-0 px-3 py-1.5 rounded-xl text-sm font-medium flex items-center gap-1 transition-colors ${open ? 'bg-violet-600 text-white' : 'bg-violet-50 text-violet-700 hover:bg-violet-100'}`}>
          {open ? 'Cancel' : 'Complete'}
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>

      {open && (
        <div className="border-t border-slate-100 px-4 pb-4 bg-slate-50/50">
          <div className="pt-3 space-y-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">Notes / Output</label>
              <textarea
                autoFocus
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 resize-none bg-white"
                rows={3} value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Add notes, decisions, or output..." />
            </div>
            <button onClick={handleComplete} disabled={loading}
              className="flex items-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-xl hover:bg-green-700 text-sm font-semibold disabled:opacity-60 transition-colors">
              <CheckCircle2 size={16} />
              {loading ? 'Saving...' : 'Mark Complete'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CompletedCard({ item }) {
  return (
    <div className="flex items-center gap-3 bg-white rounded-xl border border-slate-100 px-4 py-3">
      <CheckCircle2 size={16} className="text-green-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-sm text-slate-500 line-through">{item.actionName}</span>
        <span className="mx-1.5 text-slate-300">·</span>
        <span className="text-xs text-slate-400">{item.workflowName} › {item.taskName}</span>
      </div>
      <span className="text-xs text-slate-400 shrink-0">
        {new Date(item.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
    </div>
  );
}

const AVATAR_COLORS = [
  'bg-violet-200 text-violet-700',
  'bg-sky-200 text-sky-700',
  'bg-emerald-200 text-emerald-700',
  'bg-amber-200 text-amber-700',
];

export default function WorkBucket() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const users = getUsers();
  const user = users.find(u => u.id === userId);
  const userIdx = users.findIndex(u => u.id === userId);

  const [pending, setPending] = useState([]);
  const [completed, setCompleted] = useState([]);

  const refresh = useCallback(() => {
    setPending(getMyWorkItems(userId));
    setCompleted(getMyCompletedItems(userId));
  }, [userId]);

  useEffect(() => {
    refresh();
    // re-read when user switches back to this tab
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-slate-500 mb-4">User not found.</p>
          <button onClick={() => navigate('/')} className="text-violet-600 hover:underline text-sm">← Back</button>
        </div>
      </div>
    );
  }

  function handleComplete(item, notes) {
    completeActionInstance(item.instanceId, item.taskInstanceId, item.actionInstanceId, notes);
    refresh();
  }

  const avatarCls = AVATAR_COLORS[userIdx % AVATAR_COLORS.length];

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-100 sticky top-0 z-10">
        <div className="max-w-xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate('/')} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
            <ArrowLeft size={18} />
          </button>
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm ${avatarCls}`}>
            {user.name[0]}
          </div>
          <div className="flex-1">
            <div className="font-semibold text-slate-800 text-sm">{user.name}</div>
            <div className="text-xs text-slate-400">Work Bucket</div>
          </div>
          <button onClick={refresh} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
            <RefreshCw size={16} />
          </button>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-4 py-6 space-y-6">
        <section>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            <h2 className="text-sm font-semibold text-slate-700">
              Pending
              {pending.length > 0 && (
                <span className="ml-2 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-bold">{pending.length}</span>
              )}
            </h2>
          </div>

          {pending.length === 0 ? (
            <div className="text-center py-12 text-slate-400">
              <Inbox size={36} className="mx-auto mb-3 opacity-30" />
              <p className="font-medium text-slate-500">You're all caught up!</p>
              <p className="text-xs mt-1">No pending tasks right now.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {pending.map(item => (
                <ActionCard key={item.actionInstanceId} item={item} onComplete={handleComplete} />
              ))}
            </div>
          )}
        </section>

        {completed.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <span className="w-2 h-2 rounded-full bg-green-400" />
              <h2 className="text-sm font-semibold text-slate-500">Completed ({completed.length})</h2>
            </div>
            <div className="space-y-2">
              {completed.map(item => (
                <CompletedCard key={item.actionInstanceId} item={item} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
