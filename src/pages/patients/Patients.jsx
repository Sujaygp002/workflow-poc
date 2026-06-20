import { useEffect, useState } from 'react';
import { Archive, GitBranch, Loader2, RefreshCw, UserRound } from 'lucide-react';
import PatientHierarchyView from '../../components/PatientHierarchyView';
import { formatUiDate } from '../../lib/dateFormat';
import { fetchPatientTree, fetchPatientUnits } from '../../lib/workflowApi';

function Metric({ label, value }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className="text-lg font-black text-slate-900">{value}</div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
    </div>
  );
}

function UnitCard({ unit, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!unit.current_patient_id}
      className={`w-full rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${selected ? 'border-sky-300 bg-sky-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-black text-slate-900">{unit.name || 'Unnamed patient'}</div>
          <div className="mt-0.5 text-xs text-slate-500">DOB {formatUiDate(unit.dob)} | MRN {unit.mrn || 'Missing'}</div>
        </div>
        <span className="shrink-0 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-black uppercase text-sky-700">
          unit
        </span>
      </div>
      <div className="mt-2 text-xs text-slate-500">
        HHAH {unit.current_hhah_name || 'Missing'} | PG {unit.current_pg_name || 'Missing'}
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
        <span>{unit.patient_record_count || 0} records</span>
        <span>{unit.admission_count || 0} adm</span>
        <span>{unit.episode_count || 0} ep</span>
        <span>{unit.order_count || 0} orders</span>
      </div>
      {(unit.archived_patient_record_count || 0) > 0 && (
        <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-black uppercase text-slate-500">
          <Archive size={11} /> {unit.archived_patient_record_count} archived record{unit.archived_patient_record_count === 1 ? '' : 's'}
        </div>
      )}
    </button>
  );
}

export default function Patients() {
  const [units, setUnits] = useState([]);
  const [selectedUnit, setSelectedUnit] = useState(null);
  const [tree, setTree] = useState(null);
  const [loadingUnits, setLoadingUnits] = useState(false);
  const [loadingTree, setLoadingTree] = useState(false);
  const [error, setError] = useState('');

  async function openUnit(unit) {
    if (!unit?.current_patient_id) return;
    setSelectedUnit(unit);
    setTree(null);
    setLoadingTree(true);
    try {
      setTree(await fetchPatientTree(unit.current_patient_id));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingTree(false);
    }
  }

  async function refresh() {
    setLoadingUnits(true);
    try {
      const nextUnits = await fetchPatientUnits();
      setUnits(nextUnits);
      const nextSelected = selectedUnit
        ? nextUnits.find((unit) => unit.patient_unit_id === selectedUnit.patient_unit_id)
        : nextUnits[0];
      if (nextSelected) await openUnit(nextSelected);
      else {
        setSelectedUnit(null);
        setTree(null);
      }
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingUnits(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function loadInitial() {
      setLoadingUnits(true);
      try {
        const nextUnits = await fetchPatientUnits();
        if (cancelled) return;
        setUnits(nextUnits);
        const firstUnit = nextUnits[0];
        if (firstUnit?.current_patient_id) {
          setSelectedUnit(firstUnit);
          setLoadingTree(true);
          try {
            const nextTree = await fetchPatientTree(firstUnit.current_patient_id);
            if (!cancelled) setTree(nextTree);
          } finally {
            if (!cancelled) setLoadingTree(false);
          }
        }
        setError('');
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoadingUnits(false);
      }
    }
    loadInitial();
    return () => { cancelled = true; };
  }, []);

  const totals = units.reduce((acc, unit) => ({
    records: acc.records + Number(unit.patient_record_count || 0),
    admissions: acc.admissions + Number(unit.admission_count || 0),
    episodes: acc.episodes + Number(unit.episode_count || 0),
    orders: acc.orders + Number(unit.order_count || 0),
  }), { records: 0, admissions: 0, episodes: 0, orders: 0 });

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-slate-900">Patients</h1>
          <p className="mt-1 text-sm text-slate-500">Patient Unit hierarchy with admission-based archive grouping.</p>
        </div>
        <button onClick={refresh} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">
          <RefreshCw size={14} className={loadingUnits ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {error && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}

      <div className="mb-5 grid gap-3 md:grid-cols-4">
        <Metric label="Patient Units" value={units.length} />
        <Metric label="Patient Records" value={totals.records} />
        <Metric label="Admissions" value={totals.admissions} />
        <Metric label="Orders" value={totals.orders} />
      </div>

      <section className="grid gap-5 xl:grid-cols-[380px_1fr]">
        <div className="rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
            <UserRound size={17} className="text-sky-600" />
            <div>
              <h2 className="font-black text-slate-900">Patient Units</h2>
              <p className="text-xs text-slate-500">Stable identity grouped by name, DOB, and MRN.</p>
            </div>
          </div>
          <div className="max-h-[760px] space-y-2 overflow-y-auto p-3">
            {loadingUnits && units.length === 0 ? (
              <div className="flex justify-center py-12 text-slate-400"><Loader2 className="animate-spin" /></div>
            ) : units.length === 0 ? (
              <div className="py-12 text-center text-sm text-slate-400">
                <GitBranch size={30} className="mx-auto mb-2 opacity-40" />
                No patient units yet.
              </div>
            ) : units.map((unit) => (
              <UnitCard
                key={unit.patient_unit_id}
                unit={unit}
                selected={selectedUnit?.patient_unit_id === unit.patient_unit_id}
                onClick={() => openUnit(unit)}
              />
            ))}
          </div>
        </div>

        <div className="min-h-[640px] rounded-xl border border-slate-200 bg-white p-4">
          {loadingTree ? (
            <div className="flex min-h-[520px] items-center justify-center text-slate-400">
              <Loader2 size={24} className="animate-spin" />
            </div>
          ) : tree ? (
            <PatientHierarchyView tree={tree} />
          ) : (
            <div className="flex min-h-[520px] items-center justify-center text-center text-slate-400">
              <div>
                <GitBranch size={42} className="mx-auto mb-3 opacity-40" />
                <p className="font-medium">Select a patient unit to open the archive hierarchy.</p>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
