// Print-time and filament estimation for a whole build plate.
//
// Copies on a plate are printed layer by layer together (as Bambu Studio does
// by default), so travel between copies and the per-layer cooling slowdown
// are evaluated for the plate as a whole rather than per object.

import { F, FEATURES } from './features.js';
import { crossSection } from './pipeline.js';

const TRAVEL = FEATURES.length; // index used for travel time in the breakdown

function featureSpeed(t, first, proc, o) {
  const s = proc.speed;
  if (first) {
    const infill = t === F.SPARSE_INFILL || t === F.INTERNAL_SOLID || t === F.BOTTOM_SURFACE ||
      t === F.TOP_SURFACE || t === F.BRIDGE;
    return infill ? s.firstLayerInfill : s.firstLayer;
  }
  switch (t) {
    case F.OUTER_WALL: return s.outerWall;
    case F.INNER_WALL: return s.innerWall;
    case F.OVERHANG_WALL: return s.overhang[o] || s.outerWall;
    case F.SPARSE_INFILL: return s.sparseInfill;
    case F.INTERNAL_SOLID: return s.internalSolidInfill;
    case F.TOP_SURFACE: return s.topSurface;
    case F.BOTTOM_SURFACE: return s.internalSolidInfill;
    case F.BRIDGE: return s.bridge;
    case F.GAP_INFILL: return s.gapInfill;
    case F.SUPPORT: return s.support;
    case F.SUPPORT_INTERFACE: return s.supportInterface;
    case F.BRIM: return s.firstLayer;
    default: return s.innerWall;
  }
}

function featureAccel(t, first, proc) {
  const a = proc.accel;
  if (first) return a.firstLayer;
  switch (t) {
    case F.OUTER_WALL:
    case F.OVERHANG_WALL: return a.outerWall;
    case F.INNER_WALL: return a.innerWall;
    case F.SPARSE_INFILL: return a.sparseInfill;
    case F.TOP_SURFACE: return a.topSurface;
    default: return a.default;
  }
}

function pathArea(t, w, h) {
  // Bridges are extruded as round strands (Bambu "thick bridges").
  return t === F.BRIDGE ? (Math.PI / 4) * w * w : crossSection(w, h);
}

/** Time to move distance L from speed v0 to v1 with cruise vc and accel a. */
function trapezoid(L, v0, v1, vc, a) {
  if (L <= 0) return 0;
  const d1 = (vc * vc - v0 * v0) / (2 * a);
  const d2 = (vc * vc - v1 * v1) / (2 * a);
  if (d1 + d2 <= L) return (vc - v0) / a + (vc - v1) / a + (L - d1 - d2) / vc;
  const vp = Math.sqrt(Math.max(0, (2 * a * L + v0 * v0 + v1 * v1) / 2));
  return Math.max(0, (vp - v0) / a) + Math.max(0, (vp - v1) / a);
}

// Scratch buffers reused across paths.
let segL = new Float64Array(1024);
let vMax = new Float64Array(1024);

/** Time for one extrusion polyline with classic-jerk junctions and look-ahead. */
function polylineTime(p, closed, v, a, jerk) {
  const nPts = p.length / 2;
  const nSeg = closed ? nPts : nPts - 1;
  if (nSeg <= 0) return { t: 0, L: 0 };
  if (segL.length < nSeg + 1) { segL = new Float64Array((nSeg + 1) * 2); vMax = new Float64Array((nSeg + 1) * 2); }
  let L = 0;
  let pdx = 0, pdy = 0;
  for (let s = 0; s < nSeg; s++) {
    const i = s * 2, j = ((s + 1) % nPts) * 2;
    const dx = p[j] - p[i], dy = p[j + 1] - p[i + 1];
    const len = Math.hypot(dx, dy);
    segL[s] = len;
    L += len;
    const ux = len > 0 ? dx / len : 0, uy = len > 0 ? dy / len : 0;
    if (s === 0) vMax[0] = Math.min(v, jerk);
    else {
      const dv = Math.max(Math.abs(ux - pdx), Math.abs(uy - pdy));
      vMax[s] = dv > 1e-9 ? Math.min(v, jerk / dv) : v;
    }
    pdx = ux; pdy = uy;
  }
  vMax[nSeg] = Math.min(v, jerk);
  // Backward then forward pass (accel-limited junction speeds).
  for (let s = nSeg - 1; s >= 0; s--) vMax[s] = Math.min(vMax[s], Math.sqrt(vMax[s + 1] ** 2 + 2 * a * segL[s]));
  for (let s = 1; s <= nSeg; s++) vMax[s] = Math.min(vMax[s], Math.sqrt(vMax[s - 1] ** 2 + 2 * a * segL[s - 1]));
  let t = 0;
  for (let s = 0; s < nSeg; s++) t += trapezoid(segL[s], vMax[s], vMax[s + 1], v, a);
  return { t, L };
}

/**
 * Estimates one build plate. All objects share the profile's layer heights,
 * so plate layer i is layer i of every object tall enough to have one.
 *
 * @param instances [{ obj, x, y }] — sliced objects ({ layers: [{z,h,paths}] })
 *                  and where each copy sits on the plate (mm)
 */
export function estimatePlate(instances, proc, filament, printer) {
  const jerk = printer.jerkXY;
  const maxA = printer.maxAccelExtruding;
  const travelV = Math.min(proc.speed.travel, printer.maxSpeedX);
  const travelA = Math.min(proc.accel.travel, printer.maxAccelTravel);
  const firstTravelA = Math.min(proc.accel.firstLayerTravel, printer.maxAccelTravel);
  // Retract + unretract; Bambu's z-hop is blended into the travel move, so it adds little.
  const retractT = 2 * (printer.retractionLength / printer.retractionSpeed);
  const byFeature = new Float64Array(FEATURES.length + 1);
  let volume = 0;
  let total = 0;
  let x = instances[0].x, y = instances[0].y;
  const nLayers = Math.max(...instances.map((it) => it.obj.layers.length));

  const pathTimes = [];
  for (let li = 0; li < nLayers; li++) {
    const first = li === 0;
    let h = 0;
    pathTimes.length = 0;
    let travelTime = 0;

    // Visit the objects that have this layer, nearest-first from the nozzle.
    const left = [];
    for (const it of instances) {
      const layer = it.obj.layers[li];
      if (layer && layer.paths.length) { left.push({ layer, dx: it.x, dy: it.y }); h = layer.h; }
    }
    if (!left.length) continue;
    while (left.length) {
      let best = 0, bestD = Infinity;
      for (let j = 0; j < left.length; j++) {
        const p0 = left[j].layer.paths[0].p;
        const d = (p0[0] + left[j].dx - x) ** 2 + (p0[1] + left[j].dy - y) ** 2;
        if (d < bestD) { bestD = d; best = j; }
      }
      const { layer, dx, dy } = left.splice(best, 1)[0];
      let prevT = -1;
      for (const path of layer.paths) {
        const p = path.p;
        const sx = p[0] + dx, sy = p[1] + dy;
        const D = Math.hypot(sx - x, sy - y);
        if (D > 0.01) {
          travelTime += trapezoid(D, Math.min(jerk, travelV), Math.min(jerk, travelV), travelV, first ? firstTravelA : travelA);
          // Bambu skips retraction for short hops inside the same infill.
          const sameInfill = prevT === path.t && (path.t === F.SPARSE_INFILL || path.t === F.INTERNAL_SOLID ||
            path.t === F.TOP_SURFACE || path.t === F.BOTTOM_SURFACE || path.t === F.SUPPORT_INTERFACE);
          if (D > printer.retractionMinTravel && !(sameInfill && D < 3)) travelTime += retractT;
        }
        let v = featureSpeed(path.t, first, proc, path.o || 0);
        const ar = pathArea(path.t, path.w, layer.h);
        v = Math.min(v, filament.maxVolumetricSpeed / ar, printer.maxSpeedX);
        const a = Math.min(featureAccel(path.t, first, proc), maxA);
        const { t, L } = polylineTime(p, path.c, v, a, jerk);
        pathTimes.push(path.t, t, L);
        volume += L * ar;
        const endI = path.c ? 0 : p.length - 2;
        x = p[endI] + dx; y = p[endI + 1] + dy;
        prevT = path.t;
      }
    }

    // Layer change: retract, z move, un-retract.
    travelTime += retractT + trapezoid(h, 0, 0, printer.maxSpeedZ, printer.maxAccelZ);

    // Cooling: slow extrusions so a layer takes at least slow_down_layer_time.
    let extrudeTime = 0;
    for (let k = 0; k < pathTimes.length; k += 3) extrudeTime += pathTimes[k + 1];
    let scale = 1;
    const minLayer = filament.slowDownForLayerCooling ? filament.slowDownLayerTime : 0;
    if (!first && extrudeTime > 0 && extrudeTime + travelTime < minLayer) {
      const target = minLayer - travelTime;
      const stretched = (k) => {
        let sum = 0;
        for (let i = 0; i < pathTimes.length; i += 3) {
          const t = pathTimes[i + 1], L = pathTimes[i + 2];
          sum += Math.min(t * k, Math.max(t, L / filament.slowDownMinSpeed));
        }
        return sum;
      };
      let lo = 1, hi = 64;
      for (let it = 0; it < 40; it++) {
        const mid = (lo + hi) / 2;
        if (stretched(mid) < target) lo = mid; else hi = mid;
      }
      scale = hi;
    }
    let layerTime = travelTime;
    for (let k = 0; k < pathTimes.length; k += 3) {
      const t0 = pathTimes[k + 1], L = pathTimes[k + 2];
      const t = scale === 1 ? t0 : Math.min(t0 * scale, Math.max(t0, L / filament.slowDownMinSpeed));
      byFeature[pathTimes[k]] += t;
      layerTime += t;
    }
    byFeature[TRAVEL] += travelTime;
    total += layerTime;
  }

  const filamentArea = Math.PI * (filament.diameter / 2) ** 2;
  return {
    seconds: total,
    byFeature: Array.from(byFeature),
    volumeMm3: volume,
    grams: (volume / 1000) * filament.density,
    meters: volume / filamentArea / 1000,
    layers: nLayers,
  };
}

export const TRAVEL_INDEX = TRAVEL;
