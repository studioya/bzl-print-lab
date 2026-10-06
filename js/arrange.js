// Arranges copies of one object on as few build plates as possible.

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
 * @param size {x, y} footprint of one copy (mm)
 * @param count number of copies
 * @param brim {width, objectGap}
 * @returns {perPlate, plates: [[ [cx, cy], ... ], ...]} copy centres in plate coordinates
 *          (0..PLATE.width, 0..PLATE.depth), or null if it does not fit.
 */
export function arrangeCopies(size, count, brim) {
  if (size.x > PLATE.width + EPS || size.y > PLATE.depth + EPS) return null;
  // Leave room for both copies' brims plus a small clearance.
  const gap = 2 * ((brim?.width || 0) + (brim?.objectGap || 0)) + 2;
  const cols = Math.max(1, Math.floor((PLATE.width + gap) / (size.x + gap)));
  const rows = Math.max(1, Math.floor((PLATE.depth + gap) / (size.y + gap)));
  const perPlate = cols * rows;
  const plates = [];
  let left = count;
  while (left > 0) {
    const k = Math.min(perPlate, left);
    left -= k;
    const usedCols = Math.min(cols, k);
    const usedRows = Math.ceil(k / cols);
    const blockW = usedCols * size.x + (usedCols - 1) * gap;
    const blockD = usedRows * size.y + (usedRows - 1) * gap;
    const x0 = (PLATE.width - blockW) / 2 + size.x / 2;
    const y0 = (PLATE.depth - blockD) / 2 + size.y / 2;
    const pos = [];
    for (let i = 0; i < k; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      pos.push([x0 + c * (size.x + gap), y0 + (usedRows - 1 - r) * (size.y + gap)]);
    }
    plates.push(pos);
  }
  return { perPlate, plates };
}
