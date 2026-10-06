// Slices one (oriented) object into per-layer extrusion paths, following the
// structure of Bambu Studio's slicing: walls → top/bottom shells → sparse
// infill → supports → brim.
//
// Output path: { t: feature type, p: Float32Array [x0,y0,...] (mm, object
// frame), c: closed loop?, w: line width (mm), o?: overhang class 1..3 }

import { SCALE, C, union, diff, intersect, offset, opening, toExPolygons, exToPaths, area, dropSmall, toFlat } from './clip.js';
import { computeLayers, sliceMesh } from './slice.js';
import { linesFill, gyroidFill, orderPolylines } from './fill.js';
import { generateSupports } from './supports.js';
import { F } from './features.js';

/** Extrusion spacing for a line of width w and height h (Slic3r flow model). */
export function spacing(w, h) { return w - h * (1 - Math.PI / 4); }
/** Cross-section area (mm²) of an extrusion (Slic3r flow model). */
export function crossSection(w, h) { return h * (w - h * (1 - Math.PI / 4)); }

export function meshHeight(positions) {
  let maxZ = 0;
  for (let i = 2; i < positions.length; i += 3) if (positions[i] > maxZ) maxZ = positions[i];
  return maxZ;
}

export function sliceObject(positions, proc, onProgress = () => {}) {
  const maxZ = meshHeight(positions);
  const layers = computeLayers(maxZ, proc.firstLayerHeight, proc.layerHeight);
  const n = layers.length;
  const lw = proc.lineWidth;

  onProgress('slice', 0);
  const slices = sliceMesh(positions, layers, (f) => onProgress('slice', f));

  // Layers whose cross-section is identical to the one below (common in
  // prismatic parts) reuse that layer's walls and infill regions.
  const same = new Uint8Array(n);
  for (let i = 2; i < n; i++) same[i] = samePaths(slices[i], slices[i - 1]) && layers[i].h === layers[i - 1].h ? 1 : 0;
  const sameRun = new Int32Array(n + 1); // prefix sums for window checks
  for (let i = 0; i < n; i++) sameRun[i + 1] = sameRun[i] + same[i];
  const allSame = (a, b) => a >= 1 && b < n && sameRun[b + 1] - sameRun[a] === b - a + 1; // same[a..b]

  // ---- Walls ----
  const islands = new Array(n);
  const fill = new Array(n);
  for (let i = 0; i < n; i++) {
    if (same[i]) { islands[i] = islands[i - 1]; fill[i] = fill[i - 1]; continue; }
    const h = layers[i].h;
    const first = i === 0;
    const wO = first ? lw.firstLayer : lw.outerWall;
    const wI = first ? lw.firstLayer : lw.innerWall;
    let base = slices[i];
    if (first && proc.elephantFootCompensation > 0) base = offset(base, -proc.elephantFootCompensation);
    const isl = [];
    const fillParts = [];
    for (const ex of toExPolygons(base)) {
      const region = exToPaths(ex);
      const walls = [];
      let cur = offset(region, -wO / 2);
      let lastW = wO;
      if (cur.length) {
        walls.push({ paths: cur, t: F.OUTER_WALL, w: wO });
        for (let k = 1; k < proc.wallLoops; k++) {
          const d = k === 1 ? (spacing(wO, h) + spacing(wI, h)) / 2 : spacing(wI, h);
          const nxt = offset(cur, -d);
          if (!nxt.length) break;
          cur = nxt;
          lastW = wI;
          walls.push({ paths: cur, t: F.INNER_WALL, w: wI });
        }
      }
      const inner = walls.length ? offset(cur, -spacing(lastW, h) / 2) : [];
      let thin = [];
      if (proc.detectThinWall) {
        const covered = walls.length ? offset(walls[0].paths, wO / 2 + 0.01) : [];
        thin = dropSmall(opening(diff(region, covered), 0.05), Math.max(0.15, wO * wO));
      }
      isl.push({ outer: ex.outer, walls, thin, w: wO });
      if (inner.length) fillParts.push(...inner);
    }
    islands[i] = isl;
    fill[i] = fillParts.length ? union(fillParts) : [];
    if (i % 10 === 0) onProgress('walls', (i + 1) / n);
  }

  // ---- Top / bottom shells and infill regions ----
  const topLayers = Math.max(proc.topShellLayers, Math.ceil(proc.topShellThickness / proc.layerHeight - 1e-6));
  const bottomLayers = Math.max(proc.bottomShellLayers, Math.ceil((proc.bottomShellThickness || 0) / proc.layerHeight - 1e-6));
  const regions = new Array(n);
  for (let i = 0; i < n; i++) {
    const F_i = fill[i];
    if (!F_i.length) { regions[i] = null; continue; }
    // Same shells as the layer below if everything within the shell window matches.
    if (i > 1 && allSame(i - bottomLayers, i + topLayers) && regions[i - 1]) { regions[i] = regions[i - 1]; continue; }
    // Area covered by every one of the next `topLayers` layers.
    let above = i + 1 < n ? slices[i + 1] : [];
    for (let k = 2; k <= topLayers && above.length; k++) above = i + k < n ? intersect(above, slices[i + k]) : [];
    let belowAll = i - 1 >= 0 ? slices[i - 1] : [];
    for (let k = 2; k <= bottomLayers && belowAll.length; k++) belowAll = i - k >= 0 ? intersect(belowAll, slices[i - k]) : [];

    let solid = union(diff(F_i, above), diff(F_i, belowAll));
    solid = dropSmall(opening(solid, 0.1), 0.1);
    let sparse = diff(F_i, solid);
    // Bambu turns small sparse areas into solid infill (minimum_sparse_infill_area).
    const small = [];
    const keep = [];
    for (const ex of toExPolygons(sparse)) {
      const p = exToPaths(ex);
      (area(p) < proc.minimumSparseInfillArea ? small : keep).push(...p);
    }
    if (small.length) solid = union(solid, small);
    sparse = keep;

    let top = [], bridge = [], internal = [], bottom = [];
    if (i === 0) {
      bottom = solid;
    } else {
      const exposed = i + 1 < n ? diff(F_i, slices[i + 1]) : F_i;
      top = exposed.length ? dropSmall(intersect(solid, offset(exposed, 0.2)), 0.1) : [];
      const rest = top.length ? diff(solid, top) : solid;
      const air = diff(F_i, slices[i - 1]);
      bridge = air.length ? dropSmall(intersect(rest, offset(air, 0.4)), 0.5) : [];
      internal = bridge.length ? diff(rest, bridge) : rest;
    }
    regions[i] = { top, bridge, internal, bottom, sparse };
    if (i % 10 === 0) onProgress('shells', (i + 1) / n);
  }

  // ---- Supports ----
  onProgress('support', 0);
  const support = generateSupports(slices, layers, proc, (f) => onProgress('support', f));

  // ---- Toolpaths per layer ----
  const out = new Array(n);
  let posX = 0, posY = 0;
  for (let i = 0; i < n; i++) {
    const { z, h } = layers[i];
    const first = i === 0;
    const paths = [];

    // Brim (first layer only).
    if (first && proc.brim.type !== 'no_brim' && proc.brim.width > 0) {
      paths.push(...brimPaths(slices[0], proc, layers[0].h));
    }

    // Support first, like Bambu.
    const sp = support.paths[i];
    if (sp.length) {
      for (const s of sp.length > 200 ? sp : orderClosedAndOpen(sp, posX, posY)) paths.push(s);
    }

    // Infill polylines for this layer (assigned to islands below).
    const r = regions[i];
    const infill = [];
    if (r) {
      const angle = (proc.infillDirection || 45) + (i % 2 ? 90 : 0);
      const wSolid = first ? lw.firstLayer : lw.internalSolidInfill;
      const add = (region, t, w, spc, ang = angle) => {
        for (const l of linesFill(region, ang, spc)) infill.push({ t, p: l, c: false, w });
      };
      if (r.bottom.length) add(r.bottom, F.BOTTOM_SURFACE, wSolid, spacing(wSolid, h));
      if (r.bridge.length) add(r.bridge, F.BRIDGE, proc.lineWidth.default, spacing(proc.lineWidth.default, h));
      if (r.internal.length) add(r.internal, F.INTERNAL_SOLID, lw.internalSolidInfill, spacing(lw.internalSolidInfill, h));
      if (r.top.length) add(r.top, F.TOP_SURFACE, lw.topSurface, spacing(lw.topSurface, h));
      if (r.sparse.length && proc.sparseInfillDensity > 0) {
        const ws = lw.sparseInfill;
        const g = gyroidFill(r.sparse, proc.sparseInfillDensity, spacing(ws, h), z, proc.infillDirection || 45);
        for (const l of g) infill.push({ t: F.SPARSE_INFILL, p: l, c: false, w: ws });
      }
    }

    // Walls, gap fill and infill per island, nearest island first.
    const isl = islands[i];
    const ovh = i > 0 && !same[i] ? overhangContext(slices[i - 1], slices[i], lw.outerWall) : null;
    const byIsland = assignToIslands(infill, isl);
    const order = orderIslands(isl, posX, posY);
    for (const k of order) {
      const island = isl[k];
      // Inner walls first, then outer wall (Bambu: inner wall/outer wall/infill).
      for (let wi = island.walls.length - 1; wi >= 0; wi--) {
        const wall = island.walls[wi];
        for (const loop of wall.paths) {
          const flat = startNearest(toFlat(loop), posX, posY);
          const pieces = ovh ? overhangPieces(flat, ovh) : null;
          if (pieces) {
            for (const pc of pieces) paths.push({ t: pc.o ? F.OVERHANG_WALL : wall.t, p: pc.p, c: false, w: wall.w, o: pc.o });
          } else {
            paths.push({ t: wall.t, p: flat, c: true, w: wall.w });
          }
          posX = flat[0]; posY = flat[1];
        }
      }
      for (const t of island.thin) {
        const half = halfOutline(toFlat(t));
        if (half) paths.push({ t: F.GAP_INFILL, p: half, c: false, w: island.w });
      }
      const mine = byIsland[k];
      if (mine.length) {
        // Solid infill keeps its serpentine order; sparse is ordered greedily.
        const solid = mine.filter((p) => p.t !== F.SPARSE_INFILL);
        const sparse = mine.filter((p) => p.t === F.SPARSE_INFILL);
        for (const s of solid) paths.push(s);
        if (sparse.length) {
          const ordered = orderPolylines(sparse.map((s) => s.p), posX, posY);
          for (const p of ordered) paths.push({ t: F.SPARSE_INFILL, p, c: false, w: sparse[0].w });
        }
      }
      const last = paths[paths.length - 1];
      if (last) { posX = last.p[last.p.length - 2]; posY = last.p[last.p.length - 1]; }
    }
    // Infill that could not be matched to an island (rare).
    for (const p of byIsland.orphans) paths.push(p);

    out[i] = { z, h, paths };
    if (i % 10 === 0) onProgress('paths', (i + 1) / n);
  }

  return { layers: out, height: maxZ, hasSupport: support.hasSupport };
}

function samePaths(a, b) {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) {
    const p = a[k], q = b[k];
    if (p.length !== q.length) return false;
    for (let m = 0; m < p.length; m++) if (p[m].X !== q[m].X || p[m].Y !== q[m].Y) return false;
  }
  return true;
}

function brimPaths(firstSlices, proc, h) {
  const w = proc.lineWidth.firstLayer;
  const s = spacing(w, h);
  let src = firstSlices;
  if (proc.brim.type === 'outer_only' || proc.brim.type === 'auto_brim') {
    src = toExPolygons(firstSlices).map((ex) => ex.outer);
  }
  const out = [];
  for (let k = 0; ; k++) {
    const d = proc.brim.objectGap + w / 2 + k * s;
    if (d > proc.brim.width + proc.brim.objectGap) break;
    for (const loop of offset(src, d)) out.push({ t: F.BRIM, p: toFlat(loop), c: true, w });
  }
  // Outermost loops first is how Bambu prints the brim; order doesn't change time much.
  return out.reverse();
}

/**
 * Per-layer bands of Bambu's overhang speed classes, by how much of a wall
 * line hangs over the previous layer: <25% → normal speed, 25–50% → class 1,
 * 50–75% → class 2, >75% → class 3. Returns null when no wall can overhang.
 */
function overhangContext(lower, current, w) {
  if (!lower.length) return null;
  const lowerIn = offset(lower, -w / 4);
  const wallZone = offset(current, -w / 2 + 0.01);
  if (area(diff(wallZone, lowerIn)) < 0.05) return null;
  const lowerOut = offset(lower, w / 4);
  return {
    normal: lowerIn,
    bands: [[diff(lower, lowerIn), 1], [diff(lowerOut, lower), 2]],
    beyond: lowerOut,
  };
}

/** Splits a wall loop into overhang-class pieces; null if fully supported. */
function overhangPieces(flat, ctx) {
  const open = [];
  for (let i = 0; i < flat.length; i += 2) open.push({ X: Math.round(flat[i] * SCALE), Y: Math.round(flat[i + 1] * SCALE) });
  open.push(open[0]);
  const outside = clipOpen([open], ctx.normal, true);
  let total = 0;
  for (const p of outside) total += pathLen(p);
  if (total < 0.5) return null;

  const pieces = [];
  for (const p of clipOpen([open], ctx.normal, false)) pieces.push({ p: flatOf(p), o: 0 });
  for (const [band, o] of ctx.bands) {
    if (band.length) for (const p of clipOpen([open], band, false)) pieces.push({ p: flatOf(p), o });
  }
  for (const p of clipOpen([open], ctx.beyond, true)) pieces.push({ p: flatOf(p), o: 3 });
  // Clipper returns pieces in arbitrary order; walk them along the loop.
  const valid = pieces.filter((pc) => pc.p.length >= 4);
  const ordered = [];
  let x = flat[0], y = flat[1];
  while (valid.length) {
    let best = 0, bestD = Infinity;
    for (let k = 0; k < valid.length; k++) {
      const d = (valid[k].p[0] - x) ** 2 + (valid[k].p[1] - y) ** 2;
      if (d < bestD) { bestD = d; best = k; }
    }
    const pc = valid.splice(best, 1)[0];
    ordered.push(pc);
    x = pc.p[pc.p.length - 2]; y = pc.p[pc.p.length - 1];
  }
  return ordered;
}

function clipOpen(lines, region, outside) {
  const c = new C.Clipper();
  c.AddPaths(lines, C.PolyType.ptSubject, false);
  if (region.length) c.AddPaths(region, C.PolyType.ptClip, true);
  const tree = new C.PolyTree();
  c.Execute(outside ? C.ClipType.ctDifference : C.ClipType.ctIntersection, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  return C.Clipper.OpenPathsFromPolyTree(tree);
}

function pathLen(p) {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].X - p[i - 1].X, p[i].Y - p[i - 1].Y);
  return L / SCALE;
}

function flatOf(p) {
  const f = new Float32Array(p.length * 2);
  for (let i = 0; i < p.length; i++) { f[i * 2] = p[i].X / SCALE; f[i * 2 + 1] = p[i].Y / SCALE; }
  return f;
}

/** Thin features become a single line ≈ half their outline (medial length). */
function halfOutline(flat) {
  const n = flat.length / 2;
  if (n < 3) return null;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    total += Math.hypot(flat[j * 2] - flat[i * 2], flat[j * 2 + 1] - flat[i * 2 + 1]);
  }
  const out = [flat[0], flat[1]];
  let acc = 0;
  for (let i = 1; i < n && acc < total / 2; i++) {
    acc += Math.hypot(flat[i * 2] - flat[i * 2 - 2], flat[i * 2 + 1] - flat[i * 2 - 1]);
    out.push(flat[i * 2], flat[i * 2 + 1]);
  }
  return out.length >= 4 ? Float32Array.from(out) : null;
}

/** Rotates a closed loop so it starts at the vertex nearest (x, y). */
function startNearest(flat, x, y) {
  const n = flat.length / 2;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const d = (flat[i * 2] - x) ** 2 + (flat[i * 2 + 1] - y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best === 0) return flat;
  const out = new Float32Array(flat.length);
  out.set(flat.subarray(best * 2));
  out.set(flat.subarray(0, best * 2), flat.length - best * 2);
  return out;
}

function orderIslands(isl, x, y) {
  const left = isl.map((_, k) => k);
  const order = [];
  while (left.length) {
    let best = 0, bestD = Infinity;
    for (let j = 0; j < left.length; j++) {
      const p = isl[left[j]].outer[0];
      const d = (p.X / SCALE - x) ** 2 + (p.Y / SCALE - y) ** 2;
      if (d < bestD) { bestD = d; best = j; }
    }
    const k = left.splice(best, 1)[0];
    order.push(k);
    const p = isl[k].outer[0];
    x = p.X / SCALE; y = p.Y / SCALE;
  }
  return order;
}

function assignToIslands(infill, isl) {
  const res = isl.map(() => []);
  res.orphans = [];
  if (isl.length === 1) { res[0] = infill; return res; }
  for (const path of infill) {
    // Use the midpoint of the first segment (endpoints sit on boundaries).
    const pt = { X: Math.round(((path.p[0] + path.p[2]) / 2) * SCALE), Y: Math.round(((path.p[1] + path.p[3]) / 2) * SCALE) };
    let found = -1;
    for (let k = 0; k < isl.length && found < 0; k++) {
      if (C.Clipper.PointInPolygon(pt, isl[k].outer) !== 0) found = k;
    }
    (found >= 0 ? res[found] : res.orphans).push(path);
  }
  return res;
}

function orderClosedAndOpen(paths, x, y) {
  const left = paths.slice();
  const out = [];
  while (left.length) {
    let best = 0, bestD = Infinity;
    for (let j = 0; j < left.length; j++) {
      const p = left[j].p;
      const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
      if (d < bestD) { bestD = d; best = j; }
    }
    const s = left.splice(best, 1)[0];
    out.push(s);
    x = s.p[s.c ? 0 : s.p.length - 2]; y = s.p[s.c ? 1 : s.p.length - 1];
  }
  return out;
}

