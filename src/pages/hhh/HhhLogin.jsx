import { useEffect, useState } from 'react';
import { Activity, ArrowLeft, Building2, CheckCircle2, ChevronRight, FileArchive, FileSpreadsheet, GitBranch, Loader2, Lock, RefreshCw, Upload, UserRound } from 'lucide-react';
import { fetchPatientTree, fetchPatients, startBulkUploadRun } from '../../lib/workflowApi';

function formatDate(value) {
  if (!value) return 'Missing';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString();
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
          </div>
          <ChevronRight className="text-slate-300 shrink-0" />
          <div className="flex flex-col gap-4">
            {(tree.admissions || []).map((admission) => (
              <div key={admission.id} className="flex items-start gap-3">
                <div className="w-56 rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-3">
                  <div className="text-[10px] font-bold text-emerald-700 uppercase">Admission</div>
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
                          <div className="text-[10px] font-bold text-amber-700 uppercase">Episode</div>
                          <div className="text-sm font-bold text-slate-800 mt-1">
                            {formatDate(episode.soe)} to {formatDate(episode.eoe)}
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

function LoginPanel({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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

export default function HhhLogin() {
  const [loggedIn, setLoggedIn] = useState(() => sessionStorage.getItem('hhh_logged_in') === 'true');
  const [workbook, setWorkbook] = useState(null);
  const [zip, setZip] = useState(null);
  const [patients, setPatients] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [selectedTree, setSelectedTree] = useState(null);
  const [loadingPatients, setLoadingPatients] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function refreshPatients() {
    setLoadingPatients(true);
    try {
      setPatients(await fetchPatients());
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

  async function openPatient(patient) {
    setSelectedPatient(patient);
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
        orderZip: zip,
        sourceLabel: workbook.name,
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
        <div className="grid md:grid-cols-4 gap-3">
          <Metric label="Patients" value={patients.length} />
          <Metric label="Admissions" value={totals.admissions} />
          <Metric label="Episodes" value={totals.episodes} />
          <Metric label="Orders" value={totals.orders} />
        </div>

        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Bulk Upload</h2>
              <p className="text-sm text-slate-500 mt-1">Upload one Excel workbook. Put order PDFs in a ZIP where each PDF filename is the order number.</p>
            </div>
            <a href="/worker" className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">
              <Activity size={15} /> Worker buckets
            </a>
          </div>
          <form onSubmit={uploadBatch} className="mt-4 grid lg:grid-cols-[1fr_1fr_auto] gap-3 items-end">
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Patient + order Excel</span>
              <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <FileSpreadsheet size={18} className="text-emerald-600" />
                <input type="file" accept=".xlsx" onChange={(event) => setWorkbook(event.target.files?.[0] || null)} className="w-full text-sm" />
              </div>
            </label>
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Order PDFs ZIP</span>
              <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <FileArchive size={18} className="text-amber-600" />
                <input type="file" accept=".zip" onChange={(event) => setZip(event.target.files?.[0] || null)} className="w-full text-sm" />
              </div>
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
                <h2 className="font-bold text-slate-900">View Patients</h2>
                <p className="text-xs text-slate-500">Open a patient to inspect admissions, episodes, and orders.</p>
              </div>
              <button onClick={refreshPatients} className="p-2 rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-700">
                <RefreshCw size={16} className={loadingPatients ? 'animate-spin' : ''} />
              </button>
            </div>
            <div className="max-h-[640px] overflow-y-auto p-3 space-y-2">
              {patients.length === 0 ? (
                <div className="py-12 text-center text-sm text-slate-400">
                  <GitBranch size={30} className="mx-auto mb-2 opacity-40" />
                  No patients yet.
                </div>
              ) : patients.map((patient) => (
                <button
                  key={patient.id}
                  onClick={() => openPatient(patient)}
                  className={`w-full text-left rounded-xl border p-3 transition-colors ${selectedPatient?.id === patient.id ? 'border-sky-300 bg-sky-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
                >
                  <div className="font-bold text-slate-800">{patient.name}</div>
                  <div className="text-xs text-slate-500 mt-0.5">DOB {formatDate(patient.dob)} | MRN {patient.mrn || 'Missing'}</div>
                  <div className="flex gap-2 mt-2 text-[11px] text-slate-500">
                    <span>{patient.admission_count} adm</span>
                    <span>{patient.episode_count} ep</span>
                    <span>{patient.order_count} orders</span>
                    <span className="ml-auto font-bold text-sky-700">Open patient</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 min-h-[520px]">
            {!selectedPatient ? (
              <div className="h-full min-h-[460px] flex items-center justify-center text-center text-slate-400">
                <div>
                  <GitBranch size={42} className="mx-auto mb-3 opacity-40" />
                  <p className="font-medium">Select a patient to open the flow chart.</p>
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
