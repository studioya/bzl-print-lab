// Writes 3MF files (zip + XML).
//
// buildProject3MF() writes a Bambu Studio project: every copy on the plate the
// student put it on, at the exact position, plus the chosen printer/filament/
// process presets, so File → Open Project in Bambu Studio shows the same plates.
// The layout follows Bambu Studio's own 3MF writer (src/libslic3r/Format/bbs_3mf.cpp)
// and plate grid (src/slic3r/GUI/PartPlate.cpp).

const BAMBU_NS = 'http://schemas.bambulab.com/package/2021';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="config" ContentType="text/xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function num(v) {
  return Number.isInteger(v) ? String(v) : (+v.toFixed(5)).toString();
}

/** Indexed mesh XML for a triangle soup (identical vertices shared). */
function meshXml(p) {
  const index = new Map();
  const verts = [];
  const tris = [];
  for (let k = 0; k < p.length; k += 3) {
    const key = `${p[k]},${p[k + 1]},${p[k + 2]}`;
    let id = index.get(key);
    if (id === undefined) { id = verts.length; index.set(key, id); verts.push(`<vertex x="${num(p[k])}" y="${num(p[k + 1])}" z="${num(p[k + 2])}"/>`); }
    tris.push(id);
  }
  const t = [];
  for (let k = 0; k < tris.length; k += 3) t.push(`<triangle v1="${tris[k]}" v2="${tris[k + 1]}" v3="${tris[k + 2]}"/>`);
  return { xml: `<mesh><vertices>\n${verts.join('\n')}\n</vertices><triangles>\n${t.join('\n')}\n</triangles></mesh>`, faces: tris.length / 3 };
}

/**
 * Where Bambu Studio puts plate i (0-based): plates are laid out in a grid of
 * round(sqrt(n)) columns (one more if that's too few), each plate's slot being
 * the plate size + 1/5 gap; rows go towards −Y. (PartPlateList::compute_origin)
 * The plate size is the printable area minus the axes' tip radius (1.25 mm),
 * truncated to whole mm, as in Plater::priv::on_config_change / reset_size.
 */
export function bambuPlateOrigin(i, count, printableWidth, printableDepth) {
  let cols = Math.round(Math.sqrt(count));
  if (Math.sqrt(count) > cols) cols++;
  const w = Math.trunc(printableWidth - 1.25), d = Math.trunc(printableDepth - 1.25);
  const row = Math.floor(i / cols), col = i % cols;
  return { x: col * w * 1.2, y: -row * d * 1.2 };
}

/**
 * @param objects   [{ name, positions: Float32Array, extruder? }] — triangle soup in mm,
 *                  centred at x/y = 0 with min z = 0 (as oriented on the page);
 *                  extruder: 1-based filament (index into options.colors + 1)
 * @param plates    [[{ object: index into objects, x, y }]] — plate coordinates
 *                  (0..printable width/depth, the page's plate view)
 * @param presets   PROJECT_PRESETS (js/project-presets.js)
 * @param options   { processName, filamentName, colors: ['#RRGGBB', …] (one filament each),
 *                    printableArea: {minX, minY, maxX, maxY} }
 * @returns Promise<Blob>
 */
export async function buildProject3MF(objects, plates, presets, options) {
  const area = options.printableArea;
  const W = area.maxX - area.minX, D = area.maxY - area.minY;
  plates = plates.filter((p) => p.length);
  const n = objects.length;
  const uuid = (a, b) => `${a.toString(16).padStart(8, '0')}-${b.toString(16).padStart(4, '0')}-4000-8000-000000000000`;

  // Instances of each object, in the order of their <item>s (= Bambu instance index).
  const instances = objects.map(() => []);
  plates.forEach((plate, pi) => {
    const o = bambuPlateOrigin(pi, plates.length, W, D);
    for (const it of plate) {
      instances[it.object].push({ plate: pi, x: o.x + area.minX + it.x, y: o.y + area.minY + it.y });
    }
  });

  const model = [];
  model.push(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="${BAMBU_NS}">
 <metadata name="Application">BambuStudio-${esc(presets.version)}</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="Title">${esc(options.title || 'Student plates')}</metadata>
 <resources>
`);
  const faces = [];
  objects.forEach((o, i) => {
    const m = meshXml(o.positions);
    faces.push(m.faces);
    model.push(`  <object id="${i + 1}" type="model" name="${esc(o.name)}">${m.xml}</object>\n`);
  });
  model.push(' </resources>\n <build>\n');
  const assemble = [];
  objects.forEach((o, i) => instances[i].forEach((inst, k) => {
    const tr = `1 0 0 0 1 0 0 0 1 ${num(inst.x)} ${num(inst.y)} 0`;
    model.push(`  <item objectid="${i + 1}" transform="${tr}" printable="1"/>\n`);
    assemble.push(`  <assemble_item object_id="${i + 1}" instance_id="${k}" transform="${tr}" offset="0 0 0"/>\n`);
  }));
  model.push(' </build>\n</model>\n');

  // Metadata/model_settings.config: object names and which plate each copy is on.
  const cfg = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n'];
  objects.forEach((o, i) => {
    cfg.push(`  <object id="${i + 1}">
    <metadata key="name" value="${esc(o.name)}"/>
    <metadata key="extruder" value="${o.extruder || 1}"/>
    <metadata face_count="${faces[i]}"/>
    <part id="${i + 1}" subtype="normal_part">
      <metadata key="name" value="${esc(o.name)}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <mesh_stat face_count="${faces[i]}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
  </object>\n`);
  });
  let identify = 1000;
  plates.forEach((plate, pi) => {
    cfg.push(`  <plate>
    <metadata key="plater_id" value="${pi + 1}"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>\n`);
    objects.forEach((o, i) => instances[i].forEach((inst, k) => {
      if (inst.plate !== pi) return;
      cfg.push(`    <model_instance>
      <metadata key="object_id" value="${i + 1}"/>
      <metadata key="instance_id" value="${k}"/>
      <metadata key="identify_id" value="${identify++}"/>
    </model_instance>\n`);
    }));
    cfg.push('  </plate>\n');
  });
  cfg.push(`  <assemble>\n${assemble.join('')}  </assemble>\n</config>\n`);

  const enc = new TextEncoder();
  return zip([
    ['[Content_Types].xml', enc.encode(CONTENT_TYPES)],
    ['_rels/.rels', enc.encode(RELS)],
    ['3D/3dmodel.model', enc.encode(model.join(''))],
    ['Metadata/model_settings.config', enc.encode(cfg.join(''))],
    ['Metadata/project_settings.config', enc.encode(JSON.stringify(projectSettings(presets, options), null, 4))],
  ]);
}

/**
 * The project config Bambu Studio stores in a project: printer, process and
 * filament settings merged into one object, with the preset names so Bambu
 * selects the lab's presets (PresetBundle::full_fff_config).
 */
export function projectSettings(presets, { processName, filamentName, colors, color }) {
  const printer = presets.printer, process = presets.processes[processName], filament = presets.filaments[filamentName];
  if (!process || !filament) throw new Error(`Unknown preset: ${!process ? processName : filamentName}`);
  colors = colors?.length ? colors : [color || '#FFFFFF'];
  // One filament slot per colour, all the same lab PLA preset: per-filament
  // settings (arrays) are repeated for each slot.
  const filamentSettings = {};
  for (const [k, v] of Object.entries(filament.settings)) {
    filamentSettings[k] = Array.isArray(v) && v.length === 1 ? colors.map(() => v[0]) : v;
  }
  const out = { ...printer.settings, ...process.settings, ...filamentSettings };
  out.filament_colour = colors.slice();
  out.filament_settings_id = colors.map(() => filament.name);
  out.print_settings_id = process.name;
  out.printer_settings_id = printer.name;
  out.print_compatible_printers = process.compatiblePrinters;
  out.inherits_group = [process.inherits, filament.inherits, printer.inherits];
  out.from = 'project';
  out.name = 'project_settings';
  out.version = presets.version;
  return out;
}

/**
 * Plain 3MF (no Bambu project data), each object once at the given position.
 * @param objects [{ name, positions: Float32Array (triangle soup, mm), x, y }]
 * @returns Promise<Blob>
 */
export async function build3MF(objects) {
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n<resources>\n');
  objects.forEach((o, i) => parts.push(`<object id="${i + 1}" type="model" name="${esc(o.name)}">${meshXml(o.positions).xml}</object>\n`));
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
