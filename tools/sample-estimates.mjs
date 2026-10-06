// Prints slicing time/filament estimates for the test meshes (dev aid).
// Usage: node tools/sample-estimates.mjs ["BEZALEL FABLAB FINE"]
import { PROCESSES, FILAMENTS, PRINTER } from '../js/profiles-data.js';
import { sliceObject } from '../js/slicer/pipeline.js';
import { estimatePlate } from '../js/slicer/estimate.js';
import { FEATURES } from '../js/slicer/features.js';
import * as fx from '../tests/fixtures.mjs';
const meshes = { cube20: fx.box(20,20,20,-10,-10,0), cyl: fx.cylinder(15,30), sphere: fx.sphere(20), tee: fx.tee() };
const name = process.argv[2] || 'BEZALEL FABLAB NORMAL';
const proc = PROCESSES.find(p => p.name === name);
for (const [k, m] of Object.entries(meshes)) {
  const t0 = Date.now();
  const obj = sliceObject(fx.f32(m), proc);
  const t1 = Date.now();
  const est = estimatePlate([{ obj, x: 0, y: 0 }], proc, FILAMENTS['BEZALEL GENERIC PLA'], PRINTER);
  const by = est.byFeature.map((s,i)=>s>1?`${(FEATURES[i]?.en||'Travel')}:${(s/60).toFixed(1)}`:null).filter(Boolean).join(' ');
  console.log(`${k}: layers=${est.layers} time=${(est.seconds/60).toFixed(1)}min grams=${est.grams.toFixed(1)} slice=${t1-t0}ms est=${Date.now()-t1}ms support=${obj.hasSupport}\n   ${by}`);
}
