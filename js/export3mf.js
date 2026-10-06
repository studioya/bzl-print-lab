// Writes a standard 3MF (zip + XML) holding several meshes, each placed on
// the build plate. Bambu Studio opens it as separate objects, keeping the
// orientation the student chose.

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function num(v) {
  return Number.isInteger(v) ? String(v) : (+v.toFixed(5)).toString();
}

/**
 * @param objects [{ name, positions: Float32Array (triangle soup, mm), x, y }]
 *        positions are centred at x/y = 0 with min z = 0; x, y place the object.
 * @returns Promise<Blob>
 */
export async function build3MF(objects) {
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n<resources>\n');
  objects.forEach((o, i) => {
    // Share identical vertices so the file stays small.
    const index = new Map();
    const verts = [];
    const tris = [];
    const p = o.positions;
    for (let k = 0; k < p.length; k += 3) {
      const key = `${p[k]},${p[k + 1]},${p[k + 2]}`;
      let id = index.get(key);
      if (id === undefined) { id = verts.length; index.set(key, id); verts.push(`<vertex x="${num(p[k])}" y="${num(p[k + 1])}" z="${num(p[k + 2])}"/>`); }
      tris.push(id);
    }
    const t = [];
    for (let k = 0; k < tris.length; k += 3) t.push(`<triangle v1="${tris[k]}" v2="${tris[k + 1]}" v3="${tris[k + 2]}"/>`);
    parts.push(`<object id="${i + 1}" type="model" name="${esc(o.name)}"><mesh><vertices>\n${verts.join('\n')}\n</vertices><triangles>\n${t.join('\n')}\n</triangles></mesh></object>\n`);
  });
  parts.push('</resources>\n<build>\n');
  objects.forEach((o, i) => parts.push(`<item objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${num(o.x)} ${num(o.y)} 0"/>\n`));
  parts.push('</build>\n</model>\n');
  const enc = new TextEncoder();
  return zip([
    ['[Content_Types].xml', enc.encode(CONTENT_TYPES)],
    ['_rels/.rels', enc.encode(RELS)],
    ['3D/3dmodel.model', enc.encode(parts.join(''))],
  ]);
}

// ---- minimal ZIP writer (deflate via CompressionStream) ----

let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameB = enc.encode(name);
    const comp = await deflate(data);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 8, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, comp.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameB.length, true);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(10, 8, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, comp.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameB.length, true);
    cen.setUint32(42, offset, true);
    chunks.push(local, nameB, comp);
    central.push(cen, nameB);
    offset += 30 + nameB.length + comp.length;
  }
  const cdSize = central.reduce((s, c) => s + c.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end], { type: 'model/3mf' });
}
