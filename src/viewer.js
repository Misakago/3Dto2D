// three.js 3D 预览：PBR 材质、特征高亮、剖切、视角动画
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const FEATURE_COLORS = { hole: 0x0891b2, boss: 0xd97706, fillet: 0x7c3aed };

export class Viewer {
  constructor(container) {
    this.container = container;
    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.localClippingEnabled = true;
    container.appendChild(renderer.domElement);

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1e6);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(1, -1.2, 0.9);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, -2, 3);
    this.scene.add(key, new THREE.HemisphereLight(0xbfdcff, 0x202030, 0.6));

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.grid = null;

    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    this.clipEnabled = false;

    this.material = new THREE.MeshStandardMaterial({
      color: 0x9fb4c8, metalness: 0.75, roughness: 0.32, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      clippingPlanes: [],
    });
    this.edgeMaterial = new THREE.LineBasicMaterial({ color: 0x0b1220, transparent: true, opacity: 0.55, clippingPlanes: [] });
    this.featureMaterials = Object.fromEntries(Object.entries(FEATURE_COLORS).map(([k, c]) => [k, new THREE.MeshStandardMaterial({
      color: c, emissive: c, emissiveIntensity: 0.2, metalness: 0.3, roughness: 0.4, side: THREE.DoubleSide, clippingPlanes: [],
    })]));

    this.tween = null;
    this.dark = document.documentElement.dataset.theme === 'dark';
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    renderer.setAnimationLoop(() => this.tick());
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  tick() {
    if (this.tween) {
      const t = Math.min(1, (performance.now() - this.tween.start) / this.tween.dur);
      const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.camera.position.lerpVectors(this.tween.from, this.tween.to, k);
      this.camera.up.lerpVectors(this.tween.upFrom, this.tween.upTo, k).normalize();
      this.camera.lookAt(this.controls.target);
      if (t >= 1) this.tween = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** geometries: BufferGeometry[]（模型坐标），orientation: Quaternion */
  setModel(geometries, parts, features) {
    this.root.clear();
    this.geometries = geometries;
    this.meshGroup = new THREE.Group();
    this.edgeGroup = new THREE.Group();
    this.featureGroup = new THREE.Group();
    geometries.forEach((g, i) => {
      const color = parts[i].color;
      const mat = this.material.clone();
      if (color) mat.color.setRGB(...color).lerp(new THREE.Color(0x9fb4c8), 0.55);
      mat.clippingPlanes = this.material.clippingPlanes;
      this.meshGroup.add(new THREE.Mesh(g, mat));
      this.edgeGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 28), this.edgeMaterial));
    });
    // 特征面高亮：按 brep 面三角范围抽取子网格
    for (const f of features) {
      const idx = [];
      for (const { partIndex, faceIndex } of f.faces) {
        const bf = parts[partIndex].brepFaces[faceIndex];
        const I = parts[partIndex].index;
        for (let t = bf.first; t <= bf.last; t++) idx.push(I[3 * t], I[3 * t + 1], I[3 * t + 2]);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', geometries[partIndex].attributes.position);
        g.setAttribute('normal', geometries[partIndex].attributes.normal);
        g.setIndex(idx.splice(0));
        const m = new THREE.Mesh(g, this.featureMaterials[f.kind]);
        m.userData.kind = f.kind;
        this.featureGroup.add(m);
      }
    }
    this.featureGroup.visible = false;
    this.root.add(this.meshGroup, this.edgeGroup, this.featureGroup);
    this.fit();
  }

  /** 显示网格（按三角形着色），用于网格质量查看：{ pos, tris, colors(每三角形 rgb) } */
  showMesh({ pos, tris, colors, edges = true, highlight = null }) {
    this.root.clear();
    const n = tris.length / 3;
    const P = new Float32Array(n * 9), C = new Float32Array(n * 9);
    for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
      const v = tris[3 * t + k];
      P.set([pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]], 9 * t + 3 * k);
      C.set([colors[3 * t], colors[3 * t + 1], colors[3 * t + 2]], 9 * t + 3 * k);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('color', new THREE.BufferAttribute(C, 3));
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.1, roughness: 0.75, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes: this.material.clippingPlanes });
    this.meshGroup = new THREE.Group();
    this.meshGroup.add(new THREE.Mesh(g, mat));
    this.edgeGroup = new THREE.Group();
    if (edges) {
      const wire = new THREE.WireframeGeometry(g);
      this.edgeGroup.add(new THREE.LineSegments(wire, new THREE.LineBasicMaterial({ color: this.dark ? 0x0b0f17 : 0x334155, transparent: true, opacity: 0.35 })));
    }
    this.featureGroup = new THREE.Group();
    if (highlight) {
      // 高亮三角形（如去除的圆角面），叠加半透明红色
      const hg = new THREE.BufferGeometry();
      hg.setAttribute('position', new THREE.BufferAttribute(highlight, 3));
      hg.computeVertexNormals();
      this.featureGroup.add(new THREE.Mesh(hg, new THREE.MeshBasicMaterial({ color: 0xd32f2f, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthTest: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
    }
    this.root.add(this.meshGroup, this.edgeGroup, this.featureGroup);
    this.root.updateMatrixWorld(true);
    this.fit();
  }

  setOrientation(q) {
    this.root.quaternion.copy(q);
    this.root.updateMatrixWorld(true);
    this.fit();
  }

  fit(animate = false) {
    const box = new THREE.Box3().setFromObject(this.meshGroup || this.root);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    this.radius = size.length() / 2;
    this.center = center;
    this.controls.target.copy(center);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = this.radius / Math.sin(Math.min(vfov, hfov) / 2) * 1.02;
    this.camera.near = dist / 100;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    const dir = new THREE.Vector3(1, -1.25, 0.85).normalize();
    if (animate) this.flyTo(dir, new THREE.Vector3(0, 0, 1));
    else {
      this.camera.position.copy(center).addScaledVector(dir, dist);
      this.camera.up.set(0, 0, 1);
      this.camera.lookAt(center);
    }
    // 地面网格
    if (this.grid) this.scene.remove(this.grid);
    const step = Math.pow(10, Math.floor(Math.log10(this.radius)));
    const gsize = Math.ceil((this.radius * 4) / step) * step;
    const [c1, c2] = this.dark ? [0x3a4250, 0x262c36] : [0xb8c0cc, 0xd5dae2];
    this.grid = new THREE.GridHelper(gsize, gsize / step * 2, c1, c2);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.set(center.x, center.y, box.min.z - this.radius * 0.02);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.8;
    this.scene.add(this.grid);
    this.box = box;
    this.setClip(this.clipEnabled, this.clipValue ?? 0.5);
  }

  /** 视线方向 dir（从模型指向相机） */
  flyTo(dir, up, dur = 900) {
    if (!this.center) return;
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = this.radius / Math.sin(Math.min(vfov, hfov) / 2) * 1.02;
    this.tween = {
      start: performance.now(), dur,
      from: this.camera.position.clone(),
      to: this.center.clone().addScaledVector(dir.clone().normalize(), dist),
      upFrom: this.camera.up.clone(), upTo: up.clone(),
    };
  }

  setWireframe(on) { this.meshGroup?.children.forEach(m => { m.material.wireframe = on; }); }
  setEdges(on) { if (this.edgeGroup) this.edgeGroup.visible = on; }
  setFeatures(on) {
    if (!this.featureGroup) return;
    this.featureGroup.visible = on;
    this.meshGroup.children.forEach(m => { m.material.transparent = on; m.material.opacity = on ? 0.35 : 1; m.material.depthWrite = !on; });
  }

  setClip(on, value) {
    this.clipEnabled = on;
    this.clipValue = value;
    const planes = on ? [this.clipPlane] : [];
    if (this.box) this.clipPlane.constant = THREE.MathUtils.lerp(this.box.min.z, this.box.max.z, value) + 1e-6;
    const all = [this.material, this.edgeMaterial, ...Object.values(this.featureMaterials), ...(this.meshGroup?.children.map(m => m.material) || [])];
    all.forEach(m => { m.clippingPlanes = planes; m.needsUpdate = true; });
  }

  setTheme(dark) {
    this.dark = dark;
    this.edgeMaterial.color.set(dark ? 0x05070a : 0x1f2733);
    this.edgeMaterial.opacity = dark ? 0.6 : 0.45;
    if (this.meshGroup) {
      const keepCam = this.camera.position.clone(), keepUp = this.camera.up.clone(), keepTarget = this.controls.target.clone();
      this.fit();
      this.camera.position.copy(keepCam); this.camera.up.copy(keepUp); this.controls.target.copy(keepTarget);
    }
  }

  /** 离屏渲染透明背景缩略图（轴测视角，无网格） */
  renderThumbnail(w = 360, h = 240) {
    const r = this.renderer;
    const prevSize = r.getSize(new THREE.Vector2());
    const prevRatio = r.getPixelRatio();
    const cam = this.camera.clone();
    cam.aspect = w / h;
    const vfov = THREE.MathUtils.degToRad(cam.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * cam.aspect);
    const dist = this.radius / Math.sin(Math.min(vfov, hfov) / 2) * 0.98;
    cam.up.set(0, 0, 1);
    cam.position.copy(this.center).addScaledVector(new THREE.Vector3(1, -1.25, 0.85).normalize(), dist);
    cam.lookAt(this.center);
    cam.updateProjectionMatrix();
    const gridVis = this.grid?.visible, featVis = this.featureGroup?.visible;
    if (this.grid) this.grid.visible = false;
    if (this.featureGroup) this.setFeatures(false);
    r.setPixelRatio(1);
    r.setSize(w, h, false);
    r.setClearColor(0x000000, 0);
    r.render(this.scene, cam);
    const url = r.domElement.toDataURL('image/webp', 0.86);
    if (this.grid) this.grid.visible = gridVis;
    if (featVis) this.setFeatures(true);
    r.setPixelRatio(prevRatio);
    r.setSize(prevSize.x, prevSize.y);
    return url;
  }

  snapshot(w = 320, h = 200) {
    const src = this.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const s = Math.min(src.width / w, src.height / h);
    const sw = w * s, sh = h * s;
    ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, w, h);
    return c.toDataURL('image/webp', 0.8);
  }
}
