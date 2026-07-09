// One MSA (Metropolitan Statistical Area) polygon for the Coverage Map.
//
// The map renders every agency + physician group INSIDE this polygon. There is no
// statistical_areas geometry in the DB (area metadata carries no GeoJSON), so this
// is a client-side constant. It is shaped to the live TEST data: the active agency
// Nightingale Visiting Nurses is in Taunton, Bristol County, Massachusetts, so the
// polygon is a stylized Bristol-County / Taunton-MSA outline drawn in the map's
// 960×600 view box. It is NOT a survey-accurate boundary — it is a recognizable
// region silhouette that gives the agencies/PGs a "coverage area" to live inside.
//
// Coordinates are in the SAME coordinate space as the graph nodes (the SVG view box
// VW=960 × VH=600), so agencies/PGs can be placed against it directly.

export const MSA = {
  name: 'Taunton–Bristol County MSA',
  state: 'Massachusetts',
  // A closed ring in view-box units. Kept convex-ish so seeded interior points
  // (see pointInsideMsa / seedInside) always land on land.
  ring: [
    [300, 120],
    [470, 96],
    [620, 130],
    [690, 210],
    [700, 330],
    [648, 430],
    [545, 492],
    [420, 500],
    [318, 452],
    [268, 350],
    [262, 228],
  ],
};

// Axis-aligned bounds of the ring — used to seed interior positions.
export function msaBounds(ring = MSA.ring) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of ring) {
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
  }
  return { minx, miny, maxx, maxy, cx: (minx + maxx) / 2, cy: (miny + maxy) / 2 };
}

// Centroid of the ring (polygon centroid, area-weighted).
export function msaCentroid(ring = MSA.ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-6) { const b = msaBounds(ring); return [b.cx, b.cy]; }
  return [cx / (6 * a), cy / (6 * a)];
}

// Point-in-polygon (ray cast). True when (x,y) is inside the ring.
export function pointInsideMsa(x, y, ring = MSA.ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = (yi > y) !== (yj > y)
      && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// The SVG path `d` string for the closed ring.
export function msaPathD(ring = MSA.ring) {
  if (!ring.length) return '';
  return `${ring.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ')} Z`;
}

// Deterministically seed N interior positions on a ring/spiral pulled toward the
// centroid, then nudged inward until each point is inside the polygon. Deterministic
// (no Math.random) so a live re-poll never reshuffles the layout.
export function seedInside(count, { ring = MSA.ring, radius = 0.62, phase = 0 } = {}) {
  const [cx, cy] = msaCentroid(ring);
  const b = msaBounds(ring);
  const rx = ((b.maxx - b.minx) / 2) * radius;
  const ry = ((b.maxy - b.miny) / 2) * radius;
  const out = [];
  const N = Math.max(count, 1);
  for (let i = 0; i < count; i++) {
    const ang = phase + (i / N) * Math.PI * 2;
    // spread across two soft rings so a handful of balls don't sit on one circle
    const ringMul = count > 6 ? (i % 2 === 0 ? 0.72 : 1) : 1;
    let x = cx + Math.cos(ang) * rx * ringMul;
    let y = cy + Math.sin(ang) * ry * ringMul;
    // pull toward centroid until inside (guards odd concave edges)
    let guard = 0;
    while (!pointInsideMsa(x, y, ring) && guard < 20) {
      x = x + (cx - x) * 0.18;
      y = y + (cy - y) * 0.18;
      guard += 1;
    }
    out.push([x, y]);
  }
  return out;
}
