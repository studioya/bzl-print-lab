// Support generation approximating Bambu Studio's "tree(auto)" supports:
//  1. find overhang areas steeper than the profile's threshold angle,
//  2. project them down (keeping an XY gap to the model) — with
//     "on build plate only", columns that would land on the model are dropped,
//  3. print dense interface layers just under the overhang and thin
//     branch columns (growing slightly in diameter) below that.

import { SCALE, C, union, diff, intersect, offset, dropSmall, bounds, simplify } from './clip.js';
import { linesFill } from './fill.js';
import { F } from './features.js';

const BRANCH_GRID = 6;          // mm between branch tips
const BRANCH_GROWTH = 0.06;     // radius growth per mm of depth below the tip
const BRANCH_MAX_RADIUS = 3;    // mm
const MERGE_DEPTH = 12;         // every this many mm down, branches merge 2×2 → 1
const MAX_MERGE_LEVEL = 2;      // up to 24 mm between trunks

export function generateSupports(slices, layers, proc, onProgress) {
  const n = layers.length;
  const out = Array.from({ length: n }, () => []);
  const sup = proc.support;
  if (!sup.enabled || n < 2) return { paths: out, hasSupport: false };

  const w = proc.lineWidth.support;
  const theta = ((sup.thresholdAngle || 30) * Math.PI) / 180;
  const xy = sup.objectXYDistance;

  // 1. Overhang (contact) areas per layer.
  const contact = new Array(n).fill(null);
  let any = false;
  for (let i = 1; i < n; i++) {
    if (!slices[i].length) continue;
    const allowed = layers[i].h / Math.tan(theta);
    const c = dropSmall(diff(slices[i], offset(slices[i - 1], allowed)), 0.2);
    // Grow each overhang strip by the self-supporting distance so the strips of
    // consecutive layers merge into one continuous area (the model itself is
    // cut away again below). Detail finer than 0.1 mm isn't needed for support.
    if (c.length) { contact[i] = simplify(offset(c, allowed + 0.05), 0.1); any = true; }
  }
  if (!any) return { paths: out, hasSupport: false };

  const topContact = contact.reduce((m, c, i) => (c ? i : m), 0);

  // Region support may not occupy at each layer, already grown by the XY gap:
  // the model at that layer, or — with "on build plate only" — anything at or
  // below it (a column must reach the plate without landing on the model).
  const blocked = new Array(topContact + 1);
  let acc = [];
  for (let j = 0; j <= topContact; j++) {
    const here = slices[j].length ? offset(slices[j], xy) : [];
    if (sup.onBuildPlateOnly) {
      if (here.length) acc = simplify(union(acc, here), 0.1);
      blocked[j] = acc;
    } else {
      blocked[j] = here;
    }
  }

  // 2. Project contacts downward.
  const area = new Array(n).fill(null);
  const iface = new Array(n).fill(null);
  let A = [];
  for (let j = topContact; j >= 0; j--) {
    const gap = Math.max(1, Math.round(sup.topZDistance / layers[j].h));
    const src = contact[j + 1 + gap];
    if (src) A = union(A, src);
    if (!A.length) continue;
    if (blocked[j].length) A = diff(A, blocked[j]);
    A = dropSmall(simplify(A, 0.1), 0.5);
    if (!A.length) continue;
    area[j] = A;
    const cap = [];
    for (let k = 0; k < (sup.interfaceTopLayers || 0); k++) {
      const c = contact[j + 1 + gap + k];
      if (c) cap.push(...c);
    }
    if (cap.length) {
      const it = dropSmall(intersect(A, cap), 0.5);
      if (it.length) iface[j] = it;
    }
    if (onProgress && j % 20 === 0) onProgress(1 - j / n);
  }

  // 3. Toolpaths: interface lines + branch columns. Branches start on a
  // square grid under the overhang and merge (2×2 → 1 on a nested grid) as
  // they go down, approximating how tree supports join into thicker trunks.
  const depth = new Map(); // grid key -> depth below the branch tip (mm)
  const sp = w - layers[Math.min(1, n - 1)].h * (1 - Math.PI / 4);
  const g = BRANCH_GRID * SCALE;
  const key = (gx, gy) => gx * 1000003 + gy;
  for (let j = n - 1; j >= 0; j--) {
    const h = layers[j].h;
    if (!area[j]) { depth.clear(); continue; }
    if (iface[j]) {
      const spacing = (sup.interfaceSpacing || 0.5) + w;
      for (const l of linesFill(iface[j], j % 2 ? 0 : 90, spacing)) out[j].push({ t: F.SUPPORT_INTERFACE, p: l, c: false, w });
    }
    const body = iface[j] ? diff(area[j], iface[j]) : area[j];
    if (!body.length) { depth.clear(); continue; }
    const b = bounds(body);
    const gx0 = Math.floor(b.minX / g), gx1 = Math.ceil(b.maxX / g);
    const gy0 = Math.floor(b.minY / g), gy1 = Math.ceil(b.maxY / g);
    const inside = new Map();
    const isInside = (gx, gy) => {
      const k = key(gx, gy);
      let v = inside.get(k);
      if (v === undefined) { v = insideAny({ X: gx * g, Y: gy * g }, body); inside.set(k, v); }
      return v;
    };
    const next = new Map();
    for (let gy = gy0; gy <= gy1; gy++) {
      const row = [];
      for (let gx = gx0; gx <= gx1; gx++) {
        if (!isInside(gx, gy)) continue;
        const k = key(gx, gy);
        const d = (depth.get(k) ?? -h) + h;
        next.set(k, d); // remembered even when merged, so it doesn't restart as a new tip
        // Merge into the parent trunk on the coarser grid if that one exists here.
        const level = Math.min(MAX_MERGE_LEVEL, Math.floor(d / MERGE_DEPTH));
        if (level > 0 && hasParent(gx, gy, 1 << level, isInside)) continue;
        const r = Math.min(BRANCH_MAX_RADIUS, (sup.treeBranchDiameter || 2) / 2 + d * BRANCH_GROWTH);
        const loops = r >= 2 ? 2 : 1;
        for (let l = 0; l < loops; l++) {
          const rr = r - w / 2 - l * sp;
          if (rr <= w / 2) break;
          row.push({ t: F.SUPPORT, p: circle(gx * BRANCH_GRID, gy * BRANCH_GRID, rr), c: true, w });
        }
      }
      // Serpentine row order keeps travel short without an O(n²) search.
      if ((gy - gy0) % 2) row.reverse();
      for (const s of row) out[j].push(s);
    }
    depth.clear();
    for (const [k, d] of next) depth.set(k, d);
  }
  return { paths: out, hasSupport: true };
}

/** Is there a coarse-grid trunk (one of the 4 surrounding coarse points) to merge into? */
function hasParent(gx, gy, step, isInside) {
  const x0 = Math.floor(gx / step) * step, y0 = Math.floor(gy / step) * step;
  if (x0 === gx && y0 === gy) return false; // this is a trunk itself
  for (const px of [x0, x0 + step]) {
    for (const py of [y0, y0 + step]) {
      if ((px !== gx || py !== gy) && isInside(px, py)) return true;
    }
  }
  return false;
}

function insideAny(pt, paths) {
  // NonZero winding: inside if inside an outer (CCW) more times than holes.
  let wind = 0;
  for (const p of paths) {
    const r = C.Clipper.PointInPolygon(pt, p);
    if (r !== 0) wind += C.Clipper.Orientation(p) ? 1 : -1;
  }
  return wind > 0;
}

function circle(cx, cy, r) {
  const seg = Math.max(8, Math.min(16, Math.ceil((2 * Math.PI * r) / 1.0)));
  const f = new Float32Array(seg * 2);
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * 2 * Math.PI;
    f[i * 2] = cx + r * Math.cos(a);
    f[i * 2 + 1] = cy + r * Math.sin(a);
  }
  return f;
}
