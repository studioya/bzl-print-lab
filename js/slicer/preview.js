// Packs sliced toolpaths into a compact instance buffer for the 3D preview.
// One instance per extrusion segment: x1, y1, x2, y2, z, width, height, type.

export const FLOATS_PER_SEGMENT = 8;
const BUDGET = 2_500_000; // max segments sent to the GPU per object

function simplify(p, closed, tol) {
  // Radial-distance + collinearity reduction (cheap Douglas–Peucker substitute).
  const n = p.length / 2;
  if (n <= 2 || tol <= 0) return p;
  const out = [p[0], p[1]];
  let ax = p[0], ay = p[1];
  for (let i = 1; i < n - 1; i++) {
    const bx = p[i * 2], by = p[i * 2 + 1];
    const cx = p[i * 2 + 2], cy = p[i * 2 + 3];
    const dx = cx - ax, dy = cy - ay;
    const len = Math.hypot(dx, dy);
    const dist = len > 0 ? Math.abs((bx - ax) * dy - (by - ay) * dx) / len : Math.hypot(bx - ax, by - ay);
    if (dist > tol) { out.push(bx, by); ax = bx; ay = by; }
  }
  out.push(p[p.length - 2], p[p.length - 1]);
  if (closed) out.push(p[0], p[1]);
  return out;
}

export function buildPreview(obj) {
  let tol = 0.01;
  let polys;
  for (;;) {
    polys = [];
    let count = 0;
    for (const layer of obj.layers) {
      const lp = [];
      for (const path of layer.paths) {
        const s = simplify(path.p, path.c, tol);
        lp.push({ s, t: path.t, w: path.w });
        count += s.length / 2 - 1;
      }
      polys.push(lp);
    }
    if (count <= BUDGET || tol > 1) break;
    tol *= 3;
  }

  let total = 0;
  for (const lp of polys) for (const q of lp) total += q.s.length / 2 - 1;
  const data = new Float32Array(total * FLOATS_PER_SEGMENT);
  const layerStart = new Uint32Array(obj.layers.length + 1);
  const zs = new Float32Array(obj.layers.length);
  let k = 0;
  for (let li = 0; li < obj.layers.length; li++) {
    layerStart[li] = k / FLOATS_PER_SEGMENT;
    const { z, h } = obj.layers[li];
    zs[li] = z;
    for (const { s, t, w } of polys[li]) {
      for (let i = 0; i + 3 < s.length; i += 2) {
        data[k++] = s[i]; data[k++] = s[i + 1]; data[k++] = s[i + 2]; data[k++] = s[i + 3];
        data[k++] = z; data[k++] = w; data[k++] = h; data[k++] = t;
      }
    }
  }
  layerStart[obj.layers.length] = k / FLOATS_PER_SEGMENT;
  return { data, layerStart, zs };
}
