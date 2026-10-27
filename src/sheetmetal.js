// 钣金分析：料厚、折弯轴、截面轮廓、折弯角/半径、展开长度（K 因子）与展开图
// 适用于单向折弯（折弯线互相平行）的冲压件；不满足时返回 { ok:false, reason }

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function faceStats(part) {
  const { positions: P, index: I, brepFaces } = part;
  return brepFaces.map((bf, fi) => {
    let area = 0;
    const n = [0, 0, 0], c = [0, 0, 0];
    for (let t = bf.first; t <= bf.last; t++) {
      const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, d = I[3 * t + 2] * 3;
      const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
      const v = [P[d] - P[a], P[d + 1] - P[a + 1], P[d + 2] - P[a + 2]];
      const cr = cross(u, v);
      const ar = Math.hypot(cr[0], cr[1], cr[2]) / 2;
      area += ar;
      for (let k = 0; k < 3; k++) { n[k] += cr[k] / 2; c[k] += ar * (P[a + k] + P[b + k] + P[d + k]) / 3; }
    }
    const nl = Math.hypot(n[0], n[1], n[2]);
    return { fi, area, planar: area > 0 && nl / area > 0.999, n: n.map(x => x / (nl || 1)), c: c.map(x => x / (area || 1)) };
  });
}

// 用垂直于 a 的平面切网格，返回截面上的线段（2D 坐标 e1/e2）
function sliceSegments(parts, a, e1, e2, u) {
  const segs = [];
  for (const part of parts) {
    const P = part.positions, I = part.index;
    for (let t = 0; t < I.length; t += 3) {
      const pts = [];
      const vs = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
      const ds = vs.map(o => P[o] * a[0] + P[o + 1] * a[1] + P[o + 2] * a[2] - u);
      for (let k = 0; k < 3; k++) {
        const k2 = (k + 1) % 3;
        if ((ds[k] > 0) !== (ds[k2] > 0)) {
          const f = ds[k] / (ds[k] - ds[k2]);
          const o1 = vs[k], o2 = vs[k2];
          const p = [P[o1] + (P[o2] - P[o1]) * f, P[o1 + 1] + (P[o2 + 1] - P[o1 + 1]) * f, P[o1 + 2] + (P[o2 + 2] - P[o1 + 2]) * f];
          pts.push([dot(p, e1), dot(p, e2)]);
        }
      }
      if (pts.length === 2) segs.push(pts);
    }
  }
  return segs;
}

// 线段 → 闭合折线（按端点哈希连接）
function chain(segs, eps) {
  const key = (p) => Math.round(p[0] / eps) + ',' + Math.round(p[1] / eps);
  const adj = new Map();
  segs.forEach((s, i) => {
    for (const j of [0, 1]) {
      const k = key(s[j]);
      if (!adj.has(k)) adj.set(k, []);
      adj.get(k).push([i, j]);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const pts = [segs[i][0], segs[i][1]];
    let cur = segs[i][1];
    for (let guard = 0; guard < segs.length; guard++) {
      const cand = (adj.get(key(cur)) || []).find(([si]) => !used[si]);
      if (!cand) break;
      used[cand[0]] = 1;
      cur = segs[cand[0]][1 - cand[1]];
      pts.push(cur);
    }
    loops.push(pts);
  }
  return loops;
}

const plen = (pts) => { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return l; };

// 合并共线点
function simplify(loop, angTol = 0.5 * Math.PI / 180) {
  const out = [loop[0]];
  for (let i = 1; i < loop.length - 1; i++) {
    const a = out[out.length - 1], b = loop[i], c = loop[i + 1];
    const h1 = Math.atan2(b[1] - a[1], b[0] - a[0]), h2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let d = h2 - h1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    if (Math.abs(d) > angTol && Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) out.push(b);
  }
  out.push(loop[loop.length - 1]);
  return out;
}

function resample(pts, n) {
  const L = plen(pts);
  const out = [];
  let seg = 0, acc = 0;
  for (let i = 0; i < n; i++) {
    const target = (L * i) / (n - 1);
    while (seg < pts.length - 2 && acc + Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]) < target) {
      acc += Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]);
      seg++;
    }
    const a = pts[seg], b = pts[seg + 1];
    const sl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const f = Math.min(1, Math.max(0, (target - acc) / sl));
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return out;
}

// 沿侧边折线识别折弯：同号、相邻的转角归为一个折弯；遇到反向或长直段即分段
function detectBends(side, t) {
  const sAt = [0];
  for (let i = 1; i < side.length; i++) sAt.push(sAt[i - 1] + Math.hypot(side[i][0] - side[i - 1][0], side[i][1] - side[i - 1][1]));
  const bends = [];
  let cur = null;
  const close = () => { if (cur) bends.push(cur); cur = null; };
  for (let i = 1; i < side.length - 1; i++) {
    const a = side[i - 1], b = side[i], c = side[i + 1];
    const h1 = Math.atan2(b[1] - a[1], b[0] - a[0]), h2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let d = h2 - h1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    const segPrev = sAt[i] - sAt[i - 1];
    if (Math.abs(d) < 0.2 * Math.PI / 180) { if (cur && segPrev > Math.max(1, 2 * t)) close(); continue; }
    if (cur && (Math.sign(d) !== Math.sign(cur.angle) || sAt[i] - cur.s1 > Math.max(1, 2 * t))) close();
    if (!cur) cur = { angle: 0, s0: sAt[i], s1: sAt[i], n: 0, i0: i, i1: i };
    cur.angle += d; cur.s1 = sAt[i]; cur.n++; cur.i1 = i;
  }
  close();
  return bends
    .filter(b => Math.abs(b.angle) > 5 * Math.PI / 180)
    .map(b => {
      // 弧长：首尾转折点之间的长度按段数外推（每个转折点代表一段弦）
      const arc = b.n > 1 ? ((b.s1 - b.s0) * b.n) / (b.n - 1) : 0;
      return { ...b, arc, r: b.n > 1 ? arc / Math.abs(b.angle) : 0 };
    });
}

export function analyzeSheetMetal(parts, metrics, { K = 0.4 } = {}) {
  if (!parts.length || !parts[0].brepFaces.length) return { ok: false, reason: '需要 STEP / IGES / BREP 实体模型' };
  const faces = parts.flatMap((p, pi) => faceStats(p).map(f => ({ ...f, pi })));
  const planar = faces.filter(f => f.planar).sort((a, b) => b.area - a.area);
  if (!planar.length) return { ok: false, reason: '未找到平面' };
  const main = planar[0];
  const n0 = main.n;
  // 料厚：与主平面反向平行、面积相近的平面之间的距离
  let t = Infinity;
  for (const f of planar) {
    if (f === main || dot(f.n, n0) > -0.999 || f.area < main.area * 0.3) continue;
    const d = Math.abs(dot(sub(main.c, f.c), n0));
    if (d > 1e-4 && d < t) t = d;
  }
  const tEst = (2 * metrics.volume) / metrics.area;
  if (!isFinite(t) || Math.abs(tEst - t) / t > 0.35) return { ok: false, reason: '不是等厚钣金件', tEst };
  if (t > 8) return { ok: false, reason: `料厚约 ${t.toFixed(1)} mm，超出冲压件常用范围（≤ 8 mm）`, t };

  // 折弯轴：取包围盒中与 n0 垂直、且轮廓变化最小的方向——用候选方向切片比较
  const boxSize = metrics.size.toArray();
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].filter(a => Math.abs(dot(a, n0)) < 0.2);
  let best = null;
  for (const aRaw of axes) {
    const a = norm(sub(aRaw, n0.map(x => x * dot(aRaw, n0))));
    const e1 = norm(n0.map((x, k) => x - a[k] * dot(n0, a)));
    const e2 = cross(a, e1);
    const lo = metrics.box.min.toArray(), hi = metrics.box.max.toArray();
    const uMin = Math.min(dot(lo, a), dot(hi, a)), uMax = Math.max(dot(lo, a), dot(hi, a));
    for (let k = 1; k < 16; k++) {
      const u = uMin + ((uMax - uMin) * k) / 16;
      const loops = chain(sliceSegments(parts, a, e1, e2, u), t * 1e-3).filter(l => l.length > 3);
      if (!loops.length) continue;
      const loop = loops.sort((x, y) => plen(y) - plen(x))[0];
      const L = plen(loop);
      if (!best || L > best.L + 1e-6) best = { a, e1, e2, u, loop, L, uMin, uMax };
    }
  }
  if (!best) return { ok: false, reason: '截面失败' };
  const { a: aSec, e1, e2 } = best;
  void boxSize;

  // ---- 折弯件：截面展开 ----
  const bentModel = () => {
    const a = aSec;
  // 截面闭环 → 找两个端面（长度≈t 的直段）→ 分成两条侧边
  const loop = simplify(best.loop);
  const segLen = (i) => Math.hypot(loop[i + 1][0] - loop[i][0], loop[i + 1][1] - loop[i][1]);
  const caps = [];
  for (let i = 0; i < loop.length - 1; i++) if (Math.abs(segLen(i) - t) < 0.12 * t) caps.push(i);
  if (caps.length < 2) return null;
  // 选相距最远的两个端面
  let c1 = caps[0], c2 = caps[1], far = -1;
  for (const i of caps) for (const j of caps) {
    if (j <= i) continue;
    const d = Math.hypot(loop[i][0] - loop[j][0], loop[i][1] - loop[j][1]);
    if (d > far) { far = d; c1 = i; c2 = j; }
  }
  const sideA = loop.slice(c1 + 1, c2 + 1);
  const sideB = [...loop.slice(c2 + 1, loop.length - 1), ...loop.slice(0, c1 + 1)].reverse();
  const lenA = plen(sideA), lenB = plen(sideB);
  const N = 600;
  const rA = resample(sideA, N), rB = resample(sideB, N);
  const mid = rA.map((p, i) => [(p[0] + rB[i][0]) / 2, (p[1] + rB[i][1]) / 2]);

  // 折弯：两侧分别检测，按顺序配对；半径小的一侧为内侧
  const pairA = detectBends(sideA, t), pairB = detectBends(sideB, t);
  const bends = [];
  const nB = Math.min(pairA.length, pairB.length);
  for (let i = 0; i < nB; i++) {
    const ba = pairA[i], bb = pairB[i];
    const theta = (Math.abs(ba.angle) + Math.abs(bb.angle)) / 2;
    const rIn = Math.min(ba.r, bb.r);
    // 半径接近 0 的转角是切口直角，不是折弯
    if (rIn < 0.15 * t && Math.max(ba.r, bb.r) < 1.15 * t) continue;
    bends.push({ theta, deg: (theta * 180) / Math.PI, rIn: Math.round(rIn * 20) / 20, sA: (ba.s0 + ba.s1) / 2, dir: Math.sign(ba.angle) });
  }

  const midLen = (lenA + lenB) / 2; // K = 0.5 时的展开长度
  const lengthFor = (k, rOverride = null) => {
    let L = midLen - bends.reduce((s, b) => s + b.theta * (0.5 - k) * t, 0);
    if (rOverride != null) {
      // 保持外形（虚拟尖点）不变时，内 R 变化引起的展开长度变化
      for (const b of bends) {
        const dr = rOverride - b.rIn;
        L += b.theta * dr - 2 * dr * Math.tan(b.theta / 2);
      }
    }
    return L;
  };
  const L = lengthFor(K);

  // 展开映射：3D 点 → (u, s)
  const midS = [0];
  for (let i = 1; i < mid.length; i++) midS.push(midS[i - 1] + Math.hypot(mid[i][0] - mid[i - 1][0], mid[i][1] - mid[i - 1][1]));
  const scale = L / midS[midS.length - 1];
  const mapPoint = (p) => {
    const x = p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2], y = p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2];
    let bestD = Infinity, bestS = 0, bestOff = 0;
    for (let i = 0; i < mid.length - 1; i++) {
      const ax = mid[i][0], ay = mid[i][1], bx = mid[i + 1][0], by = mid[i + 1][1];
      const vx = bx - ax, vy = by - ay;
      const l2 = vx * vx + vy * vy || 1e-12;
      let f = ((x - ax) * vx + (y - ay) * vy) / l2;
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      const dx = ax + vx * f - x, dy = ay + vy * f - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; bestS = midS[i] + f * Math.sqrt(l2); bestOff = (vx * (y - ay) - vy * (x - ax)) / Math.sqrt(l2); }
    }
    return [p[0] * a[0] + p[1] * a[1] + p[2] * a[2], bestS * scale, bestOff];
  };

    return { bends, midLen, lengthFor, L, mapPoint, a, lenA, sideA, sideB, mid, loop };
  };
  let model = bentModel();

  // ---- 平板件（无折弯）：直接投影到板面 ----
  let flatMode = false;
  if (!model || !model.bends.length) {
    let h0 = Infinity, h1 = -Infinity;
    for (const part of parts) for (let i = 0; i < part.positions.length; i += 3) {
      const d = part.positions[i] * n0[0] + part.positions[i + 1] * n0[1] + part.positions[i + 2] * n0[2];
      if (d < h0) h0 = d; if (d > h1) h1 = d;
    }
    const h = h1 - h0;
    const span = Math.max(...metrics.size.toArray());
    if (h <= Math.max(2.2 * tEst, 1.15 * t) && h < 0.2 * span) {
      flatMode = true;
      t = h;
      const cand = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(v => norm(sub(v, n0.map(x => x * dot(v, n0))))).filter(v => Math.hypot(...v) > 0.5);
      const ext = (v) => { let lo = Infinity, hi = -Infinity; for (const part of parts) for (let i = 0; i < part.positions.length; i += 3) { const d = part.positions[i] * v[0] + part.positions[i + 1] * v[1] + part.positions[i + 2] * v[2]; if (d < lo) lo = d; if (d > hi) hi = d; } return hi - lo; };
      const a1 = cand.sort((p, q) => ext(p) - ext(q))[0];
      const a2 = cross(n0, a1);
      const midPlane = (h0 + h1) / 2;
      const len = ext(a2);
      model = {
        bends: [], midLen: len, lengthFor: () => len, L: len, a: a1, lenA: len, sideA: null, sideB: null, mid: null, loop: null,
        mapPoint: (p) => [dot(p, a1), dot(p, a2), dot(p, n0) - midPlane],
      };
    } else if (!model) return { ok: false, reason: '截面中未找到料厚端面，不是单向折弯钣金件', t };
  }
  const { bends, midLen, lengthFor, L, mapPoint, a, lenA, sideA, sideB, mid, loop } = model;

  // 展开图线条：B-rep 面边界（不同面之间的网格边）
  const flatSegs = [];
  for (const part of parts) {
    const P = part.positions, I = part.index;
    const faceOf = new Int32Array(I.length / 3);
    part.brepFaces.forEach((bf, fi) => { for (let tt = bf.first; tt <= bf.last; tt++) faceOf[tt] = fi; });
    const edges = new Map();
    const key = (i, j) => (i < j ? i + '_' + j : j + '_' + i);
    // 先按位置合并顶点（不同 B-rep 面的顶点不共享索引）
    const vkey = (o) => Math.round(P[o] * 1e4) + ',' + Math.round(P[o + 1] * 1e4) + ',' + Math.round(P[o + 2] * 1e4);
    const canon = new Map();
    const vid = (i) => { const k = vkey(i * 3); if (!canon.has(k)) canon.set(k, i); return canon.get(k); };
    for (let tt = 0; tt < I.length / 3; tt++) {
      const v = [vid(I[3 * tt]), vid(I[3 * tt + 1]), vid(I[3 * tt + 2])];
      for (let k = 0; k < 3; k++) {
        const ek = key(v[k], v[(k + 1) % 3]);
        const e = edges.get(ek);
        if (e) e.f2 = faceOf[tt]; else edges.set(ek, { i: v[k], j: v[(k + 1) % 3], f1: faceOf[tt], f2: -1 });
      }
    }
    const cache = new Map();
    const mp = (i) => { if (!cache.has(i)) cache.set(i, mapPoint([P[3 * i], P[3 * i + 1], P[3 * i + 2]])); return cache.get(i); };
    for (const e of edges.values()) {
      if (e.f2 === e.f1) continue;
      const p = mp(e.i), q = mp(e.j);
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-4) continue;
      flatSegs.push(p[0], p[1], q[0], q[1]);
    }
  }
  // 外形轮廓：上表面（偏移 > +t/4）的面与侧壁面之间的边，连接成闭环
  const outlineSegs = [];
  for (const part of parts) {
    const P = part.positions, I = part.index;
    const faceSide = part.brepFaces.map((bf) => {
      let sum = 0, n = 0;
      for (let tt = bf.first; tt <= bf.last; tt += Math.max(1, Math.floor((bf.last - bf.first + 1) / 12))) {
        for (let k = 0; k < 3; k++) { const o = I[3 * tt + k] * 3; sum += mapPoint([P[o], P[o + 1], P[o + 2]])[2]; n++; }
      }
      const off = sum / (n || 1);
      return off > t / 4 ? 1 : off < -t / 4 ? -1 : 0;
    });
    const faceOf = new Int32Array(I.length / 3);
    part.brepFaces.forEach((bf, fi) => { for (let tt = bf.first; tt <= bf.last; tt++) faceOf[tt] = fi; });
    const vkey = (o) => Math.round(P[o] * 1e4) + ',' + Math.round(P[o + 1] * 1e4) + ',' + Math.round(P[o + 2] * 1e4);
    const canon = new Map();
    const vid = (i) => { const k = vkey(i * 3); if (!canon.has(k)) canon.set(k, i); return canon.get(k); };
    const edges = new Map();
    for (let tt = 0; tt < I.length / 3; tt++) {
      const v = [vid(I[3 * tt]), vid(I[3 * tt + 1]), vid(I[3 * tt + 2])];
      for (let k = 0; k < 3; k++) {
        const i = v[k], j = v[(k + 1) % 3];
        const ek = i < j ? i + '_' + j : j + '_' + i;
        const e = edges.get(ek);
        if (e) e.sides.push(faceSide[faceOf[tt]]); else edges.set(ek, { i, j, sides: [faceSide[faceOf[tt]]] });
      }
    }
    const cache = new Map();
    const mp = (i) => { if (!cache.has(i)) cache.set(i, mapPoint([P[3 * i], P[3 * i + 1], P[3 * i + 2]])); return cache.get(i); };
    for (const e of edges.values()) {
      if (e.sides.length !== 2 || !(e.sides.includes(1) && e.sides.includes(0))) continue;
      const p = mp(e.i), q = mp(e.j);
      outlineSegs.push([[p[0], p[1]], [q[0], q[1]]]);
    }
  }
  if (flatMode) {
    // 平板件：朝上三角形区域的边界即落料外形
    outlineSegs.length = 0;
    for (const part of parts) {
      const P = part.positions, I = part.index;
      const vkey = (o) => Math.round(P[o] * 1e4) + ',' + Math.round(P[o + 1] * 1e4) + ',' + Math.round(P[o + 2] * 1e4);
      const canon = new Map();
      const vid = (i) => { const k = vkey(i * 3); if (!canon.has(k)) canon.set(k, i); return canon.get(k); };
      const cnt = new Map();
      for (let tt = 0; tt < I.length / 3; tt++) {
        const o = [I[3 * tt] * 3, I[3 * tt + 1] * 3, I[3 * tt + 2] * 3];
        const u = sub([P[o[1]], P[o[1] + 1], P[o[1] + 2]], [P[o[0]], P[o[0] + 1], P[o[0] + 2]]);
        const w = sub([P[o[2]], P[o[2] + 1], P[o[2] + 2]], [P[o[0]], P[o[0] + 1], P[o[0] + 2]]);
        const nz = dot(cross(u, w), n0);
        if (nz <= 1e-9) continue;
        const v = [vid(I[3 * tt]), vid(I[3 * tt + 1]), vid(I[3 * tt + 2])];
        for (let k = 0; k < 3; k++) {
          const i = v[k], j = v[(k + 1) % 3];
          const ek = i < j ? i + '_' + j : j + '_' + i;
          const e = cnt.get(ek);
          if (e) e.n++; else cnt.set(ek, { i, j, n: 1 });
        }
      }
      for (const e of cnt.values()) {
        if (e.n !== 1) continue;
        const p = mapPoint([P[3 * e.i], P[3 * e.i + 1], P[3 * e.i + 2]]), q = mapPoint([P[3 * e.j], P[3 * e.j + 1], P[3 * e.j + 2]]);
        outlineSegs.push([[p[0], p[1]], [q[0], q[1]]]);
      }
    }
  }
  const loopArea = (l) => { let ar = 0; for (let i = 0, j = l.length - 1; i < l.length; j = i++) ar += (l[j][0] + l[i][0]) * (l[j][1] - l[i][1]); return Math.abs(ar / 2); };
  const outlineLoops = chain(outlineSegs, 1e-3).filter(l => l.length > 2 && loopArea(l) > 0.02 * t * t);


  let u0 = Infinity, u1 = -Infinity, s0 = Infinity, s1 = -Infinity;
  for (let i = 0; i < flatSegs.length; i += 2) { u0 = Math.min(u0, flatSegs[i]); u1 = Math.max(u1, flatSegs[i]); s0 = Math.min(s0, flatSegs[i + 1]); s1 = Math.max(s1, flatSegs[i + 1]); }
  const flat = new Float32Array(flatSegs.length);
  for (let i = 0; i < flatSegs.length; i += 2) { flat[i] = flatSegs[i] - u0; flat[i + 1] = flatSegs[i + 1] - s0; }

  // 折弯线位置（展开图中沿 s 的坐标，取弧段中点）
  const bendLines = bends.map(b => (b.sA / lenA) * L - s0);

  const loops = outlineLoops.map(l => l.map(p => [p[0] - u0, p[1] - s0]));
  const loopBox = (l) => { let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const p of l) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); } return (x1 - x0) * (y1 - y0); };
  loops.sort((p, q) => loopBox(q) - loopBox(p));
  const mapFlat = (p) => { const m = mapPoint(p); return [m[0] - u0, m[1] - s0]; };

  // 展开轮廓校验：外轮廓必须闭合，面积与体积/料厚一致
  if (!loops.length) return { ok: false, reason: '未能提取展开轮廓', t };
  const outerL = loops[0];
  const gap = Math.hypot(outerL[0][0] - outerL[outerL.length - 1][0], outerL[0][1] - outerL[outerL.length - 1][1]);
  const pa = (l) => { let ar = 0; for (let i = 0, j = l.length - 1; i < l.length; j = i++) ar += (l[j][0] + l[i][0]) * (l[j][1] - l[i][1]); return Math.abs(ar / 2); };
  const netArea = pa(outerL) - loops.slice(1).reduce((s2, l) => s2 + pa(l), 0);
  const expect = metrics.volume / t;
  if (gap > 0.01 * Math.max(u1 - u0, s1 - s0) || (!flatMode && Math.abs(netArea - expect) / expect > 0.3)) {
    return { ok: false, reason: '展开轮廓不闭合（截面沿折弯方向不一致，可能存在多方向折弯或局部成形）', t };
  }

  return {
    ok: true,
    outer: loops[0] || null,
    inner: loops.slice(1),
    mapFlat,
    t, K, a, n0,
    bends,
    profile: { sideA, sideB, mid, loop },
    flatMode,
    midLen,
    length: L,
    lengthFor,
    width: u1 - u0,
    flat,
    flatSize: [u1 - u0, s1 - s0],
    bendLines,
    area: metrics.volume / t,
  };
}
