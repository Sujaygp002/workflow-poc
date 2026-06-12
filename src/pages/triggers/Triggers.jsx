import { useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, FileArchive, FileSpreadsheet, Play, RefreshCw, Upload, Zap } from 'lucide-react';
import { startBulkUploadRun } from '../../lib/workflowApi';

const CONDITIONS = [
  'excel_row_complete',
  'excel_row_incomplete',
  'practitioner_not_exists',
  'pg_not_exists',
  'hhah_not_exists',
  'patient_exists',
  'patient_not_exists',
  'order_exists',
  'order_not_exists',
];

function DiamondCondition({ label }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800">
      <span className="inline-flex h-3 w-3 rotate-45 border border-amber-500 bg-white" />
      {label}
    </span>
  );
}

export default function Triggers() {
  const workbookRef = useRef(null);
  const zipRef = useRef(null);
  const [workbook, setWorkbook] = useState(null);
  const [zip, setZip] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function fireTrigger(event) {
    event.preventDefault();
    if (!workbook) {
      setError('Select an Excel workbook first.');
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
          <p className="text-sm text-slate-500">Start the DB-backed bulk upload workflow.</p>
        </div>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold text-slate-900">Bulk Upload Patient & Order</h2>
              <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-700 border border-sky-100">trigger-7</span>
            </div>
            <p className="text-sm text-slate-500 mt-1">Upload one Excel workbook and a ZIP of order PDFs. The workflow loops over every patient/order row.</p>
          </div>
          <div className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-bold text-violet-700">
            <Play size={13} className="inline mr-1" /> File upload trigger
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {CONDITIONS.map((condition) => <DiamondCondition key={condition} label={condition} />)}
        </div>

        <form onSubmit={fireTrigger} className="mt-5 grid lg:grid-cols-[1fr_1fr_auto] gap-3 items-end">
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
            <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Order PDFs ZIP</span>
            <button
              type="button"
              onClick={() => zipRef.current?.click()}
              className="mt-1 w-full flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left"
            >
              <FileArchive size={18} className="text-amber-600" />
              <span className="text-sm text-slate-700 truncate">{zip?.name || 'Choose .zip file'}</span>
            </button>
            <input ref={zipRef} type="file" accept=".zip" className="hidden" onChange={(event) => setZip(event.target.files?.[0] || null)} />
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
