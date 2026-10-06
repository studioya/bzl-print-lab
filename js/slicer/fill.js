// Infill pattern generators. All output is in mm as flat polylines
// (Float32Array [x0,y0,x1,y1,...]) in the object's XY frame.

import { SCALE, clipLines } from './clip.js';

/**
 * Parallel lines at `angleDeg` with `spacing` mm, clipped to the region.
 * Lines are returned in serpentine order (alternating direction), like
 * Bambu's monotonic / rectilinear fills. Uses a scanline sweep.
 */
export function linesFill(region, angleDeg, spacing) {
  if (!region.length) return [];
  const a = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(-a), sa = Math.sin(-a);
  // Rotate edges into a frame where the fill lines are horizontal.
  const edges = [];
  let minY = Infinity, maxY = -Infinity;
  for (const path of region) {
    const n = path.length;
    for (let i = 0; i < n; i++) {
      const p = path[i], q = path[(i + 1) % n];
      const x1 = (p.X * ca - p.Y * sa) / SCALE, y1 = (p.X * sa + p.Y * ca) / SCALE;
      const x2 = (q.X * ca - q.Y * sa) / SCALE, y2 = (q.X * sa + q.Y * ca) / SCALE;
      if (y1 === y2) continue;
      const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
      edges.push(y1 < y2 ? [lo, hi, x1, (x2 - x1) / (y2 - y1)] : [lo, hi, x2, (x1 - x2) / (y1 - y2)]);
      if (lo < minY) minY = lo;
      if (hi > maxY) maxY = hi;
    }
  }
  edges.sort((e, f) => e[0] - f[0]);

  // Sweep rows and group segments into monotonic strips: a segment joins the
  // strip whose previous-row segment overlaps it, so each connected part of
  // the region is filled in one serpentine pass (no jumps across holes).
  const chains = [];
  let open = [];
  let ei = 0;
  let active = [];
  const first = Math.ceil(minY / spacing + 1e-9) * spacing; // global grid
  for (let y = first, row = 0; y <= maxY; y += spacing, row++) {
    while (ei < edges.length && edges[ei][0] <= y) active.push(edges[ei++]);
    active = active.filter((e) => e[1] > y);
    const xs = [];
    for (const e of active) if (y >= e[0]) xs.push(e[2] + (y - e[0]) * e[3]);
    xs.sort((p, q) => p - q);
    const nextOpen = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x1 = xs[i], x2 = xs[i + 1];
      if (x2 - x1 < 0.05) continue;
      let chain = null;
      for (let k = 0; k < open.length; k++) {
        const c = open[k];
        if (c.row === row - 1 && c.x1 < x2 && c.x2 > x1) { chain = c; open.splice(k, 1); break; }
      }
      if (!chain) { chain = { segs: [] }; chains.push(chain); }
      chain.segs.push([x1, x2, y]);
      chain.row = row; chain.x1 = x1; chain.x2 = x2;
      nextOpen.push(chain);
    }
    open = nextOpen;
  }

  const cb = Math.cos(a), sb = Math.sin(a);
  const out = [];
  for (const chain of chains) {
    chain.segs.forEach(([x1, x2, y], k) => {
      const sx = k % 2 ? x2 : x1, ex = k % 2 ? x1 : x2;
      out.push(Float32Array.of(sx * cb - y * sb, sx * sb + y * cb, ex * cb - y * sb, ex * sb + y * cb));
    });
  }
  return out;
}

// ---- Gyroid (port of the PrusaSlicer/Bambu Studio FillGyroid wave generator) ----

const DENSITY_ADJUST = 2.44;
const PATTERN_TOLERANCE = 0.2;

function gyroidF(x, zSin, zCos, vertical, flip) {
  if (vertical) {
    const phase = (zCos < 0 ? Math.PI : 0) + Math.PI;
    const a = Math.sin(x + phase);
    const b = -zCos;
    const res = zSin * Math.cos(x + phase + (flip ? Math.PI : 0));
    const r = Math.sqrt(a * a + b * b);
    return Math.asin(clamp(a / r)) + Math.asin(clamp(res / r)) + Math.PI;
  }
  const phase = zSin < 0 ? Math.PI : 0;
  const a = Math.cos(x + phase);
  const b = -zSin;
  const res = zCos * Math.sin(x + phase + (flip ? 0 : Math.PI));
  const r = Math.sqrt(a * a + b * b);
  return Math.asin(clamp(a / r)) + Math.asin(clamp(res / r)) + 0.5 * Math.PI;
}
function clamp(v) { return v > 1 ? 1 : v < -1 ? -1 : v; }

function onePeriod(width, zSin, zCos, vertical, flip, tol) {
  const pts = [];
  const limit = Math.min(2 * Math.PI, width);
  for (let x = 0; x < limit - 1e-9; x += tol) pts.push([x, gyroidF(x, zSin, zCos, vertical, flip)]);
  pts.push([limit, gyroidF(limit, zSin, zCos, vertical, flip)]);
  return pts;
}

/**
 * Gyroid sparse infill for one layer.
 * @param region Clipper paths (fill area)
 * @param density 0..1
 * @param spacing extrusion spacing in mm
 * @param z layer top z in mm
 * @param angleDeg pattern rotation
 */
export function gyroidFill(region, density, spacing, z, angleDeg = 45) {
  if (!region.length || density <= 0) return [];
  const dAdj = density * DENSITY_ADJUST;
  const sf = spacing / dAdj; // mm per gyroid unit
  const tol = Math.max(0.15, Math.min(spacing / 2, PATTERN_TOLERANCE) / sf * 3);
  const zz = z / sf;
  const zSin = Math.sin(zz), zCos = Math.cos(zz);
  const vertical = Math.abs(zSin) <= Math.abs(zCos);

  // Work in a rotated frame; snap the origin to the pattern period so the
  // waves line up from layer to layer.
  const a = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(-a), sa = Math.sin(-a);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const path of region) for (const p of path) {
    const x = (p.X * ca - p.Y * sa) / SCALE, y = (p.X * sa + p.Y * ca) / SCALE;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const period = 2 * Math.PI * sf;
  const ox = Math.floor(minX / period) * period - period;
  const oy = Math.floor(minY / period) * period - period;
  let width = (maxX - ox) / sf + 2 * Math.PI;
  let height = (maxY - oy) / sf + 2 * Math.PI;

  let lower = 0, upper = height;
  let flip = true;
  if (vertical) {
    flip = false;
    lower = -Math.PI;
    upper = width - Math.PI / 2;
    [width, height] = [height, width];
  }
  const odd = onePeriod(width, zSin, zCos, vertical, flip, tol);
  const even = onePeriod(width, zSin, zCos, vertical, !flip, tol);

  const cb = Math.cos(a), sb = Math.sin(a);
  const lines = [];
  const makeWave = (one, y0) => {
    const path = [];
    for (let base = 0; base < width; base += 2 * Math.PI) {
      for (let k = base === 0 ? 0 : 1; k < one.length; k++) {
        const px = one[k][0] + base;
        if (px > width + 1e-9) break;
        let gx = px, gy = one[k][1] + y0;
        if (vertical) [gx, gy] = [gy, gx];
        const fx = ox + gx * sf, fy = oy + gy * sf;
        path.push({ X: Math.round((fx * cb - fy * sb) * SCALE), Y: Math.round((fx * sb + fy * cb) * SCALE) });
      }
    }
    if (path.length > 1) lines.push(path);
  };
  for (let y0 = lower; y0 < upper + 1e-9; y0 += Math.PI) {
    makeWave(odd, y0);
    y0 += Math.PI;
    if (y0 < upper + 1e-9) makeWave(even, y0);
  }

  const clipped = clipLines(lines, region);
  const out = [];
  for (const p of clipped) {
    if (p.length < 2) continue;
    const f = new Float32Array(p.length * 2);
    for (let i = 0; i < p.length; i++) { f[i * 2] = p[i].X / SCALE; f[i * 2 + 1] = p[i].Y / SCALE; }
    if (polylineLength(f) >= 0.5) out.push(f);
  }
  return out;
}

export function polylineLength(f) {
  let L = 0;
  for (let i = 2; i < f.length; i += 2) L += Math.hypot(f[i] - f[i - 2], f[i + 1] - f[i - 1]);
  return L;
}

/** Greedy nearest-neighbour ordering of open polylines (may reverse them). */
export function orderPolylines(polys, startX, startY) {
  const out = [];
  const left = polys.slice();
  let x = startX, y = startY;
  while (left.length) {
    let best = 0, bestD = Infinity, rev = false;
    for (let i = 0; i < left.length; i++) {
      const p = left[i];
      const d1 = (p[0] - x) ** 2 + (p[1] - y) ** 2;
      const d2 = (p[p.length - 2] - x) ** 2 + (p[p.length - 1] - y) ** 2;
      if (d1 < bestD) { bestD = d1; best = i; rev = false; }
      if (d2 < bestD) { bestD = d2; best = i; rev = true; }
    }
    let p = left.splice(best, 1)[0];
    if (rev) p = reversePolyline(p);
    out.push(p);
    x = p[p.length - 2]; y = p[p.length - 1];
  }
  return out;
}

export function reversePolyline(p) {
  const r = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 2) {
    r[p.length - 2 - i] = p[i];
    r[p.length - 1 - i] = p[i + 1];
  }
  return r;
}
