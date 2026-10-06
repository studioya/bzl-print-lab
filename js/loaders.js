// Model file loaders → triangle soup (Float32Array, 9 floats per triangle, mm).
// Supports STL (binary + ASCII), OBJ and 3MF (incl. Bambu Studio's
// multi-file 3MF layout with components). Only geometry is read; any print
// settings, colours or plates stored in a 3MF are ignored.

export const ACCEPTED_EXTENSIONS = ['stl', 'obj', '3mf'];

export function extensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export async function loadModel(buffer, fileName) {
  const ext = extensionOf(fileName);
  let positions;
  if (ext === 'stl') positions = parseSTL(buffer);
  else if (ext === 'obj') positions = parseOBJ(new TextDecoder().decode(buffer));
  else if (ext === '3mf') positions = await parse3MF(buffer);
  else throw new LoadError('unsupported', `Unsupported file type ".${ext}"`);
  if (!positions.length) throw new LoadError('empty', 'The file contains no triangles');
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new LoadError('corrupt', 'The file contains invalid coordinates');
  }
  return positions;
}

export class LoadError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------------- STL ----------------

export function parseSTL(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength >= 84) {
    const n = view.getUint32(80, true);
    if (84 + n * 50 === buffer.byteLength) return parseBinarySTL(view, n);
  }
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(1024, buffer.byteLength)));
  if (/^\s*solid/i.test(head)) {
    const text = new TextDecoder().decode(buffer);
    if (/facet/i.test(text)) return parseAsciiSTL(text);
  }
  if (buffer.byteLength >= 84) {
    // Some exporters write a wrong file length; trust the triangle count if it fits.
    const n = view.getUint32(80, true);
    if (84 + n * 50 <= buffer.byteLength && n > 0) return parseBinarySTL(view, n);
  }
  throw new LoadError('corrupt', 'Could not read this STL file');
}

function parseBinarySTL(view, n) {
  const out = new Float32Array(n * 9);
  let o = 84;
  for (let t = 0; t < n; t++) {
    o += 12; // skip normal
    for (let k = 0; k < 9; k++) { out[t * 9 + k] = view.getFloat32(o, true); o += 4; }
    o += 2;
  }
  return out;
}

function parseAsciiSTL(text) {
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const vals = [];
  let m;
  while ((m = re.exec(text))) vals.push(+m[1], +m[2], +m[3]);
  const usable = vals.length - (vals.length % 9);
  return Float32Array.from(vals.slice(0, usable));
}

// ---------------- OBJ ----------------

export function parseOBJ(text) {
  const verts = [];
  const out = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      verts.push([+p[1], +p[2], +p[3]]);
    } else if (line.startsWith('f ')) {
      const idx = line.split(/\s+/).slice(1).map((tok) => {
        const i = parseInt(tok.split('/')[0], 10);
        return i < 0 ? verts.length + i : i - 1;
      });
      for (let k = 1; k + 1 < idx.length; k++) {
        const a = verts[idx[0]], b = verts[idx[k]], c = verts[idx[k + 1]];
        if (a && b && c) out.push(...a, ...b, ...c);
      }
    }
  }
  return Float32Array.from(out);
}

// ---------------- 3MF ----------------

const UNIT_SCALE = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

export async function parse3MF(buffer) {
  const files = await readZip(buffer);
  const modelPaths = Object.keys(files).filter((p) => /\.model$/i.test(p));
  if (!modelPaths.length) throw new LoadError('corrupt', 'No 3D model found inside the 3MF');

  // Root model: from _rels/.rels, else 3D/3dmodel.model, else the first .model.
  let root = modelPaths.find((p) => /^3D\/3dmodel\.model$/i.test(p)) || modelPaths[0];
  const rels = files['_rels/.rels'];
  if (rels) {
    const m = /Target="\/?([^"]+\.model)"/i.exec(new TextDecoder().decode(rels));
    if (m && files[m[1]]) root = m[1];
  }

  const models = {};
  const getModel = (path) => {
    if (!models[path]) {
      if (!files[path]) throw new LoadError('corrupt', `Missing part ${path} in 3MF`);
      models[path] = parseModelXml(new TextDecoder().decode(files[path]));
    }
    return models[path];
  };

  const rootModel = getModel(root);
  const out = [];
  const emit = (path, objectId, M, depth) => {
    if (depth > 16) return;
    const model = getModel(path);
    const obj = model.objects[objectId];
    if (!obj) return;
    if (obj.mesh) {
      const { v, t } = obj.mesh;
      const s = model.unitScale;
      for (let i = 0; i < t.length; i++) {
        const idx = t[i];
        const x = v[idx * 3] * s, y = v[idx * 3 + 1] * s, z = v[idx * 3 + 2] * s;
        out.push(M[0] * x + M[3] * y + M[6] * z + M[9],
          M[1] * x + M[4] * y + M[7] * z + M[10],
          M[2] * x + M[5] * y + M[8] * z + M[11]);
      }
    }
    for (const c of obj.components) {
      const childPath = c.path ? c.path.replace(/^\//, '') : path;
      emit(childPath, c.objectId, mul(c.transform, M), depth + 1);
    }
  };
  for (const item of rootModel.build) emit(root, item.objectId, item.transform, 0);
  if (!rootModel.build.length) {
    for (const id of Object.keys(rootModel.objects)) emit(root, id, IDENTITY, 0);
  }
  return Float32Array.from(out);
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseTransform(s) {
  if (!s) return IDENTITY;
  const v = s.trim().split(/\s+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENTITY;
}

// Composes affine 3MF transforms: apply a, then b.
function mul(a, b) {
  const r = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  for (let j = 0; j < 3; j++) r[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j];
  return r;
}

function attr(tag, name) {
  const m = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

// Streaming regex parser (faster and lighter than DOMParser for big meshes).
export function parseModelXml(xml) {
  const unitM = /<model[^>]*\sunit="([^"]+)"/.exec(xml);
  const unitScale = UNIT_SCALE[(unitM?.[1] || 'millimeter').toLowerCase()] ?? 1;
  const objects = {};
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let m;
  while ((m = objRe.exec(xml))) {
    const id = attr(m[1], 'id');
    const body = m[2];
    const obj = { mesh: null, components: [] };
    const vStart = body.indexOf('<vertices');
    if (vStart >= 0) {
      const v = [];
      const vre = /<vertex\b([^>]*)\/?>/g;
      vre.lastIndex = vStart;
      const vEnd = body.indexOf('</vertices>', vStart);
      let vm;
      while ((vm = vre.exec(body)) && (vEnd < 0 || vm.index < vEnd)) {
        v.push(+attr(vm[1], 'x'), +attr(vm[1], 'y'), +attr(vm[1], 'z'));
      }
      const t = [];
      const tre = /<triangle\b([^>]*)\/?>/g;
      tre.lastIndex = Math.max(0, vEnd);
      let tm;
      while ((tm = tre.exec(body))) t.push(+attr(tm[1], 'v1'), +attr(tm[1], 'v2'), +attr(tm[1], 'v3'));
      obj.mesh = { v, t };
    }
    const cre = /<component\b([^>]*)\/?>/g;
    let cm;
    while ((cm = cre.exec(body))) {
      obj.components.push({ objectId: attr(cm[1], 'objectid'), path: attr(cm[1], 'path'), transform: parseTransform(attr(cm[1], 'transform')) });
    }
    objects[id] = obj;
  }
  const build = [];
  const buildM = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml);
  if (buildM) {
    const ire = /<item\b([^>]*)\/?>/g;
    let im;
    while ((im = ire.exec(buildM[1]))) {
      if (attr(im[1], 'printable') === '0') continue;
      build.push({ objectId: attr(im[1], 'objectid'), transform: parseTransform(attr(im[1], 'transform')) });
    }
  }
  return { unitScale, objects, build };
}

// ---------------- minimal ZIP reader ----------------

export async function readZip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new LoadError('corrupt', 'Not a valid 3MF (zip) file');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = {};
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (!/\.(model|rels)$/i.test(name)) continue; // only geometry is needed
    const lNameLen = view.getUint16(local + 26, true);
    const lExtraLen = view.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(start, start + csize);
    if (method === 0) files[name] = data;
    else if (method === 8) files[name] = await inflateRaw(data);
    else throw new LoadError('corrupt', `Unsupported compression in 3MF (${method})`);
  }
  return files;
}

async function inflateRaw(data) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
