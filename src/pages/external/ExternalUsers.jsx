import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Ban,
  Building2,
  Globe,
  KeyRound,
  Loader2,
  Power,
  RefreshCw,
  Stethoscope,
  UserPlus,
  UsersRound,
  X,
} from 'lucide-react';
import { createExternalUser, listExternalUsers, updateExternalUser } from '../../lib/authApi';
import { fetchReferenceData } from '../../lib/workflowApi';
import { formatUiDate } from '../../lib/dateFormat';

const MIN_PASSWORD = 8;

// Mirrors the server's normalizeNpi (api/_lib/normalizers.js): digits only.
function npiDigitsOf(value) {
  return String(value || '').replace(/\D/g, '');
}

const inputClass =
  'mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-violet-200';

function Field({ label, children, hint }) {
  return (
    <label className="block">
      <span className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

function RadioPill({ checked, onChange, name, children }) {
  return (
    <label
      className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm font-bold transition-colors ${
        checked
          ? 'border-violet-300 bg-violet-50 text-violet-700'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
      }`}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} className="accent-violet-600" />
      {children}
    </label>
  );
}

function TypeBadge({ user }) {
  if (user.user_type === 'hhah') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">
        <Building2 size={11} /> HHAH
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-bold text-violet-700">
      <UsersRound size={11} /> PG
    </span>
  );
}

function RoleBadge({ user }) {
  if (user.role === 'practitioner') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-bold text-sky-700">
        <Stethoscope size={11} /> Practitioner
      </span>
    );
  }
  return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">Admin</span>;
}

// ── Create external user card ────────────────────────────────────────────────
function CreateExternalUserCard({ reference, onCreated }) {
  const [userType, setUserType] = useState('hhah');
  const [agencyId, setAgencyId] = useState('');
  const [pgId, setPgId] = useState('');
  const [role, setRole] = useState('admin');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [npi, setNpi] = useState('');
  const [practitionerId, setPractitionerId] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const agencies = reference.hhahs || [];
  const physicianGroups = reference.physicianGroups || [];

  const isPractitioner = userType === 'pg' && role === 'practitioner';
  const npiDigits = npiDigitsOf(npi);

  // Mapping select is filtered to Entity practitioners whose NPI matches the typed NPI.
  const matchingPractitioners = useMemo(() => {
    if (!npiDigits) return [];
    return (reference.practitioners || []).filter((p) => p.npi_digits === npiDigits);
  }, [reference.practitioners, npiDigits]);

  // Auto-select when the typed NPI narrows the mapping to exactly one practitioner;
  // clear a selection that no longer matches the NPI.
  useEffect(() => {
    if (!isPractitioner) return;
    if (matchingPractitioners.length === 1) {
      setPractitionerId(matchingPractitioners[0].id);
    } else if (practitionerId && !matchingPractitioners.some((p) => p.id === practitionerId)) {
      setPractitionerId('');
    }
  }, [isPractitioner, matchingPractitioners, practitionerId]);

  async function submit(event) {
    event.preventDefault();
    setError('');
    if (!displayName.trim() || !username.trim()) {
      setError('Name and username are required.');
      return;
    }
    if (userType === 'hhah' && !agencyId) {
      setError('Pick the agency this HHAH user belongs to.');
      return;
    }
    if (userType === 'pg' && !pgId) {
      setError('Pick the physician group this user belongs to.');
      return;
    }
    if (isPractitioner) {
      if (!npiDigits) {
        setError('Enter the practitioner NPI.');
        return;
      }
      if (!practitionerId) {
        setError('Map this login to a practitioner with a matching NPI (create one on the Entity page first).');
        return;
      }
    }
    if (password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        username: username.trim(),
        displayName: displayName.trim(),
        password,
        userType,
      };
      if (userType === 'hhah') {
        payload.agencyId = agencyId;
        payload.role = 'admin';
      } else {
        payload.pgId = pgId;
        payload.role = role;
        if (isPractitioner) {
          payload.practitionerName = displayName.trim();
          payload.npi = npiDigits;
          payload.practitionerId = practitionerId;
        }
      }
      const result = await createExternalUser(payload);
      setDisplayName('');
      setUsername('');
      setNpi('');
      setPractitionerId('');
      setPassword('');
      setConfirm('');
      onCreated(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <UserPlus size={17} className="text-violet-600" />
        <h2 className="font-bold text-slate-900">Add external user</h2>
      </div>

      <div className="mb-4">
        <div className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">Type</div>
        <div className="flex flex-wrap gap-2">
          <RadioPill name="userType" checked={userType === 'hhah'} onChange={() => setUserType('hhah')}>
            <Building2 size={14} className="text-emerald-600" /> HHAH (agency portal)
          </RadioPill>
          <RadioPill name="userType" checked={userType === 'pg'} onChange={() => setUserType('pg')}>
            <UsersRound size={14} className="text-violet-600" /> PG (physician group portal)
          </RadioPill>
        </div>
      </div>

      {userType === 'hhah' ? (
        <div className="mb-4 grid gap-3 md:grid-cols-2">
          <Field
            label="Agency"
            hint={agencies.length === 0 ? 'No agencies yet — create one on the Entity page first.' : undefined}
          >
            <select value={agencyId} onChange={(e) => setAgencyId(e.target.value)} className={inputClass}>
              <option value="">Select agency</option>
              {agencies.map((agency) => (
                <option key={agency.id} value={agency.id}>{agency.name}</option>
              ))}
            </select>
          </Field>
          <div className="self-end pb-2 text-xs text-slate-400">
            HHAH users log in at <span className="font-mono">/hhh-login</span> (upload portal). Role is fixed to admin.
          </div>
        </div>
      ) : (
        <div className="mb-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <Field
              label="Physician group"
              hint={physicianGroups.length === 0 ? 'No PGs yet — create one on the Entity page first.' : undefined}
            >
              <select value={pgId} onChange={(e) => setPgId(e.target.value)} className={inputClass}>
                <option value="">Select PG</option>
                {physicianGroups.map((pg) => (
                  <option key={pg.id} value={pg.id}>{pg.name}</option>
                ))}
              </select>
            </Field>
            <div>
              <div className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">Role</div>
              <div className="flex flex-wrap gap-2">
                <RadioPill name="pgRole" checked={role === 'admin'} onChange={() => setRole('admin')}>
                  Admin
                </RadioPill>
                <RadioPill name="pgRole" checked={role === 'practitioner'} onChange={() => setRole('practitioner')}>
                  <Stethoscope size={14} className="text-sky-600" /> Practitioner
                </RadioPill>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                {role === 'practitioner'
                  ? 'Practitioners see the Bulk Sign view on /pg-login.'
                  : 'Admins see the dashboard only on /pg-login.'}
              </p>
            </div>
          </div>
          {isPractitioner && (
            <div className="grid gap-3 rounded-xl border border-sky-100 bg-sky-50/50 p-3 md:grid-cols-2">
              <Field label="NPI" hint="Used to find the matching Entity practitioner. The server re-verifies the match.">
                <input
                  value={npi}
                  onChange={(e) => setNpi(e.target.value)}
                  placeholder="1234567890"
                  inputMode="numeric"
                  className={inputClass}
                />
              </Field>
              <Field
                label="Map to practitioner"
                hint={
                  !npiDigits
                    ? 'Enter the NPI first — the list shows practitioners with that NPI.'
                    : matchingPractitioners.length === 0
                      ? 'No practitioner with this NPI. Create one on the Entity page first.'
                      : undefined
                }
              >
                <select
                  value={practitionerId}
                  onChange={(e) => setPractitionerId(e.target.value)}
                  disabled={matchingPractitioners.length === 0}
                  className={`${inputClass} disabled:bg-slate-50 disabled:text-slate-400`}
                >
                  <option value="">Select practitioner</option>
                  {matchingPractitioners.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.physician_name || 'Unnamed practitioner'} ({p.npi_digits})
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <Field label={isPractitioner ? 'Practitioner name' : 'Display name'}>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={isPractitioner ? 'Dr. Kim' : 'Sunrise Home Health'}
            className={inputClass}
          />
        </Field>
        <Field label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="sunrise" autoComplete="off" className={inputClass} />
        </Field>
        <Field label={`Password (min ${MIN_PASSWORD})`}>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className={inputClass} />
        </Field>
        <Field label="Confirm password">
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" className={inputClass} />
        </Field>
      </div>

      {error && <div className="mt-3 text-sm text-rose-600">{error}</div>}
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-slate-400">
          Only accounts created here can log in to <span className="font-mono">/hhh-login</span> and{' '}
          <span className="font-mono">/pg-login</span>.
        </p>
        <button
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-violet-700 disabled:opacity-60"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />}
          Create user
        </button>
      </div>
    </form>
  );
}

// ── Per-row reset-password panel ─────────────────────────────────────────────
function ResetPasswordRow({ user, onDone, onCancel }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setError('');
    if (password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSaving(true);
    try {
      await updateExternalUser({ id: user.id, password });
      onDone();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <tr className="bg-slate-50/70">
      <td colSpan={7} className="px-4 py-3">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="text-sm font-bold text-slate-700">
            Reset password for <span className="text-violet-700">{user.display_name}</span>
          </div>
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-500">New password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className={`${inputClass} w-48`} />
          </label>
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Confirm</span>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" className={`${inputClass} w-48`} />
          </label>
          <button
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-3 py-2 text-sm font-bold text-white hover:bg-violet-700 disabled:opacity-60"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
            Reset
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-500 hover:bg-white"
          >
            <X size={14} /> Cancel
          </button>
          {error && <span className="text-sm text-rose-600">{error}</span>}
        </form>
      </td>
    </tr>
  );
}

export default function ExternalUsers() {
  const [users, setUsers] = useState([]);
  const [reference, setReference] = useState({ hhahs: [], physicianGroups: [], practitioners: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [resetId, setResetId] = useState('');
  const [busyId, setBusyId] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      const [userRows, referenceData] = await Promise.all([listExternalUsers(), fetchReferenceData()]);
      setUsers(userRows);
      setReference(referenceData);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function toggleActive(user) {
    const next = !user.active;
    if (!next && !window.confirm(`Deactivate ${user.display_name}? They will no longer be able to log in.`)) {
      return;
    }
    setBusyId(user.id);
    setMessage('');
    try {
      await updateExternalUser({ id: user.id, active: next });
      setMessage(`${user.display_name} ${next ? 'reactivated' : 'deactivated'}.`);
      setError('');
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId('');
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">External Users</h1>
          <p className="mt-1 text-sm text-slate-500">
            Logins for HHAH agencies (<span className="font-mono">/hhh-login</span>) and physician groups
            (<span className="font-mono">/pg-login</span>).
          </p>
        </div>
        <button
          onClick={refresh}
          className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="mb-5">
        <CreateExternalUserCard
          reference={reference}
          onCreated={(result) => {
            setMessage(`External user ${result.user?.display_name} created.`);
            setError('');
            refresh();
          }}
        />
      </div>

      {message && <div className="mb-3 text-sm text-emerald-700">{message}</div>}
      {error && <div className="mb-3 text-sm text-rose-600">{error}</div>}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <Globe size={17} className="text-violet-600" />
          <h2 className="font-bold text-slate-900">All external users</h2>
          <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{users.length}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2.5 font-bold">Name</th>
                <th className="px-4 py-2.5 font-bold">Username</th>
                <th className="px-4 py-2.5 font-bold">Type / role</th>
                <th className="px-4 py-2.5 font-bold">Entity</th>
                <th className="px-4 py-2.5 font-bold">Status</th>
                <th className="px-4 py-2.5 font-bold">Created</th>
                <th className="px-4 py-2.5 font-bold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-sm text-slate-400">
                    <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading external users…</span>
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-sm text-slate-400">
                    No external users yet — create the first login above.
                  </td>
                </tr>
              ) : (
                users.map((user) => (
                  <Fragment key={user.id}>
                    <tr className={user.active ? '' : 'opacity-60'}>
                      <td className="px-4 py-3 font-bold text-slate-800">{user.display_name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">{user.username}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <TypeBadge user={user} />
                          {user.user_type === 'pg' && <RoleBadge user={user} />}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        <div>{user.agency_name || user.pg_name || <span className="text-slate-300">—</span>}</div>
                        {user.role === 'practitioner' && (
                          <div className="mt-0.5 text-xs text-slate-400">
                            {user.practitioner_name || 'Practitioner'} · NPI {user.npi || 'Missing'}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {user.active ? (
                          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">Active</span>
                        ) : (
                          <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-bold text-rose-600">Deactivated</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">{formatUiDate(user.created_at)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setResetId(resetId === user.id ? '' : user.id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
                          >
                            <KeyRound size={13} /> Reset password
                          </button>
                          {user.active ? (
                            <button
                              type="button"
                              onClick={() => toggleActive(user)}
                              disabled={busyId === user.id}
                              className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs font-bold text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                            >
                              <Ban size={13} /> Deactivate
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => toggleActive(user)}
                              disabled={busyId === user.id}
                              className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 px-2.5 py-1.5 text-xs font-bold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                            >
                              <Power size={13} /> Reactivate
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {resetId === user.id && (
                      <ResetPasswordRow
                        user={user}
                        onDone={() => {
                          setResetId('');
                          setMessage(`Password reset for ${user.display_name}.`);
                          setError('');
                        }}
                        onCancel={() => setResetId('')}
                      />
                    )}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
