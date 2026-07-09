// Client-side joins that turn the live API payloads into the network-graph model:
//   HHAH (agency) → patient-count edge → PG, with aggregate adm/epi/order volumes
//   and an order-type breakdown (485 / F2F / other). No new endpoint needed.
//
// Inputs come from existing fetchers in src/lib/workflowApi.js:
//   patients  = fetchPatients()        — one row per patient RECORD (Unit+HHAH+PG)
//   orders    = fetchOrders()          — carries agency_name, pg_name, document_type
//   reference = fetchReferenceData()   — { hhahs, physicianGroups, practitioners }

const clean = (v) => String(v ?? '').trim();
const key = (v) => clean(v).toLowerCase();

function classifyOrderType(order) {
  const t = key(order.document_type || order.order_type);
  if (t.includes('485')) return 'o485';
  if (t.includes('f2f') || t.includes('face')) return 'f2f';
  return 'other';
}

function dateMs(value) {
  if (!value) return null;
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ms = new Date(`${raw}T00:00:00.000Z`).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function isPastDate(value, todayMs) {
  const ms = dateMs(value);
  return ms !== null && ms < todayMs;
}

function isOrderSigned(order = {}) {
  const s = order.order_status || {};
  return !!(
    s.SignedByPhysician_Status === true
    || s.SignedByPhysician_Status === 'true'
    || s.SignedByPhyscianDate
    || s.signed === true
    || s.order_signed_date
    || s.signedDate
    || order.signed_date
  );
}

// Build the graph model. Returns { hhahs:[{id,name,received,pgCount}],
//   edges:[{hhahId,hhahName,pg,patients,admissions,episodes,orders,...metricCounts}],
//   practitionersByPg:{pgName:count} }.
export function buildGraph({ patients = [], orders = [], reference = {} } = {}) {
  const hhahsRef = reference.hhahs || [];
  const pgsRef = reference.physicianGroups || [];
  const practitioners = reference.practitioners || [];
  const todayMs = dateMs(new Date());

  // Entity-page agencies are the ONLY source of agency balls. Patient/order rows
  // whose hhah_name doesn't match a real agency (blank, or a workbook-invented
  // name) must never spawn a phantom "Unknown agency" / never-created ball.
  const refHhahNameByKey = new Map();
  hhahsRef.forEach((h) => {
    const k = key(h.name);
    if (k) refHhahNameByKey.set(k, clean(h.name));
  });

  // ---- edges: one bucket per (HHAH, PG) pair, aggregated across patient records ----
  const edgeMap = new Map(); // `${hhahName}|||${pgName}` -> edge
  const edgeKey = (h, p) => `${key(h)}|||${key(p)}`;

  const ensureEdge = (hhahName, pgName) => {
    const k = edgeKey(hhahName, pgName);
    let e = edgeMap.get(k);
    if (!e) {
      e = {
        hhahId: key(hhahName) || 'unknown',
        hhahName: hhahName || 'Unknown agency',
        pg: pgName || 'Unassigned PG',
        patients: 0, admissions: 0, episodes: 0, orders: 0,
        oldAdmissions: 0, newAdmissions: 0,
        oldEpisodes: 0, newEpisodes: 0,
        billedEpisodes: 0, unbilledEpisodes: 0, eligibleEpisodes: 0,
        signedOrders: 0, unsignedOrders: 0,
        o485: 0, f2f: 0, other: 0,
        _admissionIds: new Set(),
        _oldAdmissionIds: new Set(),
        _newAdmissionIds: new Set(),
        _episodeIds: new Set(),
        _oldEpisodeIds: new Set(),
        _newEpisodeIds: new Set(),
        _billedEpisodeIds: new Set(),
        _unbilledEpisodeIds: new Set(),
        _eligibleEpisodeIds: new Set(),
        _episodeAdmission: new Map(),
      };
      edgeMap.set(k, e);
    }
    return e;
  };

  for (const p of patients) {
    const e = ensureEdge(p.hhah_name, p.pg_name);
    e.patients += 1;
    e.admissions += Number(p.admission_count) || 0;
    e.episodes += Number(p.episode_count) || 0;
  }

  // order counts + type breakdown come from the orders feed (has agency_name/pg_name)
  for (const o of orders) {
    const e = ensureEdge(o.agency_name || o.hhah_name, o.pg_name);
    const details = o.order_admission_details || {};
    const admissionId = clean(o.admission_id);
    const episodeId = clean(o.episode_id);
    const admissionEnd = details.EOC || details.eoc || details.admission_eoc || details.admissionEndDate;

    e.orders += 1;
    e[classifyOrderType(o)] += 1;
    if (isOrderSigned(o)) e.signedOrders += 1;
    else e.unsignedOrders += 1;

    if (admissionId) {
      e._admissionIds.add(admissionId);
      if (isPastDate(admissionEnd, todayMs)) {
        e._oldAdmissionIds.add(admissionId);
        e._newAdmissionIds.delete(admissionId);
      } else if (!e._oldAdmissionIds.has(admissionId)) {
        e._newAdmissionIds.add(admissionId);
      }
    }

    if (episodeId) {
      e._episodeIds.add(episodeId);
      // Remember which admission this episode belongs to so its old/new age can
      // INHERIT the admission's age below. Classifying an episode independently by
      // its own EOE diverges from the admission age (an admission's EOC outlives its
      // episode's EOE), producing "1 new admission with 0 episodes". Inheriting keeps
      // every admission's episodes reachable.
      if (admissionId) e._episodeAdmission.set(episodeId, admissionId);
      if (o.episode_status === 'billable') {
        e._billedEpisodeIds.add(episodeId);
        e._unbilledEpisodeIds.delete(episodeId);
      } else if (!e._billedEpisodeIds.has(episodeId)) {
        e._unbilledEpisodeIds.add(episodeId);
      }
      // eligible = episode reached eligible OR billable (billable implies eligible)
      if (o.episode_status === 'eligible' || o.episode_status === 'billable') {
        e._eligibleEpisodeIds.add(episodeId);
      }
    }
  }

  // Bucket episodes old/new by their parent admission's age (fallback: own EOE).
  for (const e of edgeMap.values()) {
    for (const episodeId of e._episodeIds) {
      const admissionId = e._episodeAdmission.get(episodeId);
      const admissionIsOld = admissionId
        ? e._oldAdmissionIds.has(admissionId)
        : null;
      if (admissionIsOld === true) e._oldEpisodeIds.add(episodeId);
      else if (admissionIsOld === false) e._newEpisodeIds.add(episodeId);
    }
  }

  const edges = [...edgeMap.values()]
    .map((e) => {
      e.admissions = Math.max(e.admissions, e._admissionIds.size);
      e.episodes = Math.max(e.episodes, e._episodeIds.size);
      e.oldAdmissions = e._oldAdmissionIds.size;
      e.newAdmissions = e._newAdmissionIds.size;
      e.oldEpisodes = e._oldEpisodeIds.size;
      e.newEpisodes = e._newEpisodeIds.size;
      e.billedEpisodes = e._billedEpisodeIds.size;
      e.unbilledEpisodes = e._unbilledEpisodeIds.size;
      e.eligibleEpisodes = e._eligibleEpisodeIds.size;
      delete e._admissionIds;
      delete e._oldAdmissionIds;
      delete e._newAdmissionIds;
      delete e._episodeIds;
      delete e._oldEpisodeIds;
      delete e._newEpisodeIds;
      delete e._billedEpisodeIds;
      delete e._unbilledEpisodeIds;
      delete e._eligibleEpisodeIds;
      delete e._episodeAdmission;
      return e;
    })
    .filter((e) => (e.patients > 0 || e.orders > 0) && refHhahNameByKey.has(e.hhahId))
    // canonicalize the display name to the Entity-page agency name
    .map((e) => ({ ...e, hhahName: refHhahNameByKey.get(e.hhahId) }));

  // ---- HHAH nodes: ONLY Entity-page (reference) agencies ----
  const hhahByKey = new Map();
  const addHhah = (name, received) => {
    const k = key(name);
    if (!k) return;
    if (!hhahByKey.has(k)) hhahByKey.set(k, { id: k, name: clean(name), received: !!received, pgCount: 0 });
    else if (received) hhahByKey.get(k).received = true;
  };
  hhahsRef.forEach((h) => addHhah(h.name, false));
  // pgCount per HHAH
  edges.forEach((e) => { const h = hhahByKey.get(key(e.hhahName)); if (h) h.pgCount += 1; });

  // ---- practitioners per PG (names + count) ----
  // The PG↔practitioner link lives on physician_groups.contact_info.physician_ids[]
  // (set by mapPgToPractitioner). Resolve those ids to practitioner names; fall back
  // to practitioner.history.PG_names when a PG recorded no physician_ids.
  const practitionerById = new Map();
  practitioners.forEach((pr) => practitionerById.set(clean(pr.id), clean(pr.physician_name)));

  const practitionerNamesByPg = {}; // pgName -> [names]
  pgsRef.forEach((pg) => {
    const nm = clean(pg.name);
    const ids = pg.contact_info?.physician_ids;
    const names = Array.isArray(ids)
      ? ids.map((id) => practitionerById.get(clean(id))).filter(Boolean)
      : [];
    practitionerNamesByPg[nm] = names;
  });
  // fallback / supplement: practitioners that name this PG in their history
  practitioners.forEach((pr) => {
    const hist = pr.history?.PG_names || pr.history?.pg_names || [];
    (Array.isArray(hist) ? hist : []).forEach((entry) => {
      const nm = clean(entry?.name || entry);
      if (!nm) return;
      const list = practitionerNamesByPg[nm];
      // only use the fallback when the PG had no physician_ids-resolved names
      if (list && list.length === 0) list.push(clean(pr.physician_name));
    });
  });

  const practitionersByPg = {};
  Object.entries(practitionerNamesByPg).forEach(([nm, names]) => { practitionersByPg[nm] = names.length; });

  // ---- PG nodes: every reference PG becomes a top-level ball inside the MSA ----
  const pgs = pgsRef.map((pg) => {
    const nm = clean(pg.name);
    const agencyIds = edges.filter((e) => key(e.pg) === key(nm)).map((e) => e.hhahId);
    const isAutoCreated = pg.raw_data?.source === 'auto_upload' || pg.raw_data?.onboarded === false;
    return {
      id: `pg::${key(nm)}`,
      name: nm,
      practitioners: practitionerNamesByPg[nm] || [],
      practitionerCount: (practitionerNamesByPg[nm] || []).length,
      // agency ids (edge.hhahId) this PG is connected to (for click-to-connect lines)
      agencyIds: [...new Set(agencyIds)],
      onboarded: isAutoCreated ? false : true,
    };
  });

  return {
    hhahs: [...hhahByKey.values()].sort((a, b) => b.pgCount - a.pgCount || a.name.localeCompare(b.name)),
    pgs,
    edges,
    practitionersByPg,
    practitionerNamesByPg,
  };
}

export function edgesForHhah(graph, hhahId) {
  return graph.edges.filter((e) => e.hhahId === hhahId);
}

export function fmtCount(n) {
  const v = Number(n);
  const safe = Number.isFinite(v) ? v : 0;
  return safe >= 1000 ? `${(safe / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${safe}`;
}
