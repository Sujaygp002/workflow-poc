import { useState } from 'react';
import { Archive, Building2, ChevronDown, ChevronRight, ClipboardList, ExternalLink, GitBranch, UserRound, XCircle } from 'lucide-react';
import { formatUiDate } from '../lib/dateFormat';

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count || 0} ${(count || 0) === 1 ? singular : plural}`;
}

function statusTone(status) {
  if (status === 'billable') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (status === 'eligible') return 'bg-sky-50 text-sky-700 border-sky-200';
  if (status === 'archived') return 'bg-slate-100 text-slate-600 border-slate-200';
  if (status === 'not_archived') return 'bg-amber-50 text-amber-700 border-amber-200';
  return 'bg-slate-50 text-slate-500 border-slate-200';
}

function Pill({ children, tone = 'bg-slate-50 text-slate-500 border-slate-200' }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${tone}`}>
      {children}
    </span>
  );
}

function Section({ title, count, children, defaultOpen = false, tone = 'slate', emptyText = 'No records.' }) {
  const [open, setOpen] = useState(defaultOpen);
  const hasItems = count > 0;
  const toneClass = tone === 'amber'
    ? 'border-amber-200 bg-amber-50 text-amber-800'
    : tone === 'emerald'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : tone === 'rose'
        ? 'border-rose-200 bg-rose-50 text-rose-800'
        : tone === 'violet'
          ? 'border-violet-200 bg-violet-50 text-violet-800'
          : 'border-slate-200 bg-slate-50 text-slate-700';

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <div className="text-sm font-black text-slate-900">{title}</div>
          <div className="text-xs text-slate-500">{countLabel(count, 'item')}</div>
        </div>
        <span className={`rounded-full border px-2 py-1 text-xs font-bold ${toneClass}`}>
          {hasItems ? count : 0}
        </span>
        {open ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
      </button>
      {open && (
        <div className="border-t border-slate-100 p-3">
          {hasItems ? children : <div className="rounded-lg border border-dashed border-slate-200 p-3 text-sm text-slate-400">{emptyText}</div>}
        </div>
      )}
    </div>
  );
}

function OrderRow({ order, archive = false }) {
  if (!order) return null;
  const signed = order.signed || order.signed_status === 'signed';
  return (
    <div className={`rounded-lg border px-3 py-2 ${archive ? 'border-slate-200 bg-slate-50' : signed ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate font-bold text-slate-900">{order.order_number || 'No order number'}</div>
            {signed ? (
              <Pill tone="bg-emerald-100 text-emerald-700 border-emerald-200">signed</Pill>
            ) : (
              <Pill tone="bg-amber-100 text-amber-700 border-amber-200">unsigned</Pill>
            )}
            {archive && <Pill>archived</Pill>}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {(order.document_type || order.order_type || 'No document type')} | {formatUiDate(order.order_date)}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            Signed date: {formatUiDate(order.signed_date)}
          </div>
          {(order.order_status?.cpo_min || order.order_status?.justification_title || order.order_status?.justification_note) && (
            <div className="mt-1 text-xs text-slate-600">
              {order.order_status?.cpo_min != null && order.order_status?.cpo_min !== '' && (
                <span className="mr-2 font-semibold">CPO min: {order.order_status.cpo_min}</span>
              )}
              {order.order_status?.justification_title && (
                <span className="font-semibold">Justification: {order.order_status.justification_title}</span>
              )}
              {order.order_status?.justification_note && (
                <div className="mt-0.5 text-slate-500">{order.order_status.justification_note}</div>
              )}
            </div>
          )}
          {order.archive_reason && (
            <div className="mt-0.5 text-[11px] font-semibold text-slate-400">Archive reason: {order.archive_reason}</div>
          )}
        </div>
        {order.pdf_blob_url && (
          <a
            href={order.pdf_blob_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-bold text-slate-600 hover:bg-slate-50"
          >
            <ExternalLink size={12} /> PDF
          </a>
        )}
      </div>
    </div>
  );
}

function OrderList({ title, orders = [], archive = false, tone = 'slate' }) {
  return (
    <Section title={title} count={orders.length} defaultOpen={!archive && orders.length > 0} tone={tone} emptyText={`No ${title.toLowerCase()}.`}>
      <div className="grid gap-2">
        {orders.map((order) => <OrderRow key={order.id} order={order} archive={archive} />)}
      </div>
    </Section>
  );
}

// CC notes (CCNs) live INSIDE the episode alongside its orders — one card per
// note, read from the episode's CPO months (cpo_months.reason.ccNotes).
function CcnNoteCard({ note }) {
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="font-bold text-slate-900">{note.noteTitle || 'Untitled note'}</div>
        <Pill tone="bg-violet-100 text-violet-700 border-violet-200">{note.noteType || 'CC note'}</Pill>
        <Pill tone="bg-white text-violet-700 border-violet-200">{Number(note.cpoMinutes) || 0} CPO min</Pill>
        {note.data_tags?.generated_by === 'human'
          ? <Pill tone="bg-pink-50 text-pink-700 border-pink-200">coordinator</Pill>
          : <Pill tone="bg-sky-50 text-sky-700 border-sky-200">AI service</Pill>}
      </div>
      <div className="mt-1 text-xs text-slate-500">
        Month {formatUiDate(note.month)} | Sent {formatUiDate(note.sentToPhysicianDate)}
      </div>
      {note.noteText && (
        <div className="mt-1 text-xs leading-relaxed text-slate-600">{note.noteText}</div>
      )}
    </div>
  );
}

function CcnList({ episode }) {
  const cpoMonths = episode.cpoMonths || [];
  const notes = cpoMonths.flatMap((month, monthIndex) => (month.reason?.ccNotes || []).map((note, noteIndex) => ({
    ...note,
    month: month.cpo_month,
    key: `${month.id || monthIndex}-${noteIndex}`,
  })));
  const totalMinutes = cpoMonths.reduce((sum, month) => sum + (Number(month.cpo_min) || 0), 0);
  return (
    <Section
      title="CC Notes (CCN)"
      count={notes.length}
      defaultOpen={notes.length > 0}
      tone="violet"
      emptyText="No CC notes yet — the Create CCN task adds them here."
    >
      <div className="grid gap-2">
        {totalMinutes > 0 && (
          <div className="text-xs font-semibold text-slate-500">{totalMinutes} CPO minutes captured across {cpoMonths.length} month(s).</div>
        )}
        {notes.map((note) => <CcnNoteCard key={note.key} note={note} />)}
      </div>
    </Section>
  );
}

function EpisodePanel({ episode, title = 'Latest Episode', archive = false }) {
  if (!episode) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-white p-4 text-sm text-slate-400">
        No episode available.
      </div>
    );
  }
  return (
    <div className={`rounded-xl border p-4 ${archive ? 'border-slate-200 bg-slate-50' : 'border-amber-200 bg-amber-50/60'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <GitBranch size={16} className={archive ? 'text-slate-500' : 'text-amber-600'} />
            <h4 className="font-black text-slate-900">{title}</h4>
            {archive && <Pill>archived</Pill>}
          </div>
          <div className="mt-1 text-sm text-slate-600">
            {formatUiDate(episode.soe)} to {formatUiDate(episode.eoe)}
          </div>
        </div>
        <Pill tone={statusTone(episode.status)}>{episode.status || 'started'}</Pill>
      </div>
      {archive ? (
        <div className="mt-3">
          <OrderList title="Archived Episode Orders" orders={episode.orders || []} archive />
        </div>
      ) : (
        <>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <OrderList title="Signed Orders" orders={episode.signed_orders || []} tone="emerald" />
            <OrderList title="Unsigned Orders" orders={episode.unsigned_orders || []} tone="amber" />
          </div>
          <div className="mt-3">
            <CcnList episode={episode} />
          </div>
        </>
      )}
    </div>
  );
}

function ArchivedEpisodeList({ episodes = [] }) {
  return (
    <Section title="Episode Archive" count={episodes.length} tone="amber">
      <div className="grid gap-3">
        {episodes.map((episode) => <EpisodePanel key={episode.id} episode={episode} title="Archived Episode" archive />)}
      </div>
    </Section>
  );
}

function uniqueById(items = []) {
  const seen = new Set();
  const unique = [];
  for (const item of items.filter(Boolean)) {
    const key = item.id || `${item.soe || ''}-${item.eoe || ''}-${unique.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function archivedEpisodesForAdmission(admission) {
  return uniqueById([
    ...(admission.archived_episodes || []),
    ...(admission.episodes || []),
    ...(admission.episode_archive || []),
    admission.latest_episode,
  ]);
}

function AdmissionPanel({ admission, title = 'Latest Admission', archive = false }) {
  if (!admission) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-white p-4 text-sm text-slate-400">
        No admission available.
      </div>
    );
  }
  return (
    <div className={`rounded-xl border p-4 ${archive ? 'border-slate-200 bg-slate-50' : 'border-emerald-200 bg-emerald-50/60'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Building2 size={16} className={archive ? 'text-slate-500' : 'text-emerald-600'} />
            <h3 className="font-black text-slate-900">{title}</h3>
            {archive && <Pill>archived</Pill>}
          </div>
          <div className="mt-1 text-sm text-slate-600">
            {formatUiDate(admission.soc)} to {formatUiDate(admission.eoc)}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            HHAH {admission.agency_name || 'Missing'} | PG {admission.pg_name || 'Missing'}
          </div>
        </div>
        {admission.archive_gap_days != null && (
          <Pill>{admission.archive_gap_days} day gap</Pill>
        )}
      </div>

      {archive ? (
        <div className="mt-3 grid gap-3">
          <ArchivedEpisodeList episodes={archivedEpisodesForAdmission(admission)} />
        </div>
      ) : (
        <div className="mt-3 grid gap-3">
          <ArchivedEpisodeList episodes={admission.episode_archive || []} />
          <EpisodePanel episode={admission.latest_episode} />
        </div>
      )}
    </div>
  );
}

function PatientRecordArchiveCard({ record }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Archive size={16} className="text-slate-500" />
            <h3 className="font-black text-slate-900">{record.name || 'Patient record'}</h3>
            <Pill>archived record</Pill>
          </div>
          <div className="mt-1 text-sm text-slate-600">
            HHAH {record.agency_name || record.hhah_name || 'Missing'} | PG {record.physician_group_name || record.pg_name || 'Missing'}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Archive reason: {record.archive_reason || 'patient_record_gap_90_days'}
            {record.archive_gap_days != null ? ` (${record.archive_gap_days} day gap)` : ''}
          </div>
        </div>
      </div>
      <div className="mt-3 grid gap-3">
        {(record.archived_admissions || []).map((admission) => (
          <AdmissionPanel key={admission.id} admission={admission} title="Archived Admission" archive />
        ))}
      </div>
    </div>
  );
}

export default function PatientHierarchyView({ tree }) {
  const hierarchy = tree?.unitHierarchy || tree;
  const unit = hierarchy?.unit;
  const record = hierarchy?.current_patient_record;
  const patientRecordArchive = hierarchy?.patient_record_archive || [];
  const priorPatientRecordsNotArchived = hierarchy?.prior_patient_records_not_archived || [];

  if (!hierarchy || !unit) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
        Select a patient unit to inspect the hierarchy.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-sky-200 bg-sky-50 p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <UserRound size={18} className="text-sky-700" />
              <div className="text-xs font-black uppercase tracking-wide text-sky-700">Patient Unit</div>
            </div>
            <h2 className="mt-1 text-2xl font-black text-slate-950">{unit.name || 'Unnamed patient'}</h2>
            <div className="mt-1 text-sm text-slate-600">
              DOB {formatUiDate(unit.dob)} | MRN {unit.mrn || 'Missing'} | Sex {unit.sex || 'Missing'}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Pill tone="bg-white text-sky-700 border-sky-200">source of truth</Pill>
            {patientRecordArchive.length > 0 && <Pill>{countLabel(patientRecordArchive.length, 'archived record')}</Pill>}
          </div>
        </div>
      </section>

      {patientRecordArchive.length > 0 && (
        <Section title="Patient Record Archive" count={patientRecordArchive.length} tone="slate" defaultOpen>
          <div className="grid gap-3">
            {patientRecordArchive.map((archivedRecord) => (
              <PatientRecordArchiveCard key={archivedRecord.id} record={archivedRecord} />
            ))}
          </div>
        </Section>
      )}

      {record && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <ClipboardList size={17} className="text-violet-600" />
                <h2 className="font-black text-slate-950">Current Patient Record</h2>
              </div>
              <div className="mt-1 text-sm text-slate-600">
                HHAH {record.agency_name || record.hhah_name || 'Missing'} | PG {record.physician_group_name || record.pg_name || 'Missing'}
              </div>
            </div>
            <Pill tone={statusTone(record.latest_episode_status)}>{record.latest_episode_status || 'none'}</Pill>
          </div>
          <div className="mt-4 grid gap-3">
            <Section title="Admission Archive" count={(record.admission_archive || []).length} tone="slate">
              <div className="grid gap-3">
                {(record.admission_archive || []).map((admission) => (
                  <AdmissionPanel key={admission.id} admission={admission} title="Archived Admission" archive />
                ))}
              </div>
            </Section>
            <AdmissionPanel admission={record.latest_admission} />
          </div>
        </section>
      )}

      {priorPatientRecordsNotArchived.length > 0 && (
        <Section title="Prior Patient Records Not Archived" count={priorPatientRecordsNotArchived.length} tone="amber">
          <div className="grid gap-3">
            {priorPatientRecordsNotArchived.map((priorRecord) => (
              <div key={priorRecord.id} className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <div className="flex items-start gap-2">
                  <XCircle size={16} className="mt-0.5 text-amber-600" />
                  <div>
                    <div className="font-black text-slate-900">{priorRecord.name || 'Patient record'}</div>
                    <div className="mt-1 text-sm text-amber-800">
                      Not archived: {priorRecord.not_archived_reason || 'patient record gap rule not met'}
                      {priorRecord.archive_gap_days != null ? ` (${priorRecord.archive_gap_days} day gap)` : ''}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
