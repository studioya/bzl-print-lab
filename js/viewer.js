// three.js scene: build plate, model copies, and the sliced toolpath preview.

import * as THREE from '../vendor/three.bundle.min.js';
import { OrbitControls } from '../vendor/three.bundle.min.js';
import { FEATURES } from './slicer/features.js';
import { PLATE } from './arrange.js';

const COLORS = { White: 0xf4f4f0, Black: 0x2e2e2e };
const BAD = 0xe0484f;

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xdfe3e6);
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => this.requestRender());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f94, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-150, -250, 400);
    this.scene.add(sun);

    this.buildPlate();
    this.modelGroup = new THREE.Group();
    this.previewGroup = new THREE.Group();
    this.scene.add(this.modelGroup, this.previewGroup);
    this.modelColor = COLORS.White;
    this.mode = 'model';
    this.onFacePick = null;

    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    this.renderer.domElement.addEventListener('pointerdown', (e) => this.pointerDown(e));
    this.renderer.domElement.addEventListener('pointerup', (e) => this.pointerUp(e));
    this.resetCamera();
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.controls.update() || this.dirty) {
        this.dirty = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    loop();
  }

  requestRender() { this.dirty = true; }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  buildPlate() {
    const g = new THREE.Group();
    const W = PLATE.width, D = PLATE.depth;
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(W + 16, D + 16, 4),
      new THREE.MeshStandardMaterial({ color: 0x4b4f54, roughness: 0.9 }),
    );
    base.position.set(W / 2, D / 2, -2.05);
    g.add(base);
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(W, D),
      new THREE.MeshStandardMaterial({ color: 0x33373b, roughness: 0.75 }),
    );
    surface.position.set(W / 2, D / 2, -0.02);
    g.add(surface);
    const pts = [];
    for (let x = 0; x <= W + 1e-6; x += 10) pts.push(x, 0, 0, x, D, 0);
    for (let y = 0; y <= D + 1e-6; y += 10) pts.push(0, y, 0, W, y, 0);
    const grid = new THREE.BufferGeometry();
    grid.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g.add(new THREE.LineSegments(grid, new THREE.LineBasicMaterial({ color: 0x5d6368 })));
    const border = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0.05), new THREE.Vector3(W, 0, 0.05), new THREE.Vector3(W, D, 0.05),
      new THREE.Vector3(0, D, 0.05), new THREE.Vector3(0, 0, 0.05),
    ]);
    g.add(new THREE.Line(border, new THREE.LineBasicMaterial({ color: 0x00ae42 })));
    // Build volume outline.
    const vol = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(W, D, PLATE.height)),
      new THREE.LineBasicMaterial({ color: 0x9aa3ab, transparent: true, opacity: 0.35 }),
    );
    vol.position.set(W / 2, D / 2, PLATE.height / 2);
    g.add(vol);
    this.scene.add(g);
  }

  resetCamera() {
    const W = PLATE.width, D = PLATE.depth;
    this.controls.target.set(W / 2, D / 2, 20);
    this.camera.position.set(W / 2 - 60, -D * 0.95, 260);
    this.controls.update();
    this.requestRender();
  }

  /** Points the camera at a box on the plate, keeping the view direction. */
  frame(minX, maxX, minY, maxY, maxZ) {
    const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, maxZ / 2);
    const radius = Math.max(Math.hypot(maxX - minX, maxY - minY, maxZ) / 2, 25);
    const dist = Math.min(Math.max(radius / Math.sin((this.camera.fov * Math.PI) / 360) * 2.1, 120), 750);
    const dir = new THREE.Vector3(-0.22, -0.78, 0.6).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.update();
    this.requestRender();
  }

  setModelColor(name) {
    this.modelColor = COLORS[name] ?? COLORS.White;
    this.updateMaterials();
  }

  /**
   * objects: [{ key, positions (oriented, centred), version, fits }]
   * placements: [{ key, x, y }] — what to show on the current plate
   */
  setScene(objects, placements, selectedKey) {
    this.clearGroup(this.modelGroup, false);
    this.objects = new Map(objects.map((o) => [o.key, o]));
    // Rebuild geometry only for objects that changed.
    this.geoms ??= new Map();
    for (const [key, g] of this.geoms) {
      const o = this.objects.get(key);
      if (!o || o.version !== g.version) { g.geom.dispose(); this.geoms.delete(key); }
    }
    for (const o of objects) {
      if (this.geoms.has(o.key)) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(o.positions, 3));
      geom.computeVertexNormals();
      this.geoms.set(o.key, { geom, version: o.version });
    }
    this.materials ??= {
      normal: new THREE.MeshStandardMaterial({ roughness: 0.55 }),
      selected: new THREE.MeshStandardMaterial({ roughness: 0.55, emissive: 0x00ae42, emissiveIntensity: 0.35 }),
      bad: new THREE.MeshStandardMaterial({ roughness: 0.55, color: BAD }),
      badSelected: new THREE.MeshStandardMaterial({ roughness: 0.55, color: BAD, emissive: 0x00ae42, emissiveIntensity: 0.3 }),
    };
    this.updateMaterials();
    for (const pl of placements) {
      const o = this.objects.get(pl.key);
      const g = this.geoms.get(pl.key);
      if (!o || !g) continue;
      const sel = pl.key === selectedKey;
      const mat = o.fits ? (sel ? this.materials.selected : this.materials.normal) : (sel ? this.materials.badSelected : this.materials.bad);
      const m = new THREE.Mesh(g.geom, mat);
      m.position.set(pl.x, pl.y, 0);
      m.userData.key = pl.key;
      this.modelGroup.add(m);
    }
    this.requestRender();
  }

  updateMaterials() {
    if (!this.materials) return;
    this.materials.normal.color.setHex(this.modelColor);
    this.materials.selected.color.setHex(this.modelColor);
    this.requestRender();
  }

  clearGroup(g, dispose = true) {
    for (const c of [...g.children]) {
      g.remove(c);
      if (dispose) c.geometry?.dispose?.();
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.modelGroup.visible = mode === 'model';
    this.previewGroup.visible = mode === 'preview';
    this.requestRender();
  }

  // ---- lay on face picking ----
  setFacePicking(cb) {
    this.onFacePick = cb;
    this.renderer.domElement.style.cursor = cb ? 'crosshair' : '';
  }

  pointerDown(e) { this.downAt = [e.clientX, e.clientY]; }

  pointerUp(e) {
    if (!this.downAt || this.mode !== 'model') return;
    if (Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]) > 4) return; // was a drag
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObjects(this.modelGroup.children, false)[0];
    if (this.onFacePick) {
      if (hit && hit.face) {
        const n = hit.face.normal.clone();
        const cb = this.onFacePick;
        this.setFacePicking(null);
        cb(hit.object.userData.key, [n.x, n.y, n.z]);
      }
      return;
    }
    if (this.onSelect) this.onSelect(hit ? hit.object.userData.key : null);
  }

  // ---- toolpath preview ----
  /** previews: { key: preview buffers }; placements: [{ key, x, y }] on this plate. */
  setPreview(previews, placements) {
    this.clearGroup(this.previewGroup, false);
    for (const g of this.previewGeoms?.values() || []) g.dispose();
    this.previewGeoms = new Map();
    this.previews = previews;
    // All objects share the profile's layer heights; use the tallest for z values.
    this.zs = Object.values(previews).reduce((a, p) => (p.zs.length > a.length ? p.zs : a), new Float32Array(0));
    const total = placements.reduce((s, pl) => s + (previews[pl.key]?.layerStart.at(-1) || 0), 0);
    // Small previews use a full box per segment (Bambu-like tubes); big ones a
    // flat top ribbon, which is 6× cheaper to draw on modest GPUs.
    const lite = total > 600_000;
    const box = lite ? new THREE.PlaneGeometry(1, 1) : new THREE.BoxGeometry(1, 1, 1);
    box.translate(0.5, 0, lite ? 0 : -0.5);

    const colors = FEATURES.map((f) => new THREE.Color(f.color));
    this.previewUniforms = {
      uColors: { value: colors },
      uMaxZ: { value: 1e9 },
      uMinZ: { value: -1 },
      uHidden: { value: 0 },
      uLightDir: { value: new THREE.Vector3(-0.35, -0.55, 0.75).normalize() },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.previewUniforms,
      vertexShader: `
        attribute vec4 aSeg; attribute vec3 aZWH; attribute float aType;
        uniform vec3 uColors[${FEATURES.length}];
        uniform float uMaxZ; uniform float uMinZ; uniform float uHidden;
        uniform vec3 uLightDir;
        varying vec3 vColor;
        void main() {
          float t = floor(aType + 0.5);
          float hidden = mod(floor(uHidden / pow(2.0, t)), 2.0);
          if (aZWH.x > uMaxZ + 0.001 || aZWH.x < uMinZ - 0.001 || hidden > 0.5) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;
          }
          vec2 d = aSeg.zw - aSeg.xy;
          float len = length(d);
          vec2 dir = len > 0.0 ? d / len : vec2(1.0, 0.0);
          vec2 nrm = vec2(-dir.y, dir.x);
          float w = aZWH.y, h = aZWH.z;
          // Extend by half a width at both ends so joints look continuous.
          float along = position.x * (len + w) - w * 0.5;
          vec2 xy = aSeg.xy + dir * along + nrm * position.y * w;
          float z = aZWH.x + position.z * h;
          vec3 n = vec3(dir * normal.x + nrm * normal.y, normal.z);
          float light = 0.45 + 0.55 * max(dot(n, uLightDir), 0.0) + 0.15 * max(n.z, 0.0);
          int ti = int(t);
          vec3 c = uColors[0];
          ${FEATURES.map((f, i) => `if (ti == ${i}) c = uColors[${i}];`).join('\n          ')}
          vColor = c * light;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(xy, z, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vColor;
        void main() { gl_FragColor = vec4(vColor, 1.0); }`,
    });

    for (const pl of placements) {
      const pv = previews[pl.key];
      if (!pv) continue;
      let geom = this.previewGeoms.get(pl.key);
      if (!geom) {
        geom = new THREE.InstancedBufferGeometry();
        geom.index = box.index;
        geom.setAttribute('position', box.getAttribute('position'));
        geom.setAttribute('normal', box.getAttribute('normal'));
        const buf = new THREE.InstancedInterleavedBuffer(pv.data, 8);
        geom.setAttribute('aSeg', new THREE.InterleavedBufferAttribute(buf, 4, 0));
        geom.setAttribute('aZWH', new THREE.InterleavedBufferAttribute(buf, 3, 4));
        geom.setAttribute('aType', new THREE.InterleavedBufferAttribute(buf, 1, 7));
        geom.instanceCount = pv.layerStart.at(-1);
        geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 400);
        geom.userData.preview = pv;
        this.previewGeoms.set(pl.key, geom);
      }
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(pl.x, pl.y, 0);
      mesh.frustumCulled = false;
      this.previewGroup.add(mesh);
    }
    this.requestRender();
  }

  setPreviewLayers(minLayer, maxLayer) {
    if (!this.previewUniforms || !this.zs?.length) return;
    const zs = this.zs;
    this.previewUniforms.uMaxZ.value = zs[Math.min(maxLayer, zs.length - 1)];
    this.previewUniforms.uMinZ.value = zs[Math.max(0, Math.min(minLayer, zs.length - 1))];
    for (const geom of this.previewGeoms.values()) {
      const pv = geom.userData.preview;
      geom.instanceCount = pv.layerStart[Math.min(maxLayer + 1, pv.zs.length)];
    }
    this.requestRender();
  }

  setHiddenFeatures(ids) {
    if (!this.previewUniforms) return;
    this.previewUniforms.uHidden.value = ids.reduce((m, id) => m + 2 ** id, 0);
    this.requestRender();
  }

  snapshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/jpeg', 0.8);
  }
}
