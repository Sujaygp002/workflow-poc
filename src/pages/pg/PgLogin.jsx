import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Building2, CheckCircle2, ClipboardSignature, ExternalLink, FileText, GitBranch, LayoutDashboard, Loader2, Lock, RefreshCw, Stethoscope, UserRound } from 'lucide-react';
import { formatUiDate } from '../../lib/dateFormat';
import { clearAuthToken, externalLogin, getAuthToken, getSession, logout, setAuthToken } from '../../lib/authApi';
import { bulkSignPgOrders, fetchPatientTree, fetchPatients, fetchPgUnsignedOrders } from '../../lib/workflowApi';
import RcmTable from '../../components/RcmTable';
import PatientHierarchyView from '../../components/PatientHierarchyView';

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function LoginPanel({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const result = await externalLogin({ username: username.trim(), password });
      if (result.user?.userType !== 'pg') {
        // A valid account, but not a PG portal login — discard the session.
        setAuthToken('pg', result.token);
        logout('pg').catch(() => {});
        setError('This account is not a PG login. Use the HHAH portal instead.');
        return;
      }
      setAuthToken('pg', result.token);
      onLogin(result.user);
    } catch (err) {
      setError(err.status === 401 ? 'Invalid username or password.' : err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_25%_25%,rgba(14,165,233,0.2),transparent_30%),radial-gradient(circle_at_75%_15%,rgba(16,185,129,0.18),transparent_28%),linear-gradient(135deg,#020617,#0f172a_52%,#111827)]" />
      <form onSubmit={submit} className="relative w-full max-w-md rounded-2xl border border-white/10 bg-white/95 p-6 shadow-2xl">
        <div className="w-12 h-12 rounded-2xl bg-emerald-600 flex items-center justify-center text-white mb-4">
          <Building2 size={24} />
        </div>
        <h1 className="text-2xl font-bold text-slate-900">PG Login</h1>
        <p className="text-sm text-slate-500 mt-1">Sign in with the account created for your physician group.</p>
        <div className="mt-6 space-y-3">
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
          <button disabled={submitting} className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-60">
            {submitting && <Loader2 size={15} className="animate-spin" />}
            {submitting ? 'Signing in' : 'Login'}
          </button>
        </div>
      </form>
    </div>
  );
}

function BulkSign({ user }) {
  const pgId = user?.pgId || '';
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [signing, setSigning] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const selectedCount = selected.size;
  const allSelected = orders.length > 0 && selectedCount === orders.length;

  const refresh = useCallback(async (nextPgId = '') => {
    setLoading(true);
    try {
      const rows = await fetchPgUnsignedOrders(nextPgId);
      setOrders(rows);
      setSelected(new Set());
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (pgId) refresh(pgId);
  }, [pgId, refresh]);

  function toggleOrder(orderId) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(orders.map((order) => order.id)));
  }

  async function bulkSign() {
    if (selectedCount === 0) {
      setError('Select at least one order to sign.');
      return;
    }
    setSigning(true);
    setMessage('');
    setError('');
    try {
      const result = await bulkSignPgOrders({ orderIds: [...selected], pgId, date: todayYmd() });
      setMessage(`Signed ${result.updatedCount || 0} order(s). ${result.skippedCount || 0} skipped.`);
      await refresh(pgId);
    } catch (err) {
      setError(err.message);
    } finally {
      setSigning(false);
    }
  }

  const pgName = user?.pgName || 'Physician group';

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Bulk Sign</h2>
            <p className="mt-1 text-sm text-slate-500">Orders sent to physician and waiting for signature.</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="block">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Physician group</span>
              <div className="mt-1 min-w-[240px] rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700">
                {pgName}
              </div>
            </div>
            <button onClick={() => refresh(pgId)} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
            <button
              onClick={bulkSign}
              disabled={signing || selectedCount === 0}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {signing ? <Loader2 size={15} className="animate-spin" /> : <ClipboardSignature size={15} />}
              Bulk Sign ({selectedCount})
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1">{pgName}</span>
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 font-semibold text-emerald-700">
            Signing as {user?.displayName || 'practitioner'}{user?.npi ? ` · NPI ${user.npi}` : ''}
          </span>
          <span>{orders.length} unsigned order(s)</span>
        </div>
        {message && <div className="mt-3 flex items-center gap-2 text-sm text-emerald-700"><CheckCircle2 size={15} /> {message}</div>}
        {error && <div className="mt-3 text-sm text-rose-600">{error}</div>}
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="grid grid-cols-[44px_1.1fr_1.2fr_1fr_1fr_1fr_92px] gap-3 border-b border-slate-100 bg-slate-50 px-4 py-3 text-xs font-black uppercase tracking-wide text-slate-500">
          <button onClick={toggleAll} className="flex h-5 w-5 items-center justify-center rounded border border-slate-300 bg-white text-[10px] text-slate-600">
            {allSelected ? '✓' : ''}
          </button>
          <span>Order</span>
          <span>Patient</span>
          <span>Type</span>
          <span>Sent</span>
          <span>HHAH</span>
          <span>PDF</span>
        </div>
        {loading && orders.length === 0 ? (
          <div className="flex justify-center py-16 text-slate-400"><Loader2 className="animate-spin" /></div>
        ) : orders.length === 0 ? (
          <div className="py-16 text-center text-sm text-slate-400">No sent unsigned orders.</div>
        ) : orders.map((order) => (
          <div key={order.id} className="grid grid-cols-[44px_1.1fr_1.2fr_1fr_1fr_1fr_92px] gap-3 border-b border-slate-100 px-4 py-3 text-sm last:border-b-0">
            <button onClick={() => toggleOrder(order.id)} className="flex h-5 w-5 items-center justify-center rounded border border-slate-300 text-[10px] text-emerald-700">
              {selected.has(order.id) ? '✓' : ''}
            </button>
            <div className="font-bold text-slate-800">{order.order_number}</div>
            <div>
              <div className="font-semibold text-slate-700">{order.patient_name || 'No patient'}</div>
              <div className="text-xs text-slate-400">MRN {order.patient_mrn || 'Missing'}</div>
            </div>
            <div className="text-slate-600">{order.order_type || order.document_type || 'No type'}</div>
            <div className="text-slate-600">{formatUiDate(order.order_status?.SentToPhysicianDate)}</div>
            <div className="text-slate-600">{order.agency_name || 'Missing'}</div>
            <div>
              {order.pdf_blob_url ? (
                <a href={order.pdf_blob_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-bold text-slate-600 hover:bg-slate-50">
                  <ExternalLink size={12} /> Open
                </a>
              ) : (
                <span className="text-xs text-slate-400">Missing</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const EPISODE_STATUS_TONES = {
  billable: 'border-green-200 bg-green-100 text-green-700',
  eligible: 'border-sky-200 bg-sky-100 text-sky-700',
  started: 'border-amber-200 bg-amber-50 text-amber-700',
};

function EpisodeStatusPill({ status }) {
  const key = String(status || '').toLowerCase();
  const tone = EPISODE_STATUS_TONES[key] || 'border-slate-200 bg-slate-100 text-slate-500';
  return (
    <span className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tone}`}>
      {key && key !== 'none' ? key : 'no episode'}
    </span>
  );
}

// Patients tab: the PG-scoped mirror of the HHAH portal's patient list + hierarchy
// drilldown (see HhhLogin.jsx). Fetches /api/patients?pgId=<session pgId>.
function PgPatients({ user }) {
  const pgId = user?.pgId || '';
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [selectedTree, setSelectedTree] = useState(null);
  const [treeError, setTreeError] = useState('');

  const refresh = useCallback(async () => {
    if (!pgId) return;
    setLoading(true);
    try {
      setPatients(await fetchPatients({ pgId }));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [pgId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function openPatient(patient) {
    setSelectedPatient(patient);
    setSelectedTree(null);
    setTreeError('');
    try {
      setSelectedTree(await fetchPatientTree(patient.id));
    } catch (err) {
      setTreeError(err.message);
    }
  }

  function backToList() {
    setSelectedPatient(null);
    setSelectedTree(null);
    setTreeError('');
  }

  if (!pgId) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
        No physician group is linked to this account.
      </div>
    );
  }

  return (
    <section className="grid gap-5 lg:grid-cols-[360px_1fr]">
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div>
            <h2 className="font-bold text-slate-900">Patients</h2>
            <p className="text-xs text-slate-500">
              {user?.pgName || 'Your physician group'} · {patients.length} patient{patients.length === 1 ? '' : 's'}
            </p>
          </div>
          <button onClick={refresh} className="rounded-lg p-2 text-slate-400 hover:bg-slate-50 hover:text-slate-700">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        {error && <div className="border-b border-rose-100 bg-rose-50 px-4 py-2 text-sm text-rose-600">{error}</div>}
        <div className="max-h-[640px] space-y-2 overflow-y-auto p-3">
          {loading && patients.length === 0 ? (
            <div className="flex justify-center py-16 text-slate-400"><Loader2 className="animate-spin" /></div>
          ) : patients.length === 0 ? (
            <div className="py-12 text-center text-sm text-slate-400">
              <UserRound size={30} className="mx-auto mb-2 opacity-40" />
              No patients are linked to your physician group yet
            </div>
          ) : patients.map((patient) => (
            <button
              key={patient.id}
              onClick={() => openPatient(patient)}
              className={`w-full rounded-xl border p-3 text-left transition-colors ${selectedPatient?.id === patient.id ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="truncate font-bold text-slate-800">{patient.name}</div>
                <EpisodeStatusPill status={patient.latest_episode_status} />
              </div>
              <div className="mt-0.5 text-xs text-slate-500">DOB {formatUiDate(patient.dob)} | MRN {patient.mrn || 'Missing'}</div>
              <div className="mt-1 text-xs text-slate-400">Agency: {patient.hhah_name || 'Missing'}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-[520px] rounded-2xl border border-slate-200 bg-white p-4">
        {!selectedPatient ? (
          <div className="flex h-full min-h-[460px] items-center justify-center text-center text-slate-400">
            <div>
              <GitBranch size={42} className="mx-auto mb-3 opacity-40" />
              <p className="font-medium">Select a patient to open details.</p>
            </div>
          </div>
        ) : treeError ? (
          <div className="space-y-4">
            <button onClick={backToList} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
              <ArrowLeft size={15} /> Back to patient list
            </button>
            <div className="text-sm text-rose-600">{treeError}</div>
          </div>
        ) : !selectedTree ? (
          <div className="flex h-full min-h-[460px] items-center justify-center text-slate-400">
            <Loader2 size={24} className="animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            <button onClick={backToList} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
              <ArrowLeft size={15} /> Back to patient list
            </button>
            <PatientHierarchyView tree={selectedTree} />
          </div>
        )}
      </div>
    </section>
  );
}

export default function PgLogin() {
  const [user, setUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(() => !!getAuthToken('pg'));
  const [activeTab, setActiveTab] = useState('dashboard');

  // Restore an existing PG session (bearer token in sessionStorage) on mount.
  useEffect(() => {
    if (!getAuthToken('pg')) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await getSession('pg');
        if (cancelled) return;
        if (data.principalType === 'external' && data.user?.userType === 'pg') {
          setUser(data.user);
        } else {
          clearAuthToken('pg');
        }
      } catch {
        if (!cancelled) clearAuthToken('pg');
      } finally {
        if (!cancelled) setCheckingSession(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function signOut() {
    logout('pg').catch(() => {});
    setUser(null);
  }

  if (checkingSession) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Loader2 size={28} className="animate-spin text-slate-400" />
      </div>
    );
  }

  if (!user) return <LoginPanel onLogin={setUser} />;

  const pgId = user?.pgId || '';

  const tabs = [
    { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { key: 'sign', label: 'Bulk Sign', icon: ClipboardSignature },
    { key: 'patients', label: 'Patients', icon: UserRound },
    { key: 'rcm', label: 'RCM Table', icon: FileText },
  ];

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white">
              <Building2 size={20} />
            </div>
            <div>
              <h1 className="font-bold text-slate-900">PG Portal</h1>
              <p className="text-xs text-slate-500">
                {user.pgName || 'Physician group'} · {user.role === 'practitioner' ? 'Physician signing bucket' : 'Admin'}
              </p>
            </div>
            {user.role === 'practitioner' && (
              <span className="ml-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
                <Stethoscope size={13} />
                {user.displayName || user.username}{user.npi ? ` · NPI ${user.npi}` : ''}
              </span>
            )}
          </div>
          <button
            onClick={signOut}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="border-b border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-6">
          <nav className="flex gap-1">
            {tabs.map(({ key, label, icon: Icon }) => (
              <button key={key} onClick={() => setActiveTab(key)}
                className={`flex items-center gap-1.5 border-b-2 px-4 py-3 text-sm font-semibold transition-colors ${activeTab === key ? 'border-violet-600 text-violet-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                <Icon size={15} /> {label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <main className="mx-auto max-w-7xl px-6 py-6">
        {activeTab === 'dashboard' && (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
            <LayoutDashboard size={40} className="mx-auto mb-3 text-slate-300" />
            <h2 className="text-xl font-bold text-slate-700">Dashboard</h2>
            <p className="mt-1 text-sm text-slate-400">Analytics and insights coming soon.</p>
          </div>
        )}
        {activeTab === 'sign' && <BulkSign user={user} />}
        {activeTab === 'patients' && <PgPatients user={user} />}
        {activeTab === 'rcm' && <RcmTable pgId={pgId} />}
      </main>
    </div>
  );
}
