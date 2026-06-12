import { useEffect, useState } from 'react';
import { Building2, Link2, Loader2, RefreshCw, Stethoscope, UsersRound } from 'lucide-react';
import { fetchReferenceData, mapPgToPractitioner } from '../../lib/workflowApi';

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="text-2xl font-bold text-slate-800">{value}</div>
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
    </div>
  );
}

function Panel({ title, icon, rows, render }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
        {icon}
        <h2 className="font-bold text-slate-900">{title}</h2>
        <span className="ml-auto text-xs rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">{rows.length}</span>
      </div>
      <div className="divide-y divide-slate-100 max-h-[520px] overflow-y-auto">
        {rows.length === 0 ? (
          <div className="p-4 text-sm text-slate-400">No records.</div>
        ) : rows.map(render)}
      </div>
    </div>
  );
}

export default function ReferenceData() {
  const [data, setData] = useState({ practitioners: [], physicianGroups: [], hhahs: [] });
  const [pgId, setPgId] = useState('');
  const [practitionerId, setPractitionerId] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      setData(await fetchReferenceData());
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function submitMap(event) {
    event.preventDefault();
    if (!pgId || !practitionerId) {
      setError('Select both a PG and practitioner.');
      return;
    }
    setSaving(true);
    try {
      await mapPgToPractitioner({ pgId, practitionerId });
      setMessage('PG mapped to practitioner.');
      setError('');
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Reference Data</h1>
          <p className="text-sm text-slate-500 mt-1">View HHAH, physician groups, practitioners, and map PG to practitioner.</p>
        </div>
        <button onClick={refresh} className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="grid md:grid-cols-3 gap-3 mb-5">
        <Stat label="Practitioners" value={data.practitioners.length} />
        <Stat label="Physician Groups" value={data.physicianGroups.length} />
        <Stat label="HHAH" value={data.hhahs.length} />
      </div>

      <form onSubmit={submitMap} className="rounded-2xl border border-slate-200 bg-white p-4 mb-5">
        <div className="flex items-center gap-2 mb-3">
          <Link2 size={17} className="text-violet-600" />
          <h2 className="font-bold text-slate-900">Map PG To Practitioner</h2>
        </div>
        <div className="grid md:grid-cols-[1fr_1fr_auto] gap-3 items-end">
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Physician Group</span>
            <select value={pgId} onChange={(event) => setPgId(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
              <option value="">Select PG</option>
              {data.physicianGroups.map((pg) => <option key={pg.id} value={pg.id}>{pg.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Practitioner</span>
            <select value={practitionerId} onChange={(event) => setPractitionerId(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
              <option value="">Select practitioner</option>
              {data.practitioners.map((practitioner) => (
                <option key={practitioner.id} value={practitioner.id}>
                  {practitioner.physician_name || 'Unnamed practitioner'} ({practitioner.npi_digits})
                </option>
              ))}
            </select>
          </label>
          <button disabled={saving} className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-violet-700 disabled:opacity-60">
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />}
            Map
          </button>
        </div>
        {message && <div className="mt-3 text-sm text-emerald-700">{message}</div>}
        {error && <div className="mt-3 text-sm text-rose-600">{error}</div>}
      </form>

      <div className="grid xl:grid-cols-3 gap-5">
        <Panel
          title="Practitioners"
          icon={<Stethoscope size={17} className="text-sky-600" />}
          rows={data.practitioners}
          render={(row) => (
            <div key={row.id} className="p-3 text-sm">
              <div className="font-bold text-slate-800">{row.physician_name || 'Unnamed practitioner'}</div>
              <div className="text-xs text-slate-500">NPI {row.npi_digits || 'Missing'} | {row.speciality || 'No speciality'}</div>
              {(row.history?.PG_names || []).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {row.history.PG_names.map((pg) => <span key={pg.id || pg.name} className="text-[10px] rounded-full bg-violet-50 px-2 py-0.5 text-violet-700">{pg.name}</span>)}
                </div>
              )}
            </div>
          )}
        />
        <Panel
          title="Physician Groups"
          icon={<UsersRound size={17} className="text-violet-600" />}
          rows={data.physicianGroups}
          render={(row) => (
            <div key={row.id} className="p-3 text-sm">
              <div className="font-bold text-slate-800">{row.name}</div>
              <div className="text-xs text-slate-500">NPI {row.npi || 'Missing'} | {row.type || 'No type'}</div>
              <div className="text-xs text-slate-400 mt-1">{(row.contact_info?.physician_ids || []).length} mapped practitioner(s)</div>
            </div>
          )}
        />
        <Panel
          title="HHAH"
          icon={<Building2 size={17} className="text-emerald-600" />}
          rows={data.hhahs}
          render={(row) => (
            <div key={row.id} className="p-3 text-sm">
              <div className="font-bold text-slate-800">{row.name}</div>
              <div className="text-xs text-slate-500">NPI {row.npi || 'Missing'} | {row.type_of_service || row.type || 'No type'}</div>
              <div className="text-xs text-slate-400 mt-1">{row.contact_info?.email || row.contact_info?.phone_number || 'No contact'}</div>
            </div>
          )}
        />
      </div>
    </div>
  );
}
