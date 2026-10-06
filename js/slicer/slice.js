// Mesh → per-layer polygons.
//
// positions: Float32Array of triangle soup (9 floats per triangle), in mm,
// already oriented for printing with min Z = 0.

import { SCALE, union, simplify, dropSmall } from './clip.js';

/** Layer list like Bambu Studio: first layer, then fixed layer height. */
export function computeLayers(maxZ, firstLayerHeight, layerHeight) {
  const layers = [];
  let z = firstLayerHeight;
  let h = firstLayerHeight;
  while (z - h / 2 < maxZ - 1e-6) {
    layers.push({ z: +z.toFixed(4), h: +h.toFixed(4) });
    h = layerHeight;
    z += layerHeight;
  }
  return layers;
}

// Point keys for chaining segments into loops (positions are quantized to 0.1 µm).
const Q = 1e4;
const OFF = 5e6;
function key(x, y) {
  return (Math.round(x * Q) + OFF) * 1e8 + (Math.round(y * Q) + OFF);
}

/**
 * Slices the mesh at the middle of each layer.
 * Returns an array (one per layer) of Clipper paths (outer CCW, holes CW).
 */
export function sliceMesh(positions, layers, onProgress) {
  const triCount = positions.length / 9;
  const zmin = new Float32Array(triCount);
  const zmax = new Float32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const a = positions[o + 2], b = positions[o + 5], c = positions[o + 8];
    zmin[t] = Math.min(a, b, c);
    zmax[t] = Math.max(a, b, c);
  }
  const order = new Uint32Array(triCount);
  for (let i = 0; i < triCount; i++) order[i] = i;
  order.sort((p, q) => zmin[p] - zmin[q]);

  let next = 0;
  let active = [];
  const result = [];

  // Reused per-layer segment buffers.
  let segs = new Float64Array(1024 * 4);

  for (let li = 0; li < layers.length; li++) {
    // Tiny offset keeps the plane off exact vertex heights (common in CAD exports).
    const z = layers[li].z - layers[li].h / 2 + 1.37e-5;

    while (next < triCount && zmin[order[next]] <= z) active.push(order[next++]);
    active = active.filter((t) => zmax[t] >= z);

    if (segs.length < active.length * 4) segs = new Float64Array(active.length * 8);
    let n = 0;
    for (const t of active) {
      const o = t * 9;
      if (zmin[t] > z) continue;
      const pts = [];
      for (let e = 0; e < 3; e++) {
        let i = o + e * 3;
        let j = o + ((e + 1) % 3) * 3;
        let zi = positions[i + 2], zj = positions[j + 2];
        if ((zi - z) * (zj - z) >= 0) continue;
        // Canonical endpoint order so shared edges give bit-identical points.
        if (zi > zj || (zi === zj && positions[i] > positions[j])) {
          const tmp = i; i = j; j = tmp;
          const tz = zi; zi = zj; zj = tz;
        }
        const f = (z - zi) / (zj - zi);
        pts.push(positions[i] + (positions[j] - positions[i]) * f,
          positions[i + 1] + (positions[j + 1] - positions[i + 1]) * f);
      }
      if (pts.length !== 4) continue;
      // Orient segment so the outward normal is on its right (outer loops CCW).
      const ax = positions[o + 3] - positions[o], ay = positions[o + 4] - positions[o + 1], az = positions[o + 5] - positions[o + 2];
      const bx = positions[o + 6] - positions[o], by = positions[o + 7] - positions[o + 1], bz = positions[o + 8] - positions[o + 2];
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const dx = pts[2] - pts[0], dy = pts[3] - pts[1];
      if (nx * dy - ny * dx >= 0) {
        segs[n * 4] = pts[0]; segs[n * 4 + 1] = pts[1]; segs[n * 4 + 2] = pts[2]; segs[n * 4 + 3] = pts[3];
      } else {
        segs[n * 4] = pts[2]; segs[n * 4 + 1] = pts[3]; segs[n * 4 + 2] = pts[0]; segs[n * 4 + 3] = pts[1];
      }
      n++;
    }
    result.push(chainLoops(segs, n));
    if (onProgress && (li % 10 === 0 || li === layers.length - 1)) onProgress((li + 1) / layers.length);
  }
  return result;
}

function chainLoops(segs, n) {
  if (n === 0) return [];
  const startMap = new Map();
  const endKeys = new Float64Array(n);
  const startKeys = new Float64Array(n);
  for (let s = 0; s < n; s++) {
    const ks = key(segs[s * 4], segs[s * 4 + 1]);
    startKeys[s] = ks;
    endKeys[s] = key(segs[s * 4 + 2], segs[s * 4 + 3]);
    const list = startMap.get(ks);
    if (list) list.push(s); else startMap.set(ks, [s]);
  }
  const used = new Uint8Array(n);
  const closed = [];
  const open = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const chain = [s0];
    let cur = s0;
    let isClosed = false;
    for (;;) {
      if (endKeys[cur] === startKeys[s0]) { isClosed = true; break; }
      const list = startMap.get(endKeys[cur]);
      let nxt = -1;
      if (list) for (const c of list) if (!used[c]) { nxt = c; break; }
      if (nxt < 0) break;
      used[nxt] = 1;
      chain.push(nxt);
      cur = nxt;
    }
    (isClosed ? closed : open).push(chain);
  }

  const toPts = (chain) => {
    const pts = [];
    for (const s of chain) pts.push(segs[s * 4], segs[s * 4 + 1]);
    return pts;
  };
  const loops = closed.map(toPts);

  // Repair open chains from non-manifold meshes: join nearest ends, then close small gaps.
  if (open.length) {
    let chains = open.map((c) => {
      const pts = toPts(c);
      const last = c[c.length - 1];
      pts.push(segs[last * 4 + 2], segs[last * 4 + 3]);
      return pts;
    });
    const MAX_JOIN = 2.0;
    let merged = true;
    while (merged && chains.length > 1) {
      merged = false;
      for (let i = 0; i < chains.length && !merged; i++) {
        const a = chains[i];
        const ex = a[a.length - 2], ey = a[a.length - 1];
        let best = -1, bestD = MAX_JOIN;
        for (let j = 0; j < chains.length; j++) {
          if (j === i) continue;
          const d = Math.hypot(chains[j][0] - ex, chains[j][1] - ey);
          if (d < bestD) { bestD = d; best = j; }
        }
        if (best >= 0) {
          chains[i] = a.concat(chains[best]);
          chains.splice(best, 1);
          merged = true;
        }
      }
    }
    for (const c of chains) {
      const gap = Math.hypot(c[0] - c[c.length - 2], c[1] - c[c.length - 1]);
      if (c.length >= 6 && gap <= MAX_JOIN) loops.push(c);
    }
  }

  const paths = [];
  for (const pts of loops) {
    if (pts.length < 6) continue;
    const p = [];
    for (let i = 0; i < pts.length; i += 2) p.push({ X: Math.round(pts[i] * SCALE), Y: Math.round(pts[i + 1] * SCALE) });
    paths.push(p);
  }
  return dropSmall(simplify(union(paths), 0.0125), 0.01);
}
