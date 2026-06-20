import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock, FileArchive, FileSpreadsheet, Mail, Play, RefreshCw, Upload, Zap } from 'lucide-react';
import { fetchAreaIntakeStatus, fetchReferenceData, startBulkUploadRun } from '../../lib/workflowApi';

const TRIGGERS = [
  {
    number: 1,
    title: 'Area Upload Monitor',
    description: 'Tracks expected HHAH daily uploads and creates a missing-upload notification task when needed.',
    tone: 'border-violet-200 bg-violet-50 text-violet-700',
    icon: Clock,
  },
  {
    number: 2,
    title: 'HHAH Uploads Documents',
    description: 'Starts patient, admission, episode, and order intake from the Excel workbook and PDF ZIPs.',
    tone: 'border-sky-200 bg-sky-50 text-sky-700',
    icon: Upload,
  },
  {
    number: 3,
    title: 'Send To Physician',
    description: 'Sends ready unsigned order documents to the PG signing bucket.',
    tone: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    icon: Mail,
  },
  {
    number: 4,
    title: 'Make Patients Billable',
    description: 'Every 10 seconds checks eligibility, billability, signatures, and CPO minutes.',
    tone: 'border-amber-200 bg-amber-50 text-amber-700',
    icon: RefreshCw,
  },
];

function TriggerCard({ trigger }) {
  const Icon = trigger.icon;
  return (
    <div className={`rounded-2xl border p-4 ${trigger.tone}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-black uppercase tracking-wide">Trigger {trigger.number}</div>
        <Icon size={18} />
      </div>
      <div className="mt-2 font-bold text-slate-900">{trigger.title}</div>
      <p className="mt-1 text-xs leading-5 text-slate-600">{trigger.description}</p>
    </div>
  );
}

export default function Triggers() {
  const workbookRef = useRef(null);
  const unsignedZipRef = useRef(null);
  const signedZipRef = useRef(null);
  const [workbook, setWorkbook] = useState(null);
  const [unsignedZip, setUnsignedZip] = useState(null);
  const [signedZip, setSignedZip] = useState(null);
  const [hhahs, setHhahs] = useState([]);
  const [selectedHhahId, setSelectedHhahId] = useState('');
  const [areaContext, setAreaContext] = useState(null);
  const [loadingScope, setLoadingScope] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function loadScope() {
      setLoadingScope(true);
      try {
        const [reference, areas] = await Promise.all([
          fetchReferenceData(),
          fetchAreaIntakeStatus().catch(() => []),
        ]);
        if (cancelled) return;
        const nextHhahs = reference.hhahs || [];
        const nextSelectedId = selectedHhahId || nextHhahs[0]?.id || '';
        setHhahs(nextHhahs);
        setSelectedHhahId(nextSelectedId);
        const selectedArea = (areas || []).find((area) => (
          (area.hhahs || []).some((hhah) => hhah.hhah_id === nextSelectedId)
        ));
        setAreaContext(selectedArea ? { id: selectedArea.id, name: selectedArea.name } : null);
        setError('');
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoadingScope(false);
      }
    }
    loadScope();
    return () => { cancelled = true; };
  }, [selectedHhahId]);

  async function fireTrigger(event) {
    event.preventDefault();
    if (!workbook) {
      setError('Select an Excel workbook first.');
      return;
    }
    const selectedHhah = hhahs.find((hhah) => hhah.id === selectedHhahId);
    if (!selectedHhah) {
      setError('Select a Home Health agency first.');
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
        areaId: areaContext?.id,
        hhahId: selectedHhah.id,
        hhahName: selectedHhah.name,
      });
      setMessage(`Trigger fired. ${result.inputSummary?.joinedRows ?? 0} patient/order row(s) entered wf7.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-violet-600 flex items-center justify-center">
          <Zap size={20} className="text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Trigger</h1>
          <p className="text-sm text-slate-500">Start uploads and review the four workflow triggers.</p>
        </div>
      </div>

      <section className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {TRIGGERS.map((trigger) => <TriggerCard key={trigger.number} trigger={trigger} />)}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold text-slate-900">Trigger 2 · Bulk Upload Patient & Order</h2>
              <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-700 border border-sky-100">file upload</span>
            </div>
            <p className="text-sm text-slate-500 mt-1">Upload one Excel workbook plus unsigned/signed order PDF ZIPs. The workflow creates patient, admission, episode, and order records, then routes ready documents to physician signing.</p>
            <p className="mt-2 text-xs font-semibold text-slate-500">
              Scope: {areaContext?.name || 'No area linked'} · {hhahs.find((hhah) => hhah.id === selectedHhahId)?.name || 'Select HHAH'}
            </p>
          </div>
          <div className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-bold text-violet-700">
            <Play size={13} className="inline mr-1" /> File upload trigger
          </div>
        </div>

        <form onSubmit={fireTrigger} className="mt-5 grid lg:grid-cols-[1fr_1fr_1fr_1fr_auto] gap-3 items-end">
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Home Health</span>
            <select
              value={selectedHhahId}
              onChange={(event) => setSelectedHhahId(event.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
            >
              <option value="">{loadingScope ? 'Loading HHAHs...' : 'Select HHAH'}</option>
              {hhahs.map((hhah) => <option key={hhah.id} value={hhah.id}>{hhah.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Patient + order Excel</span>
            <button
              type="button"
              onClick={() => workbookRef.current?.click()}
              className="mt-1 w-full flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left"
            >
              <FileSpreadsheet size={18} className="text-emerald-600" />
              <span className="text-sm text-slate-700 truncate">{workbook?.name || 'Choose .xlsx file'}</span>
            </button>
            <input ref={workbookRef} type="file" accept=".xlsx" className="hidden" onChange={(event) => setWorkbook(event.target.files?.[0] || null)} />
          </label>

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Unsigned order PDFs ZIP</span>
            <button
              type="button"
              onClick={() => unsignedZipRef.current?.click()}
              className="mt-1 w-full flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left"
            >
              <FileArchive size={18} className="text-amber-600" />
              <span className="text-sm text-slate-700 truncate">{unsignedZip?.name || 'Choose .zip file'}</span>
            </button>
            <input ref={unsignedZipRef} type="file" accept=".zip" className="hidden" onChange={(event) => setUnsignedZip(event.target.files?.[0] || null)} />
          </label>

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Signed order PDFs ZIP</span>
            <button
              type="button"
              onClick={() => signedZipRef.current?.click()}
              className="mt-1 w-full flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left"
            >
              <FileArchive size={18} className="text-emerald-600" />
              <span className="text-sm text-slate-700 truncate">{signedZip?.name || 'Choose .zip file'}</span>
            </button>
            <input ref={signedZipRef} type="file" accept=".zip" className="hidden" onChange={(event) => setSignedZip(event.target.files?.[0] || null)} />
          </label>

          <button disabled={uploading} className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-violet-700 disabled:opacity-60">
            {uploading ? <RefreshCw size={16} className="animate-spin" /> : <Upload size={16} />}
            {uploading ? 'Firing' : 'Fire Trigger'}
          </button>
        </form>

        {message && <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"><CheckCircle2 size={15} /> {message}</div>}
        {error && <div className="mt-4 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"><AlertCircle size={15} /> {error}</div>}
      </section>
    </div>
  );
}
