// Arranges objects (and their copies) on as few build plates as possible.

import { PRINTER } from './profiles-data.js';

export const PLATE = {
  width: PRINTER.printableArea.maxX - PRINTER.printableArea.minX,
  depth: PRINTER.printableArea.maxY - PRINTER.printableArea.minY,
  height: PRINTER.printableHeight,
};

const EPS = 1e-6;

/** Does an object of this size fit the printable volume? */
export function fitsPlate(size) {
  return size.x <= PLATE.width + EPS && size.y <= PLATE.depth + EPS && size.z <= PLATE.height + EPS;
}

/**
 * Shelf-packs every copy of every item onto plates (first fit, largest first),
 * leaving room for brims between parts, then centres each plate's layout.
 *
 * @param items [{ key, size: {x, y}, count }] — items must fit the plate
 * @param brim  {width, objectGap}
 * @returns plates: [[{ key, x, y }, ...], ...] — centres in plate coordinates
 *          (0..PLATE.width, 0..PLATE.depth)
 */
export function arrangePlates(items, brim) {
  const gap = 2 * ((brim?.width || 0) + (brim?.objectGap || 0)) + 2;
  const W = PLATE.width, D = PLATE.depth;
  const pieces = [];
  items.forEach((it, order) => {
    for (let c = 0; c < it.count; c++) pieces.push({ key: it.key, w: it.size.x, d: it.size.y, order });
  });
  pieces.sort((a, b) => b.d - a.d || b.w - a.w || a.order - b.order);

  const plates = []; // { shelves: [{y, h, x}], placed: [] }
  for (const p of pieces) {
    let placed = false;
    for (const plate of plates) {
      if (place(plate, p)) { placed = true; break; }
    }
    if (!placed) {
      const plate = { shelves: [], placed: [] };
      plates.push(plate);
      place(plate, p);
    }
  }

  function place(plate, p) {
    for (const s of plate.shelves) {
      if (p.d <= s.h + EPS && s.x + p.w <= W + EPS) {
        plate.placed.push({ key: p.key, x: s.x + p.w / 2, y: s.y + p.d / 2 });
        s.x += p.w + gap;
        return true;
      }
    }
    const last = plate.shelves[plate.shelves.length - 1];
    const y = last ? last.y + last.h + gap : 0;
    if (y + p.d > D + EPS || p.w > W + EPS) return false;
    plate.shelves.push({ y, h: p.d, x: p.w + gap });
    plate.placed.push({ key: p.key, x: p.w / 2, y: y + p.d / 2 });
    return true;
  }

  // Centre each plate's layout.
  const sizeOf = new Map(items.map((it) => [it.key, it.size]));
  return plates.map((plate) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of plate.placed) {
      const s = sizeOf.get(q.key);
      minX = Math.min(minX, q.x - s.x / 2); maxX = Math.max(maxX, q.x + s.x / 2);
      minY = Math.min(minY, q.y - s.y / 2); maxY = Math.max(maxY, q.y + s.y / 2);
    }
    const dx = (W - (maxX - minX)) / 2 - minX, dy = (D - (maxY - minY)) / 2 - minY;
    return plate.placed.map((q) => ({ key: q.key, x: q.x + dx, y: q.y + dy }));
  });
}

// ---- student-arranged plates ----

/** 2D convex hull (x, y) of a triangle soup — the object's footprint on the plate. */
export function footprint(positions) {
  const pts = [];
  const seen = new Set();
  for (let i = 0; i < positions.length; i += 3) {
    // Round to 0.01 mm: dedupes vertices and keeps the hull small.
    const x = Math.round(positions[i] * 100) / 100, y = Math.round(positions[i + 1] * 100) / 100;
    const k = x * 1e6 + y;
    if (!seen.has(k)) { seen.add(k); pts.push([x, y]); }
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1)); // counter-clockwise
}

/**
 * Do two footprints (convex hulls, each offset by its piece's position)
 * overlap by more than `tolerance` mm? Separating-axis test.
 */
export function hullsOverlap(a, ax, ay, b, bx, by, tolerance = 0.05) {
  if (a.length < 3 || b.length < 3) return false;
  for (const [poly, ox, oy] of [[a, ax, ay], [b, bx, by]]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      let nx = q[1] - p[1], ny = p[0] - q[0];
      const len = Math.hypot(nx, ny);
      if (len < 1e-9) continue;
      nx /= len; ny /= len;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const v of a) { const d = (v[0] + ax) * nx + (v[1] + ay) * ny; minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
      for (const v of b) { const d = (v[0] + bx) * nx + (v[1] + by) * ny; minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
      if (maxA - tolerance <= minB || maxB - tolerance <= minA) return false; // separating axis found
    }
  }
  return true;
}

/** Keep a piece's centre so its footprint (size) stays on the plate when possible. */
export function clampToPlate(x, y, size) {
  const c = (lo, hi, v) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  return { x: c(size.x / 2, PLATE.width - size.x / 2, x), y: c(size.y / 2, PLATE.depth - size.y / 2, y) };
}

/** Is the piece's footprint (centred at x, y) inside the printable area? */
export function onPlate(x, y, size) {
  const tol = 0.01;
  return x - size.x / 2 >= -tol && x + size.x / 2 <= PLATE.width + tol
    && y - size.y / 2 >= -tol && y + size.y / 2 <= PLATE.depth + tol;
}

/**
 * Free spot for a new piece of `size` on a plate already holding `occupied`
 * ([{ x, y, size }]), keeping `gap` mm between bounding boxes. Prefers spots
 * near the plate centre. Returns { x, y } or null when the plate is full.
 */
export function findFreeSpot(size, occupied, gap = 4) {
  if (!fitsPlate({ ...size, z: 0 })) return null;
  const W = PLATE.width, D = PLATE.depth;
  const step = 2;
  let best = null;
  for (let x = size.x / 2; x <= W - size.x / 2 + EPS; x += step) {
    for (let y = size.y / 2; y <= D - size.y / 2 + EPS; y += step) {
      const d = (x - W / 2) ** 2 + (y - D / 2) ** 2;
      if (best && d >= best.d) continue;
      let free = true;
      for (const o of occupied) {
        if (Math.abs(x - o.x) * 2 < size.x + o.size.x + 2 * gap && Math.abs(y - o.y) * 2 < size.y + o.size.y + 2 * gap) { free = false; break; }
      }
      if (free) best = { x, y, d };
    }
  }
  return best && { x: best.x, y: best.y };
}
