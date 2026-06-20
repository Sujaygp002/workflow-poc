import { useCallback, useEffect, useState } from 'react';
import { Building2, CheckCircle2, ClipboardSignature, ExternalLink, LayoutDashboard, Loader2, Lock, RefreshCw, UserRound } from 'lucide-react';
import { formatUiDate } from '../../lib/dateFormat';
import { bulkSignPgOrders, fetchPgUnsignedOrders, fetchReferenceData } from '../../lib/workflowApi';

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

const PG_SCOPE_KEY = 'pg_selected_pg';

function readSelectedPg() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(PG_SCOPE_KEY) || 'null');
    return parsed?.id && parsed?.name ? parsed : null;
  } catch {
    return null;
  }
}

function LoginPanel({ onLogin }) {
  const [username, setUsername] = useState('test123');
  const [password, setPassword] = useState('test123');
  const [physicianGroups, setPhysicianGroups] = useState([]);
  const [selectedPgId, setSelectedPgId] = useState(() => readSelectedPg()?.id || '');
  const [loadingPgs, setLoadingPgs] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function loadPhysicianGroups() {
      setLoadingPgs(true);
      try {
        const data = await fetchReferenceData();
        if (cancelled) return;
        const groups = data.physicianGroups || [];
        setPhysicianGroups(groups);
        setSelectedPgId((current) => current || groups[0]?.id || '');
        setError('');
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoadingPgs(false);
      }
    }
    loadPhysicianGroups();
    return () => { cancelled = true; };
  }, []);

  function submit(event) {
    event.preventDefault();
    const selected = physicianGroups.find((pg) => pg.id === selectedPgId);
    if (!selected) {
      setError('Select a physician group.');
      return;
    }
    if (username === 'test123' && password === 'test123') {
      setError('');
      onLogin({ id: selected.id, name: selected.name });
      return;
    }
    setError('Invalid username or password.');
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_25%_25%,rgba(14,165,233,0.2),transparent_30%),radial-gradient(circle_at_75%_15%,rgba(16,185,129,0.18),transparent_28%),linear-gradient(135deg,#020617,#0f172a_52%,#111827)]" />
      <form onSubmit={submit} className="relative w-full max-w-md rounded-2xl border border-white/10 bg-white/95 p-6 shadow-2xl">
        <div className="w-12 h-12 rounded-2xl bg-emerald-600 flex items-center justify-center text-white mb-4">
          <Building2 size={24} />
        </div>
        <h1 className="text-2xl font-bold text-slate-900">PG Login</h1>
        <p className="text-sm text-slate-500 mt-1">Sign physician orders and review PG work.</p>
        <div className="mt-6 space-y-3">
          <div>
            <span className="text-xs font-semibold text-slate-500 uppercase">Physician Group</span>
            <div className="mt-1 max-h-36 space-y-2 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-2">
              {loadingPgs ? (
                <div className="px-2 py-3 text-sm text-slate-400">Loading physician groups...</div>
              ) : physicianGroups.length === 0 ? (
                <div className="px-2 py-3 text-sm text-slate-400">No physician groups found.</div>
              ) : physicianGroups.map((pg) => (
                <button
                  key={pg.id}
                  type="button"
                  onClick={() => setSelectedPgId(pg.id)}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${selectedPgId === pg.id ? 'border-emerald-300 bg-white text-emerald-800 shadow-sm' : 'border-transparent bg-transparent text-slate-600 hover:bg-white'}`}
                >
                  <span className="font-semibold">{pg.name}</span>
                  {selectedPgId === pg.id && <CheckCircle2 size={15} />}
                </button>
              ))}
            </div>
          </div>
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
          <button className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-700">
            Login
          </button>
        </div>
      </form>
    </div>
  );
}

function Dashboard() {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-10 min-h-[420px] flex items-center justify-center text-center">
      <div>
        <LayoutDashboard size={42} className="mx-auto mb-3 text-slate-300" />
        <h2 className="text-2xl font-bold text-slate-900">Dashboard</h2>
        <p className="mt-2 text-sm text-slate-500">Coming soon</p>
      </div>
    </section>
  );
}

function BulkSign({ selectedPg }) {
  const pgId = selectedPg?.id || '';
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

  const selectedPgName = selectedPg?.name || 'Selected physician group';

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
                {selectedPgName}
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
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1">{selectedPgName}</span>
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

export default function PgLogin() {
  const [selectedPg, setSelectedPg] = useState(() => readSelectedPg());
  const [loggedIn, setLoggedIn] = useState(() => sessionStorage.getItem('pg_logged_in') === 'true' && !!readSelectedPg());
  const [tab, setTab] = useState('dashboard');

  function login(pg) {
    sessionStorage.setItem(PG_SCOPE_KEY, JSON.stringify(pg));
    sessionStorage.setItem('pg_logged_in', 'true');
    setSelectedPg(pg);
    setLoggedIn(true);
  }

  if (!loggedIn) return <LoginPanel onLogin={login} />;

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
              <p className="text-xs text-slate-500">{selectedPg?.name || 'Practice'} · Physician signing bucket</p>
            </div>
          </div>
          <button
            onClick={() => {
              sessionStorage.removeItem('pg_logged_in');
              sessionStorage.removeItem(PG_SCOPE_KEY);
              setSelectedPg(null);
              setLoggedIn(false);
            }}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <div className="mb-5 inline-flex rounded-xl border border-slate-200 bg-white p-1">
          <button onClick={() => setTab('dashboard')} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold ${tab === 'dashboard' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
            <LayoutDashboard size={15} /> Dashboard
          </button>
          <button onClick={() => setTab('bulk-sign')} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold ${tab === 'bulk-sign' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
            <ClipboardSignature size={15} /> Bulk Sign
          </button>
        </div>
        {tab === 'dashboard' ? <Dashboard /> : <BulkSign selectedPg={selectedPg} />}
      </main>
    </div>
  );
}
