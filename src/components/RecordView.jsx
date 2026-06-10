// Renders the nested patient → admission → episode (+ orders) record as an
// indented, readable tree. Used by the orchestrator detail view and the work
// bucket human-review card.

function Field({ label, value }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-slate-400 w-32 shrink-0">{label}</span>
      <span className={value ? 'text-slate-700 font-medium' : 'text-slate-300 italic'}>{value || '—'}</span>
    </div>
  );
}

function diagnoses(ep) {
  return [ep.Diagnosis1, ep.Diagnosis2, ep.Diagnosis3, ep.Diagnosis4, ep.Diagnosis5, ep.Diagnosis6]
    .filter(Boolean);
}

export function OrderView({ order }) {
  if (!order) return null;
  return (
    <div className="rounded-lg border border-rose-100 bg-rose-50/40 p-2.5">
      <div className="text-[11px] font-bold uppercase tracking-wide text-rose-500 mb-1">order · {order.orderno}</div>
      <div className="grid sm:grid-cols-2 gap-x-4 gap-y-0.5">
        <Field label="Order date" value={order.orderdate} />
        <Field label="Document type" value={order.documentType} />
        <Field label="Signed date" value={order.SignedDate} />
        <Field label="NPI" value={order.NPI} />
        <Field label="SOC / EOC" value={[order.SOC, order.EOC].filter(Boolean).join(' → ')} />
        <Field label="SOE / EOE" value={[order.SOE, order.EOE].filter(Boolean).join(' → ')} />
      </div>
    </div>
  );
}

export default function RecordView({ patient, order, orders }) {
  if (!patient) return null;
  const orderList = orders && orders.length ? orders : (order ? [order] : []);
  return (
    <div className="rounded-xl border border-violet-100 bg-white overflow-hidden">
      {/* patient header */}
      <div className="px-3 py-2 bg-violet-50/60 border-b border-violet-100">
        <div className="text-[11px] font-bold uppercase tracking-wide text-violet-500 mb-1">patient</div>
        <div className="grid sm:grid-cols-2 gap-x-4 gap-y-0.5">
          <Field label="Name" value={patient.patientName} />
          <Field label="DOB" value={patient.dob} />
          <Field label="MRN" value={patient.mrn} />
          <Field label="Sex" value={patient.patient_sex} />
          <Field label="Physician Group" value={patient.PgName} />
          <Field label="Agency" value={patient.Agencyname} />
          <Field label="Address" value={patient.address} />
        </div>
      </div>

      {/* admissions → episodes */}
      <div className="p-3 space-y-2">
        {(patient.admissions || []).map((adm, ai) => (
          <div key={ai} className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5">
            <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-1">
              admission {ai + 1} · {[adm.SOC, adm.EOC].filter(Boolean).join(' → ') || 'no dates'}
            </div>
            <div className="space-y-1.5 pl-2 border-l-2 border-slate-200">
              {(adm.episodes || []).map((ep, ei) => (
                <div key={ei} className="rounded border border-slate-100 bg-white p-2">
                  <div className="text-[10px] font-semibold text-slate-400 mb-0.5">
                    episode {ei + 1} · {[ep.SOE, ep.EOE].filter(Boolean).join(' → ') || 'no dates'}
                  </div>
                  {diagnoses(ep).length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {diagnoses(ep).map((d, di) => (
                        <span key={di} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100 font-mono">{d}</span>
                      ))}
                    </div>
                  ) : <span className="text-[10px] text-slate-300 italic">no diagnoses</span>}
                </div>
              ))}
            </div>
          </div>
        ))}

        {orderList.length > 0 && (
          <div className="space-y-1.5">
            {orderList.map((o, oi) => <OrderView key={oi} order={o} />)}
          </div>
        )}
      </div>
    </div>
  );
}
