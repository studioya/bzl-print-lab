#!/usr/bin/env node
// Resolves the lab's Bambu Studio presets (profiles/lab, exported from the
// .bbscfg bundle) against Bambu's built-in base presets (profiles/bambu-base,
// copied from github.com/bambulab/BambuStudio resources/profiles/BBL) and
// writes the values the web slicer needs to js/profiles-data.js.
//
// Usage: node tools/resolve-profiles.mjs
// Re-run after replacing the files in profiles/lab with a new export.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAB = join(ROOT, 'profiles/lab');
const BASE = join(ROOT, 'profiles/bambu-base');

function findPreset(dirs, name) {
  for (const d of dirs) {
    const p = join(d, `${name}.json`);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  throw new Error(`Preset not found: ${name} (looked in ${dirs.join(', ')})`);
}

function resolve(dirs, name) {
  const preset = findPreset(dirs, name);
  const base = preset.inherits ? resolve(dirs, preset.inherits) : {};
  return { ...base, ...preset };
}

// Bambu stores most values as strings, per-extruder arrays, or percentages.
function first(v) { return Array.isArray(v) ? v[0] : v; }
function num(v, of = 0) {
  v = first(v);
  if (v === undefined || v === null || v === 'nil' || v === '') return undefined;
  if (typeof v === 'string' && v.trim().endsWith('%')) return (parseFloat(v) / 100) * of;
  return parseFloat(v);
}
function pct(v) { return parseFloat(first(v)) / 100; }
function points(arr) {
  return (arr || []).map((s) => s.split('x').map(Number));
}

const processDirs = [join(LAB, 'process'), join(BASE, 'process')];
const filamentDirs = [join(LAB, 'filament'), join(BASE, 'filament')];
const machineDirs = [join(LAB, 'printer'), join(BASE, 'machine')];

const bundle = JSON.parse(readFileSync(join(LAB, 'bundle_structure.json'), 'utf8'));

const m = resolve(machineDirs, bundle.printer_preset_name);
const area = points(m.printable_area);
const printer = {
  name: m.name,
  model: m.printer_model,
  nozzleDiameter: num(m.nozzle_diameter),
  // Printable area exactly as defined in the lab's printer preset.
  printableArea: {
    minX: Math.min(...area.map((p) => p[0])),
    minY: Math.min(...area.map((p) => p[1])),
    maxX: Math.max(...area.map((p) => p[0])),
    maxY: Math.max(...area.map((p) => p[1])),
  },
  printableHeight: num(m.printable_height),
  maxSpeedX: num(m.machine_max_speed_x),
  maxSpeedY: num(m.machine_max_speed_y),
  maxSpeedZ: num(m.machine_max_speed_z),
  maxAccelExtruding: num(m.machine_max_acceleration_extruding),
  maxAccelTravel: num(m.machine_max_acceleration_travel),
  maxAccelZ: num(m.machine_max_acceleration_z),
  jerkXY: num(m.machine_max_jerk_x),
  retractionLength: num(m.retraction_length),
  retractionSpeed: num(m.retraction_speed),
  retractionMinTravel: num(m.retraction_minimum_travel),
  zHop: num(m.z_hop),
  prepareTime: num(m.machine_prepare_compensation_time),
};

function filamentFor(name) {
  const f = resolve(filamentDirs, name);
  return {
    name: f.name,
    diameter: num(f.filament_diameter),
    density: num(f.filament_density),
    maxVolumetricSpeed: num(f.filament_max_volumetric_speed),
    slowDownForLayerCooling: num(f.slow_down_for_layer_cooling) === 1,
    slowDownLayerTime: num(f.slow_down_layer_time),
    slowDownMinSpeed: num(f.slow_down_min_speed),
  };
}

const filaments = {};
for (const path of bundle.filament_config) {
  const name = path.replace(/^filament\//, '').replace(/\.json$/, '');
  filaments[name] = filamentFor(name);
}

const processes = [];
for (const path of bundle.process_config) {
  const name = path.replace(/^process\//, '').replace(/\.json$/, '');
  const p = resolve(processDirs, name);
  const defAccel = num(p.default_acceleration);
  const lineWidth = num(p.line_width);
  const width = (v) => num(v, printer.nozzleDiameter) || lineWidth;
  const accel = (v) => num(v, defAccel) || defAccel;
  processes.push({
    name: p.name,
    layerHeight: num(p.layer_height),
    firstLayerHeight: num(p.initial_layer_print_height),
    wallLoops: num(p.wall_loops),
    topShellLayers: num(p.top_shell_layers),
    topShellThickness: num(p.top_shell_thickness),
    bottomShellLayers: num(p.bottom_shell_layers),
    bottomShellThickness: num(p.bottom_shell_thickness),
    sparseInfillDensity: pct(p.sparse_infill_density),
    sparseInfillPattern: p.sparse_infill_pattern,
    topSurfacePattern: p.top_surface_pattern,
    bottomSurfacePattern: p.bottom_surface_pattern,
    infillDirection: num(p.infill_direction),
    infillWallOverlap: pct(p.infill_wall_overlap),
    minimumSparseInfillArea: num(p.minimum_sparse_infill_area),
    elephantFootCompensation: num(p.elefant_foot_compensation),
    detectThinWall: num(p.detect_thin_wall) === 1,
    wallSequence: p.wall_infill_order,
    seamPosition: p.seam_position,
    lineWidth: {
      default: lineWidth,
      firstLayer: width(p.initial_layer_line_width),
      outerWall: width(p.outer_wall_line_width),
      innerWall: width(p.inner_wall_line_width),
      sparseInfill: width(p.sparse_infill_line_width),
      internalSolidInfill: width(p.internal_solid_infill_line_width),
      topSurface: width(p.top_surface_line_width),
      support: width(p.support_line_width),
    },
    speed: {
      outerWall: num(p.outer_wall_speed),
      innerWall: num(p.inner_wall_speed),
      sparseInfill: num(p.sparse_infill_speed),
      internalSolidInfill: num(p.internal_solid_infill_speed),
      topSurface: num(p.top_surface_speed),
      gapInfill: num(p.gap_infill_speed),
      bridge: num(p.bridge_speed),
      support: num(p.support_speed),
      supportInterface: num(p.support_interface_speed),
      travel: num(p.travel_speed),
      firstLayer: num(p.initial_layer_speed),
      firstLayerInfill: num(p.initial_layer_infill_speed),
      overhang: [num(p.overhang_1_4_speed), num(p.overhang_2_4_speed), num(p.overhang_3_4_speed), num(p.overhang_4_4_speed)],
    },
    accel: {
      default: defAccel,
      outerWall: accel(p.outer_wall_acceleration),
      innerWall: accel(p.inner_wall_acceleration),
      sparseInfill: accel(p.sparse_infill_acceleration),
      topSurface: accel(p.top_surface_acceleration),
      firstLayer: accel(p.initial_layer_acceleration),
      travel: accel(p.travel_acceleration),
      firstLayerTravel: accel(p.initial_layer_travel_acceleration),
    },
    brim: {
      type: p.brim_type,
      width: num(p.brim_width),
      objectGap: num(p.brim_object_gap),
    },
    support: {
      enabled: num(p.enable_support) === 1,
      type: p.support_type,
      thresholdAngle: num(p.support_threshold_angle),
      onBuildPlateOnly: num(p.support_on_build_plate_only) === 1,
      topZDistance: num(p.support_top_z_distance),
      bottomZDistance: num(p.support_bottom_z_distance),
      objectXYDistance: num(p.support_object_xy_distance),
      interfaceTopLayers: num(p.support_interface_top_layers),
      interfaceSpacing: num(p.support_interface_spacing),
      baseSpacing: num(p.support_base_pattern_spacing),
      treeBranchDiameter: num(p.tree_support_branch_diameter),
      treeBranchAngle: num(p.tree_support_branch_angle),
    },
  });
}

// Student-facing names: the preset names from Bambu Studio without the suffix
// they all share (e.g. "Normal - Bezalel Modelling Center" → "Normal").
const suffix = commonSuffix(processes.map((p) => p.name));
for (const p of processes) p.label = suffix ? p.name.slice(0, -suffix.length).trim() : p.name;

function commonSuffix(names) {
  if (names.length < 2) return '';
  let s = names[0];
  for (const n of names) while (s && !n.endsWith(s)) s = s.slice(1);
  // Only strip a whole " - …" part, never part of a word.
  const i = s.indexOf(' - ');
  return i >= 0 ? s.slice(i) : '';
}

const out = `// GENERATED by tools/resolve-profiles.mjs from profiles/ — do not edit by hand.
// Source bundle: ${bundle.bundle_id} (Bambu Studio ${bundle.version})

export const PRINTER = ${JSON.stringify(printer, null, 2)};

export const FILAMENTS = ${JSON.stringify(filaments, null, 2)};

export const PROCESSES = ${JSON.stringify(processes, null, 2)};
`;
writeFileSync(join(ROOT, 'js/profiles-data.js'), out);
console.log(`Wrote js/profiles-data.js: ${processes.length} processes, ${Object.keys(filaments).length} filaments`);
