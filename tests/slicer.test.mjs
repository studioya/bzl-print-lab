import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { PROCESSES, FILAMENTS, PRINTER } from '../js/profiles-data.js';
import { PROFILE_INFO } from '../js/profile-info.js';
import { computeLayers, sliceMesh } from '../js/slicer/slice.js';
import { sliceObject } from '../js/slicer/pipeline.js';
import { estimatePlate } from '../js/slicer/estimate.js';
import { buildPreview, FLOATS_PER_SEGMENT } from '../js/slicer/preview.js';
import { area } from '../js/slicer/clip.js';
import { arrangePlates, fitsPlate, PLATE } from '../js/arrange.js';
import { parseSTL, parseOBJ, parse3MF } from '../js/loaders.js';
import { toBinarySTL, orientMesh, alignRotation, autoOrient, splitComponents } from '../js/mesh.js';
import { build3MF, buildProject3MF, bambuPlateOrigin } from '../js/export3mf.js';
import { PROJECT_PRESETS } from '../js/project-presets.js';
import { footprint, hullsOverlap, findFreeSpot, clampToPlate } from '../js/arrange.js';
import * as fx from './fixtures.mjs';

const NORMAL = PROCESSES.find((p) => p.name === 'Normal - Bezalel Modelling Center');
const PLA = FILAMENTS['Generic PLA - Bezalel Modelling Center'];

test('profiles: all 7 lab presets resolved with their key settings', () => {
  assert.equal(PROCESSES.length, 7);
  const byName = Object.fromEntries(PROCESSES.map((p) => [p.name, p]));
  assert.equal(byName['Draft - Bezalel Modelling Center'].layerHeight, 0.24);
  assert.equal(byName['Fine - Bezalel Modelling Center'].layerHeight, 0.12);
  assert.equal(byName['Strong - Bezalel Modelling Center'].wallLoops, 4);
  assert.equal(byName['Strong - Bezalel Modelling Center'].sparseInfillDensity, 0.28);
  assert.equal(byName['Lost PLA - Bezalel Modelling Center'].sparseInfillDensity, 0.03);
  assert.equal(byName['Normal - Bezalel Modelling Center'].support.thresholdAngle, 38);
  assert.equal(PLA.maxVolumetricSpeed, 15);
  assert.equal(byName['Press - Bezalel Modelling Center'].topShellLayers, 0);
  for (const p of PROCESSES) assert.ok(PROFILE_INFO[p.name], `description for ${p.name}`);
});

test('printable area is taken from the lab printer preset', () => {
  assert.deepEqual(PRINTER.printableArea, { minX: 18, minY: 18, maxX: 258, maxY: 258 });
  assert.equal(PLATE.width, 240);
  assert.equal(PLATE.depth, 240);
  assert.equal(PLATE.height, 250);
});

test('layers: first layer 0.2 then profile layer height', () => {
  const l = computeLayers(20, 0.2, 0.18);
  assert.equal(l[0].z, 0.2);
  assert.equal(l[1].h, 0.18);
  assert.equal(l.length, 111);
});

test('slicing a 20 mm cube gives 400 mm² square layers', () => {
  const pos = fx.f32(fx.box(20, 20, 20, -10, -10, 0));
  const layers = computeLayers(20, 0.2, 0.2);
  const s = sliceMesh(pos, layers);
  for (const k of [0, 50, layers.length - 1]) assert.ok(Math.abs(area(s[k]) - 400) < 0.01, `layer ${k}: ${area(s[k])}`);
});

test('a ring slices to an outer contour with a hole', () => {
  const outer = fx.cylinder(20, 10, 64);
  const inner = fx.cylinder(10, 10, 64);
  // Flip the inner cylinder's triangles so its normals point inwards (a hole).
  const flipped = [];
  for (let i = 0; i < inner.length; i += 9) flipped.push(...inner.slice(i, i + 3), ...inner.slice(i + 6, i + 9), ...inner.slice(i + 3, i + 6));
  const s = sliceMesh(fx.f32([...outer, ...flipped]), computeLayers(10, 0.2, 0.2));
  const expected = Math.PI * (400 - 100);
  assert.ok(Math.abs(area(s[10]) - expected) / expected < 0.01, `ring area ${area(s[10])}`);
});

test('cube: no supports, plausible time and filament', () => {
  const obj = sliceObject(fx.f32(fx.box(20, 20, 20, -10, -10, 0)), NORMAL);
  assert.equal(obj.hasSupport, false);
  const est = estimatePlate([{ obj, x: 0, y: 0 }], NORMAL, PLA, PRINTER);
  assert.ok(est.seconds > 10 * 60 && est.seconds < 25 * 60, `time ${est.seconds / 60} min`);
  assert.ok(est.grams > 2 && est.grams < 5, `grams ${est.grams}`);
});

test('Press profile leaves the top open; other profiles close it', () => {
  const cube = fx.f32(fx.box(20, 20, 20, -10, -10, 0));
  const solidTypes = new Set([3, 4]); // internal solid, top surface
  const topSolid = (name) => {
    const obj = sliceObject(cube, PROCESSES.find((p) => p.name === name));
    return obj.layers.slice(-6).map((l) => l.paths.some((p) => solidTypes.has(p.t)));
  };
  assert.deepEqual(topSolid('Press - Bezalel Modelling Center'), [false, false, false, false, false, false]);
  assert.ok(topSolid('Normal - Bezalel Modelling Center').at(-1), 'Normal closes the top');
  // Press still has a solid bottom.
  const press = sliceObject(cube, PROCESSES.find((p) => p.name === 'Press - Bezalel Modelling Center'));
  assert.ok(press.layers[0].paths.some((p) => p.t === 5), 'bottom surface on the first layer');
  assert.ok(press.layers[2].paths.some((p) => p.t === 3), 'solid bottom shell');
});

test('cantilever needs support; supports are only built from the plate', () => {
  const obj = sliceObject(fx.f32(fx.tee()), NORMAL);
  assert.equal(obj.hasSupport, true);
  const supportLayers = obj.layers.filter((l) => l.paths.some((p) => p.t === 9 || p.t === 10)).length;
  assert.ok(supportLayers > 50, `support on ${supportLayers} layers`);
});

test('copies on one plate are cheaper per copy than separate prints (shared layer time)', () => {
  const obj = sliceObject(fx.f32(fx.box(15, 15, 10, -7.5, -7.5, 0)), NORMAL);
  const one = estimatePlate([{ obj, x: 0, y: 0 }], NORMAL, PLA, PRINTER);
  const four = estimatePlate([0, 30, 60, 90].map((x) => ({ obj, x, y: 0 })), NORMAL, PLA, PRINTER);
  assert.ok(four.seconds < one.seconds * 4 * 0.9, `${four.seconds} vs 4×${one.seconds}`);
  assert.ok(four.seconds > one.seconds * 1.5);
  assert.ok(Math.abs(four.grams - one.grams * 4) < 0.01);
});

test('finer profiles take longer', () => {
  const pos = fx.f32(fx.cylinder(15, 20));
  const t = (name) => {
    const p = PROCESSES.find((x) => x.name === name);
    return estimatePlate([{ obj: sliceObject(pos, p), x: 0, y: 0 }], p, PLA, PRINTER).seconds;
  };
  assert.ok(t('Fine - Bezalel Modelling Center') > t('Normal - Bezalel Modelling Center'));
  assert.ok(t('Normal - Bezalel Modelling Center') > t('Draft - Bezalel Modelling Center'));
});

test('preview buffer has one entry per segment and per-layer offsets', () => {
  const obj = sliceObject(fx.f32(fx.box(10, 10, 5, -5, -5, 0)), NORMAL);
  const pv = buildPreview(obj);
  assert.equal(pv.layerStart.length, obj.layers.length + 1);
  assert.equal(pv.data.length, pv.layerStart[obj.layers.length] * FLOATS_PER_SEGMENT);
  for (let i = 1; i < pv.layerStart.length; i++) assert.ok(pv.layerStart[i] >= pv.layerStart[i - 1]);
});

test('fit check and multi-object arrangement', () => {
  assert.equal(fitsPlate({ x: 240, y: 100, z: 250 }), true);
  assert.equal(fitsPlate({ x: 241, y: 100, z: 10 }), false);
  assert.equal(fitsPlate({ x: 10, y: 10, z: 251 }), false);
  const plates = arrangePlates([{ key: 'a', size: { x: 100, y: 100 }, count: 10 }], NORMAL.brim);
  assert.deepEqual(plates.map((p) => p.length), [4, 4, 2]);
  const big = arrangePlates([{ key: 'a', size: { x: 230, y: 230 }, count: 2 }], NORMAL.brim);
  assert.equal(big.length, 2);
  // Mixed sizes: every piece placed once, inside the plate, without overlaps (incl. brim gap).
  const items = [
    { key: 'big', size: { x: 150, y: 90 }, count: 2 },
    { key: 'mid', size: { x: 60, y: 40 }, count: 5 },
    { key: 'small', size: { x: 15, y: 15 }, count: 10 },
  ];
  const mixed = arrangePlates(items, NORMAL.brim);
  const all = mixed.flat();
  assert.equal(all.length, 17);
  const size = Object.fromEntries(items.map((i) => [i.key, i.size]));
  for (const plate of mixed) {
    for (const q of plate) {
      const s = size[q.key];
      assert.ok(q.x - s.x / 2 >= -1e-6 && q.x + s.x / 2 <= PLATE.width + 1e-6 && q.y - s.y / 2 >= -1e-6 && q.y + s.y / 2 <= PLATE.depth + 1e-6, 'inside plate');
    }
    for (let i = 0; i < plate.length; i++) for (let j = i + 1; j < plate.length; j++) {
      const a = plate[i], b = plate[j], sa = size[a.key], sb = size[b.key];
      const apart = Math.abs(a.x - b.x) >= (sa.x + sb.x) / 2 + 10 || Math.abs(a.y - b.y) >= (sa.y + sb.y) / 2 + 10;
      assert.ok(apart, `${a.key} and ${b.key} overlap`);
    }
  }
});

test('a plate with different objects is estimated together', () => {
  const cube = sliceObject(fx.f32(fx.box(15, 15, 10, -7.5, -7.5, 0)), NORMAL);
  const tall = sliceObject(fx.f32(fx.cylinder(6, 30)), NORMAL);
  const a = estimatePlate([{ obj: cube, x: 0, y: 0 }], NORMAL, PLA, PRINTER);
  const b = estimatePlate([{ obj: tall, x: 0, y: 0 }], NORMAL, PLA, PRINTER);
  const both = estimatePlate([{ obj: cube, x: 0, y: 0 }, { obj: tall, x: 40, y: 0 }], NORMAL, PLA, PRINTER);
  assert.equal(both.layers, tall.layers.length);
  assert.ok(both.seconds < a.seconds + b.seconds, 'shared layers print faster than two separate plates');
  assert.ok(both.seconds > Math.max(a.seconds, b.seconds));
  assert.ok(Math.abs(both.grams - (a.grams + b.grams)) < 0.01);
});

test('split separates disconnected parts', () => {
  const two = fx.f32([...fx.box(10, 10, 10), ...fx.box(5, 5, 5, 20, 0, 0)]);
  const parts = splitComponents(two);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].length, 12 * 9);
  assert.equal(parts[1].length, 12 * 9);
  assert.equal(splitComponents(fx.f32(fx.sphere(5))).length, 1);
});

test('oriented plate 3MF round-trips through the 3MF loader', async () => {
  const cube = fx.f32(fx.box(10, 10, 10, -5, -5, 0));
  const blob = await build3MF([
    { name: 'a & <b>', positions: cube, x: 50, y: 60 },
    { name: 'c', positions: cube, x: 120, y: 60 },
  ]);
  const pos = await parse3MF(await blob.arrayBuffer());
  assert.equal(pos.length, cube.length * 2);
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < pos.length; i += 3) { minX = Math.min(minX, pos[i]); maxX = Math.max(maxX, pos[i]); }
  assert.equal(minX, 45);
  assert.equal(maxX, 125);
});

test('Bambu project 3MF keeps every piece on its plate, with the lab presets', async () => {
  const cube = fx.f32(fx.box(10, 10, 10, -5, -5, 0));
  const plates = [
    [{ object: 0, x: 20, y: 30 }, { object: 1, x: 100, y: 30 }, { object: 0, x: 200, y: 200 }],
    [{ object: 0, x: 120, y: 120 }],
    [],                                  // empty plates are dropped
    [{ object: 1, x: 10, y: 10 }],
  ];
  const blob = await buildProject3MF([{ name: 'a & <b>', positions: cube }, { name: 'c', positions: cube }], plates, PROJECT_PRESETS, {
    processName: 'Press - Bezalel Modelling Center', filamentName: 'Generic PLA Strong - Bezalel Modelling Center',
    color: '#000000', printableArea: PRINTER.printableArea, plateNames: ['Small & <parts>', 'Big', 'empty', ''],
  });
  const { readZip } = await import('../js/loaders.js');
  const files = await readZip(await blob.arrayBuffer(), /./);
  const text = (n) => new TextDecoder().decode(files[n]);
  const model = text('3D/3dmodel.model');
  assert.match(model, /<metadata name="Application">BambuStudio-02\.07\.01\.51<\/metadata>/);
  // 3 plates → 2 columns; plate size 240 − 1.25 → 238 mm, slot 238 × 1.2.
  const r = (o) => ({ x: +o.x.toFixed(6), y: +o.y.toFixed(6) });
  assert.deepEqual(r(bambuPlateOrigin(1, 3, 240, 240)), { x: 285.6, y: 0 });
  assert.deepEqual(r(bambuPlateOrigin(2, 3, 240, 240)), { x: 0, y: -285.6 });
  assert.deepEqual(r(bambuPlateOrigin(4, 5, 240, 240)), { x: 285.6, y: -285.6 }, '5 plates → 3 columns');
  const items = [...model.matchAll(/<item objectid="(\d)" transform="1 0 0 0 1 0 0 0 1 ([-\d.]+) ([-\d.]+) 0"/g)].map((m) => [+m[1], +m[2], +m[3]]);
  assert.deepEqual(items, [[1, 38, 48], [1, 218, 218], [1, 18 + 285.6 + 120, 138], [2, 118, 48], [2, 28, 28 - 285.6]]);
  const cfg = text('Metadata/model_settings.config');
  const platesXml = cfg.split('<plate>').slice(1);
  assert.equal(platesXml.length, 3);
  assert.deepEqual(platesXml.map((x) => x.match(/plater_name" value="([^"]*)"/)[1]), ['Small &amp; &lt;parts&gt;', 'Big', '']);
  const inst = (x) => [...x.matchAll(/object_id" value="(\d)"\/>\s*<metadata key="instance_id" value="(\d)"/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(inst(platesXml[0]), ['1:0', '1:1', '2:0']);
  assert.deepEqual(inst(platesXml[1]), ['1:2']);
  assert.deepEqual(inst(platesXml[2]), ['2:1']);
  assert.match(cfg, /<metadata key="name" value="a &amp; &lt;b&gt;"\/>/);
  const proj = JSON.parse(text('Metadata/project_settings.config'));
  assert.equal(proj.print_settings_id, 'Press - Bezalel Modelling Center');
  assert.equal(proj.printer_settings_id, 'BZL Bambu Lab P1S 0.4 nozzle');
  assert.deepEqual(proj.filament_settings_id, ['Generic PLA Strong - Bezalel Modelling Center']);
  assert.deepEqual(proj.filament_colour, ['#000000']);
  assert.equal(proj.top_shell_layers, '0');
  assert.deepEqual(proj.printable_area, ['18x18', '258x18', '258x258', '18x258']);
  // Our own loader reads it back with all 5 pieces.
  assert.equal((await parse3MF(await blob.arrayBuffer())).length, cube.length * 5);
});

test('arranging helpers: footprints, overlap, free spots, clamping', () => {
  const sq = footprint(fx.f32(fx.box(10, 10, 4, -5, -5, 0)));
  assert.equal(sq.length, 4);
  assert.equal(hullsOverlap(sq, 0, 0, sq, 9, 0), true);
  assert.equal(hullsOverlap(sq, 0, 0, sq, 10, 0), false, 'touching is fine');
  // Two triangles whose boxes overlap but shapes don't.
  const tri = [[0, 0], [10, 0], [0, 10]];
  const tri2 = [[10, 10], [0, 10], [10, 0]];
  assert.equal(hullsOverlap(tri, 0, 0, tri2, 1, 1), false);
  const spot = findFreeSpot({ x: 50, y: 50 }, [{ x: 120, y: 120, size: { x: 100, y: 100 } }], 4);
  assert.ok(spot && (Math.abs(spot.x - 120) >= 79 || Math.abs(spot.y - 120) >= 79));
  assert.equal(findFreeSpot({ x: 200, y: 200 }, [{ x: 120, y: 120, size: { x: 100, y: 100 } }], 4), null);
  assert.deepEqual(clampToPlate(-10, 300, { x: 20, y: 20 }), { x: 10, y: PLATE.depth - 10 });
});

test('pricing: material + time, ₪10 minimum per plate', async () => {
  const { submissionPrice, plateCost } = await import('../js/pricing.js');
  const rate = { perGram: 0.05, perHour: 5, minimum: 10 };
  assert.deepEqual(plateCost({ grams: 100, seconds: 7200 }, rate), { material: 5, time: 10, subtotal: 15, minimumApplied: false, cost: 15 });
  assert.equal(plateCost({ grams: 5.4, seconds: 1320 }, rate).cost, 10); // 0.27 + 1.83 → minimum
  const p = submissionPrice([{ grams: 100, seconds: 7200 }, { grams: 5.4, seconds: 1320 }, { grams: 2, seconds: 600 }], rate);
  assert.equal(p.subtotal, 15 + 2.1 + 0.93);
  assert.deepEqual(p.platesAtMinimum, [1, 2]);
  assert.equal(p.total, 35);
  assert.equal(p.minimumTopUp, 35 - 18.03);
  assert.equal(submissionPrice([], rate).total, 0);
});

test('STL binary and ASCII parse to the same triangles', () => {
  const tri = fx.box(1, 2, 3);
  const bin = parseSTL(toBinarySTL(fx.f32(tri)));
  assert.equal(bin.length, tri.length);
  let ascii = 'solid t\n';
  for (let i = 0; i < tri.length; i += 9) {
    ascii += 'facet normal 0 0 0\nouter loop\n';
    for (let k = 0; k < 9; k += 3) ascii += `vertex ${tri[i + k]} ${tri[i + k + 1]} ${tri[i + k + 2]}\n`;
    ascii += 'endloop\nendfacet\n';
  }
  ascii += 'endsolid t\n';
  const a = parseSTL(new TextEncoder().encode(ascii).buffer);
  assert.deepEqual(Array.from(a), Array.from(bin));
});

test('OBJ with quads and negative indices', () => {
  const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1/1/1 2/2/2 3/3/3 4/4/4\nf -4 -3 -2\n';
  assert.equal(parseOBJ(obj).length, 27);
});

function zip(entries) {
  // Tiny ZIP writer (deflate) for building test 3MF files.
  const parts = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text);
    const comp = deflateRawSync(data);
    const nameB = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameB.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameB.length, 28);
    cen.writeUInt32LE(offset, 42);
    parts.push(local, nameB, comp);
    central.push(cen, nameB);
    offset += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const buf = Buffer.concat([...parts, cd, end]);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
}

test('3MF: Bambu-style components across files, transforms and units', async () => {
  const mesh = `<?xml version="1.0"?><model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>
    <object id="1" type="model"><mesh><vertices>
      <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
    </vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources></model>`;
  const root = `<?xml version="1.0"?><model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>
    <object id="2" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></components></object>
    </resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 100 0"/></build></model>`;
  const buf = zip({
    '_rels/.rels': '<Relationships><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    '3D/3dmodel.model': root,
    '3D/Objects/object_1.model': mesh,
  });
  const pos = await parse3MF(buf);
  // Child mesh is in cm → ×10; component +5 mm in X, then build item +100,+100.
  assert.deepEqual(Array.from(pos), [105, 100, 0, 115, 100, 0, 105, 110, 0]);
});

test('orientation helpers', () => {
  const R = alignRotation([0, 1, 0], [0, 0, -1]);
  const v = [R[0] * 0 + R[1] * 1 + R[2] * 0, R[3] * 0 + R[4] * 1 + R[5] * 0, R[6] * 0 + R[7] * 1 + R[8] * 0];
  assert.ok(Math.abs(v[2] + 1) < 1e-9 && Math.abs(v[0]) < 1e-9 && Math.abs(v[1]) < 1e-9);
  const o = orientMesh(fx.f32(fx.box(10, 20, 30, 5, 5, 5)), [1, 0, 0, 0, 1, 0, 0, 0, 1], 2);
  assert.deepEqual(o.size, { x: 20, y: 40, z: 60 });
  // The tee lies flat (no overhangs) when auto-oriented.
  const t = orientMesh(fx.f32(fx.tee()), autoOrient(fx.f32(fx.tee()), 30));
  assert.ok(Math.abs(t.size.z - 10) < 1e-6, `tee height ${t.size.z}`);
});
