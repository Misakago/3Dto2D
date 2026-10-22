// 特征识别：对每个 B-rep 面的网格做几何拟合（与单位/装配变换无关）
//  - 法向全部垂直于某一方向 → 圆柱面，最小二乘拟合轴线与半径
//  - 法向朝内 → 孔；朝外 → 凸台/轴；覆盖角 < 290° → 圆角/圆弧面
// 输入 parts: [{ positions, normals, index, brepFaces:[{first,last}] }]，坐标为 mm

const BINS = 36;

function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function normalize(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

// 3x3 对称矩阵 Jacobi 特征分解，返回按特征值升序的 [{value, vector}]
function eigSym3(m) {
  const a = [[m[0], m[1], m[2]], [m[1], m[4], m[5]], [m[2], m[5], m[8]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-12) break;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return [0, 1, 2].map(i => ({ value: a[i][i], vector: [v[0][i], v[1][i], v[2][i]] })).sort((x, y) => x.value - y.value);
}

function solve3(A, b) {
  // 克莱姆法则
  const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const D = det(A);
  if (Math.abs(D) < 1e-18) return null;
  const r = [];
  for (let c = 0; c < 3; c++) {
    const M = A.slice();
    M[c] = b[0]; M[3 + c] = b[1]; M[6 + c] = b[2];
    r.push(det(M) / D);
  }
  return r;
}

function fitFace(pos, nrm, verts) {
  const n = verts.length;
  if (n < 6) return null;
  // 法向协方差
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const i of verts) {
    const x = nrm[3 * i], y = nrm[3 * i + 1], z = nrm[3 * i + 2];
    M[0] += x * x; M[1] += x * y; M[2] += x * z; M[4] += y * y; M[5] += y * z; M[8] += z * z;
  }
  const e = eigSym3(M);
  const [l0, l1, l2] = e.map(x => x.value / n);
  if (l2 > 0.995) return { type: 'plane', normal: e[2].vector };
  if (l0 > 2e-3 || l1 < 2e-3) return { type: 'freeform' };
  const a = normalize(e[0].vector);
  let u = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  u = normalize(cross(a, u));
  const w = cross(a, u);
  // Kåsa 代数圆拟合（顶点精确位于曲面上，比法向拟合更准）
  const pts = [];
  let mx = 0, my = 0;
  for (const i of verts) {
    const px = pos[3 * i], py = pos[3 * i + 1], pz = pos[3 * i + 2];
    const nx = nrm[3 * i], ny = nrm[3 * i + 1], nz = nrm[3 * i + 2];
    const X = px * u[0] + py * u[1] + pz * u[2], Y = px * w[0] + py * w[1] + pz * w[2];
    const Nx = nx * u[0] + ny * u[1] + nz * u[2], Ny = nx * w[0] + ny * w[1] + nz * w[2];
    const T = px * a[0] + py * a[1] + pz * a[2];
    pts.push([X, Y, Nx, Ny, T]);
    mx += X; my += Y;
  }
  mx /= n; my /= n;
  const A = [0, 0, 0, 0, 0, 0, 0, 0, n], b = [0, 0, 0];
  for (const q of pts) {
    const x = q[0] - mx, y = q[1] - my, z = x * x + y * y;
    A[0] += x * x; A[1] += x * y; A[2] += x; A[4] += y * y; A[5] += y;
    b[0] -= x * z; b[1] -= y * z; b[2] -= z;
  }
  A[3] = A[1]; A[6] = A[2]; A[7] = A[5];
  const sol = solve3(A, b);
  if (!sol) return { type: 'freeform' };
  const cx = mx - sol[0] / 2, cy = my - sol[1] / 2;
  const r2 = (sol[0] * sol[0] + sol[1] * sol[1]) / 4 - sol[2];
  if (!(r2 > 0)) return { type: 'freeform' };
  const rFit = Math.sqrt(r2);
  let err = 0, tMin = Infinity, tMax = -Infinity, side = 0;
  const bins = new Uint8Array(BINS);
  for (const [X, Y, Nx, Ny, T] of pts) {
    const dx = X - cx, dy = Y - cy;
    err += (Math.hypot(dx, dy) - rFit) ** 2;
    side += dx * Nx + dy * Ny;
    if (T < tMin) tMin = T;
    if (T > tMax) tMax = T;
    const ang = Math.atan2(dy, dx);
    bins[Math.min(BINS - 1, Math.floor(((ang + Math.PI) / (2 * Math.PI)) * BINS))] = 1;
  }
  const rs = side < 0 ? -rFit : rFit;
  const r = Math.abs(rs);
  if (Math.sqrt(err / n) > Math.max(r * 0.005, 0.005)) return { type: 'freeform' };
  const p = [cx * u[0] + cy * w[0], cx * u[1] + cy * w[1], cx * u[2] + cy * w[2]];
  return { type: 'cylinder', a, u, w, p, r, concave: rs < 0, tMin, tMax, bins };
}

function canonicalAxis(a) {
  const i = Math.abs(a[0]) > 1e-4 ? 0 : Math.abs(a[1]) > 1e-4 ? 1 : 2;
  return a[i] < 0 ? [-a[0], -a[1], -a[2]] : a;
}

export function analyzeFeatures(parts, bboxDiag) {
  const groups = new Map();
  const faceTypes = { plane: 0, cylinder: 0, freeform: 0 };
  const posTol = Math.max(bboxDiag * 2e-4, 2e-3);
  parts.forEach((part, partIndex) => {
    const { positions, normals, index, brepFaces } = part;
    brepFaces.forEach((bf, faceIndex) => {
      const set = new Set();
      for (let t = bf.first; t <= bf.last; t++) {
        set.add(index[3 * t]); set.add(index[3 * t + 1]); set.add(index[3 * t + 2]);
      }
      const verts = [...set];
      const fit = fitFace(positions, normals, verts);
      if (!fit) return;
      faceTypes[fit.type]++;
      if (fit.type !== 'cylinder') return;
      const a = canonicalAxis(fit.a);
      const sgn = a[0] === fit.a[0] && a[1] === fit.a[1] && a[2] === fit.a[2] ? 1 : -1;
      const tp = fit.p[0] * a[0] + fit.p[1] * a[1] + fit.p[2] * a[2];
      const p0 = [fit.p[0] - a[0] * tp, fit.p[1] - a[1] * tp, fit.p[2] - a[2] * tp];
      const q = (v, s) => Math.round(v / s);
      const key = [fit.concave ? 'c' : 'v', q(fit.r, Math.max(fit.r * 2e-3, 1e-3)), q(a[0], 2e-3), q(a[1], 2e-3), q(a[2], 2e-3),
        q(p0[0], posTol), q(p0[1], posTol), q(p0[2], posTol)].join('|');
      let g = groups.get(key);
      if (!g) {
        g = { r: fit.r, a, p: p0, concave: fit.concave, tMin: Infinity, tMax: -Infinity, bins: new Uint8Array(BINS), faces: [] };
        groups.set(key, g);
      }
      const t0 = sgn * fit.tMin, t1 = sgn * fit.tMax;
      g.tMin = Math.min(g.tMin, t0, t1);
      g.tMax = Math.max(g.tMax, t0, t1);
      // 角度分箱基于各面自己的 u/w，合并时只累加覆盖量
      g.coverage = (g.coverage || 0) + fit.bins.reduce((s, b) => s + b, 0) / BINS;
      g.faces.push({ partIndex, faceIndex });
    });
  });

  const features = [];
  for (const g of groups.values()) {
    const coverage = Math.min(1, g.coverage);
    const full = coverage > 0.8;
    const kind = !full ? 'fillet' : g.concave ? 'hole' : 'boss';
    const tMid = (g.tMin + g.tMax) / 2;
    features.push({
      kind, r: g.r, d: g.r * 2, a: g.a, p: g.p,
      tMin: g.tMin, tMax: g.tMax, length: g.tMax - g.tMin,
      center: [g.p[0] + g.a[0] * tMid, g.p[1] + g.a[1] * tMid, g.p[2] + g.a[2] * tMid],
      coverage, faces: g.faces,
    });
  }
  return { features, faceTypes };
}

// 汇总为孔表 / 圆角表（相近尺寸合并，容差 0.3%）
function cluster(list, val, tol = 3e-3) {
  const sorted = [...list].sort((x, y) => val(x) - val(y));
  const out = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(val(f) - last.ref) <= Math.max(last.ref * tol, 0.01)) last.items.push(f);
    else out.push({ ref: val(f), items: [f] });
  }
  return out;
}

export function summarizeFeatures(features) {
  const fmt = (v) => +v.toFixed(2);
  const holes = [];
  for (const kind of ['hole', 'boss']) {
    for (const c of cluster(features.filter(f => f.kind === kind), f => f.d)) {
      const d = c.items.reduce((s, f) => s + f.d, 0) / c.items.length;
      holes.push({ kind, d: fmt(d), count: c.items.length, depth: Math.max(...c.items.map(f => f.length)), items: c.items });
    }
  }
  holes.sort((x, y) => (x.kind === y.kind ? y.d - x.d : x.kind === 'hole' ? -1 : 1));
  const fillets = cluster(features.filter(f => f.kind === 'fillet'), f => f.r)
    .map(c => ({ r: fmt(c.items.reduce((s, f) => s + f.r, 0) / c.items.length), count: c.items.length, items: c.items }));
  return { holes, fillets };
}
