// 网格纵横比优化 Worker：投影使用原始网格 BVH，按体分别优化
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { weld, aspectStats, optimizeAspect } from '../meshopt.js';

const ARB = [1.5, 2, 3, 4, 6, 10, 20, 50, Infinity];
const summarize = (pos, tris, target) => {
  const s = aspectStats(pos, tris);
  return { n: s.n, max: s.max, mean: s.mean, over: s.countOver(target), hist: s.hist, bins: ARB, ar: Float32Array.from(s.ar) };
};

self.onmessage = (e) => {
  const { bodies, target, edgeLength, featureAngle, cornerTol } = e.data;
  try {
    const out = [];
    const t0 = performance.now();
    bodies.forEach((b, bi) => {
      const w = b.welded ? { pos: b.pos, tris: b.tris } : weld(b.pos, b.tris, 1e-5);
      const before = summarize(w.pos, w.tris, target);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(w.pos), 3));
      g.setIndex(new THREE.BufferAttribute(Uint32Array.from(w.tris), 1));
      const bvh = new MeshBVH(g);
      const v3 = new THREE.Vector3(), hit = {};
      const project = (p) => { const r = bvh.closestPointToPoint(v3.set(p[0], p[1], p[2]), hit); return r ? [r.point.x, r.point.y, r.point.z] : p; };
      const res = optimizeAspect(w.pos, w.tris, {
        target, edgeLength, featureAngle, cornerTol, project,
        onProgress: (stage, f) => self.postMessage({ type: 'progress', stage, body: bi, bodies: bodies.length, frac: (bi + f) / bodies.length }),
      });
      // 几何偏差：新顶点到原曲面的距离
      let dmax = 0, dsum = 0;
      for (let i = 0; i < res.pos.length; i += 3) { const r = bvh.closestPointToPoint(v3.set(res.pos[i], res.pos[i + 1], res.pos[i + 2]), hit); if (r) { dmax = Math.max(dmax, r.distance); dsum += r.distance; } }
      out.push({ before, after: summarize(res.pos, res.tris, target), pos: res.pos, tris: res.tris, origPos: w.pos, origTris: w.tris, devMax: dmax, devMean: dsum / (res.pos.length / 3), log: res.log });
    });
    self.postMessage({ type: 'done', bodies: out, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.stack || err) });
  }
};
