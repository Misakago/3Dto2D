// 2D 工程图生成：HLR 消隐投影 → 三视图 + 轴测图布局 → 尺寸/中心线/孔表/标题栏 → SVG / DXF
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { ProjectionGenerator } from 'three-edge-projection';

export const PAPERS = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594] };
const SCALES = [10, 5, 4, 2.5, 2, 1, 1 / 1.5, 1 / 2, 1 / 2.5, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 10, 1 / 15, 1 / 20, 1 / 25, 1 / 50, 1 / 100];
const FONT = "'FangSong','STFangsong','Noto Serif SC','Songti SC',serif";

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// 视图定义：d = 视线（从模型指向观察者），u = 图纸向上方向，r = u × d 为图纸向右
function makeView(key, label, d, u, opts = {}) {
  d = d.clone().normalize();
  u = u.clone().sub(d.clone().multiplyScalar(u.dot(d))).normalize();
  const r = new THREE.Vector3().crossVectors(u, d).normalize();
  return { key, label, d, u, r, ...opts };
}

export function getViews(projection) {
  const front = makeView('front', '主视图', V(0, -1, 0), V(0, 0, 1), { dims: ['h', 'v'] });
  const top = makeView('top', '俯视图', V(0, 0, 1), V(0, 1, 0), { dims: ['v'] });
  const side = projection === 'first'
    ? makeView('side', '左视图', V(-1, 0, 0), V(0, 0, 1), { dims: ['h'] })
    : makeView('side', '右视图', V(1, 0, 0), V(0, 0, 1), { dims: ['h'] });
  const iso = makeView('iso', '轴测图', V(1, -1, 1), V(0, 0, 1), { iso: true });
  return { front, top, side, iso };
}

function viewMatrix(view, q) {
  const { r, d, u } = view;
  const m = new THREE.Matrix4().set(
    r.x, r.y, r.z, 0,
    d.x, d.y, d.z, 0,
    -u.x, -u.y, -u.z, 0,
    0, 0, 0, 1,
  );
  return m.multiply(new THREE.Matrix4().makeRotationFromQuaternion(q));
}

function flatten(geom) {
  // (x,0,z) 线段 → [X1,Y1,X2,Y2,...]，Y = -z
  const p = geom.attributes.position.array;
  const out = new Float32Array((p.length / 6) * 4);
  let c = 0;
  for (let i = 0; i < p.length; i += 6) {
    const dx = p[i + 3] - p[i], dz = p[i + 5] - p[i + 2];
    if (dx * dx + dz * dz < 1e-10) continue;
    out[c++] = p[i]; out[c++] = -p[i + 2]; out[c++] = p[i + 3]; out[c++] = -p[i + 5];
  }
  return out.subarray(0, c);
}

export function prepareGeometries(geometries) {
  for (const g of geometries) if (!g.boundsTree) g.boundsTree = new MeshBVH(g);
}

/** 对单个视图执行 HLR 消隐投影 */
export async function projectView(geometries, view, q, { onProgress, signal, angleThreshold = 28 } = {}) {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.matrix.copy(viewMatrix(view, q));
  for (const g of geometries) group.add(new THREE.Mesh(g));
  group.updateMatrixWorld(true);
  const gen = new ProjectionGenerator();
  gen.angleThreshold = angleThreshold;
  gen.includeIntersectionEdges = false;
  gen.iterationTime = 24;
  const res = await gen.generateAsync(group, {
    signal: signal || new AbortController().signal,
    onProgress: (p, msg) => onProgress && onProgress(p, msg),
  });
  return {
    visible: flatten(res.visibleEdges.getLineGeometry()),
    hidden: view.iso ? new Float32Array(0) : flatten(res.hiddenEdges.getLineGeometry()),
  };
}

// 模型包围盒 8 角点 → 视图坐标范围
export function viewExtents(box, view, q) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p = V(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyQuaternion(q);
    const X = p.dot(view.r), Y = p.dot(view.u);
    x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
  }
  return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
}

function fmtScale(s) {
  if (s >= 1) return `${+s.toFixed(2)}:1`;
  return `1:${+(1 / s).toFixed(2)}`;
}

/** 计算布局：多种轴测图摆位 × 标准比例，选能放下的最大比例，再整体居中 */
export function computeLayout({ box, q, projection, paper }) {
  const views = getViews(projection);
  const [PW, PH] = PAPERS[paper];
  const frame = { x0: 20, y0: 10, x1: PW - 10, y1: PH - 10 };
  const tb = { w: 180, h: 56 };
  const title = { x0: frame.x1 - tb.w, y0: frame.y1 - tb.h, x1: frame.x1, y1: frame.y1 };
  const ext = Object.fromEntries(Object.entries(views).map(([k, v]) => [k, viewExtents(box, v, q)]));
  const gap = 26;
  const inter = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  // 视图外扩：左侧/下方留尺寸线，上方留视图名
  const dimsOf = (k) => views[k].dims || [];
  const margin = (r, k) => ({ x0: r.x0 - (dimsOf(k).includes('v') ? 16 : 4), y0: r.y0 - 7, x1: r.x1 + 4, y1: r.y1 + (dimsOf(k).includes('h') ? 15 : 4) });
  const inside = (m, f) => m.x0 >= f.x0 + 2 && m.y0 >= f.y0 + 2 && m.x1 <= f.x1 - 2 && m.y1 <= f.y1 - 2;

  const tryLayout = (s, isoSlot) => {
    const W = k => ext[k].w * s, H = k => ext[k].h * s;
    const R = (k, x0, y0) => ({ x0, y0, x1: x0 + W(k), y1: y0 + H(k) });
    const ox = frame.x0 + 18, oy = frame.y0 + 9;
    const rects = {};
    if (projection === 'first') {
      rects.front = R('front', ox, oy);
      rects.side = R('side', rects.front.x1 + gap, oy);
      rects.top = R('top', ox, rects.front.y1 + gap);
    } else {
      rects.top = R('top', ox, oy);
      rects.front = R('front', ox, rects.top.y1 + gap);
      rects.side = R('side', rects.front.x1 + gap, rects.front.y0);
    }
    const ortho = Object.values(rects);
    const right = Math.max(...ortho.map(r => r.x1));
    if (isoSlot === 'row1') rects.iso = R('iso', Math.max(rects.side.x1, rects.top.x1) + gap, oy);
    else if (isoSlot === 'row2') {
      const row2 = projection === 'first' ? rects.top : rects.front;
      const x = (projection === 'first' ? rects.top.x1 : rects.side.x1) + gap;
      rects.iso = R('iso', x, row2.y0);
    } else if (isoSlot === 'corner') rects.iso = R('iso', frame.x1 - 6 - W('iso'), oy);
    else if (isoSlot === 'aboveTitle') rects.iso = R('iso', Math.max(right + gap, frame.x1 - 6 - W('iso')), title.y0 - 18 - H('iso'));
    const ms = Object.fromEntries(Object.entries(rects).map(([k, r]) => [k, margin(r, k)]));
    const keys = Object.keys(ms);
    for (const k of keys) {
      if (!inside(ms[k], frame) || inter(ms[k], title)) return null;
      for (const j of keys) if (j < k && inter(ms[k], ms[j])) return null;
    }
    return rects;
  };

  for (const s of SCALES) {
    for (const slot of ['row1', 'row2', 'corner', 'aboveTitle']) {
      const rects = tryLayout(s, slot);
      if (!rects) continue;
      // 整体居中（保持视图间对齐关系），失败则保持原位
      const ms = Object.entries(rects).map(([k, r]) => margin(r, k));
      const bb = { x0: Math.min(...ms.map(m => m.x0)), y0: Math.min(...ms.map(m => m.y0)), x1: Math.max(...ms.map(m => m.x1)), y1: Math.max(...ms.map(m => m.y1)) };
      const dx = Math.max(0, ((frame.x1 - frame.x0) - (bb.x1 - bb.x0)) / 2 - (bb.x0 - frame.x0) - 4);
      const dy = Math.max(0, ((frame.y1 - frame.y0) - (bb.y1 - bb.y0)) / 2 - (bb.y0 - frame.y0) - 4);
      for (const [fx, fy] of [[dx, dy], [dx, 0], [0, dy], [dx / 2, dy / 2], [0, 0]]) {
        const moved = Object.fromEntries(Object.entries(rects).map(([k, r]) => [k, { x0: r.x0 + fx, x1: r.x1 + fx, y0: r.y0 + fy, y1: r.y1 + fy }]));
        const mm = Object.entries(moved).map(([k, r]) => margin(r, k));
        if (mm.every(m => inside(m, frame) && !inter(m, title))) {
          return { views, rects: moved, ext, scale: s, scaleText: fmtScale(s), paper, PW, PH, frame, title, isoSlot: slot };
        }
      }
    }
  }
  throw new Error('模型过大，无法放入所选图幅');
}

// ---------------- 图纸图元（图纸坐标 mm，y 向下） ----------------
class Sheet {
  constructor() { this.items = []; }
  line(layer, x1, y1, x2, y2) { this.items.push({ t: 'line', layer, x1, y1, x2, y2 }); }
  rect(layer, x0, y0, x1, y1) { this.line(layer, x0, y0, x1, y0); this.line(layer, x1, y0, x1, y1); this.line(layer, x1, y1, x0, y1); this.line(layer, x0, y1, x0, y0); }
  text(layer, x, y, str, size = 3.5, anchor = 'start', rot = 0, extra = {}) { this.items.push({ t: 'text', layer, x, y, str, size, anchor, rot, ...extra }); }
  solid(layer, pts) { this.items.push({ t: 'solid', layer, pts }); }
  circle(layer, cx, cy, r) { this.items.push({ t: 'circle', layer, cx, cy, r }); }
  segs(layer, arr, view, cls) { this.items.push({ t: 'segs', layer, arr, view, cls }); }
  arrow(layer, tx, ty, dx, dy, len = 3, wid = 0.9) {
    const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const bx = tx - dx * len, by = ty - dy * len;
    this.solid(layer, [[tx, ty], [bx - dy * wid / 2, by + dx * wid / 2], [bx + dy * wid / 2, by - dx * wid / 2]]);
  }
}

const f2 = v => (Math.abs(v - Math.round(v)) < 0.005 ? String(Math.round(v)) : v.toFixed(2).replace(/0$/, ''));

function dimH(sh, xa, xb, yRef, yDim, value) {
  const s = Math.sign(yDim - yRef) || 1;
  sh.line('DIM', xa, yRef + s * 1.5, xa, yDim + s * 2);
  sh.line('DIM', xb, yRef + s * 1.5, xb, yDim + s * 2);
  sh.line('DIM', xa, yDim, xb, yDim);
  sh.arrow('DIM', xa, yDim, -1, 0);
  sh.arrow('DIM', xb, yDim, 1, 0);
  sh.text('DIMTXT', (xa + xb) / 2, yDim - 1.2, value, 3.5, 'middle');
}

function dimV(sh, ya, yb, xRef, xDim, value) {
  const s = Math.sign(xDim - xRef) || -1;
  sh.line('DIM', xRef + s * 1.5, ya, xDim + s * 2, ya);
  sh.line('DIM', xRef + s * 1.5, yb, xDim + s * 2, yb);
  sh.line('DIM', xDim, ya, xDim, yb);
  sh.arrow('DIM', xDim, ya, 0, -1);
  sh.arrow('DIM', xDim, yb, 0, 1);
  sh.text('DIMTXT', xDim - 1.2, (ya + yb) / 2, value, 3.5, 'middle', -90);
}

/**
 * 组装整张图纸
 * results: { front:{visible,hidden}, ... }（可部分为空，用于渐进显示）
 */
export function buildSheet({ layout, results, q, features, holeSummary, meta, options }) {
  const sh = new Sheet();
  const { views, rects, ext, scale: s, frame, title, PW, PH } = layout;

  // 图框
  sh.rect('FRAME_THIN', 0, 0, PW, PH);
  sh.rect('FRAME', frame.x0, frame.y0, frame.x1, frame.y1);
  // 对中符号
  sh.line('FRAME', PW / 2, 0, PW / 2, frame.y0 + 5); sh.line('FRAME', PW / 2, PH, PW / 2, frame.y1 - 5);
  sh.line('FRAME', 0, PH / 2, frame.x0 + 5, PH / 2); sh.line('FRAME', PW, PH / 2, frame.x1 - 5, PH / 2);

  const toSheet = (k) => {
    const r = rects[k], e = ext[k];
    return (X, Y) => [r.x0 + (X - e.x0) * s, r.y0 + (e.y1 - Y) * s];
  };

  for (const [k, view] of Object.entries(views)) {
    const r = rects[k];
    const map = toSheet(k);
    sh.text('LABEL', r.x0, r.y0 - 3, view.label + (view.iso ? '' : ''), 3.5, 'start', 0, { cls: 'view-label' });
    const res = results[k];
    if (!res) {
      sh.items.push({ t: 'pending', x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, label: view.label });
      continue;
    }
    const tr = (arr) => {
      const out = new Float32Array(arr.length);
      for (let i = 0; i < arr.length; i += 2) { const [x, y] = map(arr[i], arr[i + 1]); out[i] = x; out[i + 1] = y; }
      return out;
    };
    if (options.hidden && res.hidden.length) sh.segs('HIDDEN', tr(res.hidden), k);
    sh.segs('VISIBLE', tr(res.visible), k);

    if (view.iso) continue;
    // 中心线
    if (options.centerlines) {
      for (const f of features) {
        if (f.kind === 'fillet') continue;
        const a = V(...f.a).applyQuaternion(q), p = V(...f.p).applyQuaternion(q);
        const c = p.clone().addScaledVector(a, (f.tMin + f.tMax) / 2);
        const ad = Math.abs(a.dot(view.d));
        const ext2 = 2.5 / s;
        if (ad > 0.995) {
          const [cx, cy] = map(c.dot(view.r), c.dot(view.u));
          const L = f.r * s + 2.5;
          if (f.r * s < 0.6) continue;
          sh.line('CENTER', cx - L, cy, cx + L, cy);
          sh.line('CENTER', cx, cy - L, cx, cy + L);
        } else if (ad < 0.005) {
          const p0 = p.clone().addScaledVector(a, f.tMin - ext2), p1 = p.clone().addScaledVector(a, f.tMax + ext2);
          const [x0, y0] = map(p0.dot(view.r), p0.dot(view.u));
          const [x1, y1] = map(p1.dot(view.r), p1.dot(view.u));
          if (Math.hypot(x1 - x0, y1 - y0) > 4) sh.line('CENTER', x0, y0, x1, y1);
        }
      }
    }
    // 外形尺寸
    if (options.dims) {
      const e = ext[k];
      if (view.dims.includes('h')) dimH(sh, r.x0, r.x1, r.y1, r.y1 + 9, f2(e.w));
      if (view.dims.includes('v')) dimV(sh, r.y0, r.y1, r.x0, r.x0 - 9, f2(e.h));
    }
  }

  // 孔径引线标注：每组直径只标一次，选轴线平行于视线的视图
  if (options.dims) {
    let n = 0;
    const labelBoxes = [];
    const order = ['front', 'top', 'side'];
    for (const g of holeSummary.holes) {
      if (n >= 10) break;
      let placed = false;
      for (const k of order) {
        if (placed || !results[k]) continue;
        const view = views[k];
        const cands = g.items.filter(f => Math.abs(V(...f.a).applyQuaternion(q).dot(view.d)) > 0.995);
        if (!cands.length) continue;
        const map = toSheet(k);
        let best = null, bestScore = -Infinity;
        for (const f of cands) {
          const c = V(...f.center).applyQuaternion(q);
          const [x, y] = map(c.dot(view.r), c.dot(view.u));
          const score = x - y;
          if (score > bestScore) { bestScore = score; best = [x, y, f]; }
        }
        const [cx, cy, f] = best;
        const rr = f.r * s;
        if (rr < 0.4) continue;
        const label = (g.count > 1 ? `${g.count}×` : '') + 'Ø' + f2(g.d);
        const tw = label.length * 2.1 + 2;
        // 依次尝试四个方向与两种长度，避开已放置的标注
        let ok = null;
        for (const len of [7, 12, 17]) {
          for (const ang of [-45, -135, 45, 135]) {
            const rad = ang * Math.PI / 180;
            const sx = cx + rr * Math.cos(rad), sy = cy + rr * Math.sin(rad);
            const ex = sx + len * Math.cos(rad), ey = sy + len * Math.sin(rad);
            const dir = Math.cos(rad) > 0 ? 1 : -1;
            const box = { x0: Math.min(ex, ex + dir * tw) - 0.5, x1: Math.max(ex, ex + dir * tw) + 0.5, y0: ey - 4.2, y1: ey + 0.8 };
            if (box.x0 < frame.x0 + 2 || box.x1 > frame.x1 - 2 || box.y0 < frame.y0 + 2 || box.y1 > title.y0 - 2 && box.x1 > title.x0) continue;
            if (labelBoxes.some(b => b.x0 < box.x1 && b.x1 > box.x0 && b.y0 < box.y1 && b.y1 > box.y0)) continue;
            ok = { sx, sy, ex, ey, dir, box };
            break;
          }
          if (ok) break;
        }
        if (!ok) continue;
        const { sx, sy, ex, ey, dir, box } = ok;
        labelBoxes.push(box);
        sh.line('DIM', sx, sy, ex, ey);
        sh.line('DIM', ex, ey, ex + dir * tw, ey);
        sh.arrow('DIM', sx, sy, sx - ex, sy - ey, 2.5, 0.8);
        sh.text('DIMTXT', dir > 0 ? ex + 1 : ex - 1, ey - 1, label, 3, dir > 0 ? 'start' : 'end');
        placed = true; n++;
      }
    }
  }

  // 投影符号 / 标题栏
  drawTitleBlock(sh, title, meta, layout, options);

  // 技术要求 + 孔表（标题栏上方）
  const holesAll = holeSummary.holes;
  const viewBoxes = Object.entries(rects).map(([k, r]) => ({ x0: r.x0 - 16, y0: r.y0 - 7, x1: r.x1 + 4, y1: r.y1 + 15 }));
  const free = (b) => !viewBoxes.some(r => r.x0 < b.x1 && r.x1 > b.x0 && r.y0 < b.y1 && r.y1 > b.y0);
  let tableBox = null;
  if (options.holeTable && holesAll.length) {
    const cols = [12, 18, 26, 14, 24];
    const tw = cols.reduce((a, b) => a + b, 0);
    const rh = 5.5;
    // 候选位置：标题栏上方右对齐 / 标题栏左侧底对齐；行数自适应
    let placed = null;
    for (let n = Math.min(10, holesAll.length); n >= 2 && !placed; n--) {
      const th = (n + 1) * rh;
      const cands = [
        { x0: title.x1 - tw, y0: title.y0 - 5 - th },
        { x0: title.x0 - 6 - tw, y0: frame.y1 - 4 - th },
      ];
      for (const c of cands) {
        const b = { x0: c.x0, y0: c.y0 - 6, x1: c.x0 + tw, y1: c.y0 + th };
        if (b.y0 > frame.y0 + 2 && b.x0 > frame.x0 + 2 && free(b)) { placed = { ...c, n, th }; break; }
      }
    }
    if (placed) {
      const { x0, y0, n, th } = placed;
      const x1 = x0 + tw, y1 = y0 + th;
      const shown = holesAll.slice(0, n);
      const rows = [['序号', '类型', '直径', '数量', '长度'], ...shown.map((h, i) => [String(i + 1), h.kind === 'hole' ? '孔' : '凸台/轴', 'Ø' + f2(h.d), String(h.count), f2(h.depth)])];
      sh.rect('FRAME', x0, y0, x1, y1);
      rows.forEach((row, i) => {
        const yy = y0 + i * rh;
        if (i) sh.line('THIN', x0, yy, x1, yy);
        let xx = x0;
        row.forEach((cell, j) => {
          if (i === 0 && j) sh.line('THIN', xx, y0, xx, y1);
          sh.text(i === 0 ? 'TITLE' : 'TEXT', xx + cols[j] / 2, yy + rh - 1.6, cell, 2.8, 'middle');
          xx += cols[j];
        });
      });
      sh.text('TITLE', x0, y0 - 2, `孔/轴特征表（自动识别${holesAll.length > n ? `，前 ${n}/${holesAll.length} 组` : ''}）`, 3, 'start');
      tableBox = { x0, y0: y0 - 6, x1, y1 };
    }
  }
  if (options.notes) {
    const notes = ['技术要求', '1. 未注线性尺寸公差按 GB/T 1804-m。', '2. 未注倒角 C0.5，锐边倒钝。', `3. 本图由 3D 模型自动生成，比例 ${layout.scaleText}。`];
    const nx = frame.x0 + 8;
    const ny = frame.y1 - 6 - (notes.length - 1) * 5.5;
    const box = { x0: nx, y0: ny - 5, x1: nx + Math.max(...notes.map(t => t.length)) * 3.05, y1: frame.y1 - 2 };
    const hitTable = tableBox && tableBox.x0 < box.x1 && tableBox.x1 > box.x0 && tableBox.y0 < box.y1 && tableBox.y1 > box.y0;
    if (free(box) && !hitTable) notes.forEach((t, i) => sh.text(i ? 'TEXT' : 'TITLE', nx, ny + i * 5.5, t, i ? 3 : 3.5));
  }
  return sh;
}

function projectionSymbol(sh, x, y, first) {
  // 截锥投影符号（GB/T 14692）：高 h=5
  const h = 5;
  const cone = (cx) => { // 侧视梯形
    sh.line('THIN', cx - h, y - h / 2, cx + h, y - h * 0.9);
    sh.line('THIN', cx + h, y - h * 0.9, cx + h, y + h * 0.9);
    sh.line('THIN', cx + h, y + h * 0.9, cx - h, y + h / 2);
    sh.line('THIN', cx - h, y + h / 2, cx - h, y - h / 2);
    sh.line('CENTER', cx - h - 2, y, cx + h + 2, y);
  };
  const circ = (cx) => {
    sh.circle('THIN', cx, y, h * 0.9);
    sh.circle('THIN', cx, y, h / 2);
    sh.line('CENTER', cx - h - 2, y, cx + h + 2, y);
    sh.line('CENTER', cx, y - h - 2, cx, y + h + 2);
  };
  if (first) { cone(x - 7); circ(x + 9); } else { circ(x - 9); cone(x + 7); }
}

function drawTitleBlock(sh, t, meta, layout, options) {
  const { x0, y0, x1, y1 } = t;
  sh.rect('FRAME', x0, y0, x1, y1);
  // 列：左签名区 80 | 中 50 | 右 50
  const xa = x0 + 80, xb = x0 + 130;
  sh.line('FRAME', xa, y0, xa, y1);
  sh.line('FRAME', xb, y0, xb, y1);
  // 左：签名区 7 行
  const rows = ['设计', '校对', '审核', '工艺', '标准化', '批准', '日期'];
  const rh = 56 / 7;
  const sig = { 设计: meta.designer, 日期: meta.date, 审核: '', 校对: '' };
  rows.forEach((name, i) => {
    const yy = y0 + i * rh;
    if (i) sh.line('THIN', x0, yy, xa, yy);
    sh.text('TEXT', x0 + 8, yy + rh - 2.3, name, 3, 'middle');
    if (sig[name]) sh.text('TEXT', x0 + 16 + 32, yy + rh - 2.3, sig[name], 3, 'middle');
  });
  sh.line('THIN', x0 + 16, y0, x0 + 16, y1);
  sh.line('THIN', x0 + 64, y0, x0 + 64, y1);
  // 中：材料、比例、重量、共张
  sh.line('THIN', xa, y0 + 18, xb, y0 + 18);
  sh.text('LABEL', xa + 2, y0 + 4.5, '材料', 2.5);
  if (meta.material) sh.text('TITLE', (xa + xb) / 2, y0 + 13, meta.material, 4.5, 'middle');
  const cells = [['比例', layout.scaleText], ['版本', meta.revision || 'A'], ['单位', 'mm'], ['图幅', layout.paper]];
  cells.forEach(([k, v], i) => {
    const cx = xa + (i % 2) * 25, cy = y0 + 18 + Math.floor(i / 2) * 10;
    sh.rect('THIN', cx, cy, cx + 25, cy + 10);
    sh.text('LABEL', cx + 1.5, cy + 3.4, k, 2.3);
    sh.text('TEXT', cx + 12.5, cy + 8.2, v, 3, 'middle');
  });
  sh.text('LABEL', xa + 2, y0 + 41.5, options.projection === 'first' ? '第一角投影 (GB/ISO-E)' : '第三角投影 (ASME/ISO-A)', 2.3);
  projectionSymbol(sh, xa + 25, y0 + 49, options.projection === 'first');
  // 右：公司 / 图名 / 图号
  sh.line('THIN', xb, y0 + 16, x1, y0 + 16);
  sh.line('THIN', xb, y0 + 38, x1, y0 + 38);
  sh.text('TITLE', (xb + x1) / 2, y0 + 7.5, meta.company, 4.2, 'middle');
  sh.text('LABEL', (xb + x1) / 2, y0 + 13, meta.companySub, 2.3, 'middle');
  sh.text('TITLE', (xb + x1) / 2, y0 + 29.5, meta.title.length > 18 ? meta.title.slice(0, 18) + '…' : meta.title, meta.title.length > 12 ? 3.8 : 5, 'middle');
  sh.text('LABEL', xb + 2, y0 + 42, '图号', 2.3);
  sh.text('TITLE', (xb + x1) / 2, y0 + 49.5, meta.drawingNo, 4.2, 'middle');
  sh.text('LABEL', x1 - 2, y0 + 54.5, '共 1 张  第 1 张', 2.2, 'end');
}

// ---------------- 输出 ----------------
const STROKE = {
  FRAME: { w: 0.7, c: '#111' }, FRAME_THIN: { w: 0.25, c: '#111' }, THIN: { w: 0.25, c: '#111' },
  VISIBLE: { w: 0.5, c: '#0b0f17' }, HIDDEN: { w: 0.25, c: '#3a4556', dash: '2 1' },
  CENTER: { w: 0.18, c: '#b4232a', dash: '6 1 1 1' }, DIM: { w: 0.18, c: '#1d4ed8' },
};
const TEXT_FILL = { DIMTXT: '#1d4ed8', LABEL: '#4b5563', TITLE: '#111', TEXT: '#111' };

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

export function sheetToSVG(sh, layout, { fresh = null } = {}) {
  const { PW, PH } = layout;
  const byLayer = {};
  const out = [];
  const segPaths = [];
  for (const it of sh.items) {
    if (it.t === 'line') {
      (byLayer[it.layer] ||= []).push(`M${it.x1.toFixed(2)} ${it.y1.toFixed(2)}L${it.x2.toFixed(2)} ${it.y2.toFixed(2)}`);
    } else if (it.t === 'segs') {
      const a = it.arr;
      const parts = new Array(a.length / 4);
      for (let i = 0, j = 0; i < a.length; i += 4, j++) parts[j] = `M${a[i].toFixed(2)} ${a[i + 1].toFixed(2)}L${a[i + 2].toFixed(2)} ${a[i + 3].toFixed(2)}`;
      const st = STROKE[it.layer];
      segPaths.push(`<path class="v-${it.view} l-${it.layer}${fresh?.has(it.view) ? ' fresh' : ''}" d="${parts.join('')}" stroke="${st.c}" stroke-width="${st.w}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/>`);
    } else if (it.t === 'text') {
      const fill = TEXT_FILL[it.layer] || '#111';
      const tr = it.rot ? ` transform="rotate(${it.rot} ${it.x.toFixed(2)} ${it.y.toFixed(2)})"` : '';
      const weight = it.layer === 'TITLE' ? ' font-weight="600"' : '';
      out.push(`<text x="${it.x.toFixed(2)}" y="${it.y.toFixed(2)}" font-size="${it.size}" text-anchor="${it.anchor}" fill="${fill}"${weight}${tr}>${esc(it.str)}</text>`);
    } else if (it.t === 'solid') {
      out.push(`<polygon points="${it.pts.map(p => p.map(v => v.toFixed(2)).join(',')).join(' ')}" fill="${STROKE[it.layer]?.c || '#111'}"/>`);
    } else if (it.t === 'circle') {
      const st = STROKE[it.layer];
      out.push(`<circle cx="${it.cx}" cy="${it.cy}" r="${it.r}" fill="none" stroke="${st.c}" stroke-width="${st.w}"/>`);
    } else if (it.t === 'pending') {
      out.push(`<g class="pending"><rect x="${it.x0}" y="${it.y0}" width="${it.x1 - it.x0}" height="${it.y1 - it.y0}" rx="1.5"/><text x="${(it.x0 + it.x1) / 2}" y="${(it.y0 + it.y1) / 2}" font-size="3.5" text-anchor="middle">${esc(it.label)} 投影中…</text></g>`);
    }
  }
  const layerPaths = Object.entries(byLayer).map(([layer, ds]) => {
    const st = STROKE[layer] || STROKE.THIN;
    return `<path class="l-${layer}" d="${ds.join('')}" stroke="${st.c}" stroke-width="${st.w}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PW} ${PH}" width="${PW}mm" height="${PH}mm" >
<rect width="${PW}" height="${PH}" fill="#fff"/>
<g fill="none" stroke-linecap="round" stroke-linejoin="round">${segPaths.join('\n')}${layerPaths.join('\n')}</g>
<g font-family="${FONT}">${out.join('\n')}</g>
</svg>`;
}

// DXF (R12 ASCII)，中文以 \U+XXXX 转义
export function sheetToDXF(sh, layout) {
  const { PH } = layout;
  const L = [];
  const p = (...kv) => { for (let i = 0; i < kv.length; i += 2) L.push(String(kv[i]), String(kv[i + 1])); };
  const enc = (s) => String(s).replace(/[^\x20-\x7e]/g, ch => '\\U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
  const fy = y => (PH - y).toFixed(3);
  const LAYERS = { FRAME: [7, 'CONTINUOUS'], FRAME_THIN: [7, 'CONTINUOUS'], THIN: [7, 'CONTINUOUS'], VISIBLE: [7, 'CONTINUOUS'], HIDDEN: [8, 'DASHED'], CENTER: [1, 'CENTER'], DIM: [5, 'CONTINUOUS'], DIMTXT: [5, 'CONTINUOUS'], TEXT: [7, 'CONTINUOUS'], TITLE: [7, 'CONTINUOUS'], LABEL: [8, 'CONTINUOUS'] };
  p(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, 4, 9, '$EXTMIN', 10, 0, 20, 0, 9, '$EXTMAX', 10, layout.PW, 20, PH, 0, 'ENDSEC');
  p(0, 'SECTION', 2, 'TABLES');
  p(0, 'TABLE', 2, 'LTYPE', 70, 3);
  p(0, 'LTYPE', 2, 'CONTINUOUS', 70, 0, 3, 'Solid', 72, 65, 73, 0, 40, 0);
  p(0, 'LTYPE', 2, 'DASHED', 70, 0, 3, '__ __', 72, 65, 73, 2, 40, 3, 49, 2, 49, -1);
  p(0, 'LTYPE', 2, 'CENTER', 70, 0, 3, '____ _ ', 72, 65, 73, 4, 40, 9, 49, 6, 49, -1, 49, 1, 49, -1);
  p(0, 'ENDTAB');
  p(0, 'TABLE', 2, 'LAYER', 70, Object.keys(LAYERS).length);
  for (const [name, [color, lt]] of Object.entries(LAYERS)) p(0, 'LAYER', 2, name, 70, 0, 62, color, 6, lt);
  p(0, 'ENDTAB', 0, 'ENDSEC');
  p(0, 'SECTION', 2, 'ENTITIES');
  const line = (layer, x1, y1, x2, y2) => p(0, 'LINE', 8, layer, 10, x1.toFixed(3), 20, fy(y1), 30, 0, 11, x2.toFixed(3), 21, fy(y2), 31, 0);
  for (const it of sh.items) {
    if (it.t === 'line') line(it.layer, it.x1, it.y1, it.x2, it.y2);
    else if (it.t === 'segs') { const a = it.arr; for (let i = 0; i < a.length; i += 4) line(it.layer, a[i], a[i + 1], a[i + 2], a[i + 3]); }
    else if (it.t === 'circle') p(0, 'CIRCLE', 8, it.layer, 10, it.cx.toFixed(3), 20, fy(it.cy), 30, 0, 40, it.r);
    else if (it.t === 'solid') {
      const [a, b, c] = it.pts;
      p(0, 'SOLID', 8, it.layer, 10, a[0].toFixed(3), 20, fy(a[1]), 30, 0, 11, b[0].toFixed(3), 21, fy(b[1]), 31, 0, 12, c[0].toFixed(3), 22, fy(c[1]), 32, 0, 13, c[0].toFixed(3), 23, fy(c[1]), 33, 0);
    } else if (it.t === 'text') {
      const h = { start: 0, middle: 1, end: 2 }[it.anchor];
      p(0, 'TEXT', 8, it.layer, 10, it.x.toFixed(3), 20, fy(it.y), 30, 0, 40, it.size * 0.8, 1, enc(it.str));
      if (it.rot) p(50, -it.rot);
      if (h) p(72, h, 11, it.x.toFixed(3), 21, fy(it.y), 31, 0);
    }
  }
  p(0, 'ENDSEC', 0, 'EOF');
  return L.join('\n');
}

export function countSegments(results) {
  let v = 0, h = 0;
  for (const r of Object.values(results)) { if (!r) continue; v += r.visible.length / 4; h += r.hidden.length / 4; }
  return { visible: v, hidden: h };
}
