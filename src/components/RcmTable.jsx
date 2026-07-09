import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchRcmBilling, fetchRcmPatients } from '../lib/workflowApi';
import { formatUiDate } from '../lib/dateFormat';

const LIMITS = [10, 25, 50];

function Paginator({ page, total, limit, onPage, onLimit }) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center gap-2">
        <select
          value={limit}
          onChange={(e) => { onLimit(Number(e.target.value)); onPage(1); }}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600"
        >
          {LIMITS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <span className="text-xs text-slate-500">rows per page · {total} total</span>
      </div>
      <div className="flex items-center gap-1">
        <button onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1}
          className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-40">
          <ChevronLeft size={14} />
        </button>
        {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
          const p = Math.max(1, Math.min(totalPages - 4, page - 2)) + i;
          return p <= totalPages ? (
            <button key={p} onClick={() => onPage(p)}
              className={`min-w-[28px] rounded-lg border px-2 py-1 text-xs font-bold ${p === page ? 'border-violet-500 bg-violet-50 text-violet-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
              {p}
            </button>
          ) : null;
        })}
        <button onClick={() => onPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages}
          className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-40">
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

function SkeletonRow({ cols }) {
  return (
    <tr>{Array.from({ length: cols }, (_, i) => (
      <td key={i} className="px-3 py-2.5"><div className="h-3 rounded bg-slate-100 animate-pulse" /></td>
    ))}</tr>
  );
}

const PATIENT_COLS = [
  { key: 'line', label: 'Line', render: (v) => v },
  { key: 'patient_name', label: 'Patient Name', render: (v) => v },
  { key: 'account_no', label: 'Patient A/C No', render: (v) => v },
  { key: 'dob', label: 'DOB', render: (v) => formatUiDate(v) },
  { key: 'sex', label: 'Gender', render: (v) => v },
  { key: 'address', label: 'Patient Address', render: (v) => v },
  { key: 'city', label: 'Patient City', render: (v) => v },
  { key: 'state', label: 'Patient State', render: (v) => v },
  { key: 'zip', label: 'Zip', render: (v) => v },
  { key: 'insurance_company', label: 'Insurance Company', render: (v) => v },
  { key: 'insurance_id', label: 'Insurance Id', render: (v) => v },
  { key: 'agency_name', label: 'Agency', render: (v) => v },
  { key: 'agency_npi', label: 'Agency NPI', render: (v) => v },
  { key: 'diagnosis_1', label: '1st Diagnosis', render: (v) => v },
  { key: 'diagnosis_2', label: '2nd Diagnosis', render: (v) => v },
  { key: 'diagnosis_3', label: '3rd Diagnosis', render: (v) => v },
  { key: 'diagnosis_4', label: '4th Diagnosis', render: (v) => v },
  { key: 'diagnosis_5', label: '5th Diagnosis', render: (v) => v },
  { key: 'diagnosis_6', label: '6th Diagnosis', render: (v) => v },
  { key: 'soc', label: 'SOC', render: (v) => formatUiDate(v) },
  { key: 'soe', label: 'SOE', render: (v) => formatUiDate(v) },
  { key: 'eoe', label: 'EOE', render: (v) => formatUiDate(v) },
];

const BILLING_COLS = [
  { key: 'patient_name', label: 'Patient Name', render: (v) => v },
  { key: 'soe', label: 'SOE', render: (v) => formatUiDate(v) },
  { key: 'eoe', label: 'EOE', render: (v) => formatUiDate(v) },
  { key: 'dos_from', label: 'Line1 DOS From', render: (v) => formatUiDate(v) },
  { key: 'dos_to', label: 'Line1 DOS To', render: (v) => formatUiDate(v) },
  { key: 'cpt_code', label: 'Line1 CPT Code', render: (v) => v },
  { key: 'pos', label: 'Line1 POS', render: (v) => v },
  { key: 'units', label: 'AnsLine1 Units', render: (v) => v },
  { key: 'charges', label: 'Line 1 CPT Charges', render: (v) => v != null ? `${Number(v).toFixed(2)}` : '' },
  { key: 'certification_provider', label: 'Certification Provider', render: (v) => v },
  { key: 'billing_provider_npi', label: 'Billing Provider NPI', render: (v) => v },
  { key: 'supervising_provider', label: 'Supervising Provider', render: (v) => v },
  { key: 'supervising_provider_npi', label: 'Supervising Provider NPI', render: (v) => v },
  { key: 'rendering_provider', label: 'Rendering Provider', render: (v) => v },
  { key: 'rendering_provider_npi', label: 'Rendering Provider NPI', render: (v) => v },
  { key: 'comment_count', label: 'Comments', render: (v) => v != null ? `${v} note${v === 1 ? '' : 's'}` : '' },
  { key: 'audit_status', label: 'Audit Status', render: (v) => v },
  { key: 'audit_date', label: 'Audit Date', render: (v) => formatUiDate(v) },
];

export default function RcmTable({ hhahId, pgId }) {
  const [activeView, setActiveView] = useState('patient');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!hhahId && !pgId) return;
    setLoading(true);
    setError('');
    try {
      const result = activeView === 'patient'
        ? await fetchRcmPatients({ hhahId, pgId, page, limit })
        : await fetchRcmBilling({ hhahId, pgId, page, limit });
      setData(result);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [hhahId, pgId, activeView, page, limit]);

  useEffect(() => { load(); }, [load]);

  const cols = activeView === 'patient' ? PATIENT_COLS : BILLING_COLS;
  const rows = activeView === 'patient' ? (data?.patients || []) : (data?.records || []);
  const total = data?.total || 0;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      {/* view tabs */}
      <div className="flex border-b border-slate-200 bg-slate-50 px-4 pt-3 gap-1">
        {[{ key: 'patient', label: 'Patient Info' }, { key: 'billing', label: 'Billing Details' }].map(({ key, label }) => (
          <button key={key} onClick={() => { setActiveView(key); setPage(1); setData(null); }}
            className={`px-4 py-2 text-xs font-bold rounded-t-lg border-b-2 transition-colors ${activeView === key ? 'border-violet-600 text-violet-700 bg-white' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              {cols.map((c) => (
                <th key={c.key} className="whitespace-nowrap px-3 py-2.5 text-left text-[10px] font-black uppercase tracking-wide text-slate-500">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading
              ? Array.from({ length: limit }, (_, i) => <SkeletonRow key={i} cols={cols.length} />)
              : rows.length === 0
                ? (
                  <tr><td colSpan={cols.length} className="py-12 text-center text-sm text-slate-400">
                    {error || (hhahId || pgId ? 'No RCM records found.' : 'No agency selected.')}
                  </td></tr>
                )
                : rows.map((row, i) => (
                  <tr key={i} className="hover:bg-slate-50">
                    {cols.map((c) => (
                      <td key={c.key} className="max-w-[160px] truncate whitespace-nowrap px-3 py-2.5 text-slate-700" title={String(row[c.key] ?? '')}>
                        {c.render(row[c.key])}
                      </td>
                    ))}
                  </tr>
                ))
            }
          </tbody>
        </table>
      </div>

      {/* paginator */}
      <Paginator page={page} total={total} limit={limit} onPage={setPage} onLimit={setLimit} />
    </div>
  );
}
