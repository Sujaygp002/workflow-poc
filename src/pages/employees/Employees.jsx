import { Fragment, useEffect, useState } from 'react';
import {
  Ban,
  KeyRound,
  Loader2,
  Power,
  RefreshCw,
  UserPlus,
  UsersRound,
  X,
} from 'lucide-react';
import { createEmployee, listEmployees, updateEmployee } from '../../lib/authApi';
import { formatUiDate } from '../../lib/dateFormat';

const MIN_PASSWORD = 8;

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  'mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-violet-200';

// ── Add employee card ────────────────────────────────────────────────────────
function AddEmployeeCard({ onCreated }) {
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [jobRole, setJobRole] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setError('');
    if (!displayName.trim() || !username.trim()) {
      setError('Display name and username are required.');
      return;
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
      const result = await createEmployee({
        username: username.trim(),
        displayName: displayName.trim(),
        jobRole: jobRole.trim() || undefined,
        password,
      });
      setDisplayName('');
      setUsername('');
      setJobRole('');
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
        <UserPlus size={17} className="text-pink-600" />
        <h2 className="font-bold text-slate-900">Add employee</h2>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Display name">
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Dana Rivera" className={inputClass} />
        </Field>
        <Field label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="dana" autoComplete="off" className={inputClass} />
        </Field>
        <Field label="Job role (optional)">
          <input value={jobRole} onChange={(e) => setJobRole(e.target.value)} placeholder="Intake coordinator" className={inputClass} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Password (min ${MIN_PASSWORD})`}>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className={inputClass} />
          </Field>
          <Field label="Confirm">
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" className={inputClass} />
          </Field>
        </div>
      </div>
      {error && <div className="mt-3 text-sm text-rose-600">{error}</div>}
      <div className="mt-4 flex items-center justify-end gap-3">
        <button
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-violet-700 disabled:opacity-60"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />}
          Create employee
        </button>
      </div>
    </form>
  );
}

// ── Per-row reset-password panel ─────────────────────────────────────────────
function ResetPasswordRow({ employee, onDone, onCancel }) {
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
      await updateEmployee({ id: employee.id, password });
      onDone();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <tr className="bg-slate-50/70">
      <td colSpan={6} className="px-4 py-3">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="text-sm font-bold text-slate-700">
            Reset password for <span className="text-violet-700">{employee.display_name}</span>
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

export default function Employees() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [resetId, setResetId] = useState('');
  const [busyId, setBusyId] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      setEmployees(await listEmployees());
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

  async function toggleActive(employee) {
    const next = !employee.active;
    if (!next && !window.confirm(`Deactivate ${employee.display_name}? They will no longer be able to log in to the worker portal.`)) {
      return;
    }
    setBusyId(employee.id);
    setMessage('');
    try {
      await updateEmployee({ id: employee.id, active: next });
      setMessage(`${employee.display_name} ${next ? 'reactivated' : 'deactivated'}.`);
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
          <h1 className="text-2xl font-bold text-slate-800">Employees</h1>
          <p className="mt-1 text-sm text-slate-500">
            Internal accounts for the worker portal. Employees are the assignees of workflow tasks.
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
        <AddEmployeeCard
          onCreated={(result) => {
            setMessage(`Employee ${result.employee?.display_name} created.`);
            setError('');
            refresh();
          }}
        />
      </div>

      {message && <div className="mb-3 text-sm text-emerald-700">{message}</div>}
      {error && <div className="mb-3 text-sm text-rose-600">{error}</div>}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <UsersRound size={17} className="text-pink-600" />
          <h2 className="font-bold text-slate-900">All employees</h2>
          <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{employees.length}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2.5 font-bold">Name</th>
                <th className="px-4 py-2.5 font-bold">Username</th>
                <th className="px-4 py-2.5 font-bold">Job role</th>
                <th className="px-4 py-2.5 font-bold">Active</th>
                <th className="px-4 py-2.5 font-bold">Created</th>
                <th className="px-4 py-2.5 font-bold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && employees.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-sm text-slate-400">
                    <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading employees…</span>
                  </td>
                </tr>
              ) : employees.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-sm text-slate-400">
                    No employees yet — create the first account above.
                  </td>
                </tr>
              ) : (
                employees.map((employee) => (
                  <Fragment key={employee.id}>
                    <tr className={employee.active ? '' : 'opacity-60'}>
                      <td className="px-4 py-3 font-bold text-slate-800">{employee.display_name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">{employee.username}</td>
                      <td className="px-4 py-3 text-slate-600">{employee.job_role || <span className="text-slate-300">—</span>}</td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => toggleActive(employee)}
                          disabled={busyId === employee.id}
                          title={employee.active ? 'Deactivate' : 'Reactivate'}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${employee.active ? 'bg-violet-600' : 'bg-slate-200'}`}
                        >
                          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${employee.active ? 'translate-x-4' : 'translate-x-0.5'}`} />
                        </button>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">{formatUiDate(employee.created_at)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setResetId(resetId === employee.id ? '' : employee.id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
                          >
                            <KeyRound size={13} /> Reset password
                          </button>
                          {employee.active ? (
                            <button
                              type="button"
                              onClick={() => toggleActive(employee)}
                              disabled={busyId === employee.id}
                              className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs font-bold text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                            >
                              <Ban size={13} /> Deactivate
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => toggleActive(employee)}
                              disabled={busyId === employee.id}
                              className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 px-2.5 py-1.5 text-xs font-bold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                            >
                              <Power size={13} /> Reactivate
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {resetId === employee.id && (
                      <ResetPasswordRow
                        employee={employee}
                        onDone={() => {
                          setResetId('');
                          setMessage(`Password reset for ${employee.display_name}.`);
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
