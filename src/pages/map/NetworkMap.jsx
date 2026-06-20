import { useEffect, useRef, useState, useCallback } from 'react';
import { Network, Search, Plus, Minus, Maximize, RefreshCw, Pause, Play } from 'lucide-react';
import { fetchPatients, fetchOrders, fetchReferenceData } from '../../lib/workflowApi';
import { buildGraph, edgesForHhah, fmtCount } from './graph';

const VW = 960, VH = 600;
const SVGNS = 'http://www.w3.org/2000/svg';
const COLORS = { hhah: '#38D9C4', pg: '#9C8CFF', edge: '#FFB454', adm: '#FFD27A', epi: '#7BE0B0', order: '#F26D7D', otype: '#F58AA0' };
const RAD = { hhah: 24, pg: 16, edge: 24, adm: 22, epi: 22, order: 22, otype: 19 };

// Imperative force-graph engine bound to one <g> element. Kept in a ref so React
// re-renders (chrome) don't tear down the simulation. Mirrors the verified prototype.
function createEngine(nodesG, linksG, viewG, { onBanner }) {
  let nodes = [], links = [], byId = {}, hover = null, zoomMul = 1, graph = { hhahs: [], edges: [], practitionersByPg: {} };
  const fmt = fmtCount;

  function addNode(o) {
    const n = Object.assign({ r: RAD[o.kind] || 10, open: false }, o);
    nodes.push(n); byId[n.id] = n;
    const g = document.createElementNS(SVGNS, 'g'); g.setAttribute('class', 'mapnode'); g.style.cursor = 'pointer';
    const glow = document.createElementNS(SVGNS, 'circle');
    const core = document.createElementNS(SVGNS, 'circle'); core.setAttribute('fill', COLORS[n.kind]); core.setAttribute('stroke', '#ffffff'); core.setAttribute('stroke-width', '2');
    const ring = document.createElementNS(SVGNS, 'circle'); ring.setAttribute('fill', 'none'); ring.setAttribute('stroke', COLORS[n.kind]); ring.setAttribute('stroke-dasharray', '2 3'); ring.setAttribute('opacity', '.7');
    const inner = document.createElementNS(SVGNS, 'text'); inner.setAttribute('text-anchor', 'middle'); inner.style.pointerEvents = 'none'; inner.style.fontFamily = "'IBM Plex Mono',ui-monospace,Menlo,monospace";
    const close = document.createElementNS(SVGNS, 'text'); close.style.display = 'none'; close.style.pointerEvents = 'none'; close.setAttribute('font-weight', '800');
    const badge = document.createElementNS(SVGNS, 'g'); badge.style.display = 'none';
    const bc = document.createElementNS(SVGNS, 'circle'); const bt = document.createElementNS(SVGNS, 'text'); bt.setAttribute('text-anchor', 'middle'); bt.style.fontFamily = "'IBM Plex Mono',monospace"; badge.append(bc, bt);
    const label = document.createElementNS(SVGNS, 'text'); label.setAttribute('text-anchor', 'middle'); label.setAttribute('fill', '#0f172a'); label.setAttribute('font-weight', '700'); label.style.pointerEvents = 'none'; label.style.fontFamily = "'Inter',sans-serif";
    g.append(glow, core, ring, inner, badge, close, label); nodesG.appendChild(g);
    n.el = { g, glow, core, ring, inner, close, badge, bc, bt, label };
    g.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(n); });
    g.addEventListener('mouseenter', () => { hover = n; render(); });
    g.addEventListener('mouseleave', () => { hover = null; render(); });
    return n;
  }
  function addLink(a, b, kind) { const l = { a, b, kind }; links.push(l); const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('fill', 'none'); linksG.appendChild(p); l.el = p; return l; }
  function removeSubtree(id) {
    const kids = links.filter((l) => l.a === id).map((l) => l.b);
    kids.forEach(removeSubtree);
    links = links.filter((l) => { if (l.a === id || l.b === id) { l.el?.remove(); return false; } return true; });
    const n = byId[id]; if (n) { n.el.g.remove(); delete byId[id]; nodes = nodes.filter((x) => x !== n); }
  }

  function onClick(n) { if (n.open) collapse(n); else expand(n); }
  function collapse(n) {
    links.filter((l) => l.a === n.id).map((l) => l.b).forEach(removeSubtree);
    n.open = false;
    if (n.kind === 'hhah') { nodes.forEach((x) => { if (x.kind === 'hhah') x.hidden = false; }); zoomMul = 1; onBanner('Click an agency to open its physician groups · click it again to close'); }
    layout();
  }
  function spawn(parent, items, idFn, kind, labelFn, extraFn) {
    const N = Math.max(items.length, 1), base = Math.random() * 6.28;
    items.forEach((it, i) => {
      const id = idFn(it); const k = typeof kind === 'function' ? kind(it) : kind;
      if (byId[id]) { if (!links.some((l) => l.a === parent.id && l.b === id)) addLink(parent.id, id, k); return; }
      const d = parent.r + (RAD[k] || 12) + (k === 'edge' ? 38 : 38), ang = base + (i / N) * 6.28;
      addNode(Object.assign({ id, kind: k, label: labelFn(it), x: parent.x + Math.cos(ang) * d, y: parent.y + Math.sin(ang) * d, ref: it }, extraFn ? extraFn(it) : {}));
      addLink(parent.id, id, k);
    });
  }
  function expand(n) {
    if (n.kind === 'hhah') {
      n.open = true;
      nodes.forEach((x) => { if (x.kind === 'hhah') x.hidden = x.id !== n.id; });
      n.fx = null; n.fy = null;
      const edges = edgesForHhah(graph, n.ref.id);
      const N = Math.max(edges.length, 1), base = Math.random() * 6.28;
      edges.forEach((e, i) => {
        const ang = base + (i / N) * 6.28;
        const pgId = `pg:${n.id}:${e.pg}`;
        if (!byId[pgId]) addNode({ id: pgId, kind: 'pg', label: e.pg, x: n.x + Math.cos(ang) * 210, y: n.y + Math.sin(ang) * 210, ref: { name: e.pg }, practitioners: graph.practitionersByPg[e.pg] || 0 });
        const edgeId = `edge:${n.id}:${e.pg}`;
        if (!byId[edgeId]) addNode({ id: edgeId, kind: 'edge', label: '', x: n.x + Math.cos(ang) * 110, y: n.y + Math.sin(ang) * 110, ref: { stats: e } });
        if (!links.some((l) => l.a === n.id && l.b === edgeId)) addLink(n.id, edgeId, 'edge');
        if (!links.some((l) => l.a === edgeId && l.b === pgId)) addLink(edgeId, pgId, 'edge');
      });
      onBanner('The ● shows the patient count · click it for adm → epi → orders · click the agency again to close');
    } else if (n.kind === 'edge') {
      n.open = true; const s = n.ref.stats;
      const blocks = [{ k: 'adm', c: s.admissions }, { k: 'epi', c: s.episodes }, { k: 'order', c: s.orders, bd: { o485: s.o485, f2f: s.f2f, other: s.other } }];
      spawn(n, blocks, (b) => `${b.k}:${n.id}`, (b) => b.k, () => '', (b) => ({ count: b.c, breakdown: b.bd }));
      onBanner('Orders ball → 485 · F2F · other');
    } else if (n.kind === 'order' && n.breakdown) {
      n.open = true; const b = n.breakdown;
      spawn(n, [{ k: 'o485', l: '485 cert/recert', c: b.o485 }, { k: 'f2f', l: 'F2F', c: b.f2f }, { k: 'other', l: 'Other orders', c: b.other }], (t) => `otype:${n.id}:${t.k}`, 'otype', (t) => t.l, (t) => ({ count: t.c, statLabel: t.l }));
      onBanner('Order types: 485 · F2F · other');
    }
    layout();
  }

  function fitView() {
    const vis = nodes.filter((n) => !n.hidden);
    if (!vis.length) { viewG.setAttribute('transform', 'translate(0,0) scale(1)'); return; }
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    vis.forEach((n) => { minx = Math.min(minx, n.x - n.r); maxx = Math.max(maxx, n.x + n.r); miny = Math.min(miny, n.y - n.r - 16); maxy = Math.max(maxy, n.y + n.r + 18); });
    const w = Math.max(maxx - minx, 1), h = Math.max(maxy - miny, 1), PADX = 70, PADY = 90;
    const fit = Math.min((VW - 2 * PADX) / w, (VH - PADY - 40) / h);
    const k = Math.max(0.4, Math.min(1.7, fit * zoomMul));
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    const tx = VW / 2 - cx * k, ty = (VH + PADY - 40) / 2 - cy * k;
    viewG.setAttribute('transform', `translate(${tx.toFixed(1)},${ty.toFixed(1)}) scale(${k.toFixed(3)})`);
  }
  function layout() {
    const live = nodes.filter((n) => !n.hidden);
    for (let p = 0; p < 160; p++) {
      for (let i = 0; i < live.length; i++) { const a = live[i];
        for (let j = i + 1; j < live.length; j++) { const b = live[j];
          let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01, min = a.r + b.r + 20;
          if (d < min) { const push = (min - d) / 2, ux = dx / d, uy = dy / d; const aP = a.fx != null || a.kind === 'edge', bP = b.fx != null || b.kind === 'edge';
            if (aP && bP) continue; if (aP) { b.x += ux * push * 2; b.y += uy * push * 2; } else if (bP) { a.x -= ux * push * 2; a.y -= uy * push * 2; } else { a.x -= ux * push; a.y -= uy * push; b.x += ux * push; b.y += uy * push; } } } }
    }
    nodes.filter((n) => n.kind === 'edge').forEach((e) => { const ids = links; const hl = ids.find((l) => l.b === e.id && byId[l.a]?.kind === 'hhah'); const pl = ids.find((l) => l.a === e.id && byId[l.b]?.kind === 'pg'); const A = hl && byId[hl.a], P = pl && byId[pl.b]; if (A && P) { e.x = (A.x + P.x) / 2; e.y = (A.y + P.y) / 2; } });
    for (let p = 0; p < 40; p++) { const edges = live.filter((n) => n.kind === 'edge'); for (const e of edges) for (const b of live) { if (b === e || b.kind === 'edge') continue; let dx = b.x - e.x, dy = b.y - e.y, d = Math.hypot(dx, dy) || 0.01, min = e.r + b.r + 18; if (d < min) { const push = min - d; b.x += (dx / d) * push; b.y += (dy / d) * push; } } }
    fitView(); render();
  }

  function countDisplay(n) {
    if (n.kind === 'edge') return { num: fmt(n.ref.stats.patients), label: 'PATIENTS' };
    if (n.kind === 'adm') return { num: fmt(n.count), label: 'ADMISSIONS' };
    if (n.kind === 'epi') return { num: fmt(n.count), label: 'EPISODES' };
    if (n.kind === 'order') return { num: fmt(n.count), label: 'ORDERS' };
    if (n.kind === 'otype') return { num: fmt(n.count), label: (n.statLabel || '').toUpperCase().slice(0, 11) };
    return null;
  }
  function render() {
    links.forEach((l) => { const a = byId[l.a], b = byId[l.b]; if (!a || !b || a.hidden || b.hidden) { if (l.el) l.el.style.display = 'none'; return; } l.el.style.display = '';
      const sel = hover && (hover.id === a.id || hover.id === b.id); const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 10;
      l.el.setAttribute('d', `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`);
      l.el.setAttribute('stroke', l.kind === 'pg' ? '#9C8CFF' : '#7892c0'); l.el.setAttribute('stroke-width', sel ? 2 : 1); l.el.setAttribute('opacity', sel ? 0.85 : 0.22);
    });
    nodes.forEach((n) => { if (n.hidden) { n.el.g.style.display = 'none'; return; } n.el.g.style.display = '';
      const r = n.r, c = COLORS[n.kind];
      n.el.g.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
      n.el.glow.setAttribute('r', (r * 2.1).toFixed(1)); n.el.glow.setAttribute('fill', c); n.el.glow.setAttribute('opacity', '0.12');
      n.el.core.setAttribute('r', r.toFixed(1));
      const expandable = ['hhah', 'edge'].includes(n.kind) || (n.kind === 'order' && n.breakdown);
      n.el.ring.setAttribute('r', (r + 3).toFixed(1)); n.el.ring.style.display = expandable && !n.open ? '' : 'none';
      if (n.open) { n.el.close.style.display = ''; n.el.close.textContent = '×'; n.el.close.setAttribute('x', (r * 0.72).toFixed(1)); n.el.close.setAttribute('y', (-r * 0.62).toFixed(1)); n.el.close.setAttribute('font-size', '14'); n.el.close.setAttribute('fill', '#0B1220'); } else n.el.close.style.display = 'none';
      while (n.el.inner.firstChild) n.el.inner.removeChild(n.el.inner.firstChild);
      const cd = countDisplay(n);
      if (cd) { const big = String(cd.num), fs = big.length >= 4 ? 13 : big.length === 3 ? 15 : 17;
        const t = document.createElementNS(SVGNS, 'tspan'); t.setAttribute('x', '0'); t.setAttribute('y', '0'); t.setAttribute('font-size', fs); t.setAttribute('font-weight', '800'); t.setAttribute('fill', '#0B1220'); t.textContent = big; n.el.inner.appendChild(t);
        const lb = document.createElementNS(SVGNS, 'tspan'); lb.setAttribute('x', '0'); lb.setAttribute('y', '10'); lb.setAttribute('font-size', '5.5'); lb.setAttribute('font-weight', '700'); lb.setAttribute('fill', 'rgba(11,18,32,.8)'); lb.textContent = cd.label; n.el.inner.appendChild(lb);
      } else n.el.inner.textContent = '';
      if (n.kind === 'pg' && n.practitioners) { n.el.badge.style.display = ''; n.el.badge.setAttribute('transform', `translate(${(r * 0.72).toFixed(1)},${(-r * 0.72).toFixed(1)})`);
        n.el.bc.setAttribute('r', '8'); n.el.bc.setAttribute('fill', '#0B1220'); n.el.bc.setAttribute('stroke', c); n.el.bc.setAttribute('stroke-width', '1.5');
        n.el.bt.setAttribute('y', '3'); n.el.bt.setAttribute('font-size', '9'); n.el.bt.setAttribute('font-weight', '700'); n.el.bt.setAttribute('fill', c); n.el.bt.textContent = n.practitioners;
      } else n.el.badge.style.display = 'none';
      const named = ['hhah', 'pg'].includes(n.kind), showLabel = named || (hover && hover.id === n.id);
      if (showLabel) { const lbl = named ? n.label : (cd ? cd.label.toLowerCase() : n.label); n.el.label.textContent = lbl.length > 22 ? `${lbl.slice(0, 21)}…` : lbl; n.el.label.setAttribute('y', (r + 14).toFixed(1)); n.el.label.setAttribute('font-size', '11'); } else n.el.label.textContent = '';
    });
  }

  // (re)build top-level HHAH balls from graph data, preserving open clusters when possible
  function setData(g) {
    graph = g;
    nodes = []; links = []; byId = {}; nodesG.innerHTML = ''; linksG.innerHTML = ''; zoomMul = 1;
    const N = Math.max(g.hhahs.length, 1);
    g.hhahs.forEach((h, i) => { const ang = (i / N) * 6.28; addNode({ id: `hhah:${h.id}`, kind: 'hhah', label: h.name, x: 480 + Math.cos(ang) * 250, y: 300 + Math.sin(ang) * 170, ref: h }); });
    layout();
  }

  return {
    setData,
    expandByName: (name) => { const n = byId[`hhah:${String(name).toLowerCase()}`]; if (n && !n.open) expand(n); },
    zoomBy: (f) => { zoomMul = Math.max(0.5, Math.min(3, zoomMul * f)); fitView(); },
    zoomFit: () => { zoomMul = 1; fitView(); },
    // idle = no agency is expanded → safe to rebuild from a fresh poll without
    // yanking the user out of a drill-down.
    isIdle: () => !nodes.some((n) => n.kind === 'hhah' && n.open),
  };
}

export default function NetworkMap() {
  const nodesRef = useRef(null), linksRef = useRef(null), viewRef = useRef(null), engineRef = useRef(null);
  const [banner, setBanner] = useState('Click an agency to open its physician groups · click it again to close');
  const [live, setLive] = useState(true);
  const [stamp, setStamp] = useState('');
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [suggest, setSuggest] = useState([]);
  const graphRef = useRef({ hhahs: [], edges: [], practitionersByPg: {} });

  const load = useCallback(async () => {
    try {
      const [patients, orders, reference] = await Promise.all([fetchPatients(), fetchOrders(), fetchReferenceData()]);
      const g = buildGraph({ patients, orders, reference });
      graphRef.current = g;
      // rebuild only when idle (no cluster open) so a live poll never yanks the user
      // out of an open drill-down.
      if (engineRef.current?.isIdle?.()) engineRef.current.setData(g);
      setStamp(new Date().toLocaleTimeString());
      setErr('');
    } catch (e) { setErr(e.message || 'Failed to load'); }
  }, []);

  // init engine once
  useEffect(() => {
    engineRef.current = createEngine(nodesRef.current, linksRef.current, viewRef.current, { onBanner: setBanner });
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // live poll
  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => { if (!document.hidden) load(); }, 2500);
    return () => clearInterval(id);
  }, [live, load]);

  const onSearch = (v) => {
    setQuery(v); const q = v.trim().toLowerCase();
    setSuggest(q ? graphRef.current.hhahs.filter((h) => h.name.toLowerCase().includes(q)).slice(0, 6) : []);
  };
  const pick = (h) => { setQuery(''); setSuggest([]); engineRef.current?.expandByName(h.id); };
  const zoomIn = useCallback(() => engineRef.current?.zoomBy(1.25), []);
  const zoomOut = useCallback(() => engineRef.current?.zoomBy(0.8), []);
  const zoomFit = useCallback(() => engineRef.current?.zoomFit(), []);

  return (
    <div className="relative h-screen w-full overflow-hidden bg-slate-50 text-slate-900">
      {/* top bar — matches the FlowPOC light theme */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center gap-4 border-b border-slate-200 bg-white/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-violet-600">
            <Network size={16} className="text-white" />
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Intake Ops</div>
            <h1 className="text-base font-black text-slate-900">Coverage Map</h1>
          </div>
        </div>
        <div className="relative flex-1 max-w-[420px]">
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
            <Search size={14} className="text-slate-400" />
            <input value={query} onChange={(e) => onSearch(e.target.value)} placeholder="Search an agency…" className="flex-1 bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400" />
          </div>
          {suggest.length > 0 && (
            <div className="absolute left-0 right-0 top-12 z-40 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
              {suggest.map((h) => (
                <button key={h.id} onClick={() => pick(h)} className="flex w-full items-center justify-between px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50">
                  <span>{h.name}</span><span className="text-[11px] font-bold text-slate-400">{h.pgCount} PG</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => setLive((v) => !v)} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">
          {live ? <Play size={12} className="text-emerald-500" /> : <Pause size={12} />}
          {live ? `Live · ${stamp}` : 'Paused'}
        </button>
        <button onClick={load} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">
          <RefreshCw size={14} /> Reset
        </button>
      </div>

      <div className="absolute left-1/2 top-[68px] z-10 -translate-x-1/2 text-[12px] font-medium text-slate-400">{banner}</div>
      {err && <div className="absolute left-1/2 top-[92px] z-10 -translate-x-1/2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1 text-[12px] text-rose-700">{err}</div>}

      <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full">
        <g ref={viewRef}><g ref={linksRef} /><g ref={nodesRef} /></g>
      </svg>

      {/* zoom controls */}
      <div className="absolute bottom-5 right-5 z-20 flex flex-col gap-1.5">
        <button title="Zoom in" onClick={zoomIn} className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50"><Plus size={16} /></button>
        <button title="Zoom out" onClick={zoomOut} className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50"><Minus size={16} /></button>
        <button title="Fit" onClick={zoomFit} className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50"><Maximize size={16} /></button>
      </div>

      {/* legend */}
      <div className="absolute bottom-4 left-6 z-20 flex flex-wrap gap-3 rounded-xl border border-slate-200 bg-white/90 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 shadow-sm">
        {[['agency', COLORS.hhah], ['patients', COLORS.edge], ['physician group', COLORS.pg], ['adm', COLORS.adm], ['epi', COLORS.epi], ['orders', COLORS.order]].map(([l, c]) => (
          <span key={l} className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />{l}</span>
        ))}
      </div>
    </div>
  );
}
