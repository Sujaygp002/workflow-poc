import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import { getUsers, getMyWorkItems } from '../../store';

const AVATAR_COLORS = [
  'bg-violet-200 text-violet-700',
  'bg-sky-200 text-sky-700',
  'bg-emerald-200 text-emerald-700',
  'bg-amber-200 text-amber-700',
];

export default function UserSelect() {
  const navigate = useNavigate();
  const [users, setUsers] = useState(getUsers);
  const [, setTick] = useState(0);

  useEffect(() => {
    const refresh = () => { setUsers(getUsers()); setTick(t => t + 1); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    return () => window.removeEventListener('focus', refresh);
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 to-slate-100 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-violet-600 shadow-lg mb-4">
            <Inbox size={28} className="text-white" />
          </div>
          <h1 className="text-3xl font-bold text-slate-800 tracking-tight">Work Bucket</h1>
          <p className="text-slate-500 mt-2 text-sm">Select your name to see your assigned tasks</p>
        </div>

        <div className="space-y-3">
          {users.map((user, i) => {
            const pending = getMyWorkItems(user.id).length;
            return (
              <button
                key={user.id}
                onClick={() => navigate(`/bucket/${user.id}`)}
                className="w-full flex items-center gap-4 bg-white rounded-2xl p-4 shadow-sm border border-slate-100 hover:border-violet-300 hover:shadow-md transition-all group text-left"
              >
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-xl font-bold shrink-0 ${AVATAR_COLORS[i % AVATAR_COLORS.length]}`}>
                  {user.name[0]}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-slate-800 group-hover:text-violet-700 transition-colors">{user.name}</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {pending > 0
                      ? <span className="text-amber-600 font-medium">{pending} task{pending !== 1 ? 's' : ''} pending</span>
                      : <span className="text-green-600">All clear</span>}
                  </div>
                </div>
                {pending > 0 && (
                  <div className="w-6 h-6 rounded-full bg-amber-100 text-amber-700 text-xs font-bold flex items-center justify-center shrink-0">
                    {pending}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
