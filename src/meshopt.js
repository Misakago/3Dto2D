// 三角网格纵横比优化（模流分析 Dual Domain 网格）
// 纵横比定义（与 Moldflow 一致）：最长边 / 该边上的高；正三角形 = 1.155
// 策略：特征边保护下的 翻边 → 针状单元塌陷短边 → 帽状单元分裂长边 → 切平面平滑并投影回原始曲面，迭代直至达标

const EPS = 1e-12;

export function triAspect(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const e0 = Math.hypot(bx - ax, by - ay, bz - az), e1 = Math.hypot(cx - bx, cy - by, cz - bz), e2 = Math.hypot(ax - cx, ay - cy, az - cz);
  const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
  const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  const L = Math.max(e0, e1, e2);
  if (area2 < EPS) return 1e9;
  return (L * L) / area2; // L / (2A/L)
}

/** 统计：纵横比数组 + 直方图 */
export function aspectStats(pos, tris) {
  const n = tris.length / 3;
  const ar = new Float64Array(n);
  let max = 0, sum = 0, over = 0;
  for (let t = 0; t < n; t++) {
    const a = tris[3 * t] * 3, b = tris[3 * t + 1] * 3, c = tris[3 * t + 2] * 3;
    const v = triAspect(pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[c], pos[c + 1], pos[c + 2]);
    ar[t] = v; sum += v; if (v > max) max = v;
  }
  const bins = [1.5, 2, 3, 4, 6, 10, 20, 50, Infinity];
  const hist = bins.map(() => 0);
  for (const v of ar) { hist[bins.findIndex(b => v <= b)]++; }
  return { ar, max, mean: sum / n, n, bins, hist, countOver: (lim) => { let c = 0; for (const v of ar) if (v > lim) c++; return c; } };
}

/** 焊接重复顶点，返回 { pos: Float64Array, tris: Int32Array } */
export function weld(positions, index, tol = 1e-6) {
  const map = new Map();
  const pos = [];
  const remap = new Int32Array(positions.length / 3);
  for (let i = 0; i < positions.length / 3; i++) {
    const k = Math.round(positions[3 * i] / tol) + ',' + Math.round(positions[3 * i + 1] / tol) + ',' + Math.round(positions[3 * i + 2] / tol);
    let id = map.get(k);
    if (id === undefined) { id = pos.length / 3; map.set(k, id); pos.push(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]); }
    remap[i] = id;
  }
  const tris = [];
  for (let t = 0; t < index.length; t += 3) {
    const a = remap[index[t]], b = remap[index[t + 1]], c = remap[index[t + 2]];
    if (a !== b && b !== c && c !== a) tris.push(a, b, c);
  }
  return { pos: Float64Array.from(pos), tris: Int32Array.from(tris) };
}

// ---------------- 各向同性重网格（保留特征）----------------
// Botsch & Kobbelt：分裂长边 / 塌陷短边 / 翻边均衡度数 / 切向松弛 + 投影回原曲面
const KEY = 67108864; // 2^26
const ek = (a, b) => (a < b ? a * KEY + b : b * KEY + a);

class Remesher {
  constructor(pos, tris, { featureAngle = 40, project, projectFeature, target = 4, L = 1, cornerTol }) {
    this.target = target; this.L = L; this.cornerTol = cornerTol ?? 0.25 * L;
    this.P = Array.from(pos);
    this.T = Array.from(tris);
    this.alive = new Uint8Array(this.T.length / 3).fill(1);
    this.aliveArr = Array.from(this.alive);
    this.vt = Array.from({ length: this.P.length / 3 }, () => []);
    for (let t = 0; t < this.T.length / 3; t++) for (let k = 0; k < 3; k++) this.vt[this.T[3 * t + k]].push(t);
    this.project = project; this.projectFeature = projectFeature;
    // 特征边
    this.feat = new Set();
    const cosF = Math.cos((featureAngle * Math.PI) / 180);
    const edgeTris = new Map();
    for (let t = 0; t < this.T.length / 3; t++) for (const [a, b] of this.edgesOf(t)) { const k = ek(a, b); if (!edgeTris.has(k)) edgeTris.set(k, []); edgeTris.get(k).push(t); }
    for (const [k, ts] of edgeTris) if (ts.length !== 2 || dot3(this.normal(ts[0]), this.normal(ts[1])) < cosF) this.feat.add(k);
  }
  isAlive(t) { return this.aliveArr[t] === 1; }
  nv() { return this.P.length / 3; }
  v(i) { return [this.P[3 * i], this.P[3 * i + 1], this.P[3 * i + 2]]; }
  setV(i, p) { this.P[3 * i] = p[0]; this.P[3 * i + 1] = p[1]; this.P[3 * i + 2] = p[2]; }
  tri(t) { return [this.T[3 * t], this.T[3 * t + 1], this.T[3 * t + 2]]; }
  edgesOf(t) { const a = this.T[3 * t], b = this.T[3 * t + 1], c = this.T[3 * t + 2]; return [[a, b], [b, c], [c, a]]; }
  tris(v) { const out = []; for (const t of this.vt[v]) if (this.aliveArr[t] === 1 && !out.includes(t)) out.push(t); this.vt[v] = out; return out; }
  normal(t) {
    const P = this.P, a = 3 * this.T[3 * t], b = 3 * this.T[3 * t + 1], c = 3 * this.T[3 * t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const l = Math.hypot(n[0], n[1], n[2]) || 1e-30;
    return [n[0] / l, n[1] / l, n[2] / l];
  }
  ar(t) { const P = this.P, a = 3 * this.T[3 * t], b = 3 * this.T[3 * t + 1], c = 3 * this.T[3 * t + 2]; return triAspect(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]); }
  len(a, b) { const P = this.P; return Math.hypot(P[3 * a] - P[3 * b], P[3 * a + 1] - P[3 * b + 1], P[3 * a + 2] - P[3 * b + 2]); }
  edgeTris(a, b) { const out = []; for (const t of this.tris(a)) { const tr = this.tri(t); if (tr[0] === b || tr[1] === b || tr[2] === b) out.push(t); } return out; }
  nbrs(v) { const s = new Set(); for (const t of this.tris(v)) for (const u of this.tri(t)) if (u !== v) s.add(u); return s; }
  featCount(v) { let c = 0; for (const u of this.nbrs(v)) if (this.feat.has(ek(v, u))) c++; return c; }
  addTri(a, b, c) { const t = this.T.length / 3; this.T.push(a, b, c); this.aliveArr.push(1); this.vt[a].push(t); this.vt[b].push(t); this.vt[c].push(t); return t; }
  kill(t) { this.aliveArr[t] = 0; }
  addV(p) { this.P.push(p[0], p[1], p[2]); this.vt.push([]); return this.nv() - 1; }
  edges() {
    const seen = new Set(), out = [];
    for (let t = 0; t < this.aliveArr.length; t++) if (this.aliveArr[t] === 1) for (const [a, b] of this.edgesOf(t)) { const k = ek(a, b); if (!seen.has(k)) { seen.add(k); out.push([a, b]); } }
    return out;
  }

  split(a, b, f = 0.5) {
    const ts = this.edgeTris(a, b);
    if (!ts.length) return false;
    const pa = this.v(a), pb = this.v(b);
    const m = this.addV([pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f, pa[2] + (pb[2] - pa[2]) * f]);
    const isF = this.feat.has(ek(a, b));
    for (const t of ts) {
      const tr = this.tri(t);
      this.kill(t);
      const r1 = tr.map(x => (x === b ? m : x)), r2 = tr.map(x => (x === a ? m : x));
      this.addTri(...r1); this.addTri(...r2);
    }
    if (isF) { this.feat.delete(ek(a, b)); this.feat.add(ek(a, m)); this.feat.add(ek(m, b)); }
    return true;
  }

  // a 并入 b
  collapse(a, b, hi, force = false) {
    const isF = this.feat.has(ek(a, b));
    const fa = this.featCount(a);
    // force：极短边允许合并特征点（几何改变小于边长 1/4）
    if (fa > 0 && !(isF && fa === 2) && !(force && this.len(a, b) < this.cornerTol)) return false;
    const ts = this.edgeTris(a, b);
    if (ts.length !== 2 && !(isF && ts.length === 1)) return false;
    const na = this.nbrs(a), nb = this.nbrs(b);
    let common = 0; for (const u of na) if (nb.has(u)) common++;
    if (common !== ts.length) return false;
    const pb = this.v(b);
    for (const u of na) if (u !== b && Math.hypot(pb[0] - this.P[3 * u], pb[1] - this.P[3 * u + 1], pb[2] - this.P[3 * u + 2]) > hi) return false;
    const around = this.tris(a).filter(t => !ts.includes(t));
    const old = this.v(a), nOld = around.map(t => this.normal(t));
    const worstBefore = Math.max(...ts.map(t => this.ar(t)), ...around.map(t => this.ar(t)));
    this.setV(a, pb);
    let ok = true;
    for (let i = 0; i < around.length; i++) { if (dot3(this.normal(around[i]), nOld[i]) < 0.3 || this.ar(around[i]) > Math.max(worstBefore, this.target)) { ok = false; break; } }
    this.setV(a, old);
    if (!ok) return false;
    for (const t of ts) this.kill(t);
    for (const t of around) { const tr = this.tri(t).map(x => (x === a ? b : x)); this.kill(t); this.addTri(...tr); }
    // 特征边重映射
    for (const u of na) { const k = ek(a, u); if (this.feat.has(k)) { this.feat.delete(k); if (u !== b) this.feat.add(ek(b, u)); } }
    return true;
  }

  flip(a, b, mode = 'valence') {
    if (this.feat.has(ek(a, b))) return false;
    const ts = this.edgeTris(a, b);
    if (ts.length !== 2) return false;
    const [t1, t2] = ts;
    const n1 = this.normal(t1), n2 = this.normal(t2);
    if (dot3(n1, n2) < 0.94) return false;
    const tr1 = this.tri(t1), tr2 = this.tri(t2);
    const c = tr1.find(x => x !== a && x !== b), d = tr2.find(x => x !== a && x !== b);
    if (c === d || this.nbrs(c).has(d)) return false;
    const i = tr1.indexOf(a);
    const [p, q] = tr1[(i + 1) % 3] === b ? [a, b] : [b, a];
    if (mode === 'valence') {
      const opt = (v) => (this.featCount(v) ? 4 : 6);
      const val = (v) => this.tris(v).length;
      const dev = (va, vb, vc, vd) => Math.abs(va - opt(a)) + Math.abs(vb - opt(b)) + Math.abs(vc - opt(c)) + Math.abs(vd - opt(d));
      const before = dev(val(a), val(b), val(c), val(d)), after = dev(val(a) - 1, val(b) - 1, val(c) + 1, val(d) + 1);
      if (after >= before) return false;
      const P = this.P;
      const arOf = (x, y, z) => triAspect(P[3 * x], P[3 * x + 1], P[3 * x + 2], P[3 * y], P[3 * y + 1], P[3 * y + 2], P[3 * z], P[3 * z + 1], P[3 * z + 2]);
      if (Math.max(arOf(p, d, c), arOf(q, c, d)) > Math.max(this.ar(t1), this.ar(t2), this.target)) return false;
    } else {
      const P = this.P;
      const arOf = (x, y, z) => triAspect(P[3 * x], P[3 * x + 1], P[3 * x + 2], P[3 * y], P[3 * y + 1], P[3 * y + 2], P[3 * z], P[3 * z + 1], P[3 * z + 2]);
      if (Math.max(arOf(p, d, c), arOf(q, c, d)) >= Math.max(this.ar(t1), this.ar(t2)) * 0.999) return false;
    }
    this.kill(t1); this.kill(t2);
    const u = this.addTri(p, d, c), w = this.addTri(q, c, d);
    if (dot3(this.normal(u), n1) < 0.5 || dot3(this.normal(w), n1) < 0.5) { this.kill(u); this.kill(w); this.aliveArr[t1] = 1; this.aliveArr[t2] = 1; return false; }
    return true;
  }

  relax(lambda = 0.6) {
    const n = this.nv();
    const next = new Float64Array(this.P);
    for (let v = 0; v < n; v++) {
      const ts = this.tris(v);
      if (!ts.length) continue;
      const fn = [];
      const nb = this.nbrs(v);
      for (const u of nb) if (this.feat.has(ek(v, u))) fn.push(u);
      if (fn.length !== 0 && fn.length !== 2) continue; // 角点固定
      const p = this.v(v);
      let target;
      if (fn.length === 2) {
        const q1 = this.v(fn[0]), q2 = this.v(fn[1]);
        target = [(q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2, (q1[2] + q2[2]) / 2];
      } else {
        const c = [0, 0, 0]; let w = 0;
        for (const t of ts) { const tr = this.tri(t); const A = triArea(this, tr); for (const u of tr) { c[0] += A * this.P[3 * u]; c[1] += A * this.P[3 * u + 1]; c[2] += A * this.P[3 * u + 2]; } w += 3 * A; }
        if (w < 1e-30) continue;
        target = [c[0] / w, c[1] / w, c[2] / w];
        let nrm = [0, 0, 0]; for (const t of ts) { const tn = this.normal(t); nrm[0] += tn[0]; nrm[1] += tn[1]; nrm[2] += tn[2]; }
        const nl = Math.hypot(...nrm) || 1; nrm = nrm.map(x => x / nl);
        const d = [target[0] - p[0], target[1] - p[1], target[2] - p[2]], k = dot3(d, nrm);
        target = [p[0] + d[0] - k * nrm[0], p[1] + d[1] - k * nrm[1], p[2] + d[2] - k * nrm[2]];
      }
      let q = [p[0] + lambda * (target[0] - p[0]), p[1] + lambda * (target[1] - p[1]), p[2] + lambda * (target[2] - p[2])];
      q = fn.length === 2 ? this.projectFeature(q) : this.project(q);
      // 防止翻面
      const nOld = ts.map(t => this.normal(t));
      const worstBefore = ts.reduce((m, t) => Math.max(m, this.ar(t)), 0);
      this.setV(v, q);
      const bad = ts.some((t, i) => dot3(this.normal(t), nOld[i]) < 0.5) || ts.reduce((m, t) => Math.max(m, this.ar(t)), 0) > Math.max(worstBefore, this.target);
      this.setV(v, p);
      if (!bad) { next[3 * v] = q[0]; next[3 * v + 1] = q[1]; next[3 * v + 2] = q[2]; }
    }
    this.P = Array.from(next);
  }

  // 局部顶点寻优：在切平面（或沿特征线）上做模式搜索，最小化相邻单元的最大纵横比
  optimizeVertex(v) {
    const ts = this.tris(v);
    if (!ts.length) return false;
    const nb = this.nbrs(v);
    const fn = []; for (const u of nb) if (this.feat.has(ek(v, u))) fn.push(u);
    if (fn.length !== 0 && fn.length !== 2) return false;
    const p0 = this.v(v);
    const worst = () => ts.reduce((m, t) => Math.max(m, this.ar(t)), 0);
    const nOld = ts.map(t => this.normal(t));
    let best = worst(), bestP = p0;
    let dirs;
    if (fn.length === 2) {
      const q1 = this.v(fn[0]), q2 = this.v(fn[1]);
      const d1 = [q1[0] - p0[0], q1[1] - p0[1], q1[2] - p0[2]], d2 = [q2[0] - p0[0], q2[1] - p0[1], q2[2] - p0[2]];
      dirs = [d1, d2].map(d => { const l = Math.hypot(...d) || 1; return d.map(x => x / l); });
    } else {
      let n = [0, 0, 0]; for (const t of ts) { const tn = this.normal(t); n = [n[0] + tn[0], n[1] + tn[1], n[2] + tn[2]]; }
      const nl = Math.hypot(...n) || 1; n = n.map(x => x / nl);
      let t1 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const k = dot3(t1, n); t1 = [t1[0] - k * n[0], t1[1] - k * n[1], t1[2] - k * n[2]];
      const l1 = Math.hypot(...t1); t1 = t1.map(x => x / l1);
      const t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]];
      dirs = [];
      for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; dirs.push([t1[0] * Math.cos(a) + t2[0] * Math.sin(a), t1[1] * Math.cos(a) + t2[1] * Math.sin(a), t1[2] * Math.cos(a) + t2[2] * Math.sin(a)]); }
    }
    let step = 0.4 * Math.min(...[...nb].map(u => this.len(v, u)));
    for (let it = 0; it < 6; it++, step *= 0.5) {
      let improved = false;
      for (const d of dirs) {
        let q = [bestP[0] + d[0] * step, bestP[1] + d[1] * step, bestP[2] + d[2] * step];
        q = fn.length === 2 ? this.projectFeature(q) : this.project(q);
        this.setV(v, q);
        const w = worst();
        const flip = ts.some((t, i) => dot3(this.normal(t), nOld[i]) < 0.5);
        if (!flip && w < best - 1e-9) { best = w; bestP = q; improved = true; }
      }
      this.setV(v, bestP);
      if (!improved && it > 2) break;
    }
    this.setV(v, bestP);
    return bestP !== p0;
  }

  compact() {
    const tris = [];
    for (let t = 0; t < this.aliveArr.length; t++) if (this.aliveArr[t] === 1) tris.push(...this.tri(t));
    const used = new Int32Array(this.nv()).fill(-1);
    const pos = [];
    for (const v of tris) if (used[v] < 0) { used[v] = pos.length / 3; pos.push(this.P[3 * v], this.P[3 * v + 1], this.P[3 * v + 2]); }
    return { pos: Float64Array.from(pos), tris: Int32Array.from(tris.map(v => used[v])) };
  }
}
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function triArea(M, tr) {
  const [a, b, c] = tr.map(i => M.v(i));
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
}

// 特征线投影：原始特征边线段 + 网格哈希
function featureProjector(pos, tris, featureAngle, cell) {
  const M = new Remesher(pos, tris, { featureAngle, project: p => p, projectFeature: p => p });
  const segs = [];
  for (const k of M.feat) { const a = Math.floor(k / KEY), b = k % KEY; segs.push([M.v(a), M.v(b)]); }
  const grid = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  segs.forEach((s, i) => {
    const n = Math.max(1, Math.ceil(Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1], s[1][2] - s[0][2]) / cell));
    const ks = new Set();
    for (let j = 0; j <= n; j++) { const f = j / n; ks.add(key(s[0][0] + (s[1][0] - s[0][0]) * f, s[0][1] + (s[1][1] - s[0][1]) * f, s[0][2] + (s[1][2] - s[0][2]) * f)); }
    for (const k of ks) { if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
  });
  return (p) => {
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
    let best = null, bd = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const i of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) || []) {
        const [a, b] = segs[i];
        const v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const l2 = v[0] ** 2 + v[1] ** 2 + v[2] ** 2 || 1e-30;
        let f = ((p[0] - a[0]) * v[0] + (p[1] - a[1]) * v[1] + (p[2] - a[2]) * v[2]) / l2;
        f = Math.max(0, Math.min(1, f));
        const q = [a[0] + v[0] * f, a[1] + v[1] * f, a[2] + v[2] * f];
        const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
        if (d < bd) { bd = d; best = q; }
      }
    }
    return best || p;
  };
}

/**
 * 优化主函数
 * opts: { target=4, edgeLength, featureAngle=40, iterations=6, project(p)->p 投影回原曲面, onProgress(stage, frac) }
 */
export function optimizeAspect(pos0, tris0, opts = {}) {
  const target = opts.target ?? 4;
  const featureAngle = opts.featureAngle ?? 40;
  const L = opts.edgeLength;
  const project = opts.project || (p => p);
  const projectFeature = featureProjector(pos0, tris0, featureAngle, L);
  const M = new Remesher(pos0, tris0, { featureAngle, project, projectFeature, target, L, cornerTol: opts.cornerTol });
  const hi = (4 / 3) * L, lo = (4 / 5) * L;
  const log = [];
  const iters = opts.iterations ?? 6;
  for (let it = 0; it < iters; it++) {
    opts.onProgress?.('重网格', it / iters);
    // 分裂
    for (const [a, b] of M.edges()) if (M.len(a, b) > hi) M.split(a, b);
    // 塌陷
    for (const [a, b] of M.edges()) {
      if (M.len(a, b) >= lo) continue;
      if (!M.tris(a).length || !M.tris(b).length) continue;
      if (!M.collapse(a, b, hi)) M.collapse(b, a, hi);
    }
    // 翻边
    for (const [a, b] of M.edges()) M.flip(a, b, 'valence');
    // 松弛
    M.relax();
    log.push({ stage: '重网格', iter: it, tris: M.aliveArr.reduce((s, x) => s + x, 0) });
  }
  // 收尾：针对仍超标的单元
  const passes = 40;
  let bestBad = Infinity, stall = 0;
  for (let pass = 0; pass < passes; pass++) {
    opts.onProgress?.('局部修复', pass / passes);
    const force = pass >= 4;
    const bad = [];
    for (let t = 0; t < M.aliveArr.length; t++) if (M.aliveArr[t] === 1 && M.ar(t) > target) bad.push(t);
    log.push({ stage: '局部修复', iter: pass, bad: bad.length });
    if (!bad.length) break;
    if (bad.length < bestBad) { bestBad = bad.length; stall = 0; } else if (++stall >= 6) break;
    // 先对坏单元的顶点做局部寻优
    for (const t of bad) if (M.aliveArr[t] === 1 && M.ar(t) > target) for (const v of M.tri(t)) M.optimizeVertex(v);
    for (const t of bad) {
      if (M.aliveArr[t] !== 1 || M.ar(t) <= target) continue;
      const es = M.edgesOf(t).map(([a, b]) => ({ a, b, l: M.len(a, b) })).sort((x, y) => y.l - x.l);
      if (M.flip(es[0].a, es[0].b, 'aspect')) continue;
      const s = es[2];
      if (s.l < es[1].l * 0.5 && (M.collapse(s.a, s.b, hi * 1.5, force) || M.collapse(s.b, s.a, hi * 1.5, force))) continue;
      M.split(es[0].a, es[0].b);
    }
    for (const [a, b] of M.edges()) M.flip(a, b, 'aspect');
    M.relax(0.4);
  }
  // 收尾投影：偏离原曲面的顶点吸附回曲面（不翻面、不恶化纵横比）
  for (let v = 0; v < M.nv(); v++) {
    const ts = M.tris(v);
    if (!ts.length) continue;
    const p = M.v(v), q = M.featCount(v) === 2 ? projectFeature(p) : M.featCount(v) ? p : project(p);
    if (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-4 * L) continue;
    const nOld = ts.map(t => M.normal(t)), wBefore = ts.reduce((m, t) => Math.max(m, M.ar(t)), 0);
    M.setV(v, q);
    if (ts.some((t, i) => dot3(M.normal(t), nOld[i]) < 0.5) || ts.reduce((m, t) => Math.max(m, M.ar(t)), 0) > Math.max(wBefore, target)) M.setV(v, p);
  }
  for (let t = 0; t < M.aliveArr.length; t++) if (M.aliveArr[t] === 1 && M.ar(t) > target) for (const v of M.tri(t)) M.optimizeVertex(v);
  return { ...M.compact(), log };
}

// ---------------- 导入 / 导出 ----------------
// Nastran (.nas/.bdf)：GRID / CTRIA3，支持小字段与自由格式（逗号）
export function parseNastran(text) {
  const nodes = new Map(), tris = [];
  const field = (line, i) => line.slice(8 * i, 8 * i + 8).trim();
  const num = (s) => parseFloat(s.replace(/([0-9])([+-][0-9])/, '$1e$2'));
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw[0] === '$') continue;
    const free = raw.includes(',');
    const f = free ? raw.split(',').map(s => s.trim()) : [0, 1, 2, 3, 4, 5, 6].map(i => field(raw, i));
    const key = f[0].toUpperCase().replace('*', '');
    if (key === 'GRID') nodes.set(+f[1], [num(f[3]), num(f[4]), num(f[5])]);
    else if (key === 'CTRIA3') tris.push(+f[3], +f[4], +f[5]);
  }
  return toArrays(nodes, tris);
}
// Patran 中性文件 (.pat)：packet 1 节点，packet 2 单元（三角形 shape=3）
export function parsePatran(text) {
  const lines = text.split(/\r?\n/);
  const nodes = new Map(), tris = [];
  for (let i = 0; i < lines.length; i++) {
    const id = parseInt(lines[i].slice(0, 2), 10);
    if (id === 1) {
      const nid = parseInt(lines[i].slice(2, 10), 10);
      const c = lines[i + 1];
      nodes.set(nid, [parseFloat(c.slice(0, 16)), parseFloat(c.slice(16, 32)), parseFloat(c.slice(32, 48))]);
      i += 2;
    } else if (id === 2) {
      const shape = parseInt(lines[i].slice(18, 26), 10);
      const conn = lines[i + 2].trim().split(/\s+/).map(Number);
      if (shape === 3) tris.push(conn[0], conn[1], conn[2]);
      i += 2;
    }
  }
  return toArrays(nodes, tris);
}
function toArrays(nodes, tris) {
  const ids = [...nodes.keys()];
  const idx = new Map(ids.map((id, i) => [id, i]));
  const pos = new Float64Array(ids.length * 3);
  ids.forEach((id, i) => pos.set(nodes.get(id), 3 * i));
  return { pos, tris: Int32Array.from(tris.map(id => idx.get(id))) };
}
export function toNastran(pos, tris) {
  const L = ['$ 3D→2D 网格优化导出', 'BEGIN BULK'];
  const f8 = (v) => { let s = v.toPrecision(8); if (s.length > 16) s = v.toExponential(6); return s; };
  for (let i = 0; i < pos.length / 3; i++) L.push(`GRID,${i + 1},,${f8(pos[3 * i])},${f8(pos[3 * i + 1])},${f8(pos[3 * i + 2])}`);
  for (let t = 0; t < tris.length / 3; t++) L.push(`CTRIA3,${t + 1},1,${tris[3 * t] + 1},${tris[3 * t + 1] + 1},${tris[3 * t + 2] + 1}`);
  L.push('ENDDATA');
  return L.join('\n');
}
export function toSTL(pos, tris, name = 'mesh') {
  const n = tris.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  for (let i = 0; i < Math.min(80, name.length); i++) dv.setUint8(i, name.charCodeAt(i) & 0x7f);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const a = tris[3 * t] * 3, b = tris[3 * t + 1] * 3, c = tris[3 * t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (const v of [nx, ny, nz]) { dv.setFloat32(o, v, true); o += 4; }
    for (const k of [a, b, c]) for (let j = 0; j < 3; j++) { dv.setFloat32(o, pos[k + j], true); o += 4; }
    o += 2;
  }
  return buf;
}
