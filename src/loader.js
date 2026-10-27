// 统一的模型加载：STEP/IGES/BREP 走 OCCT(WASM, Web Worker)，STL/OBJ/GLB/PLY 走 three.js 加载器
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { parseStep } from './stepParser.js';
import { now } from './clock.js';

export const CAD_FORMATS = ['step', 'stp', 'iges', 'igs', 'brep', 'brp'];
export const MESH_FORMATS = ['stl', 'obj', 'glb', 'gltf', 'ply'];
export const ACCEPT = [...CAD_FORMATS, ...MESH_FORMATS].map(e => '.' + e).join(',');

export const OCCT_PARAMS = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.0008,
  angularDeflection: 0.2,
};

function runOcct(format, buffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.env.BASE_URL + 'occt/occt-import-js-worker.js', location.href));
    worker.onmessage = (ev) => { worker.terminate(); resolve(ev.data); };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'OCCT worker 错误')); };
    worker.postMessage({ format, buffer, params: OCCT_PARAMS });
  });
}

/**
 * @returns {Promise<{ parts, step, format, timings }>}
 * parts: [{ name, color, positions, normals, index, brepFaces }]
 */
export async function loadModel(file, onStage = () => {}) {
  const ext = file.name.split('.').pop().toLowerCase();
  const timings = {};
  let t = now();
  onStage('read', '读取文件');
  const buffer = await file.arrayBuffer();
  timings.read = now() - t;

  let step = null;
  let parts = [];

  if (CAD_FORMATS.includes(ext)) {
    if (ext === 'step' || ext === 'stp') {
      t = now();
      onStage('parse', '解析 STEP 实体');
      const text = new TextDecoder('latin1').decode(buffer);
      step = parseStep(text);
      timings.parse = now() - t;
    }
    t = now();
    onStage('mesh', 'OCCT B-rep 网格化');
    const format = ext === 'stp' ? 'step' : ext === 'igs' ? 'iges' : ext === 'brp' ? 'brep' : ext;
    const res = await runOcct(format, new Uint8Array(buffer));
    timings.mesh = now() - t;
    if (!res || !res.success) throw new Error('OCCT 无法解析该文件');
    parts = res.meshes.map((m, i) => ({
      name: m.name || `Body ${i + 1}`,
      color: m.color || null,
      positions: new Float32Array(m.attributes.position.array),
      normals: m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null,
      index: new Uint32Array(m.index.array),
      brepFaces: m.brep_faces || [],
    }));
  } else if (MESH_FORMATS.includes(ext)) {
    t = now();
    onStage('mesh', '解析网格');
    let geoms = [];
    if (ext === 'stl') {
      geoms = [new STLLoader().parse(buffer)];
    } else if (ext === 'ply') {
      geoms = [new PLYLoader().parse(buffer)];
    } else if (ext === 'obj') {
      const obj = new OBJLoader().parse(new TextDecoder().decode(buffer));
      obj.updateMatrixWorld(true);
      obj.traverse(o => { if (o.isMesh) geoms.push(o.geometry.clone().applyMatrix4(o.matrixWorld)); });
    } else {
      const gltf = await new GLTFLoader().parseAsync(buffer, '');
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse(o => { if (o.isMesh) geoms.push(o.geometry.clone().applyMatrix4(o.matrixWorld)); });
    }
    parts = geoms.map((g, i) => {
      g.deleteAttribute('uv');
      g.deleteAttribute('color');
      if (g.attributes.normal) g.deleteAttribute('normal');
      const merged = mergeVertices(g, 1e-5);
      merged.computeVertexNormals();
      return {
        name: `Mesh ${i + 1}`,
        color: null,
        positions: merged.attributes.position.array,
        normals: merged.attributes.normal.array,
        index: merged.index ? Uint32Array.from(merged.index.array) : Uint32Array.from({ length: merged.attributes.position.count }, (_, k) => k),
        brepFaces: [],
      };
    });
    timings.mesh = now() - t;
  } else {
    throw new Error(`不支持的格式 .${ext}`);
  }
  return { parts, step, format: ext, timings, size: buffer.byteLength };
}

export function partsToGeometries(parts) {
  return parts.map(p => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
    if (p.normals) g.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
    else g.computeVertexNormals();
    // 独立副本：BVH 构建会重排索引，B-rep 面的三角区间仍需原始顺序
    g.setIndex(new THREE.BufferAttribute(p.index.slice(), 1));
    g.computeBoundingBox();
    return g;
  });
}

// 体积 / 表面积 / 包围盒 / 三角数 / 重心
export function measure(parts) {
  let volume = 0, area = 0, tris = 0;
  const box = new THREE.Box3();
  const c = [0, 0, 0];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), e = new THREE.Vector3();
  for (const p of parts) {
    const P = p.positions, I = p.index;
    for (let i = 0; i < P.length; i += 3) box.expandByPoint(a.set(P[i], P[i + 1], P[i + 2]));
    for (let i = 0; i < I.length; i += 3) {
      a.fromArray(P, I[i] * 3); b.fromArray(P, I[i + 1] * 3); d.fromArray(P, I[i + 2] * 3);
      const v = a.dot(e.copy(b).cross(d)) / 6;
      volume += v;
      c[0] += v * (a.x + b.x + d.x) / 4; c[1] += v * (a.y + b.y + d.y) / 4; c[2] += v * (a.z + b.z + d.z) / 4;
      area += e.copy(b).sub(a).cross(d.clone().sub(a)).length() / 2;
      tris++;
    }
  }
  const size = box.getSize(new THREE.Vector3());
  const centroid = Math.abs(volume) > 1e-9 ? c.map(x => x / volume) : box.getCenter(new THREE.Vector3()).toArray();
  return { volume: Math.abs(volume), area, tris, box, size, centroid, diag: size.length() };
}
