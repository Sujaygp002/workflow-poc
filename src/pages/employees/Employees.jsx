import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  Ban,
  ChevronDown,
  ChevronRight,
  Inbox,
  KeyRound,
  Loader2,
  ListChecks,
  Power,
  RefreshCw,
  Users,
  UserPlus,
  UsersRound,
  X,
} from 'lucide-react';
import { createEmployee, listEmployees, updateEmployee } from '../../lib/authApi';
import { formatUiDate, formatUiDateTime } from '../../lib/dateFormat';

const MIN_PASSWORD = 8;

// Default custom range = last 30 days (inclusive), business-tz agnostic on the
// client — the server validates from <= to and matches against the business clock.
function defaultRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

// ── Per-employee task + performance panel (expanded row) ─────────────────────
function BucketChip({ icon: Icon, label, value, tone }) {
  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${tone}`}>
      <Icon size={20} className="shrink-0" />
      <div>
        <div className="text-2xl font-bold leading-none">{value}</div>
        <div className="mt-1 text-xs font-bold uppercase tracking-wide opacity-70">{label}</div>
      </div>
    </div>
  );
}

function EmployeeTaskPanel({ employeeId, businessDates }) {
  const [stat, setStat] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [range, setRange] = useState(defaultRange);
  const [applied, setApplied] = useState(defaultRange);

  const load = useCallback(async (r) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ view: 'employee-stats' });
      if (r?.from && r?.to) {
        params.set('from', r.from);
        params.set('to', r.to);
      }
      const res = await fetch(`/api/work-items?${params.toString()}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const body = await res.json();
      const mine = (body.stats || []).find((s) => s.id === employeeId) || null;
      setStat(mine);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    load(applied);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  function applyRange(event) {
    event.preventDefault();
    if (range.from > range.to) {
      setError('From date must be on or before To date.');
      return;
    }
    setApplied(range);
    load(range);
  }

  const counts = stat?.counts || { untouched: 0, processing: 0, done: 0 };

  return (
    <tr className="bg-slate-50/70">
      <td colSpan={7} className="px-6 py-4">
        {loading && !stat ? (
          <div className="inline-flex items-center gap-2 text-sm text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading tasks…
          </div>
        ) : error ? (
          <div className="text-sm text-rose-600">{error}</div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <BucketChip icon={Inbox} label="Untouched" value={counts.untouched} tone="border-slate-200 bg-white text-slate-700" />
              <BucketChip icon={Loader2} label="Processing" value={counts.processing} tone="border-amber-200 bg-amber-50 text-amber-700" />
              <BucketChip icon={ListChecks} label="Done" value={counts.done} tone="border-emerald-200 bg-emerald-50 text-emerald-700" />
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span className="font-bold text-slate-700">
                  Yesterday <span className="text-slate-400">({businessDates.yesterday})</span>: {' '}
                  <span className="text-violet-700">{stat?.completedYesterday ?? 0} completed</span>
                </span>
                <span className="font-bold text-slate-700">
                  Today <span className="text-slate-400">({businessDates.today})</span>: {' '}
                  <span className="text-violet-700">{stat?.completedToday ?? 0} completed</span>
                </span>
              </div>
              <form onSubmit={applyRange} className="mt-3 flex flex-wrap items-end gap-3">
                <label className="block">
                  <span className="text-xs font-bold uppercase tracking-wide text-slate-500">From</span>
                  <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className={`${inputClass} w-40`} />
                </label>
                <label className="block">
                  <span className="text-xs font-bold uppercase tracking-wide text-slate-500">To</span>
                  <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className={`${inputClass} w-40`} />
                </label>
                <button className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-3 py-2 text-sm font-bold text-white hover:bg-violet-700">
                  Apply
                </button>
                <span className="text-sm font-bold text-slate-700">
                  In range: <span className="text-violet-700">{stat?.completedInRange ?? 0} completed</span>
                </span>
              </form>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Recent completed tasks</div>
              {stat?.recentDone?.length ? (
                <ul className="divide-y divide-slate-100">
                  {stat.recentDone.map((task, i) => (
                    <li key={i} className="flex items-center justify-between gap-4 py-2 text-sm">
                      <div>
                        <span className="font-bold text-slate-800">{task.name}</span>
                        <span className="ml-2 text-slate-400">{task.workflow_name}</span>
                      </div>
                      <span className="shrink-0 text-xs text-slate-500">{formatUiDateTime(task.completed_at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-sm text-slate-400">No completed tasks yet.</div>
              )}
            </div>
          </div>
        )}
      </td>
    </tr>
  );
}

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
      <td colSpan={7} className="px-4 py-3">
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
  const [expandedId, setExpandedId] = useState('');
  const [businessDates, setBusinessDates] = useState({ today: '', yesterday: '' });
  const [unassignedUntouched, setUnassignedUntouched] = useState(null);

  async function refreshStats() {
    try {
      const res = await fetch('/api/work-items?view=employee-stats');
      if (!res.ok) return;
      const body = await res.json();
      setBusinessDates({ today: body.today || '', yesterday: body.yesterday || '' });
      setUnassignedUntouched(body.unassignedUntouched ?? null);
    } catch {
      // quiet — the header summary is best-effort
    }
  }

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
    refreshStats();
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
          {unassignedUntouched != null && (
            <span className="ml-3 inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
              <Users size={13} /> Shared pool: {unassignedUntouched} untouched
            </span>
          )}
          <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{employees.length}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
                <th className="w-8 px-2 py-2.5 font-bold" />
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
                  <td colSpan={7} className="px-4 py-6 text-sm text-slate-400">
                    <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading employees…</span>
                  </td>
                </tr>
              ) : employees.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-sm text-slate-400">
                    No employees yet — create the first account above.
                  </td>
                </tr>
              ) : (
                employees.map((employee) => (
                  <Fragment key={employee.id}>
                    <tr className={employee.active ? '' : 'opacity-60'}>
                      <td className="px-2 py-3">
                        <button
                          type="button"
                          onClick={() => setExpandedId(expandedId === employee.id ? '' : employee.id)}
                          title={expandedId === employee.id ? 'Hide tasks' : 'Show tasks'}
                          className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                        >
                          {expandedId === employee.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        </button>
                      </td>
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
                    {expandedId === employee.id && (
                      <EmployeeTaskPanel employeeId={employee.id} businessDates={businessDates} />
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
