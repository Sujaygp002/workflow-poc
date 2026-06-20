import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CheckCircle2, Inbox, Lock, UserRound } from 'lucide-react';
import { fetchWorkItems, fetchWorkUsers } from '../../lib/workflowApi';

const WORKER_SCOPE_KEY = 'worker_selected_user';
const WORKER_LOGIN_KEY = 'worker_logged_in';

const AVATAR_COLORS = [
  'bg-violet-200 text-violet-700',
  'bg-sky-200 text-sky-700',
  'bg-emerald-200 text-emerald-700',
  'bg-amber-200 text-amber-700',
];

function readSelectedWorker() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(WORKER_SCOPE_KEY) || 'null');
    return parsed?.id && parsed?.name ? parsed : null;
  } catch {
    return null;
  }
}

export default function UserSelect() {
  const navigate = useNavigate();
  const location = useLocation();
  const [users, setUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState(() => readSelectedWorker()?.id || '');
  const [counts, setCounts] = useState({});
  const [username, setUsername] = useState('test123');
  const [password, setPassword] = useState('test123');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const selected = readSelectedWorker();
    if (sessionStorage.getItem(WORKER_LOGIN_KEY) === 'true' && selected?.id) {
      navigate(location.pathname.startsWith('/worker') ? `/worker/bucket/${selected.id}` : `/bucket/${selected.id}`);
      return undefined;
    }
    let cancelled = false;
    async function refresh() {
      setLoading(true);
      try {
        const nextUsers = await fetchWorkUsers();
        if (cancelled) return;
        setUsers(nextUsers);
        setSelectedUserId((current) => current || nextUsers[0]?.id || '');
        const entries = await Promise.all(nextUsers.map(async (user) => {
          try {
            const data = await fetchWorkItems(user.id);
            return [user.id, { pending: (data.pending || []).length, done: (data.completed || []).length }];
          } catch {
            return [user.id, { pending: 0, done: 0 }];
          }
        }));
        if (!cancelled) {
          setCounts(Object.fromEntries(entries));
          setError('');
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    refresh();
    const onFocus = () => refresh();
    const onVisibility = () => { if (!document.hidden) refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [location.pathname, navigate]);

  function submit(event) {
    event.preventDefault();
    const selected = users.find((user) => user.id === selectedUserId);
    if (!selected) {
      setError('Select a worker.');
      return;
    }
    if (username !== 'test123' || password !== 'test123') {
      setError('Invalid username or password.');
      return;
    }
    sessionStorage.setItem(WORKER_SCOPE_KEY, JSON.stringify(selected));
    sessionStorage.setItem(WORKER_LOGIN_KEY, 'true');
    navigate(location.pathname.startsWith('/worker') ? `/worker/bucket/${selected.id}` : `/bucket/${selected.id}`);
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 to-slate-100 flex flex-col items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-md">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-violet-600 shadow-lg mb-4">
            <Inbox size={28} className="text-white" />
          </div>
          <h1 className="text-3xl font-bold text-slate-800 tracking-tight">Work Bucket</h1>
          <p className="text-slate-500 mt-2 text-sm">Select your name to see your assigned tasks</p>
        </div>

        <div className="space-y-3">
          {loading && users.length === 0 && (
            <div className="rounded-2xl border border-slate-100 bg-white p-4 text-center text-sm text-slate-400 shadow-sm">
              Loading workers...
            </div>
          )}
          {users.map((user, i) => {
            const pending = counts[user.id]?.pending || 0;
            const done = counts[user.id]?.done || 0;
            const total = pending + done;
            const pct = total === 0 ? 0 : Math.round((done / total) * 100);
            return (
              <button
                key={user.id}
                type="button"
                onClick={() => setSelectedUserId(user.id)}
                className={`w-full flex items-center gap-4 bg-white rounded-2xl p-4 shadow-sm border transition-all group text-left ${selectedUserId === user.id ? 'border-violet-300 ring-2 ring-violet-100' : 'border-slate-100 hover:border-violet-300 hover:shadow-md'}`}
              >
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-xl font-bold shrink-0 ${AVATAR_COLORS[i % AVATAR_COLORS.length]}`}>
                  {user.name[0]}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-slate-800 group-hover:text-violet-700 transition-colors">{user.name}</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {pending > 0
                      ? <span className="text-amber-600 font-medium">{pending} pending</span>
                      : <span className="text-green-600">All clear</span>}
                    {done > 0 && <span className="text-slate-400"> · {done} done</span>}
                  </div>
                  {total > 0 && (
                    <div className="flex items-center gap-2 mt-1.5">
                      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-violet-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[10px] text-slate-400 w-7 text-right">{pct}%</span>
                    </div>
                  )}
                </div>
                {pending > 0 && (
                  <div className="w-6 h-6 rounded-full bg-amber-100 text-amber-700 text-xs font-bold flex items-center justify-center shrink-0">
                    {pending}
                  </div>
                )}
                {selectedUserId === user.id && <CheckCircle2 size={18} className="text-violet-600 shrink-0" />}
              </button>
            );
          })}
        </div>

        <div className="mt-4 space-y-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
          <label className="block">
            <span className="text-xs font-semibold text-slate-500 uppercase">Username</span>
            <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
              <UserRound size={16} className="text-slate-400" />
              <input value={username} onChange={(event) => setUsername(event.target.value)} className="w-full outline-none text-sm" autoComplete="username" />
            </div>
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-slate-500 uppercase">Password</span>
            <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
              <Lock size={16} className="text-slate-400" />
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="w-full outline-none text-sm" autoComplete="current-password" />
            </div>
          </label>
          {error && <div className="text-sm text-rose-600">{error}</div>}
          <button className="w-full rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-violet-700">
            Login
          </button>
        </div>
      </form>
    </div>
  );
}
