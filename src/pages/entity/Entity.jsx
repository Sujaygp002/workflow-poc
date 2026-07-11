import { useEffect, useMemo, useState } from 'react';
import { Building2, Check, Link2, Loader2, Pencil, Plus, RefreshCw, Stethoscope, UsersRound } from 'lucide-react';
import {
  createAgency,
  createPg,
  createPractitioner,
  fetchReferenceData,
  mapPgToPractitioner,
  updateAgency,
  updatePg,
  updatePractitioner,
} from '../../lib/workflowApi';

function Field({ label, required = false, children }) {
  return (
    <label className="block">
      <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
        {label}
        {required && <span className="text-rose-500"> *</span>}
      </span>
      {children}
    </label>
  );
}

function TextInput({ value, onChange, placeholder = '', required = false }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      required={required}
      className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-300 focus:border-violet-400 focus:outline-none"
    />
  );
}

function CreateButton({ saving, label, icon = null }) {
  return (
    <button
      type="submit"
      disabled={saving}
      className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-sm font-bold text-white hover:bg-violet-700 disabled:opacity-60"
    >
      {saving ? <Loader2 size={15} className="animate-spin" /> : icon || <Plus size={15} />}
      {label}
    </button>
  );
}

function Notice({ message, error }) {
  if (!message && !error) return null;
  return (
    <div className={`mt-2 text-xs ${error ? 'text-rose-600' : 'text-emerald-700'}`}>
      {error || message}
    </div>
  );
}

function EntityCard({ title, icon, count, form, rows, emptyText, renderRow }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
        {icon}
        <h2 className="font-bold text-slate-900">{title}</h2>
        <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{count}</span>
      </div>
      <div className="border-b border-slate-100 bg-slate-50/60 p-4">{form}</div>
      <div className="max-h-[340px] flex-1 divide-y divide-slate-100 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="p-4 text-sm text-slate-400">{emptyText}</div>
        ) : (
          rows.map(renderRow)
        )}
      </div>
    </div>
  );
}

export default function Entity() {
  const [data, setData] = useState({ practitioners: [], physicianGroups: [], hhahs: [] });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  // Agency form (create + edit; agencyEditRow non-null puts the panel into edit mode)
  const [agencyName, setAgencyName] = useState('');
  const [agencyNpi, setAgencyNpi] = useState('');
  const [agencyEmail, setAgencyEmail] = useState('');
  const [agencyPhone, setAgencyPhone] = useState('');
  const [agencyType, setAgencyType] = useState('');
  const [agencyTos, setAgencyTos] = useState('');
  const [agencyEditRow, setAgencyEditRow] = useState(null);
  const [agencySaving, setAgencySaving] = useState(false);
  const [agencyMsg, setAgencyMsg] = useState('');
  const [agencyErr, setAgencyErr] = useState('');

  // PG form
  const [pgName, setPgName] = useState('');
  const [pgNpi, setPgNpi] = useState('');
  const [pgType, setPgType] = useState('');
  const [pgEditRow, setPgEditRow] = useState(null);
  const [pgSaving, setPgSaving] = useState(false);
  const [pgMsg, setPgMsg] = useState('');
  const [pgErr, setPgErr] = useState('');

  // Practitioner form
  const [pracName, setPracName] = useState('');
  const [pracNpi, setPracNpi] = useState('');
  const [pracSpec, setPracSpec] = useState('');
  const [pracEditRow, setPracEditRow] = useState(null);
  const [pracSaving, setPracSaving] = useState(false);
  const [pracMsg, setPracMsg] = useState('');
  const [pracErr, setPracErr] = useState('');

  // Mapping panel
  const [mapPgId, setMapPgId] = useState('');
  const [selectedPracIds, setSelectedPracIds] = useState([]);
  const [mapSaving, setMapSaving] = useState(false);
  const [mapMsg, setMapMsg] = useState('');
  const [mapErr, setMapErr] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      const body = await fetchReferenceData();
      setData({
        practitioners: body.practitioners || [],
        physicianGroups: body.physicianGroups || [],
        hhahs: body.hhahs || [],
      });
      setLoadError('');
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // Optimistically merge a freshly created row (from the POST response) into
  // local state so it is usable immediately (e.g. in the mapping picker) even
  // when the follow-up GET is slow. Prepends, deduped by id.
  function mergeCreated(listKey, row) {
    if (!row?.id) return;
    setData((current) => ({
      ...current,
      [listKey]: [row, ...(current[listKey] || []).filter((entry) => entry.id !== row.id)],
    }));
  }

  const practitionerById = useMemo(
    () => Object.fromEntries(data.practitioners.map((p) => [p.id, p])),
    [data.practitioners],
  );

  const selectedPg = useMemo(
    () => data.physicianGroups.find((pg) => pg.id === mapPgId) || null,
    [data.physicianGroups, mapPgId],
  );

  const mappedIdsForSelectedPg = useMemo(() => {
    const ids = selectedPg?.contact_info?.physician_ids;
    return new Set(Array.isArray(ids) ? ids : []);
  }, [selectedPg]);

  const currentMappings = useMemo(
    () =>
      data.physicianGroups
        .map((pg) => ({
          pg,
          practitioners: (Array.isArray(pg.contact_info?.physician_ids) ? pg.contact_info.physician_ids : [])
            .map((id) => practitionerById[id])
            .filter(Boolean),
        }))
        .filter((entry) => entry.practitioners.length > 0),
    [data.physicianGroups, practitionerById],
  );

  // ── Edit mode: the pencil on a row prefills that card's inline form panel ──
  function resetAgencyForm() {
    setAgencyEditRow(null);
    setAgencyName('');
    setAgencyNpi('');
    setAgencyEmail('');
    setAgencyPhone('');
    setAgencyType('');
    setAgencyTos('');
  }

  function startEditAgency(row) {
    setAgencyEditRow(row);
    setAgencyName(row.name || '');
    setAgencyNpi(row.npi || '');
    setAgencyType(row.type || '');
    setAgencyTos(row.type_of_service || '');
    setAgencyEmail(row.contact_info?.email || '');
    setAgencyPhone(row.contact_info?.phone_number || '');
    setAgencyMsg('');
    setAgencyErr('');
  }

  function cancelEditAgency() {
    resetAgencyForm();
    setAgencyMsg('');
    setAgencyErr('');
  }

  function resetPgForm() {
    setPgEditRow(null);
    setPgName('');
    setPgNpi('');
    setPgType('');
  }

  function startEditPg(row) {
    setPgEditRow(row);
    setPgName(row.name || '');
    setPgNpi(row.npi || '');
    setPgType(row.type || '');
    setPgMsg('');
    setPgErr('');
  }

  function cancelEditPg() {
    resetPgForm();
    setPgMsg('');
    setPgErr('');
  }

  function resetPracForm() {
    setPracEditRow(null);
    setPracName('');
    setPracNpi('');
    setPracSpec('');
  }

  function startEditPractitioner(row) {
    setPracEditRow(row);
    setPracName(row.physician_name || '');
    setPracNpi(row.npi_digits || '');
    setPracSpec(row.speciality || '');
    setPracMsg('');
    setPracErr('');
  }

  function cancelEditPractitioner() {
    resetPracForm();
    setPracMsg('');
    setPracErr('');
  }

  async function submitAgency(event) {
    event.preventDefault();
    const name = agencyName.trim();
    if (!name) {
      setAgencyErr('Agency name is required.');
      setAgencyMsg('');
      return;
    }
    setAgencySaving(true);
    try {
      if (agencyEditRow) {
        // Only send fields that changed against the row being edited.
        const payload = { id: agencyEditRow.id };
        if (name !== (agencyEditRow.name || '')) payload.name = name;
        if (agencyNpi.trim() !== (agencyEditRow.npi || '')) payload.npi = agencyNpi.trim();
        if (agencyType.trim() !== (agencyEditRow.type || '')) payload.type = agencyType.trim();
        if (agencyTos.trim() !== (agencyEditRow.type_of_service || '')) payload.typeOfService = agencyTos.trim();
        const contact = {};
        if (agencyEmail.trim() !== (agencyEditRow.contact_info?.email || '')) contact.email = agencyEmail.trim();
        if (agencyPhone.trim() !== (agencyEditRow.contact_info?.phone_number || '')) contact.phone_number = agencyPhone.trim();
        if (Object.keys(contact).length > 0) payload.contact = contact;
        if (Object.keys(payload).length === 1) {
          setAgencyMsg('No changes to save.');
          setAgencyErr('');
          return;
        }
        const body = await updateAgency(payload);
        mergeCreated('hhahs', body?.agency);
        setAgencyMsg(`Agency "${name}" updated.`);
        setAgencyErr('');
        resetAgencyForm();
        await refresh();
        return;
      }
      const body = await createAgency({
        name,
        npi: agencyNpi.trim(),
        contact: agencyEmail.trim() ? { email: agencyEmail.trim() } : {},
      });
      mergeCreated('hhahs', body?.agency);
      setAgencyMsg(`Agency "${name}" created.`);
      setAgencyErr('');
      resetAgencyForm();
      await refresh();
    } catch (err) {
      setAgencyErr(err.message);
      setAgencyMsg('');
    } finally {
      setAgencySaving(false);
    }
  }

  async function submitPg(event) {
    event.preventDefault();
    const name = pgName.trim();
    if (!name) {
      setPgErr('PG name is required.');
      setPgMsg('');
      return;
    }
    setPgSaving(true);
    try {
      if (pgEditRow) {
        const payload = { id: pgEditRow.id };
        if (name !== (pgEditRow.name || '')) payload.name = name;
        if (pgNpi.trim() !== (pgEditRow.npi || '')) payload.npi = pgNpi.trim();
        if (pgType.trim() !== (pgEditRow.type || '')) payload.type = pgType.trim();
        if (Object.keys(payload).length === 1) {
          setPgMsg('No changes to save.');
          setPgErr('');
          return;
        }
        const body = await updatePg(payload);
        mergeCreated('physicianGroups', body?.pg);
        setPgMsg(`PG "${name}" updated.`);
        setPgErr('');
        resetPgForm();
        await refresh();
        return;
      }
      const body = await createPg({ name, npi: pgNpi.trim() });
      mergeCreated('physicianGroups', body?.pg);
      setPgMsg(`PG "${name}" created.`);
      setPgErr('');
      resetPgForm();
      await refresh();
    } catch (err) {
      setPgErr(err.message);
      setPgMsg('');
    } finally {
      setPgSaving(false);
    }
  }

  async function submitPractitioner(event) {
    event.preventDefault();
    const name = pracName.trim();
    const npiDigits = pracNpi.replace(/\D/g, '');
    if (!name) {
      setPracErr('Practitioner name is required.');
      setPracMsg('');
      return;
    }
    if (!npiDigits) {
      setPracErr('Practitioner NPI is required.');
      setPracMsg('');
      return;
    }
    setPracSaving(true);
    try {
      if (pracEditRow) {
        const payload = { id: pracEditRow.id };
        if (name !== (pracEditRow.physician_name || '')) payload.name = name;
        if (pracNpi.trim() !== (pracEditRow.npi_digits || '')) payload.npi = pracNpi.trim();
        if (pracSpec.trim() !== (pracEditRow.speciality || '')) payload.speciality = pracSpec.trim();
        if (Object.keys(payload).length === 1) {
          setPracMsg('No changes to save.');
          setPracErr('');
          return;
        }
        const body = await updatePractitioner(payload);
        mergeCreated('practitioners', body?.practitioner);
        setPracMsg(`Practitioner "${name}" updated.`);
        setPracErr('');
        resetPracForm();
        await refresh();
        return;
      }
      const body = await createPractitioner({ name, npi: pracNpi.trim() });
      mergeCreated('practitioners', body?.practitioner);
      setPracMsg(`Practitioner "${name}" created.`);
      setPracErr('');
      resetPracForm();
      await refresh();
    } catch (err) {
      setPracErr(err.message);
      setPracMsg('');
    } finally {
      setPracSaving(false);
    }
  }

  function togglePractitioner(id) {
    setSelectedPracIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  function changeMapPg(id) {
    setMapPgId(id);
    setSelectedPracIds([]);
    setMapMsg('');
    setMapErr('');
  }

  async function submitMapping(event) {
    event.preventDefault();
    if (!mapPgId || selectedPracIds.length === 0) {
      setMapErr('Select a PG and at least one practitioner.');
      setMapMsg('');
      return;
    }
    setMapSaving(true);
    setMapErr('');
    setMapMsg('');
    const failures = [];
    let mapped = 0;
    // The API maps one practitioner per call; run the multi-select sequentially.
    for (const practitionerId of selectedPracIds) {
      try {
        await mapPgToPractitioner({ pgId: mapPgId, practitionerId });
        mapped += 1;
      } catch (err) {
        const name = practitionerById[practitionerId]?.physician_name || practitionerId;
        failures.push(`${name}: ${err.message}`);
      }
    }
    if (mapped > 0) {
      setMapMsg(`Mapped ${mapped} practitioner${mapped === 1 ? '' : 's'} to ${selectedPg?.name || 'PG'}.`);
    }
    if (failures.length > 0) setMapErr(failures.join(' · '));
    setSelectedPracIds([]);
    await refresh();
    setMapSaving(false);
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Entity</h1>
          <p className="mt-1 text-sm text-slate-500">
            Create agencies (HHAH), physician groups, and practitioners, then map PGs to practitioners.
          </p>
        </div>
        <button
          onClick={refresh}
          className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {loadError && (
        <div className="mb-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {loadError}
        </div>
      )}

      <div className="mb-5 grid gap-5 xl:grid-cols-3">
        <EntityCard
          title="Agency (HHAH)"
          icon={<Building2 size={17} className="text-emerald-600" />}
          count={data.hhahs.length}
          emptyText="No agencies yet. Create one above."
          rows={data.hhahs}
          renderRow={(row) => (
            <div
              key={row.id}
              className={`flex items-start justify-between gap-2 p-3 text-sm ${agencyEditRow?.id === row.id ? 'bg-violet-50/60' : ''}`}
            >
              <div className="min-w-0">
                <div className="font-bold text-slate-800">{row.name}</div>
                <div className="text-xs text-slate-500">NPI {row.npi || 'Missing'}</div>
                <div className="mt-1 text-xs text-slate-400">
                  {row.contact_info?.email || row.contact_info?.phone_number || 'No contact'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => startEditAgency(row)}
                title="Edit agency"
                className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-violet-50 hover:text-violet-600"
              >
                <Pencil size={14} />
              </button>
            </div>
          )}
          form={
            <form onSubmit={submitAgency} className="space-y-3">
              {agencyEditRow && (
                <div className="flex items-center justify-between text-xs">
                  <span className="truncate font-bold uppercase tracking-wide text-violet-700">
                    Editing {agencyEditRow.name}
                  </span>
                  <button
                    type="button"
                    onClick={cancelEditAgency}
                    className="shrink-0 font-semibold text-slate-500 underline hover:text-slate-800"
                  >
                    Cancel
                  </button>
                </div>
              )}
              <Field label="Agency name" required>
                <TextInput value={agencyName} onChange={setAgencyName} placeholder="Sunrise Home Health" required />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="NPI">
                  <TextInput value={agencyNpi} onChange={setAgencyNpi} placeholder="Optional" />
                </Field>
                <Field label="Contact email">
                  <TextInput value={agencyEmail} onChange={setAgencyEmail} placeholder="Optional" />
                </Field>
              </div>
              {agencyEditRow && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Type">
                      <TextInput value={agencyType} onChange={setAgencyType} placeholder="Optional" />
                    </Field>
                    <Field label="Type of service">
                      <TextInput value={agencyTos} onChange={setAgencyTos} placeholder="Optional" />
                    </Field>
                  </div>
                  <Field label="Contact phone">
                    <TextInput value={agencyPhone} onChange={setAgencyPhone} placeholder="Optional" />
                  </Field>
                </>
              )}
              <CreateButton
                saving={agencySaving}
                label={agencyEditRow ? 'Save changes' : 'Create agency'}
                icon={agencyEditRow ? <Check size={15} /> : null}
              />
              <Notice message={agencyMsg} error={agencyErr} />
            </form>
          }
        />

        <EntityCard
          title="PG"
          icon={<UsersRound size={17} className="text-violet-600" />}
          count={data.physicianGroups.length}
          emptyText="No physician groups yet. Create one above."
          rows={data.physicianGroups}
          renderRow={(row) => {
            const mappedCount = Array.isArray(row.contact_info?.physician_ids)
              ? row.contact_info.physician_ids.length
              : 0;
            return (
              <div
                key={row.id}
                className={`flex items-start justify-between gap-2 p-3 text-sm ${pgEditRow?.id === row.id ? 'bg-violet-50/60' : ''}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1 font-bold text-slate-800">
                    {row.name}
                    {row.raw_data?.source === 'auto_upload' && (
                      <span className="ml-1.5 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-amber-700">Auto</span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">NPI {row.npi || 'Missing'}</div>
                  <div className="mt-1 text-xs text-slate-400">
                    {mappedCount} mapped practitioner{mappedCount === 1 ? '' : 's'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => startEditPg(row)}
                  title="Edit PG"
                  className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-violet-50 hover:text-violet-600"
                >
                  <Pencil size={14} />
                </button>
              </div>
            );
          }}
          form={
            <form onSubmit={submitPg} className="space-y-3">
              {pgEditRow && (
                <div className="flex items-center justify-between text-xs">
                  <span className="truncate font-bold uppercase tracking-wide text-violet-700">
                    Editing {pgEditRow.name}
                  </span>
                  <button
                    type="button"
                    onClick={cancelEditPg}
                    className="shrink-0 font-semibold text-slate-500 underline hover:text-slate-800"
                  >
                    Cancel
                  </button>
                </div>
              )}
              <Field label="PG name" required>
                <TextInput value={pgName} onChange={setPgName} placeholder="Valley Physician Group" required />
              </Field>
              <Field label="NPI">
                <TextInput value={pgNpi} onChange={setPgNpi} placeholder="Optional" />
              </Field>
              {pgEditRow && (
                <Field label="Type">
                  <TextInput value={pgType} onChange={setPgType} placeholder="Optional" />
                </Field>
              )}
              <CreateButton
                saving={pgSaving}
                label={pgEditRow ? 'Save changes' : 'Create PG'}
                icon={pgEditRow ? <Check size={15} /> : null}
              />
              <Notice message={pgMsg} error={pgErr} />
            </form>
          }
        />

        <EntityCard
          title="Practitioner"
          icon={<Stethoscope size={17} className="text-sky-600" />}
          count={data.practitioners.length}
          emptyText="No practitioners yet. Create one above."
          rows={data.practitioners}
          renderRow={(row) => {
            const pgNames = Array.isArray(row.history?.PG_names) ? row.history.PG_names : [];
            return (
              <div
                key={row.id}
                className={`flex items-start justify-between gap-2 p-3 text-sm ${pracEditRow?.id === row.id ? 'bg-violet-50/60' : ''}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1 font-bold text-slate-800">
                    {row.physician_name || 'Unnamed practitioner'}
                    {row.raw_data?.source === 'auto_upload' && (
                      <span className="ml-1.5 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-amber-700">Auto</span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">NPI {row.npi_digits || 'Missing'}</div>
                  {pgNames.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {pgNames.map((pg) => (
                        <span key={pg.id || pg.name} className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] text-violet-700">
                          {pg.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => startEditPractitioner(row)}
                  title="Edit practitioner"
                  className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-violet-50 hover:text-violet-600"
                >
                  <Pencil size={14} />
                </button>
              </div>
            );
          }}
          form={
            <form onSubmit={submitPractitioner} className="space-y-3">
              {pracEditRow && (
                <div className="flex items-center justify-between text-xs">
                  <span className="truncate font-bold uppercase tracking-wide text-violet-700">
                    Editing {pracEditRow.physician_name || 'practitioner'}
                  </span>
                  <button
                    type="button"
                    onClick={cancelEditPractitioner}
                    className="shrink-0 font-semibold text-slate-500 underline hover:text-slate-800"
                  >
                    Cancel
                  </button>
                </div>
              )}
              <Field label="Practitioner name" required>
                <TextInput value={pracName} onChange={setPracName} placeholder="Dr. Kim" required />
              </Field>
              <Field label="NPI" required>
                <TextInput value={pracNpi} onChange={setPracNpi} placeholder="10-digit NPI" required />
              </Field>
              {pracEditRow && (
                <Field label="Speciality">
                  <TextInput value={pracSpec} onChange={setPracSpec} placeholder="Optional" />
                </Field>
              )}
              <CreateButton
                saving={pracSaving}
                label={pracEditRow ? 'Save changes' : 'Create practitioner'}
                icon={pracEditRow ? <Check size={15} /> : null}
              />
              <Notice message={pracMsg} error={pracErr} />
            </form>
          }
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <Link2 size={17} className="text-violet-600" />
          <h2 className="font-bold text-slate-900">PG ↔ Practitioner mapping</h2>
        </div>

        <form onSubmit={submitMapping} className="border-b border-slate-100 bg-slate-50/60 p-4">
          <div className="grid gap-4 lg:grid-cols-[280px_1fr_auto] lg:items-start">
            <Field label="Physician group" required>
              <select
                value={mapPgId}
                onChange={(event) => changeMapPg(event.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-violet-400 focus:outline-none"
              >
                <option value="">Select PG</option>
                {data.physicianGroups.map((pg) => (
                  <option key={pg.id} value={pg.id}>{pg.name}</option>
                ))}
              </select>
            </Field>

            <div>
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
                Practitioners<span className="text-rose-500"> *</span>
              </span>
              {data.practitioners.length === 0 ? (
                <div className="mt-1 rounded-xl border border-dashed border-slate-200 bg-white p-3 text-sm text-slate-400">
                  Create a practitioner first.
                </div>
              ) : (
                <div className="mt-1 grid max-h-48 gap-1 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 sm:grid-cols-2">
                  {data.practitioners.map((practitioner) => {
                    const alreadyMapped = mappedIdsForSelectedPg.has(practitioner.id);
                    const checked = alreadyMapped || selectedPracIds.includes(practitioner.id);
                    return (
                      <label
                        key={practitioner.id}
                        className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                          alreadyMapped ? 'cursor-default bg-slate-50 text-slate-400' : 'cursor-pointer text-slate-700 hover:bg-violet-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={alreadyMapped || !mapPgId}
                          onChange={() => togglePractitioner(practitioner.id)}
                          className="h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-400"
                        />
                        <span className="truncate">
                          {practitioner.physician_name || 'Unnamed practitioner'}
                          <span className="text-xs text-slate-400"> · NPI {practitioner.npi_digits || '—'}</span>
                        </span>
                        {alreadyMapped && (
                          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                            <Check size={10} /> mapped
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
              {!mapPgId && (
                <div className="mt-1 text-xs text-slate-400">Select a PG to enable the practitioner picker.</div>
              )}
            </div>

            <button
              type="submit"
              disabled={mapSaving || !mapPgId || selectedPracIds.length === 0}
              className="mt-5 inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-violet-700 disabled:opacity-60"
            >
              {mapSaving ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />}
              Map selected
            </button>
          </div>
          <Notice message={mapMsg} error={mapErr} />
        </form>

        <div className="p-4">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Current mappings</div>
          {currentMappings.length === 0 ? (
            <div className="text-sm text-slate-400">No PG ↔ practitioner mappings yet.</div>
          ) : (
            <div className="space-y-2">
              {currentMappings.map(({ pg, practitioners }) => (
                <div key={pg.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2">
                  <span className="text-sm font-bold text-slate-800">{pg.name}</span>
                  <span className="text-xs text-slate-400">→</span>
                  {practitioners.map((practitioner) => (
                    <span key={practitioner.id} className="rounded-full bg-sky-50 px-2 py-0.5 text-xs text-sky-700">
                      {practitioner.physician_name || 'Unnamed practitioner'}
                      <span className="text-sky-400"> · {practitioner.npi_digits || '—'}</span>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
