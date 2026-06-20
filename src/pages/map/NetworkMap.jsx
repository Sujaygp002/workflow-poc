import { useEffect, useRef, useState, useCallback } from 'react';
import { Network, Search, Plus, Minus, Maximize, RefreshCw, Pause, Play } from 'lucide-react';
import { fetchPatients, fetchOrders, fetchReferenceData } from '../../lib/workflowApi';
import { buildGraph, edgesForHhah, fmtCount } from './graph';

const VW = 960, VH = 600;
const SVGNS = 'http://www.w3.org/2000/svg';
const COLORS = { hhah: '#38D9C4', pg: '#9C8CFF', edge: '#FFB454', adm: '#FFD27A', admBucket: '#FFC25A', epi: '#7BE0B0', epBucket: '#5FD39E', billBucket: '#8FD16B', order: '#F26D7D', otype: '#F58AA0', metric: '#7AA7FF' };
const RAD = { hhah: 24, pg: 16, edge: 24, adm: 22, admBucket: 20, epi: 22, epBucket: 20, billBucket: 18, order: 22, otype: 19, metric: 17 };

// Imperative force-graph engine bound to one <g> element. Kept in a ref so React
// re-renders (chrome) don't tear down the simulation. Mirrors the verified prototype.
function createEngine(nodesG, linksG, viewG, { onBanner }) {
  let nodes = [], links = [], byId = {}, hover = null, drag = null, zoomMul = 1, graph = { hhahs: [], edges: [], practitionersByPg: {} };
  const fmt = fmtCount;

  function addNode(o) {
    const n = Object.assign({ r: RAD[o.kind] || 10, open: false }, o);
    // rendered position eases toward the logical (x,y). New balls fade/scale in.
    n.rx = n.x; n.ry = n.y; n.appear = 0;
    nodes.push(n); byId[n.id] = n;
    const g = document.createElementNS(SVGNS, 'g'); g.setAttribute('class', 'mapnode'); g.style.cursor = 'pointer';
    g.style.touchAction = 'none';
    g.style.userSelect = 'none';
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
    g.addEventListener('pointerdown', (ev) => startDrag(n, ev));
    g.addEventListener('pointermove', (ev) => moveDrag(n, ev));
    g.addEventListener('pointerup', (ev) => endDrag(n, ev));
    g.addEventListener('pointercancel', (ev) => endDrag(n, ev));
    g.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (n.ignoreClick) {
        n.ignoreClick = false;
        return;
      }
      onClick(n);
    });
    g.addEventListener('mouseenter', () => { hover = n; render(); });
    g.addEventListener('mouseleave', () => { hover = null; render(); });
    return n;
  }
  function addLink(a, b, kind) { const l = { a, b, kind }; links.push(l); const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('fill', 'none'); linksG.appendChild(p); l.el = p; return l; }

  function eventPoint(ev) {
    const svg = nodesG.ownerSVGElement;
    const matrix = viewG.getScreenCTM()?.inverse();
    if (!svg || !matrix) return { x: 0, y: 0 };
    const p = svg.createSVGPoint();
    p.x = ev.clientX;
    p.y = ev.clientY;
    return p.matrixTransform(matrix);
  }

  function startDrag(n, ev) {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const p = eventPoint(ev);
    drag = { id: ev.pointerId, node: n, dx: n.x - p.x, dy: n.y - p.y, sx: n.x, sy: n.y, moved: false };
    n.dragging = true;
    n.dragPinned = true;
    n.fx = n.x;
    n.fy = n.y;
    n.el.g.style.cursor = 'grabbing';
    n.el.g.setPointerCapture?.(ev.pointerId);
    onBanner('Drag any ball to reposition it · connected lines stay attached');
    render();
  }

  function moveDrag(n, ev) {
    if (!drag || drag.node !== n || drag.id !== ev.pointerId) return;
    ev.preventDefault();
    ev.stopPropagation();
    const p = eventPoint(ev);
    n.x = p.x + drag.dx;
    n.y = p.y + drag.dy;
    n.fx = n.x;
    n.fy = n.y;
    // dragged ball tracks the pointer with zero lag (its links redraw from rx/ry)
    n.rx = n.x;
    n.ry = n.y;
    if (Math.hypot(n.x - drag.sx, n.y - drag.sy) > 3) drag.moved = true;
    render();
  }

  function endDrag(n, ev) {
    if (!drag || drag.node !== n || drag.id !== ev.pointerId) return;
    ev.preventDefault();
    ev.stopPropagation();
    n.dragging = false;
    n.ignoreClick = drag.moved;
    n.el.g.style.cursor = 'pointer';
    n.el.g.releasePointerCapture?.(ev.pointerId);
    drag = null;
    animate();
  }

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
      const child = addNode(Object.assign({ id, kind: k, label: labelFn(it), x: parent.x + Math.cos(ang) * d, y: parent.y + Math.sin(ang) * d, ref: it }, extraFn ? extraFn(it) : {}));
      // start the new ball at the parent so it springs outward from where it was clicked
      child.rx = parent.rx ?? parent.x; child.ry = parent.ry ?? parent.y;
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
      onBanner('Click the patient count, then admissions, then episodes, then orders');
    } else if (n.kind === 'edge') {
      // patient-count → single Admissions ball (mirrors patient page: Patient → Admission)
      n.open = true; const s = n.ref.stats;
      const blocks = [{ k: 'adm', c: s.admissions || 0, stats: s }];
      spawn(n, blocks, (b) => `${b.k}:${n.id}`, (b) => b.k, () => '', (b) => ({ count: b.c, stats: b.stats }));
      onBanner('Click admissions to open new + old admissions');
    } else if (n.kind === 'adm') {
      // Admissions → clickable New + Old admission balls (each drills into its own episodes)
      n.open = true; const s = n.stats || {};
      const blocks = [
        { k: 'newAdm', type: 'admBucket', c: s.newAdmissions || 0, stats: s, label: 'New Admissions', short: 'NEW ADM', age: 'new' },
        { k: 'oldAdm', type: 'admBucket', c: s.oldAdmissions || 0, stats: s, label: 'Old Admissions', short: 'OLD ADM', age: 'old' },
      ];
      spawn(n, blocks, (b) => `${b.k}:${n.id}`, (b) => b.type, (b) => b.label || '', (b) => ({ count: b.c, stats: b.stats, statLabel: b.short || b.label, age: b.age }));
      onBanner('Click an admission bucket to show its episodes');
    } else if (n.kind === 'admBucket') {
      // New/Old admission → single Episodes ball scoped to this admission age
      n.open = true; const s = n.stats || {};
      const epCount = (n.age === 'old' ? s.oldEpisodes : s.newEpisodes) || 0;
      const blocks = [{ k: 'epi', type: 'epi', c: epCount, stats: s, age: n.age }];
      spawn(n, blocks, (b) => `${b.k}:${n.id}`, (b) => b.type, () => '', (b) => ({ count: b.c, stats: b.stats, age: b.age }));
      onBanner('Click episodes to open new + old episodes');
    } else if (n.kind === 'epi') {
      // Episodes → clickable New + Old episode balls (billed/unbilled live UNDER these)
      n.open = true; const s = n.stats || {};
      const blocks = [
        { k: 'newEp', type: 'epBucket', c: s.newEpisodes || 0, stats: s, label: 'New Episodes', short: 'NEW EP', age: 'new' },
        { k: 'oldEp', type: 'epBucket', c: s.oldEpisodes || 0, stats: s, label: 'Old Episodes', short: 'OLD EP', age: 'old' },
      ];
      spawn(n, blocks, (b) => `${b.k}:${n.id}`, (b) => b.type, (b) => b.label || '', (b) => ({ count: b.c, stats: b.stats, statLabel: b.short || b.label, age: b.age }));
      onBanner('Click an episode bucket to show billed + unbilled');
    } else if (n.kind === 'epBucket') {
      // New/Old episode → clickable Billed + Unbilled balls (each drills into its orders)
      n.open = true; const s = n.stats || {};
      const blocks = [
        { k: 'billed', type: 'billBucket', c: s.billedEpisodes || 0, stats: s, label: 'Billed', short: 'BILLED', billed: true },
        { k: 'unbilled', type: 'billBucket', c: s.unbilledEpisodes || 0, stats: s, label: 'Unbilled', short: 'UNBILLED', billed: false },
        { k: 'eligible', type: 'billBucket', c: s.eligibleEpisodes || 0, stats: s, label: 'Eligible', short: 'ELIGIBLE', billed: true },
      ];
      spawn(n, blocks, (b) => `${b.k}:${n.id}`, (b) => b.type, (b) => b.label || '', (b) => ({ count: b.c, stats: b.stats, statLabel: b.short || b.label, age: n.age, billed: b.billed }));
      onBanner('Click billed or unbilled to show its orders');
    } else if (n.kind === 'billBucket') {
      // Billed/Unbilled episode → single Orders ball scoped to this bucket
      n.open = true; const s = n.stats || {};
      const blocks = [{ k: 'order', type: 'order', c: s.orders || 0, stats: s, bd: { o485: s.o485 || 0, f2f: s.f2f || 0, other: s.other || 0 } }];
      spawn(n, blocks, (b) => `${b.k}:${n.id}`, (b) => b.type, () => '', (b) => ({ count: b.c, stats: b.stats, breakdown: b.bd }));
      onBanner('Click orders to show signed/unsigned and 485 · F2F · other');
    } else if (n.kind === 'order' && n.breakdown) {
      n.open = true; const b = n.breakdown; const s = n.stats || {};
      spawn(n, [
        { k: 'signed', type: 'metric', l: 'Signed orders', short: 'SIGNED', c: s.signedOrders },
        { k: 'unsigned', type: 'metric', l: 'Unsigned orders', short: 'UNSIGNED', c: s.unsignedOrders },
        { k: 'o485', type: 'otype', l: '485 cert/recert', c: b.o485 },
        { k: 'f2f', type: 'otype', l: 'F2F', c: b.f2f },
        { k: 'other', type: 'otype', l: 'Other orders', c: b.other },
      ], (t) => `${t.type}:${n.id}:${t.k}`, (t) => t.type, (t) => t.l, (t) => ({ count: t.c, statLabel: t.short || t.l }));
      onBanner('Orders show signed/unsigned counts and 485 · F2F · other types');
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
    nodes.filter((n) => n.kind === 'edge' && !n.dragPinned).forEach((e) => { const ids = links; const hl = ids.find((l) => l.b === e.id && byId[l.a]?.kind === 'hhah'); const pl = ids.find((l) => l.a === e.id && byId[l.b]?.kind === 'pg'); const A = hl && byId[hl.a], P = pl && byId[pl.b]; if (A && P) { e.x = (A.x + P.x) / 2; e.y = (A.y + P.y) / 2; } });
    for (let p = 0; p < 40; p++) { const edges = live.filter((n) => n.kind === 'edge'); for (const e of edges) for (const b of live) { if (b === e || b.kind === 'edge') continue; let dx = b.x - e.x, dy = b.y - e.y, d = Math.hypot(dx, dy) || 0.01, min = e.r + b.r + 18; if (d < min) { const push = min - d; b.x += (dx / d) * push; b.y += (dy / d) * push; } } }
    fitView(); animate();
  }

  function countDisplay(n) {
    if (n.kind === 'edge') return { num: fmt(n.ref.stats.patients), label: 'PATIENTS' };
    if (n.kind === 'adm') return { num: fmt(n.count), label: 'ADMISSIONS' };
    if (n.kind === 'admBucket') return { num: fmt(n.count), label: (n.statLabel || '').toUpperCase().slice(0, 11) };
    if (n.kind === 'epi') return { num: fmt(n.count), label: 'EPISODES' };
    if (n.kind === 'epBucket') return { num: fmt(n.count), label: (n.statLabel || '').toUpperCase().slice(0, 11) };
    if (n.kind === 'billBucket') return { num: fmt(n.count), label: (n.statLabel || '').toUpperCase().slice(0, 11) };
    if (n.kind === 'order') return { num: fmt(n.count), label: 'ORDERS' };
    if (n.kind === 'otype') return { num: fmt(n.count), label: (n.statLabel || '').toUpperCase().slice(0, 11) };
    if (n.kind === 'metric') return { num: fmt(n.count), label: (n.statLabel || n.label || '').toUpperCase().slice(0, 11) };
    return null;
  }
  function render() {
    links.forEach((l) => { const a = byId[l.a], b = byId[l.b]; if (!a || !b || a.hidden || b.hidden) { if (l.el) l.el.style.display = 'none'; return; } l.el.style.display = '';
      // draw from the RENDERED (eased/dragged) coords so links stay glued to the balls mid-animation
      const ax = a.rx, ay = a.ry, bx = b.rx, by = b.ry;
      const sel = hover && (hover.id === a.id || hover.id === b.id); const mx = (ax + bx) / 2, my = (ay + by) / 2 - 10;
      l.el.setAttribute('d', `M${ax.toFixed(1)},${ay.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}`);
      l.el.setAttribute('stroke', l.kind === 'pg' ? '#9C8CFF' : '#7892c0'); l.el.setAttribute('stroke-width', sel ? 2 : 1); l.el.setAttribute('opacity', sel ? 0.85 : 0.22);
    });
    nodes.forEach((n) => { if (n.hidden) { n.el.g.style.display = 'none'; return; } n.el.g.style.display = '';
      const r = n.r, c = COLORS[n.kind];
      // appear: 0→1 spring-in scale for freshly spawned balls
      const sc = 0.6 + 0.4 * (n.appear ?? 1);
      n.el.g.setAttribute('transform', `translate(${n.rx.toFixed(1)},${n.ry.toFixed(1)}) scale(${sc.toFixed(3)})`);
      n.el.g.style.opacity = (0.25 + 0.75 * (n.appear ?? 1)).toFixed(2);
      n.el.glow.setAttribute('r', (r * 2.1).toFixed(1)); n.el.glow.setAttribute('fill', c); n.el.glow.setAttribute('opacity', '0.12');
      n.el.core.setAttribute('r', r.toFixed(1));
      const expandable = ['hhah', 'edge', 'adm', 'admBucket', 'epi', 'epBucket', 'billBucket'].includes(n.kind) || (n.kind === 'order' && n.breakdown);
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
      if (showLabel) { const lbl = named ? n.label : (n.label || (cd ? cd.label.toLowerCase() : '')); n.el.label.textContent = lbl.length > 22 ? `${lbl.slice(0, 21)}…` : lbl; n.el.label.setAttribute('y', (r + 14).toFixed(1)); n.el.label.setAttribute('font-size', '11'); } else n.el.label.textContent = '';
    });
  }

  // ---- animation loop: ease rendered coords toward logical coords + spring-in new balls ----
  let raf = 0;
  function tick() {
    let busy = false;
    for (const n of nodes) {
      if (n.hidden) continue;
      if (!n.dragging) {
        const dx = n.x - n.rx, dy = n.y - n.ry;
        if (Math.abs(dx) > 0.4 || Math.abs(dy) > 0.4) { n.rx += dx * 0.18; n.ry += dy * 0.18; busy = true; }
        else { n.rx = n.x; n.ry = n.y; }
      }
      if ((n.appear ?? 1) < 1) { n.appear = Math.min(1, (n.appear ?? 1) + 0.08); busy = true; }
    }
    render();
    raf = busy ? requestAnimationFrame(tick) : 0;
  }
  function animate() { if (!raf) raf = requestAnimationFrame(tick); }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

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
    stop,
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
    return () => engineRef.current?.stop?.();
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
        {[['agency', COLORS.hhah], ['patients', COLORS.edge], ['physician group', COLORS.pg], ['adm', COLORS.adm], ['old/new adm', COLORS.admBucket], ['epi', COLORS.epi], ['old/new epi', COLORS.epBucket], ['billed/unbilled', COLORS.billBucket], ['orders', COLORS.order], ['status counts', COLORS.metric]].map(([l, c]) => (
          <span key={l} className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />{l}</span>
        ))}
      </div>
    </div>
  );
}
