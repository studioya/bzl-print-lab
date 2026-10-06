// Procedural test meshes (triangle soup, mm, outward normals, min z = 0).

function pushTri(out, a, b, c) { out.push(...a, ...b, ...c); }

export function box(sx, sy, sz, ox = 0, oy = 0, oz = 0) {
  const v = [];
  for (let i = 0; i < 8; i++) v.push([ox + (i & 1 ? sx : 0), oy + (i & 2 ? sy : 0), oz + (i & 4 ? sz : 0)]);
  const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const out = [];
  for (const [a, b, c, d] of faces) { pushTri(out, v[a], v[b], v[c]); pushTri(out, v[a], v[c], v[d]); }
  return out;
}

export function cylinder(r, h, seg = 64, cx = 0, cy = 0, oz = 0) {
  const out = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * 2 * Math.PI, a1 = ((i + 1) / seg) * 2 * Math.PI;
    const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)], p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
    pushTri(out, [...p0, oz], [...p1, oz], [...p1, oz + h]);
    pushTri(out, [...p0, oz], [...p1, oz + h], [...p0, oz + h]);
    pushTri(out, [cx, cy, oz], [...p1, oz], [...p0, oz]);
    pushTri(out, [cx, cy, oz + h], [...p0, oz + h], [...p1, oz + h]);
  }
  return out;
}

export function sphere(r, seg = 48, rings = 24) {
  const out = [];
  const P = (i, j) => {
    const th = (j / rings) * Math.PI, ph = (i / seg) * 2 * Math.PI;
    return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r - r * Math.cos(th)];
  };
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    if (j > 0) pushTri(out, a, c, b);
    if (j < rings - 1) pushTri(out, a, d, c);
  }
  return out;
}

/** A "T": a 10x10x20 post with a 40x10x5 cantilevered top (needs support). */
export function tee() {
  return [...box(10, 10, 20, 15, 0, 0), ...box(40, 10, 5, 0, 0, 20)];
}

export function f32(arr) { return Float32Array.from(arr); }
