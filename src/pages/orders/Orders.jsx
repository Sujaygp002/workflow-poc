import { useEffect, useState } from 'react';
import { ClipboardList, ExternalLink, FileText, Loader2, RefreshCw } from 'lucide-react';
import { fetchOrders } from '../../lib/workflowApi';

function fmt(value) {
  if (!value) return 'Missing';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
}

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
  const eligible = status === 'eligible' || status === 'billable';
  const billable = status === 'billable';
  return (
    <div className="flex flex-wrap gap-1">
      <StatusChip active={eligible} label="Eligible" inactiveLabel="Not eligible" tone="bg-sky-100 text-sky-700 border-sky-200" />
      <StatusChip active={billable} label="Billable" inactiveLabel="Not billable" tone="bg-green-100 text-green-700 border-green-200" />
    </div>
  );
}

function OrderCard({ order, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-xl border p-3 transition-colors ${selected ? 'border-violet-300 bg-violet-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
    >
      <div className="font-bold text-slate-800">{order.order_number}</div>
      <div className="text-xs text-slate-500 mt-0.5">{order.patient_name || 'No patient'} | {order.order_type || 'No type'}</div>
      <div className="mt-2">
        <EligibilityChips status={order.episode_status} />
      </div>
      <div className="text-[11px] text-slate-400 mt-1">{fmt(order.order_date)}</div>
    </button>
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
        <iframe title={`Order PDF ${order.order_number}`} src={pdfUrl} className="h-[720px] w-full bg-slate-100" />
      ) : (
        <div className="flex h-[420px] items-center justify-center bg-slate-50 text-center text-sm text-slate-400">
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

export default function Orders() {
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      const rows = await fetchOrders();
      setOrders(rows);
      setSelected((current) => rows.find((row) => row.id === current?.id) || rows[0] || null);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Orders</h1>
          <p className="text-sm text-slate-500 mt-1">View uploaded and created order records.</p>
        </div>
        <button onClick={refresh} className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {error && <div className="mb-4 px-4 py-3 rounded-xl border border-rose-200 bg-rose-50 text-sm text-rose-700">{error}</div>}

      <div className="grid lg:grid-cols-[360px_1fr] gap-5">
        <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
            <ClipboardList size={17} className="text-violet-600" />
            <h2 className="font-bold text-slate-900">View Orders</h2>
            <span className="ml-auto text-xs rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">{orders.length}</span>
          </div>
          <div className="p-3 space-y-2 max-h-[650px] overflow-y-auto">
            {loading && orders.length === 0 ? (
              <div className="py-12 flex justify-center text-slate-400"><Loader2 className="animate-spin" /></div>
            ) : orders.length === 0 ? (
              <div className="py-12 text-center text-sm text-slate-400">No orders yet.</div>
            ) : orders.map((order) => (
              <OrderCard key={order.id} order={order} selected={selected?.id === order.id} onClick={() => setSelected(order)} />
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          {!selected ? (
            <div className="min-h-[400px] flex items-center justify-center text-slate-400">Select an order.</div>
          ) : (
            <div className="space-y-5">
              <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4">
                <div className="text-xs font-bold uppercase tracking-wide text-violet-700">Order</div>
                <h2 className="text-2xl font-bold text-slate-900 mt-1">{selected.order_number}</h2>
                <p className="text-sm text-slate-600 mt-1">{selected.order_type || 'No type'} | {fmt(selected.order_date)}</p>
                <div className="mt-3">
                  <EligibilityChips status={selected.episode_status} />
                </div>
              </div>
              <div className="grid md:grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl border border-slate-200 p-3">
                  <div className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-2">Patient</div>
                  <div className="font-bold text-slate-800">{selected.patient_name || 'No patient linked'}</div>
                  <div className="text-slate-500 text-xs mt-1">MRN {selected.patient_mrn || 'Missing'}</div>
                </div>
                <div className="rounded-xl border border-slate-200 p-3">
                  <div className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-2">References</div>
                  <div className="text-slate-700">PG: {selected.pg_name || 'Missing'}</div>
                  <div className="text-slate-700">HHAH: {selected.agency_name || 'Missing'}</div>
                  <div className="text-slate-700">NPI: {selected.billing_provider_npi || 'Missing'}</div>
                </div>
              </div>
              <OrderPdfViewer order={selected} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
