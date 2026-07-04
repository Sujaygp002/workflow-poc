// Worker portal (/worker): standalone chrome, single-factor login
// (username/password), then three bucket tabs across the top —
// Untouched | Processing | Done — with live counts (5s poll). Clicking a card
// opens the task (the API call that claims it -> Processing) and shows the
// WorkerTaskDetail checklist; Done cards open read-only.
import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ClipboardList,
  Clock,
  Inbox,
  Loader2,
  Lock,
  LogOut,
  UserRound,
} from 'lucide-react';
import { clearAuthToken, getAuthToken, logout, workerLogin } from '../../lib/authApi';
import { fetchMyBuckets, openWorkItem } from '../../lib/workflowApi';
import WorkerTaskDetail from './WorkerTaskDetail';

const EMPTY_BUCKETS = { untouched: [], processing: [], done: [] };

const TABS = [
  { key: 'untouched', label: 'Untouched', dot: 'bg-amber-400', badge: 'bg-amber-100 text-amber-700' },
  { key: 'processing', label: 'Processing', dot: 'bg-sky-400', badge: 'bg-sky-100 text-sky-700' },
  { key: 'done', label: 'Done', dot: 'bg-green-400', badge: 'bg-green-100 text-green-700' },
];

const EMPTY_COPY = {
  untouched: 'No untouched tasks. New workflow tasks assigned to you (or shared) appear here.',
  processing: 'Nothing in progress. Open an untouched task to start working on it.',
  done: 'No completed tasks yet.',
};

// Build a read-only detail object for Done-bucket rows straight from the
// bucket row (a completed task cannot be re-opened via the open API).
function detailFromDoneRow(row) {
  return {
    task: row,
    actions: Array.isArray(row.actions) ? row.actions : [],
    actionState: row.action_state || {},
    payload: {
      patient: row.patient_payload || {},
      order: row.order_payload || {},
      references: row.reference_payload || {},
      extraction: row.extraction_payload || {},
      decisions: row.decisions || {},
      missingFields: [],
    },
    pdf: row.extraction_payload?.pdf || null,
    readOnly: true,
  };
}

function LoginShell({ icon, title, subtitle, children }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 to-slate-100 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-violet-600 shadow-lg mb-4">
            {icon}
          </div>
          <h1 className="text-3xl font-bold text-slate-800 tracking-tight">{title}</h1>
          <p className="text-slate-500 mt-2 text-sm">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function TaskCard({ row, bucket, onOpen, opening }) {
  const patientName = row.patient_payload?.patient_info?.name;
  const orderNumber = row.order_payload?.order_info?.order_number;
  const actionCount = Array.isArray(row.actions) ? row.actions.length : 1;
  const isDone = bucket === 'done';
  const when = bucket === 'untouched'
    ? (row.created_at || row.run_created_at)
    : bucket === 'processing' ? row.opened_at : row.completed_at;
  const whenLabel = bucket === 'untouched' ? 'Waiting since' : bucket === 'processing' ? 'Opened' : 'Completed';
  const cta = bucket === 'untouched' ? 'Open' : bucket === 'processing' ? 'Resume' : 'View';

  return (
    <button
      onClick={onOpen}
      disabled={opening}
      className="w-full text-left bg-white rounded-2xl border border-slate-100 shadow-sm p-4 hover:border-violet-300 hover:shadow-md transition-all disabled:opacity-60 disabled:cursor-wait"
    >
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${isDone ? 'bg-green-100' : 'bg-pink-100'}`}>
          <ClipboardList size={16} className={isDone ? 'text-green-600' : 'text-pink-600'} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`font-semibold leading-tight ${isDone ? 'text-slate-500' : 'text-slate-800'}`}>{row.name}</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-violet-50 text-violet-600">
              {row.workflow_name || row.workflow_id}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-500">
              {actionCount} action{actionCount === 1 ? '' : 's'}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap text-xs text-slate-400">
            {patientName && (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 border border-slate-100 px-2 py-0.5 text-slate-500">
                <UserRound size={10} />
                {patientName}
              </span>
            )}
            {orderNumber && (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 border border-slate-100 px-2 py-0.5 text-slate-500">
                <ClipboardList size={10} />
                {orderNumber}
              </span>
            )}
            {when && (
              <span className="inline-flex items-center gap-1">
                <Clock size={10} />
                {whenLabel} {new Date(when).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
        </div>
        <span className="shrink-0 inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-medium bg-violet-50 text-violet-700 mt-0.5">
          {opening && <Loader2 size={13} className="animate-spin" />}
          {cta}
        </span>
      </div>
    </button>
  );
}

export default function WorkerPortal() {
  // phase: 'boot' (restoring session) | 'login' | 'portal'
  const [phase, setPhase] = useState('boot');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [loginNotice, setLoginNotice] = useState('');

  const [employee, setEmployee] = useState(null);
  const [buckets, setBuckets] = useState(EMPTY_BUCKETS);
  const [bucketsError, setBucketsError] = useState('');
  const [activeTab, setActiveTab] = useState('untouched');
  const [detail, setDetail] = useState(null);
  const [openingId, setOpeningId] = useState(null);
  const [notice, setNotice] = useState('');

  const resetToLogin = useCallback((message = '') => {
    clearAuthToken('worker');
    setPhase('login');
    setEmployee(null);
    setBuckets(EMPTY_BUCKETS);
    setDetail(null);
    setActiveTab('untouched');
    setPassword('');
    setAuthError('');
    setNotice('');
    setLoginNotice(message);
  }, []);

  const loadBuckets = useCallback(async () => {
    try {
      const data = await fetchMyBuckets();
      setEmployee(data.employee || null);
      setBuckets({
        untouched: data.untouched || [],
        processing: data.processing || [],
        done: data.done || [],
      });
      setBucketsError('');
      return true;
    } catch (error) {
      if (error.status === 401) {
        resetToLogin('Your session expired. Sign in again.');
        return false;
      }
      setBucketsError(error.message);
      return false;
    }
  }, [resetToLogin]);

  // Restore an existing session on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getAuthToken('worker')) {
        setPhase('login');
        return;
      }
      try {
        const data = await fetchMyBuckets();
        if (cancelled) return;
        setEmployee(data.employee || null);
        setBuckets({
          untouched: data.untouched || [],
          processing: data.processing || [],
          done: data.done || [],
        });
        setPhase('portal');
      } catch {
        if (!cancelled) {
          clearAuthToken('worker');
          setPhase('login');
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Live bucket counts: 5s poll while signed in (skips hidden tabs).
  useEffect(() => {
    if (phase !== 'portal') return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) loadBuckets();
    }, 5000);
    return () => clearInterval(timer);
  }, [phase, loadBuckets]);

  async function submitLogin(event) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError('');
    setLoginNotice('');
    try {
      // Single-factor: a successful password login returns a complete session.
      await workerLogin({ username: username.trim(), password });
      const ok = await loadBuckets();
      if (ok) {
        setActiveTab('untouched');
        setPhase('portal');
      }
    } catch (error) {
      setAuthError(error.status === 401 ? 'Invalid username or password.' : error.message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    try {
      await logout('worker');
    } catch {
      clearAuthToken('worker');
    }
    resetToLogin('');
  }

  // Clicking a card fires the open API call: the task is claimed, opened_at is
  // stamped (Untouched -> Processing) and the response carries the checklist.
  async function openTask(row) {
    setOpeningId(row.id);
    setNotice('');
    try {
      const opened = await openWorkItem(row.id);
      // The open response task is the raw task-run row; keep the bucket row's
      // joined fields (workflow_name, run_created_at, ...) for the header.
      setDetail({ ...opened, task: { ...row, ...opened.task }, readOnly: false });
    } catch (error) {
      if (error.status === 401) {
        resetToLogin('Your session expired. Sign in again.');
        return;
      }
      setBucketsError(error.message);
      loadBuckets();
    } finally {
      setOpeningId(null);
    }
  }

  function handleBack() {
    // Back keeps the task in Processing (opened_at stays set).
    setDetail(null);
    loadBuckets();
  }

  function handleCompleted() {
    setDetail(null);
    setNotice('Task completed — it moved to Done.');
    setActiveTab('done');
    loadBuckets();
  }

  if (phase === 'boot') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-slate-400">
        <Loader2 size={24} className="animate-spin" />
      </div>
    );
  }

  if (phase === 'login') {
    return (
      <LoginShell
        icon={<Inbox size={28} className="text-white" />}
        title="Worker Portal"
        subtitle="Sign in with your employee account"
      >
        <form onSubmit={submitLogin} className="space-y-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
          {loginNotice && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{loginNotice}</div>
          )}
          <label className="block">
            <span className="text-xs font-semibold text-slate-500 uppercase">Username</span>
            <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
              <UserRound size={16} className="text-slate-400" />
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className="w-full outline-none text-sm"
                autoComplete="username"
                autoFocus
              />
            </div>
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-slate-500 uppercase">Password</span>
            <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
              <Lock size={16} className="text-slate-400" />
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full outline-none text-sm"
                autoComplete="current-password"
              />
            </div>
          </label>
          {authError && <div className="text-sm text-rose-600">{authError}</div>}
          <button
            disabled={authBusy || !username.trim() || !password}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {authBusy && <Loader2 size={15} className="animate-spin" />}
            Sign in
          </button>
        </form>
      </LoginShell>
    );
  }

  const rows = buckets[activeTab] || [];

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-100 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-violet-600 flex items-center justify-center shrink-0">
            <Inbox size={15} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-slate-800 text-sm">Worker Portal</div>
            <div className="text-xs text-slate-400">Command Center</div>
          </div>
          {employee && (
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-violet-200 text-violet-700 flex items-center justify-center font-bold text-sm">
                {(employee.displayName || employee.username || '?')[0].toUpperCase()}
              </div>
              <div className="hidden sm:block">
                <div className="text-sm font-semibold text-slate-700 leading-tight">{employee.displayName || employee.username}</div>
                <div className="text-xs text-slate-400 leading-tight">{employee.username}</div>
              </div>
            </div>
          )}
          <button
            onClick={signOut}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        {bucketsError && (
          <div className="flex items-start gap-2 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{bucketsError}</span>
          </div>
        )}

        {detail ? (
          <WorkerTaskDetail
            key={detail.task.id}
            detail={detail}
            onBack={handleBack}
            onCompleted={handleCompleted}
            onAuthExpired={() => resetToLogin('Your session expired. Sign in again.')}
          />
        ) : (
          <>
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-1.5 flex gap-1">
              {TABS.map((tab) => {
                const count = (buckets[tab.key] || []).length;
                const active = activeTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    onClick={() => { setActiveTab(tab.key); setNotice(''); }}
                    className={`flex-1 flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors ${active ? 'bg-violet-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                  >
                    <span className={`w-2 h-2 rounded-full ${tab.dot}`} />
                    {tab.label}
                    <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${active ? 'bg-white/20 text-white' : tab.badge}`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {notice && (
              <div className="flex items-start gap-2 px-4 py-3 bg-green-50 border border-green-200 rounded-xl text-green-800 text-sm">
                <ClipboardList size={16} className="mt-0.5 shrink-0" />
                <span>{notice}</span>
              </div>
            )}

            {rows.length === 0 ? (
              <div className="text-center py-16 text-slate-400">
                <Inbox size={36} className="mx-auto mb-3 opacity-30" />
                <p className="font-medium text-slate-500">{EMPTY_COPY[activeTab]}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {rows.map((row) => (
                  <TaskCard
                    key={row.id}
                    row={row}
                    bucket={activeTab}
                    opening={openingId === row.id}
                    onOpen={() => (activeTab === 'done' ? setDetail(detailFromDoneRow(row)) : openTask(row))}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
