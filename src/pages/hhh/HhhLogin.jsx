import { useEffect, useState } from 'react';
import { ArrowLeft, BellRing, Building2, CheckCircle2, ChevronRight, ExternalLink, FileArchive, FileSpreadsheet, FileText, GitBranch, Loader2, Lock, RefreshCw, Upload, UserRound } from 'lucide-react';
import { fetchAreaIntakeStatus, fetchOrders, fetchPatientTree, fetchPatients, startBulkUploadRun } from '../../lib/workflowApi';

const DEFAULT_AREA_NAME = 'Boise-Ada Metro Intake';
const DEFAULT_AREA_TYPE = 'metro_statistical_area';
const DEFAULT_HHAH_NAME = 'Boise Home Health';

function formatDate(value) {
  if (!value) return 'Missing';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString();
}

// Computed status: eligible = has 485 + active F2F. Billable = all orders signed.
// Patient status is the latest episode status.
function StatusChip({ active, label, inactiveLabel, tone }) {
  const cls = active
    ? tone
    : 'bg-slate-50 text-slate-400 border-slate-200';
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full border ${cls}`}>
      {active ? label : inactiveLabel}
    </span>
  );
}

function EligibilityChips({ status }) {
  if (!status || status === 'none') {
    return (
      <div className="flex flex-wrap gap-1">
        <StatusChip active={false} label="Eligible" inactiveLabel="Not eligible" tone="bg-sky-100 text-sky-700 border-sky-200" />
        <StatusChip active={false} label="Billable" inactiveLabel="Not billable" tone="bg-green-100 text-green-700 border-green-200" />
      </div>
    );
  }
  const eligible = status === 'eligible' || status === 'billable';
  const billable = status === 'billable';
  return (
    <div className="flex flex-wrap gap-1">
      <StatusChip active={eligible} label="Eligible" inactiveLabel="Not eligible" tone="bg-sky-100 text-sky-700 border-sky-200" />
      <StatusChip active={billable} label="Billable" inactiveLabel="Not billable" tone="bg-green-100 text-green-700 border-green-200" />
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className="text-lg font-bold text-slate-800">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
    </div>
  );
}

function PatientFlow({ tree }) {
  const [openEpisodeId, setOpenEpisodeId] = useState(null);
  const patient = tree?.patient;
  if (!patient) return null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 overflow-x-auto">
      <div className="min-w-[760px]">
        <div className="flex items-center gap-3">
          <div className="w-48 rounded-2xl border-2 border-sky-300 bg-sky-50 p-3">
            <div className="text-[10px] font-bold text-sky-600 uppercase">Patient</div>
            <div className="font-bold text-slate-800 mt-1">{patient.name}</div>
            <div className="text-xs text-slate-500 mt-1">DOB {formatDate(patient.dob)}</div>
            <div className="text-xs text-slate-500">MRN {patient.mrn || 'Missing'}</div>
            <div className="mt-2">
              <EligibilityChips status={patient.latest_episode_status} />
            </div>
          </div>
          <ChevronRight className="text-slate-300 shrink-0" />
          <div className="flex flex-col gap-4">
            {(tree.admissions || []).map((admission) => (
              <div key={admission.id} className="flex items-start gap-3">
                <div className="w-56 rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-3">
                  <div className="text-[10px] font-bold text-emerald-700 uppercase">Admission Object</div>
                  <div className="text-sm font-bold text-slate-800 mt-1">
                    {formatDate(admission.soc)} to {formatDate(admission.eoc)}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">{admission.agency_name || 'No HHAH linked'}</div>
                  <div className="text-xs text-slate-500">{admission.pg_name || 'No PG linked'}</div>
                </div>
                <ChevronRight className="text-slate-300 mt-10 shrink-0" />
                <div className="flex flex-col gap-2">
                  {(admission.episodes || []).map((episode) => {
                    const isOpen = openEpisodeId === episode.id;
                    const orders = episode.orders || [];
                    return (
                      <div key={episode.id} className="flex items-start gap-3">
                        <button
                          type="button"
                          onClick={() => setOpenEpisodeId(isOpen ? null : episode.id)}
                          className={`w-56 text-left rounded-2xl border-2 p-3 transition-colors ${isOpen ? 'border-amber-400 bg-amber-50' : 'border-amber-200 bg-white hover:bg-amber-50'}`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <div className="text-[10px] font-bold text-amber-700 uppercase">Episode Object</div>
                          </div>
                          <div className="text-sm font-bold text-slate-800 mt-1">
                            {formatDate(episode.soe)} to {formatDate(episode.eoe)}
                          </div>
                          <div className="mt-2">
                            <EligibilityChips status={episode.status} />
                          </div>
                          <div className="text-xs text-slate-500 mt-1">{orders.length} order{orders.length === 1 ? '' : 's'}</div>
                        </button>
                        {isOpen && (
                          <>
                            <ChevronRight className="text-slate-300 mt-10 shrink-0" />
                            <div className="grid gap-2">
                              {orders.length === 0 ? (
                                <div className="w-56 rounded-xl border border-dashed border-slate-300 bg-white px-3 py-2 text-xs text-slate-400">
                                  No orders linked to this episode.
                                </div>
                              ) : orders.map((order) => (
                                <div key={order.id} className="w-64 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2">
                                  <div className="text-[10px] font-bold text-violet-700 uppercase">Order</div>
                                  <div className="font-bold text-slate-800">{order.order_number}</div>
                                  <div className="text-xs text-slate-500">{order.order_type || 'No type'} | {formatDate(order.order_date)}</div>
                                  <div className="text-xs text-slate-500">Billing NPI {order.billing_provider_npi || 'Missing'}</div>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                  {(admission.orders || []).length > 0 && (
                    <div className="rounded-xl border border-violet-100 bg-white p-3 text-xs text-slate-500">
                      {admission.orders.length} admission-level order{admission.orders.length === 1 ? '' : 's'}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        {(tree.ordersWithoutEpisode || []).length > 0 && (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            {tree.ordersWithoutEpisode.length} order{tree.ordersWithoutEpisode.length === 1 ? '' : 's'} are linked to the patient but not an episode.
          </div>
        )}
      </div>
    </div>
  );
}

function OrderPdfViewer({ order }) {
  const pdfUrl = order?.pdf_blob_url;
  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-3">
        <FileText size={16} className="text-violet-600" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Order PDF</div>
          <div className="truncate text-sm font-semibold text-slate-800">{order?.pdf_file_name || `${order?.order_number || 'order'}.pdf`}</div>
        </div>
        {pdfUrl && (
          <a href={pdfUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50">
            <ExternalLink size={13} /> Open PDF
          </a>
        )}
      </div>
      {pdfUrl ? (
        <iframe title={`Order PDF ${order.order_number}`} src={pdfUrl} className="h-[680px] w-full bg-slate-100" />
      ) : (
        <div className="flex h-[360px] items-center justify-center bg-slate-50 text-center text-sm text-slate-400">
          <div>
            <FileText size={34} className="mx-auto mb-3 opacity-40" />
            <p className="font-medium text-slate-500">No matched order PDF found.</p>
            <p className="mt-1">Upload a PDF named {order?.order_number || 'ORDER_NUMBER'}.pdf in the order ZIP.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function LoginPanel({ onLogin }) {
  // Demo POC: credentials are preloaded so the user can just click Login.
  const [username, setUsername] = useState('test123');
  const [password, setPassword] = useState('test123');
  const [error, setError] = useState('');

  function submit(event) {
    event.preventDefault();
    if (username === 'test123' && password === 'test123') {
      setError('');
      onLogin();
      return;
    }
    setError('Invalid username or password.');
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(14,165,233,0.24),transparent_32%),radial-gradient(circle_at_80%_10%,rgba(16,185,129,0.2),transparent_30%),linear-gradient(135deg,#020617,#0f172a_48%,#111827)]" />
      <form onSubmit={submit} className="relative w-full max-w-sm rounded-2xl border border-white/10 bg-white/95 p-6 shadow-2xl">
        <div className="w-12 h-12 rounded-2xl bg-sky-600 flex items-center justify-center text-white mb-4">
          <Building2 size={24} />
        </div>
        <h1 className="text-2xl font-bold text-slate-900">HHH Login</h1>
        <p className="text-sm text-slate-500 mt-1">Sign in to upload patient and order batches.</p>
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
          <button className="w-full rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-sky-700">
            Login
          </button>
        </div>
      </form>
    </div>
  );
}

// Notifications pushed to the HHAH from the Area Upload Monitor (Record Notification
// Status step). Shows missing-upload reminders for this HHAH.
function NotificationBanner({ notifications }) {
  if (!notifications.length) return null;
  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-center gap-2">
        <BellRing size={18} className="text-amber-600" />
        <h2 className="text-sm font-black uppercase tracking-wide text-amber-700">
          Notifications ({notifications.length})
        </h2>
      </div>
      <div className="mt-3 space-y-2">
        {notifications.map((n) => (
          <div key={n.id} className="rounded-xl border border-amber-200 bg-white px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-bold text-slate-800">
                {n.message || 'Your documents have not been uploaded yet. Please upload your Excel + PDF ZIP.'}
              </div>
              <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-black uppercase text-amber-700">
                {n.notification_type || 'missing upload'}
              </span>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {n.hhah_name ? `${n.hhah_name} · ` : ''}{n.sent_at ? new Date(n.sent_at).toLocaleString() : 'pending'}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function HhhLogin() {
  const [loggedIn, setLoggedIn] = useState(() => sessionStorage.getItem('hhh_logged_in') === 'true');
  const [workbook, setWorkbook] = useState(null);
  const [unsignedZip, setUnsignedZip] = useState(null);
  const [signedZip, setSignedZip] = useState(null);
  const [patients, setPatients] = useState([]);
  const [orders, setOrders] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [selectedTree, setSelectedTree] = useState(null);
  const [loadingPatients, setLoadingPatients] = useState(false);
  const [viewMode, setViewMode] = useState('patients');
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function refreshPatients() {
    setLoadingPatients(true);
    try {
      const [nextPatients, nextOrders, areas] = await Promise.all([
        fetchPatients(),
        fetchOrders(),
        fetchAreaIntakeStatus().catch(() => []),
      ]);
      setPatients(nextPatients);
      setOrders(nextOrders);
      // Surface notifications addressed to this HHAH login.
      const mine = (areas || [])
        .flatMap((area) => area.notifications || [])
        .filter((n) => !n.hhah_name || n.hhah_name === DEFAULT_HHAH_NAME);
      setNotifications(mine);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingPatients(false);
    }
  }

  useEffect(() => {
    if (loggedIn) refreshPatients();
  }, [loggedIn]);

  // Demo POC: preload the sample-4 artifacts into the upload form so the user can
  // just click Start Upload. Served from /public/sample-4-artifacts.
  useEffect(() => {
    if (!loggedIn) return;
    let cancelled = false;
    async function preloadSamples() {
      const fetchAsFile = async (url, type) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`preload ${url} failed`);
        const blob = await res.blob();
        return new File([blob], url.split('/').pop(), { type });
      };
      try {
        const [xlsx, unsigned, signed] = await Promise.all([
          fetchAsFile('/sample-4-artifacts/hhh_upload_set4.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
          fetchAsFile('/sample-4-artifacts/hhh_order_pdfs_unsigned_set4.zip', 'application/zip'),
          fetchAsFile('/sample-4-artifacts/hhh_order_pdfs_signed_set4.zip', 'application/zip'),
        ]);
        if (cancelled) return;
        setWorkbook((cur) => cur || xlsx);
        setUnsignedZip((cur) => cur || unsigned);
        setSignedZip((cur) => cur || signed);
      } catch {
        // Preload is best-effort; the user can still choose files manually.
      }
    }
    preloadSamples();
    return () => { cancelled = true; };
  }, [loggedIn]);

  async function openPatient(patient) {
    setSelectedPatient(patient);
    setSelectedOrder(null);
    setViewMode('patients');
    setSelectedTree(null);
    try {
      setSelectedTree(await fetchPatientTree(patient.id));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function uploadBatch(event) {
    event.preventDefault();
    if (!workbook) {
      setError('Select one Excel workbook first.');
      return;
    }
    setUploading(true);
    setMessage('');
    setError('');
    try {
      const result = await startBulkUploadRun({
        workbook,
        unsignedZip,
        signedZip,
        sourceLabel: workbook.name,
        areaName: DEFAULT_AREA_NAME,
        areaType: DEFAULT_AREA_TYPE,
        hhahName: DEFAULT_HHAH_NAME,
      });
      setMessage(`Upload started. Joined rows: ${result.inputSummary?.joinedRows ?? 0}.`);
      await refreshPatients();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  function login() {
    sessionStorage.setItem('hhh_logged_in', 'true');
    setLoggedIn(true);
  }

  if (!loggedIn) return <LoginPanel onLogin={login} />;

  const totals = patients.reduce((acc, patient) => ({
    admissions: acc.admissions + Number(patient.admission_count || 0),
    episodes: acc.episodes + Number(patient.episode_count || 0),
    orders: acc.orders + Number(patient.order_count || 0),
  }), { admissions: 0, episodes: 0, orders: 0 });

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-sky-600 flex items-center justify-center text-white">
              <Building2 size={20} />
            </div>
            <div>
              <h1 className="font-bold text-slate-900">HHH Intake</h1>
              <p className="text-xs text-slate-500">Bulk upload and patient review</p>
            </div>
          </div>
          <button
            onClick={() => {
              sessionStorage.removeItem('hhh_logged_in');
              setLoggedIn(false);
            }}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6 space-y-5">
        <NotificationBanner notifications={notifications} />
        <div className="grid md:grid-cols-4 gap-3">
          <Metric label="Patients" value={patients.length} />
          <Metric label="Admissions" value={totals.admissions} />
          <Metric label="Episodes" value={totals.episodes} />
          <Metric label="Orders" value={orders.length || totals.orders} />
        </div>

        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Bulk Upload</h2>
            <p className="text-sm text-slate-500 mt-1">Upload one Excel workbook plus two order PDF ZIPs — unsigned (to be signed) and signed. Each PDF filename is its order number; an order number appears in only one ZIP.</p>
          </div>
          <form onSubmit={uploadBatch} className="mt-4 grid lg:grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end">
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Patient + order Excel</span>
              <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <FileSpreadsheet size={18} className="text-emerald-600" />
                <input type="file" accept=".xlsx" onChange={(event) => setWorkbook(event.target.files?.[0] || null)} className="w-full text-sm" />
              </div>
              {workbook && <div className="mt-1 truncate text-[11px] font-semibold text-emerald-700">✓ {workbook.name}</div>}
            </label>
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Unsigned order PDFs ZIP</span>
              <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <FileArchive size={18} className="text-amber-600" />
                <input type="file" accept=".zip" onChange={(event) => setUnsignedZip(event.target.files?.[0] || null)} className="w-full text-sm" />
              </div>
              {unsignedZip && <div className="mt-1 truncate text-[11px] font-semibold text-amber-700">✓ {unsignedZip.name}</div>}
            </label>
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Signed order PDFs ZIP</span>
              <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <FileArchive size={18} className="text-emerald-600" />
                <input type="file" accept=".zip" onChange={(event) => setSignedZip(event.target.files?.[0] || null)} className="w-full text-sm" />
              </div>
              {signedZip && <div className="mt-1 truncate text-[11px] font-semibold text-emerald-700">✓ {signedZip.name}</div>}
            </label>
            <button disabled={uploading} className="inline-flex items-center justify-center gap-2 rounded-xl bg-sky-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-sky-700 disabled:opacity-60">
              {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
              {uploading ? 'Uploading' : 'Start Upload'}
            </button>
          </form>
          {message && <div className="mt-3 flex items-center gap-2 text-sm text-emerald-700"><CheckCircle2 size={15} /> {message}</div>}
          {error && <div className="mt-3 text-sm text-rose-600">{error}</div>}
        </section>

        <section className="grid lg:grid-cols-[360px_1fr] gap-5">
          <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h2 className="font-bold text-slate-900">{viewMode === 'patients' ? 'View Patients' : 'View Orders'}</h2>
                <p className="text-xs text-slate-500">{viewMode === 'patients' ? 'Open a patient to inspect admissions, episodes, and orders.' : 'Open an order to inspect patient and reference links.'}</p>
              </div>
              <button onClick={refreshPatients} className="p-2 rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-700">
                <RefreshCw size={16} className={loadingPatients ? 'animate-spin' : ''} />
              </button>
            </div>
            <div className="px-3 py-2 border-b border-slate-100 flex gap-1 bg-slate-50">
              <button onClick={() => setViewMode('patients')} className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-semibold ${viewMode === 'patients' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>
                Patients
              </button>
              <button onClick={() => setViewMode('orders')} className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-semibold ${viewMode === 'orders' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>
                Orders
              </button>
            </div>
            <div className="max-h-[640px] overflow-y-auto p-3 space-y-2">
              {viewMode === 'patients' && patients.length === 0 ? (
                <div className="py-12 text-center text-sm text-slate-400">
                  <GitBranch size={30} className="mx-auto mb-2 opacity-40" />
                  No patients yet.
                </div>
              ) : viewMode === 'patients' ? patients.map((patient) => (
                <button
                  key={patient.id}
                  onClick={() => openPatient(patient)}
                  className={`w-full text-left rounded-xl border p-3 transition-colors ${selectedPatient?.id === patient.id ? 'border-sky-300 bg-sky-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-bold text-slate-800">{patient.name}</div>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">DOB {formatDate(patient.dob)} | MRN {patient.mrn || 'Missing'}</div>
                  <div className="mt-2">
                    <EligibilityChips status={patient.latest_episode_status} />
                  </div>
                  <div className="flex gap-2 mt-2 text-[11px] text-slate-500">
                    <span>{patient.admission_count} adm</span>
                    <span>{patient.episode_count} ep</span>
                    <span>{patient.order_count} orders</span>
                    <span className="ml-auto font-bold text-sky-700">Open patient</span>
                  </div>
                </button>
              )) : orders.length === 0 ? (
                <div className="py-12 text-center text-sm text-slate-400">
                  <GitBranch size={30} className="mx-auto mb-2 opacity-40" />
                  No orders yet.
                </div>
              ) : orders.map((order) => (
                <button
                  key={order.id}
                  onClick={() => {
                    setSelectedOrder(order);
                    setSelectedPatient(null);
                    setSelectedTree(null);
                  }}
                  className={`w-full text-left rounded-xl border p-3 transition-colors ${selectedOrder?.id === order.id ? 'border-violet-300 bg-violet-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
                >
                  <div className="font-bold text-slate-800">{order.order_number}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{order.patient_name || 'No patient'} | {order.order_type || 'No type'}</div>
                  <div className="mt-2">
                    <EligibilityChips status={order.episode_status} />
                  </div>
                  <div className="flex gap-2 mt-2 text-[11px] text-slate-500">
                    <span>{formatDate(order.order_date)}</span>
                    <span className="ml-auto font-bold text-violet-700">Open order</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 min-h-[520px]">
            {selectedOrder ? (
              <div className="space-y-4">
                <button onClick={() => setSelectedOrder(null)} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
                  <ArrowLeft size={15} /> Back to order list
                </button>
                <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4">
                  <div className="text-xs font-bold uppercase tracking-wide text-violet-700">Order</div>
                  <h2 className="text-2xl font-bold text-slate-900 mt-1">{selectedOrder.order_number}</h2>
                  <p className="text-sm text-slate-600 mt-1">{selectedOrder.order_type || 'No type'} | {formatDate(selectedOrder.order_date)}</p>
                  <div className="mt-3">
                    <EligibilityChips status={selectedOrder.episode_status} />
                  </div>
                </div>
                <div className="grid md:grid-cols-2 gap-3 text-sm">
                  <div className="rounded-xl border border-slate-200 p-3">
                    <div className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-2">Patient</div>
                    <div className="font-bold text-slate-800">{selectedOrder.patient_name || 'No patient linked'}</div>
                    <div className="text-slate-500 text-xs mt-1">MRN {selectedOrder.patient_mrn || 'Missing'}</div>
                  </div>
                  <div className="rounded-xl border border-slate-200 p-3">
                    <div className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-2">References</div>
                    <div className="text-slate-700">PG: {selectedOrder.pg_name || 'Missing'}</div>
                    <div className="text-slate-700">HHAH: {selectedOrder.agency_name || 'Missing'}</div>
                    <div className="text-slate-700">NPI: {selectedOrder.billing_provider_npi || 'Missing'}</div>
                  </div>
                </div>
                <OrderPdfViewer order={selectedOrder} />
              </div>
            ) : !selectedPatient ? (
              <div className="h-full min-h-[460px] flex items-center justify-center text-center text-slate-400">
                <div>
                  <GitBranch size={42} className="mx-auto mb-3 opacity-40" />
                  <p className="font-medium">Select a patient or order to open details.</p>
                </div>
              </div>
            ) : !selectedTree ? (
              <div className="h-full min-h-[460px] flex items-center justify-center text-slate-400">
                <Loader2 size={24} className="animate-spin" />
              </div>
            ) : (
              <div className="space-y-4">
                <button onClick={() => { setSelectedPatient(null); setSelectedTree(null); }} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
                  <ArrowLeft size={15} /> Back to patient list
                </button>
                <PatientFlow tree={selectedTree} />
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
