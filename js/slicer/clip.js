// Thin wrapper around Clipper (integer polygon boolean ops + offsetting).
// Polygons are arrays of {X, Y} integer points in SCALE units (1 unit = 1 µm).
// A "paths" value is an array of polygons; outer contours are CCW and holes CW
// after any union/boolean op.

import ClipperLib from '../../vendor/clipper.min.js';

export const SCALE = 1000;
export const C = ClipperLib;

const NZ = C.PolyFillType.pftNonZero;

function exec(type, subject, clip, fill = NZ) {
  const c = new C.Clipper();
  if (subject.length) c.AddPaths(subject, C.PolyType.ptSubject, true);
  if (clip && clip.length) c.AddPaths(clip, C.PolyType.ptClip, true);
  const out = [];
  c.Execute(type, out, fill, fill);
  return out;
}

export function union(a, b = null, fill = NZ) {
  if (!a.length && (!b || !b.length)) return [];
  return exec(C.ClipType.ctUnion, a, b, fill);
}

export function diff(a, b) {
  if (!a.length) return [];
  if (!b.length) return a;
  return exec(C.ClipType.ctDifference, a, b);
}

export function intersect(a, b) {
  if (!a.length || !b.length) return [];
  return exec(C.ClipType.ctIntersection, a, b);
}

/** Offset closed polygons by delta millimetres (negative = shrink). */
export function offset(paths, deltaMm, join = C.JoinType.jtMiter) {
  if (!paths.length) return [];
  const co = new C.ClipperOffset(3, 0.02 * SCALE);
  co.AddPaths(paths, join, C.EndType.etClosedPolygon);
  const out = [];
  co.Execute(out, deltaMm * SCALE);
  return out;
}

/** Morphological opening: removes features thinner than 2*r. */
export function opening(paths, r) {
  return offset(offset(paths, -r), r);
}

/** Splits paths into islands: [{ outer, holes }]. */
export function toExPolygons(paths) {
  if (!paths.length) return [];
  const c = new C.Clipper();
  c.AddPaths(paths, C.PolyType.ptSubject, true);
  const tree = new C.PolyTree();
  c.Execute(C.ClipType.ctUnion, tree, NZ, NZ);
  return C.JS.PolyTreeToExPolygons(tree);
}

export function exToPaths(ex) {
  return [ex.outer, ...ex.holes];
}

/** Signed area sum in mm² (holes subtract). */
export function area(paths) {
  let a = 0;
  for (const p of paths) a += C.Clipper.Area(p);
  return a / (SCALE * SCALE);
}

/** Removes polygons whose absolute area is below minMm2 (keeps holes of kept outers). */
export function dropSmall(paths, minMm2) {
  const min = minMm2 * SCALE * SCALE;
  return paths.filter((p) => Math.abs(C.Clipper.Area(p)) >= min);
}

export function clean(paths, distMm = 0.01) {
  return C.Clipper.CleanPolygons(paths, distMm * SCALE).filter((p) => p.length >= 3);
}

/**
 * Douglas–Peucker simplification of closed polygons (max deviation tolMm),
 * like Bambu Studio's slicing "resolution". Unlike Clipper's CleanPolygons it
 * doesn't let small deviations accumulate along gentle curves.
 */
export function simplify(paths, tolMm = 0.0125) {
  const tol2 = (tolMm * SCALE) ** 2;
  const out = [];
  for (const p of paths) {
    const n = p.length;
    if (n < 4) { if (n >= 3) out.push(p); continue; }
    // Start at the lowest (then leftmost) vertex — an extreme point, so the
    // same shape always simplifies to the same polygon however its vertices
    // were sampled — and split the loop there and at the farthest vertex.
    let lo = 0;
    for (let i = 1; i < n; i++) if (p[i].Y < p[lo].Y || (p[i].Y === p[lo].Y && p[i].X < p[lo].X)) lo = i;
    const r = lo ? p.slice(lo).concat(p.slice(0, lo)) : p;
    let far = 0, farD = -1;
    for (let i = 1; i < n; i++) {
      const d = (r[i].X - r[0].X) ** 2 + (r[i].Y - r[0].Y) ** 2;
      if (d > farD) { farD = d; far = i; }
    }
    const keep = new Uint8Array(n);
    keep[0] = 1; keep[far] = 1;
    dp(r, 0, far, tol2, keep);
    dp(r, far, n, tol2, keep);
    const q = [];
    for (let i = 0; i < n; i++) if (keep[i]) q.push(r[i]);
    if (q.length >= 3) out.push(q);
  }
  return out;
}

function dp(p, a, b, tol2, keep) {
  // Iterative Douglas–Peucker on p[a..b] (b may equal p.length, meaning p[0]).
  const n = p.length;
  const stack = [a, b];
  while (stack.length) {
    const e = stack.pop(), s = stack.pop();
    if (e - s < 2) continue;
    const A = p[s], B = p[e % n];
    const dx = B.X - A.X, dy = B.Y - A.Y;
    const len2 = dx * dx + dy * dy;
    let idx = -1, maxD = tol2;
    for (let i = s + 1; i < e; i++) {
      const P = p[i];
      let d;
      if (len2 === 0) d = (P.X - A.X) ** 2 + (P.Y - A.Y) ** 2;
      else {
        const cr = (P.X - A.X) * dy - (P.Y - A.Y) * dx;
        d = (cr * cr) / len2;
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push(s, idx, idx, e); }
  }
}

/** Clips open polylines (arrays of {X,Y}) to the region; returns open paths. */
export function clipLines(lines, region) {
  if (!lines.length || !region.length) return [];
  const c = new C.Clipper();
  c.AddPaths(lines, C.PolyType.ptSubject, false);
  c.AddPaths(region, C.PolyType.ptClip, true);
  const tree = new C.PolyTree();
  c.Execute(C.ClipType.ctIntersection, tree, NZ, NZ);
  return C.Clipper.OpenPathsFromPolyTree(tree);
}

export function bounds(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) {
    for (const pt of p) {
      if (pt.X < minX) minX = pt.X;
      if (pt.X > maxX) maxX = pt.X;
      if (pt.Y < minY) minY = pt.Y;
      if (pt.Y > maxY) maxY = pt.Y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Converts a Clipper polygon to a flat mm array [x0,y0,x1,y1,...]. */
export function toFlat(path, close = false) {
  const n = path.length + (close ? 1 : 0);
  const out = new Float32Array(n * 2);
  for (let i = 0; i < path.length; i++) {
    out[i * 2] = path[i].X / SCALE;
    out[i * 2 + 1] = path[i].Y / SCALE;
  }
  if (close && path.length) {
    out[path.length * 2] = path[0].X / SCALE;
    out[path.length * 2 + 1] = path[0].Y / SCALE;
  }
  return out;
}
