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

// Build the graph model. Returns { hhahs:[{id,name,received,pgCount}],
//   edges:[{hhahId,hhahName,pg,patients,admissions,episodes,orders,o485,f2f,other}],
//   practitionersByPg:{pgName:count} }.
export function buildGraph({ patients = [], orders = [], reference = {} } = {}) {
  const hhahsRef = reference.hhahs || [];
  const pgsRef = reference.physicianGroups || [];
  const practitioners = reference.practitioners || [];

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
        o485: 0, f2f: 0, other: 0,
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
    e.orders += 1;
    e[classifyOrderType(o)] += 1;
  }

  const edges = [...edgeMap.values()].filter((e) => e.patients > 0 || e.orders > 0);

  // ---- HHAH nodes: union of reference HHAHs + any seen on an edge ----
  const hhahByKey = new Map();
  const addHhah = (name, received) => {
    const k = key(name);
    if (!k) return;
    if (!hhahByKey.has(k)) hhahByKey.set(k, { id: k, name: clean(name), received: !!received, pgCount: 0 });
    else if (received) hhahByKey.get(k).received = true;
  };
  hhahsRef.forEach((h) => addHhah(h.name, false));
  edges.forEach((e) => addHhah(e.hhahName, false));
  // pgCount per HHAH
  edges.forEach((e) => { const h = hhahByKey.get(key(e.hhahName)); if (h) h.pgCount += 1; });

  // ---- practitioners per PG (badge) ----
  // The PG↔practitioner link lives on physician_groups.contact_info.physician_ids[]
  // (set by mapPgToPractitioner). Count those; fall back to practitioner.history.PG_names.
  const practitionersByPg = {};
  pgsRef.forEach((pg) => {
    const ids = pg.contact_info?.physician_ids;
    practitionersByPg[clean(pg.name)] = Array.isArray(ids) ? ids.length : 0;
  });
  // fallback / supplement: practitioners that name this PG in their history
  practitioners.forEach((pr) => {
    const names = pr.history?.PG_names || pr.history?.pg_names || [];
    (Array.isArray(names) ? names : []).forEach((entry) => {
      const nm = clean(entry?.name || entry);
      if (nm && practitionersByPg[nm] === 0) {
        // only use the fallback when the PG had no physician_ids recorded
        practitionersByPg[nm] = (practitionersByPg[nm] || 0) + 1;
      }
    });
  });

  return {
    hhahs: [...hhahByKey.values()].sort((a, b) => b.pgCount - a.pgCount || a.name.localeCompare(b.name)),
    edges,
    practitionersByPg,
  };
}

export function edgesForHhah(graph, hhahId) {
  return graph.edges.filter((e) => e.hhahId === hhahId);
}

export function fmtCount(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${n}`;
}
