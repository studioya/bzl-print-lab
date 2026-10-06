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
