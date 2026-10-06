// Mesh orientation helpers. Rotations are 3x3 row-major arrays.

export const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function matMul(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return r;
}

export function axisRotation(axis, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  if (axis === 'x') return [1, 0, 0, 0, c, -s, 0, s, c];
  if (axis === 'y') return [c, 0, s, 0, 1, 0, -s, 0, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Rotation taking unit vector `from` onto unit vector `to`. */
export function alignRotation(from, to) {
  const [fx, fy, fz] = normalize(from);
  const [tx, ty, tz] = normalize(to);
  const vx = fy * tz - fz * ty, vy = fz * tx - fx * tz, vz = fx * ty - fy * tx;
  const c = fx * tx + fy * ty + fz * tz;
  if (c < -0.999999) {
    // Opposite: rotate 180° about any axis perpendicular to `from`.
    const ax = Math.abs(fx) < 0.9 ? normalize([0, -fz, fy]) : normalize([-fz, 0, fx]);
    const [x, y, z] = ax;
    return [2 * x * x - 1, 2 * x * y, 2 * x * z, 2 * x * y, 2 * y * y - 1, 2 * y * z, 2 * x * z, 2 * y * z, 2 * z * z - 1];
  }
  const k = 1 / (1 + c);
  return [
    vx * vx * k + c, vx * vy * k - vz, vx * vz * k + vy,
    vy * vx * k + vz, vy * vy * k + c, vy * vz * k - vx,
    vz * vx * k - vy, vz * vy * k + vx, vz * vz * k + c,
  ];
}

function normalize([x, y, z]) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** Rotates, centres in XY around 0 and drops onto z = 0. */
export function orientMesh(src, R, scale = 1) {
  const n = src.length;
  const out = new Float32Array(n);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const [a, b, c, d, e, f, g, h, i] = R;
  for (let k = 0; k < n; k += 3) {
    const x = src[k] * scale, y = src[k + 1] * scale, z = src[k + 2] * scale;
    const X = a * x + b * y + c * z, Y = d * x + e * y + f * z, Z = g * x + h * y + i * z;
    out[k] = X; out[k + 1] = Y; out[k + 2] = Z;
    if (X < minX) minX = X; if (X > maxX) maxX = X;
    if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
    if (Z < minZ) minZ = Z; if (Z > maxZ) maxZ = Z;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  for (let k = 0; k < n; k += 3) { out[k] -= cx; out[k + 1] -= cy; out[k + 2] -= minZ; }
  return { positions: out, size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ } };
}

export function boundingSize(src, scale = 1) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let k = 0; k < src.length; k += 3) {
    const x = src[k], y = src[k + 1], z = src[k + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { x: (maxX - minX) * scale, y: (maxY - minY) * scale, z: (maxZ - minZ) * scale };
}

/**
 * Suggests a print orientation: tries the main axes, diagonals and the
 * normals of the largest flat faces, and picks the one needing the least
 * support (overhang area × height above the plate), preferring a large flat
 * base and a lower height.
 */
export function autoOrient(src, thresholdDeg = 30) {
  const triCount = src.length / 9;
  const nx = new Float32Array(triCount), ny = new Float32Array(triCount), nz = new Float32Array(triCount);
  const ar = new Float32Array(triCount);
  const cx = new Float32Array(triCount), cy = new Float32Array(triCount), cz = new Float32Array(triCount);
  const clusters = new Map();
  let totalArea = 0;
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = src[o + 3] - src[o], ay = src[o + 4] - src[o + 1], az = src[o + 5] - src[o + 2];
    const bx = src[o + 6] - src[o], by = src[o + 7] - src[o + 1], bz = src[o + 8] - src[o + 2];
    let x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx;
    const l = Math.hypot(x, y, z);
    if (l === 0) continue;
    x /= l; y /= l; z /= l;
    nx[t] = x; ny[t] = y; nz[t] = z; ar[t] = l / 2;
    totalArea += l / 2;
    cx[t] = (src[o] + src[o + 3] + src[o + 6]) / 3;
    cy[t] = (src[o + 1] + src[o + 4] + src[o + 7]) / 3;
    cz[t] = (src[o + 2] + src[o + 5] + src[o + 8]) / 3;
    const key = `${Math.round(x * 50)},${Math.round(y * 50)},${Math.round(z * 50)}`;
    const c = clusters.get(key);
    if (c) { c.a += l / 2; c.x += x * l; c.y += y * l; c.z += z * l; }
    else clusters.set(key, { a: l / 2, x: x * l, y: y * l, z: z * l });
  }

  const candidates = [];
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
    if (x || y || z) candidates.push(normalize([x, y, z]));
  }
  [...clusters.values()].sort((p, q) => q.a - p.a).slice(0, 24)
    .forEach((c) => candidates.push(normalize([c.x, c.y, c.z])));

  const cosT = Math.cos((thresholdDeg * Math.PI) / 180);
  let best = null;
  for (const down of candidates) {
    // Height along `down` (0 at the plate).
    let maxH = -Infinity, minH = Infinity;
    for (let k = 0; k < src.length; k += 3) {
      const hgt = -(src[k] * down[0] + src[k + 1] * down[1] + src[k + 2] * down[2]);
      if (hgt > maxH) maxH = hgt;
      if (hgt < minH) minH = hgt;
    }
    let supportVol = 0, contact = 0;
    for (let t = 0; t < triCount; t++) {
      if (!ar[t]) continue;
      const c = nx[t] * down[0] + ny[t] * down[1] + nz[t] * down[2]; // 1 = facing straight down
      if (c <= cosT) continue;
      const hgt = -(cx[t] * down[0] + cy[t] * down[1] + cz[t] * down[2]) - minH;
      if (hgt < 0.2 && c > 0.999) contact += ar[t];
      else supportVol += ar[t] * c * hgt;
    }
    const height = maxH - minH;
    const score = 4 * supportVol + height * Math.sqrt(totalArea) * 0.5 - contact * 2;
    if (!best || score < best.score) best = { score, down };
  }
  return alignRotation(best.down, [0, 0, -1]);
}

/** Binary STL from a triangle soup. */
export function toBinarySTL(positions, header = 'BZL Print Lab oriented model') {
  const n = positions.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const view = new DataView(buf);
  const enc = new TextEncoder().encode(header.slice(0, 79));
  new Uint8Array(buf, 0, 80).set(enc);
  view.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const p = t * 9;
    const ax = positions[p + 3] - positions[p], ay = positions[p + 4] - positions[p + 1], az = positions[p + 5] - positions[p + 2];
    const bx = positions[p + 6] - positions[p], by = positions[p + 7] - positions[p + 1], bz = positions[p + 8] - positions[p + 2];
    let x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx;
    const l = Math.hypot(x, y, z) || 1;
    view.setFloat32(o, x / l, true); view.setFloat32(o + 4, y / l, true); view.setFloat32(o + 8, z / l, true);
    o += 12;
    for (let k = 0; k < 9; k++) { view.setFloat32(o, positions[p + k], true); o += 4; }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}

/**
 * Splits a triangle soup into its connected parts (triangles sharing a
 * vertex), like Bambu Studio's "Split to objects". Returns one Float32Array
 * per part, largest first.
 */
export function splitComponents(src) {
  const triCount = src.length / 9;
  const parent = new Int32Array(triCount);
  for (let i = 0; i < triCount; i++) parent[i] = i;
  const find = (a) => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  const seen = new Map();
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      const key = `${src[o]},${src[o + 1]},${src[o + 2]}`;
      const other = seen.get(key);
      if (other === undefined) seen.set(key, t);
      else {
        const a = find(t), b = find(other);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const groups = new Map();
  for (let t = 0; t < triCount; t++) {
    const r = find(t);
    const g = groups.get(r);
    if (g) g.push(t); else groups.set(r, [t]);
  }
  const parts = [...groups.values()].sort((a, b) => b.length - a.length).map((tris) => {
    const out = new Float32Array(tris.length * 9);
    tris.forEach((t, i) => out.set(src.subarray(t * 9, t * 9 + 9), i * 9));
    return out;
  });
  return parts;
}
