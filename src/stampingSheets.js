// 冲模设计图纸：产品前期处理 / 料带 / 模板外形 / 总装 / 模板拆分 / 清单
import { Sheet, PAPERS, SCALES, fmtScale, f2, dimH, dimV, drawTitleBlock, PUNCH_COLORS } from './drawing.js';

const fitScale = (w, h, aw, ah) => SCALES.find(s => w * s <= aw && h * s <= ah) || SCALES[SCALES.length - 1];

function frame(paper, meta, scaleText, sheetTitle, sheetNo) {
  const [PW, PH] = PAPERS[paper];
  const sh = new Sheet();
  const fr = { x0: 20, y0: 10, x1: PW - 10, y1: PH - 10 };
  const title = { x0: fr.x1 - 180, y0: fr.y1 - 56, x1: fr.x1, y1: fr.y1 };
  sh.rect('FRAME_THIN', 0, 0, PW, PH);
  sh.rect('FRAME', fr.x0, fr.y0, fr.x1, fr.y1);
  const layout = { PW, PH, paper, scaleText, frame: fr, title };
  drawTitleBlock(sh, title, { ...meta, title: sheetTitle, drawingNo: `${meta.drawingNo}-${sheetNo}` }, layout, { projection: 'first' });
  return { sh, layout };
}

// 内容坐标（mm，y 向上）→ 图纸坐标
const placer = (ox, oy, s) => (x, y) => [ox + x * s, oy - y * s];

function drawLoop(sh, layer, loop, P, closed = true) { sh.poly(layer, loop.map(p => P(p[0], p[1])), closed); }
function circle(sh, layer, P, cx, cy, r, s) { const [x, y] = P(cx, cy); sh.circle(layer, x, y, r * s); }
function rectC(sh, layer, P, x0, y0, x1, y1) { const a = P(x0, y0), b = P(x1, y1); sh.rect(layer, a[0], a[1], b[0], b[1]); }
function crossMark(sh, P, cx, cy, size) { const [x, y] = P(cx, cy); sh.line('CENTER', x - size, y, x + size, y); sh.line('CENTER', x, y - size, x, y + size); }

// 线段数组（x1,y1,x2,y2…）放入矩形框
function fitSegs(arr, box, pad = 4) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < arr.length; i += 2) { x0 = Math.min(x0, arr[i]); x1 = Math.max(x1, arr[i]); y0 = Math.min(y0, arr[i + 1]); y1 = Math.max(y1, arr[i + 1]); }
  const s = Math.min((box.x1 - box.x0 - 2 * pad) / (x1 - x0 || 1), (box.y1 - box.y0 - 2 * pad) / (y1 - y0 || 1));
  const ox = (box.x0 + box.x1) / 2 - ((x0 + x1) / 2) * s, oy = (box.y0 + box.y1) / 2 + ((y0 + y1) / 2) * s;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i += 2) { out[i] = ox + arr[i] * s; out[i + 1] = oy - arr[i + 1] * s; }
  return out;
}

// 由折弯参数重建截面中性线（前 k 个折弯已成形）
export function profileAfter(sm, flat, k, K) {
  const L = flat.length;
  const bends = sm.bends.map((b, i) => ({ ...b, s: flat.bendLines[i] ?? (L * (i + 1)) / (sm.bends.length + 1) }));
  const pts = [[0, 0]];
  let x = 0, y = 0, h = Math.PI / 2, s = 0;
  const step = (len) => { const n = Math.max(1, Math.ceil(len / 0.5)); for (let i = 0; i < n; i++) { x += Math.cos(h) * len / n; y += Math.sin(h) * len / n; pts.push([x, y]); } };
  bends.forEach((b, i) => {
    const rn = b.rIn + K * sm.t;
    const arc = b.theta * rn;
    const sStart = b.s - arc / 2;
    if (sStart > s) { step(sStart - s); s = sStart; }
    if (i < k) {
      const n = 12, dir = b.dir || 1;
      for (let j = 0; j < n; j++) { h += (dir * b.theta) / n; x += Math.cos(h) * arc / n; y += Math.sin(h) * arc / n; pts.push([x, y]); }
    } else step(arc);
    s += arc;
  });
  if (L > s) step(L - s);
  return pts;
}
function thickPoly(mid, t) {
  const a = [], b = [];
  for (let i = 0; i < mid.length; i++) {
    const p = mid[Math.max(0, i - 1)], q = mid[Math.min(mid.length - 1, i + 1)];
    const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l, ny = dx / l;
    a.push([mid[i][0] + nx * t / 2, mid[i][1] + ny * t / 2]);
    b.push([mid[i][0] - nx * t / 2, mid[i][1] - ny * t / 2]);
  }
  return [...a, ...b.reverse()];
}

// ---------------- 01 产品前期处理 ----------------
export function sheetPrep({ meta, sm, flat, strip, params, results }) {
  const { sh, layout } = frame('A3', meta, '—', '产品前期处理', 'ST01');
  sh.text('HEAD', 30, 22, '第一步：产品前期处理', 6);
  const cols = ['3D', '2D', '展开图', '尺寸调整', '接刀图'];
  const x0 = 30, x1 = 400, y0 = 30, yH = 40, y1 = 205;
  const cw = (x1 - x0) / cols.length;
  sh.rect('FRAME', x0, y0, x1, y1);
  sh.line('THIN', x0, yH, x1, yH);
  cols.forEach((c, i) => {
    if (i) sh.line('THIN', x0 + i * cw, y0, x0 + i * cw, y1);
    sh.text('TITLE', x0 + i * cw + cw / 2, y0 + 7, c, 4.2, 'middle');
  });
  const cell = (i) => ({ x0: x0 + i * cw + 2, x1: x0 + (i + 1) * cw - 2, y0: yH + 10, y1: y1 - 22 });
  // 3D：轴测投影线
  if (results.iso) sh.segs('VISIBLE', fitSegs(results.iso.visible, cell(0), 6), 'prep3d');
  // 2D：主视 + 侧视
  {
    // 选投影面积最大的视图为主视，面积最小的为截面方向
    const area = (r) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; const a = r.visible; for (let i = 0; i < a.length; i += 2) { x0 = Math.min(x0, a[i]); x1 = Math.max(x1, a[i]); y0 = Math.min(y0, a[i + 1]); y1 = Math.max(y1, a[i + 1]); } return { a: (x1 - x0) * (y1 - y0), w: x1 - x0, h: y1 - y0 }; };
    const vs = ['front', 'top', 'side'].filter(k => results[k]).map(k => ({ k, ...area(results[k]) })).sort((p, q) => q.a - p.a);
    if (vs.length >= 2) {
      const c = cell(1);
      const main = vs[0], prof = vs[vs.length - 1];
      const split = c.x0 + (c.x1 - c.x0) * Math.min(0.72, Math.max(0.5, main.w / (main.w + prof.w)));
      sh.segs('VISIBLE', fitSegs(results[main.k].visible, { ...c, x1: split }, 3), 'prep2d');
      sh.segs('VISIBLE', fitSegs(results[prof.k].visible, { ...c, x0: split }, 3), 'prep2d');
    }
  }
  // 展开图 / 尺寸调整 / 接刀图：同一比例
  const fw = flat.width, fl = flat.length;
  const c2 = cell(2);
  const s = Math.min((c2.x1 - c2.x0 - 22) / fw, (c2.y1 - c2.y0 - 14) / fl);
  const drawFlat = (i, length, opts = {}) => {
    const c = cell(i);
    const sy = length / flat.length;
    const ox = (c.x0 + c.x1) / 2 - (fw * s) / 2, oy = (c.y0 + c.y1) / 2 + (fl * s) / 2;
    const P = placer(ox, oy, s);
    const tf = (l) => l.map(p => [p[0], p[1] * sy]);
    if (opts.scrap) {
      // 接刀图：外框（料带间距）减去零件 = 废料，按两段冲头着色
      const gap = (strip.pitch - fw) / 2;
      const box = [[-gap, -strip.g], [fw + gap, -strip.g], [fw + gap, fl + 1], [-gap, fl + 1]].map(p => P(p[0], p[1]));
      const part = tf(flat.outer).map(p => P(p[0], p[1]));
      const splitY = P(0, fl * 0.5)[1];
      const ov = params.overlap * s;
      sh.fill([box, part], PUNCH_COLORS[0], 0.28, [box[0][0], splitY - ov, box[1][0], box[0][1]]);
      sh.fill([box, part], PUNCH_COLORS[1], 0.28, [box[0][0], box[2][1], box[1][0], splitY + ov]);
      for (const h of flat.holes) sh.fill([tf(h.pts).map(p => P(p[0], p[1]))], PUNCH_COLORS[2], 0.4);
      sh.line('BEND', box[0][0] - 2, splitY, box[1][0] + 2, splitY);
      sh.text('NOTE', box[1][0] + 1, splitY - 1, `接刀 ${params.overlap}`, 2.2);
      sh.poly('P1', box, true);
    }
    drawLoop(sh, 'PART', tf(flat.outer), P);
    for (const h of flat.inner) drawLoop(sh, 'PART', tf(h), P);
    if (!opts.scrap) for (const b of flat.bendLines) { const a = P(-1.5, b * sy), e = P(fw + 1.5, b * sy); sh.line('BEND', a[0], a[1], e[0], e[1]); }
    if (opts.dims) {
      const a = P(0, 0), e = P(fw, length * 1);
      dimH(sh, a[0], e[0], a[1], a[1] + 7, f2(fw));
      dimV(sh, e[1], a[1], e[0], e[0] + 8, length.toFixed(3));
    }
    return { c, P };
  };
  const g2 = drawFlat(2, flat.lengthK, { dims: true });
  const g3 = drawFlat(3, flat.length, { dims: true });
  drawFlat(4, flat.length, { scrap: true });
  sh.text('NOTE', (g2.c.x0 + g2.c.x1) / 2, yH + 7, `K = ${params.K.toFixed(2)}`, 2.8, 'middle');
  sh.text('NOTE', (g3.c.x0 + g3.c.x1) / 2, yH + 7, `R角调整为${params.rAdjust}`, 2.8, 'middle');
  // 底部说明
  const ny = y1 - 16;
  const bendTxt = sm.bends.map(b => `${b.deg.toFixed(1)}°/R${b.rIn}`).join('，');
  const lines = [
    [0, `料厚 t = ${sm.t.toFixed(2)}`, '单向折弯件'],
    [1, `折弯 ${sm.bends.length} 处`, bendTxt],
    [2, `展开 ${f2(fw)} × ${flat.lengthK.toFixed(3)}`, `中性层 K=${params.K}`],
    [3, `调整后 ${flat.length.toFixed(3)}`, `Δ ${(flat.length - flat.lengthK >= 0 ? '+' : '') + (flat.length - flat.lengthK).toFixed(3)}`],
    [4, '外形分两刀冲切', `搭接 ${params.overlap}，冲孔 ${flat.holes.length} 处`],
  ];
  for (const [i, a, b] of lines) {
    sh.text('TEXT', x0 + i * cw + cw / 2, ny + 4, a, 2.8, 'middle');
    sh.text('LABEL', x0 + i * cw + cw / 2, ny + 9, b, 2.4, 'middle');
  }
  sh.line('THIN', x0, ny - 2, x1, ny - 2);
  return { sh, layout };
}

// ---------------- 02 料带生成 ----------------
export function sheetStrip({ meta, sm, flat, strip, params }) {
  const { pitch, N, C, stripWidth, g, W } = strip;
  const xA = -pitch, xB = N * pitch;
  const cw = xB - xA;
  const s = SCALES.find(k => cw * k <= 340 && stripWidth * k + 75 <= 200) || 1;
  const { sh, layout } = frame('A3', meta, fmtScale(s), '料带排样图', 'ST02');
  sh.text('HEAD', 30, 22, '第二步：料带生成', 6);
  const ox = 210 - ((xA + xB) / 2) * s, oy = 40 + (stripWidth - C) * s + 18;
  const P = placer(ox, oy, s);
  // 料带外形
  rectC(sh, 'PART', P, xA, -C, xB, stripWidth - C);
  // 中心线（导正孔）
  { const a = P(xA - 4, -C / 2), b = P(xB + 4, -C / 2); sh.line('CENTER', a[0], a[1], b[0], b[1]); }
  const partLoop = (xc) => flat.outer.map(p => [xc - W / 2 + p[0], g + p[1]]);
  const holeLoops = (xc) => flat.inner.map(l => l.map(p => [xc - W / 2 + p[0], g + p[1]]));
  const stIndex = (key) => strip.stations.findIndex(st => st.key === key);
  const iTrim2 = stIndex('trim2'), iCut = stIndex('cut'), iPierce = stIndex('pierce'), iTrim1 = stIndex('trim1');
  strip.stations.forEach((st) => {
    const xc = st.x;
    // 导正孔：每个工位都有
    circle(sh, 'PART', P, xc, -C / 2, params.pilotD / 2, s);
    if (st.i >= iCut) return;
    const cut = st.i >= iTrim2;
    // 零件轮廓（未冲切前虚线）
    drawLoop(sh, cut ? 'PART' : 'PHANTOM', partLoop(xc), P);
    if (iPierce < 0 || st.i >= iPierce) for (const l of holeLoops(xc)) drawLoop(sh, 'PART', l, P);
    // 连接颈
    if (st.i >= iTrim1) { const nx0 = xc - strip.neckW / 2, nx1 = xc + strip.neckW / 2; const a = P(nx0, 0), b = P(nx0, g), c = P(nx1, 0), d = P(nx1, g); sh.line('PART', a[0], a[1], b[0], b[1]); sh.line('PART', c[0], c[1], d[0], d[1]); }
    // 折弯线
    for (const [bi, b] of flat.bendLines.entries()) {
      if (st.bend != null || st.i > iTrim2) {
        const a = P(xc - W / 2 - 1, g + b), e = P(xc + W / 2 + 1, g + b);
        sh.line(sm.bends[bi] && strip.stations.some(x => x.bend === bi && x.i <= st.i) ? 'P1' : 'BEND', a[0], a[1], e[0], e[1]);
      }
    }
  });
  // 冲头着色（在该工位）
  strip.punches.forEach((pu, k) => {
    const color = PUNCH_COLORS[k % PUNCH_COLORS.length];
    if (pu.kind === 'circle') { const [x, y] = P(pu.cx, pu.cy); sh.fill([[...Array(24)].map((_, i) => [x + Math.cos(i / 24 * 2 * Math.PI) * pu.r * s, y + Math.sin(i / 24 * 2 * Math.PI) * pu.r * s])], color, 0.55); }
    else if (pu.kind === 'poly') sh.fill([pu.pts.map(p => P(p[0], p[1]))], color, 0.55);
    else if (pu.kind === 'rect') { const a = P(pu.x0, pu.y0), b = P(pu.x1, pu.y1); sh.fill([[[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]], color, 0.55); }
    else if (pu.kind === 'scrap') {
      const st = strip.stations[pu.station];
      const box = [[pu.x0, 0], [pu.x1, 0], [pu.x1, stripWidth - C], [pu.x0, stripWidth - C]].map(p => P(p[0], p[1]));
      const part = partLoop(st.x).map(p => P(p[0], p[1]));
      const neck = [[st.x - strip.neckW / 2, 0], [st.x + strip.neckW / 2, 0], [st.x + strip.neckW / 2, g], [st.x - strip.neckW / 2, g]].map(p => P(p[0], p[1]));
      const a = P(0, pu.y0), b = P(0, pu.y1);
      sh.fill([box, part, neck], color, 0.4, [box[0][0], b[1], box[1][0], a[1]]);
    }
  });
  // 工位编号与名称
  strip.stations.forEach((st) => {
    const [x, yTop] = P(st.x, stripWidth - C);
    sh.circle('THIN', x, yTop - 12, 3.2);
    sh.text('TEXT', x, yTop - 10.8, String(st.i + 1), 3.2, 'middle');
    sh.text('LABEL', x, yTop - 4, st.name, Math.min(2.6, pitch * s / 6), 'middle');
  });
  // 截面示意（每个工位下方）
  const yIcon = P(0, -C)[1] + 20;
  strip.stations.forEach((st) => {
    const nb = strip.stations.filter(x => x.bend != null && x.i <= st.i).length;
    if (st.i >= iCut) return;
    const prof = profileAfter(sm, flat, nb, params.K);
    const poly = thickPoly(prof, sm.t);
    let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity;
    for (const p of poly) { mx0 = Math.min(mx0, p[0]); mx1 = Math.max(mx1, p[0]); my0 = Math.min(my0, p[1]); my1 = Math.max(my1, p[1]); }
    const k = Math.min(10 / ((mx1 - mx0) || 1), 22 / ((my1 - my0) || 1), s);
    const [x] = P(st.x, 0);
    sh.poly(nb ? 'P1' : 'PART', poly.map(p => [x + (p[0] - (mx0 + mx1) / 2) * k, yIcon + 22 - (p[1] - my0) * k]), true);
  });
  sh.text('LABEL', P(xA, 0)[0] - 2, yIcon + 12, '截面', 2.6, 'end');
  // 尺寸：步距、料宽、载体
  { const a = P(strip.stations[0].x, stripWidth - C), b = P(strip.stations[1].x, stripWidth - C); dimH(sh, a[0], b[0], a[1] - 16, a[1] - 18, f2(pitch)); }
  { const a = P(xA, -C), b = P(xA, stripWidth - C); dimV(sh, b[1], a[1], a[0], a[0] - 8, f2(stripWidth)); }
  { const a = P(xB, -C), b = P(xB, 0); dimV(sh, b[1], a[1], a[0], a[0] + 7, f2(C)); }
  // 参数块（参考客户图档格式）
  const info = [
    `MATL. WIDTH     : ${stripWidth.toFixed(2)} mm  +0.0/-0.13`,
    `MATL. THICKNESS : ${sm.t.toFixed(2)} mm  +0.005/-0.01`,
    `PART PITCH      : ${pitch.toFixed(2)} mm`,
    `STATIONS        : ${N}`,
    `STRIP LENGTH    : ${(N * pitch).toFixed(1)} mm`,
    `UTILIZATION RATE: ${(strip.utilization * 100).toFixed(1)}%`,
  ];
  const iy = yIcon + 34;
  sh.text('TITLE', 32, iy, '料带参数', 3.2);
  info.forEach((l, i) => sh.text('TEXT', 32, iy + 6 + i * 4.6, l, 2.8));
  // 送料方向
  { const [ax, ay] = P(xA, stripWidth - C); sh.line('DIM', ax, ay - 22, ax + 24, ay - 22); sh.arrow('DIM', ax + 24, ay - 22, 1, 0); sh.text('DIMTXT', ax, ay - 24, '送料方向', 2.8); }
  return { sh, layout };
}

// ---------------- 03 零件与模板外形 ----------------
export function sheetOutline({ meta, strip, die, flat }) {
  const s = fitScale(die.BL, die.BW, 300, 190);
  const { sh, layout } = frame('A3', meta, fmtScale(s), '零件与模板外形', 'ST03');
  sh.text('HEAD', 30, 22, '第三步：零件与模板外形生成', 6);
  const ox = 190 - (die.BL * s) / 2, oy = 125 + (die.BW * s) / 2;
  const P = placer(ox, oy, s);
  rectC(sh, 'PART', P, 0, 0, die.BL, die.BW);
  const offX = (die.BL - die.PL) / 2, offY = (die.BW - die.PW) / 2;
  rectC(sh, 'P2', P, offX, offY, offX + die.PL, offY + die.PW);
  const sp = (x, y) => { const q = die.toPlate(x, y, true); return P(q[0], q[1]); };
  // 料带
  const a = sp(die.sx0 - 20, strip.yMin), b = sp(die.sx1 + 20, strip.yMax);
  sh.rect('P1', a[0], a[1], b[0], b[1]);
  const W = strip.W;
  const iCut = strip.stations.findIndex(x => x.key === 'cut');
  for (const st of strip.stations) {
    if (st.i >= iCut) continue;
    sh.poly('PART', flat.outer.map(p => sp(st.x - W / 2 + p[0], strip.g + p[1])), true);
    for (const l of flat.inner) sh.poly('PART', l.map(p => sp(st.x - W / 2 + p[0], strip.g + p[1])), true);
  }
  for (const st of strip.stations) { const q = sp(st.x, strip.yMin + strip.C / 2); sh.circle('PART', q[0], q[1], Math.max(0.3, (strip.params?.pilotD || 2) / 2 * s)); }
  // 外导柱与内导柱
  for (const h of die.plates.find(p => p.code === 'LP').holes.filter(h => h.code === 'A2')) { const q = P(h.x, h.y); sh.circle('PART', q[0], q[1], (h.d / 2) * s); crossMark(sh, P, h.x, h.y, h.d * s * 0.7); }
  for (const h of die.plates.find(p => p.code === 'DIE').holes.filter(h => h.code === 'B')) { const q = P(h.x + offX, h.y + offY); sh.circle('PART', q[0], q[1], (h.d / 2) * s); }
  const A = P(0, 0), B = P(die.BL, die.BW);
  dimH(sh, A[0], B[0], A[1], A[1] + 9, f2(die.BL));
  dimV(sh, B[1], A[1], A[0], A[0] - 9, f2(die.BW));
  const A2 = P(offX, offY), B2 = P(offX + die.PL, offY + die.PW);
  dimH(sh, A2[0], B2[0], B2[1], B2[1] + 8, f2(die.PL));
  dimV(sh, B2[1], A2[1], B2[0], B2[0] + 8, f2(die.PW));
  const legend = [['P2', '模板外形 ' + die.PL + '×' + die.PW], ['P1', '料带 宽 ' + f2(strip.stripWidth) + '，步距 ' + f2(strip.pitch)], ['PART', '模座 ' + die.BL + '×' + die.BW]];
  legend.forEach(([l, t], i) => { sh.line(l, 32, 200 + i * 6, 42, 200 + i * 6); sh.text('TEXT', 45, 201 + i * 6, t, 2.8); });
  return { sh, layout };
}

// ---------------- 04 模具总装图 ----------------
export function sheetAssembly({ meta, strip, die }) {
  const H = die.plates.reduce((s, p) => s + p.T, 0) + 8;
  const s = fitScale(die.BL, H, 250, 190);
  const { sh, layout } = frame('A3', meta, fmtScale(s), '模具总装图', 'ST04');
  sh.text('HEAD', 30, 22, '第四步：模具总装图', 6);
  const ox = 165 - (die.BL * s) / 2, oy = 220;
  const P = placer(ox, oy, s);
  // 自下而上：LP, LB, DIE, (料带), PS, PPS, PH, UB, UP
  const order = ['LP', 'LB', 'DIE', 'PS', 'PPS', 'PH', 'UB', 'UP'];
  let z = 0;
  const pos = {};
  const bubbles = [];
  for (const code of order) {
    const p = die.plates.find(x => x.code === code);
    if (code === 'PS') z += strip.t + 1; // 料带 + 间隙（闭合状态示意）
    const x0 = (die.BL - p.L) / 2;
    rectC(sh, 'PART', P, x0, z, x0 + p.L, z + p.T);
    pos[code] = { z, T: p.T, x0, x1: x0 + p.L };
    const bom = die.bom.find(b => b.code === code);
    bubbles.push({ y: z + p.T / 2, x: x0 + p.L, no: bom?.no, label: `${p.name} ${code}` });
    z += p.T;
  }
  // 料带
  const zs = pos.DIE.z + pos.DIE.T;
  { const a = P((die.BL - die.stripLen) / 2, zs), b = P((die.BL + die.stripLen) / 2, zs + strip.t); sh.fill([[[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]], '#111', 0.8); }
  // 冲头：夹板底 → 下模板
  const stX = (x) => die.toPlate(x, 0, true)[0];
  strip.punches.forEach((pu, k) => {
    const cx = pu.kind === 'circle' ? pu.cx : pu.kind === 'poly' ? (pu.pts.reduce((s2, p) => s2 + p[0], 0) / pu.pts.length) : (pu.x0 + pu.x1) / 2;
    const w = Math.max(2, pu.kind === 'circle' ? pu.r * 2 : pu.kind === 'poly' ? 3 : Math.min(pu.x1 - pu.x0, 10));
    const x = stX(cx);
    const a = P(x - w / 2, zs + 0.2), b = P(x + w / 2, pos.PH.z + pos.PH.T);
    sh.rect(k % 2 ? 'P2' : 'P1', a[0], b[1], b[0], a[1]);
  });
  // 外导柱
  for (const xg of [35, die.BL - 35]) {
    const a = P(xg - 16, pos.LP.z), b = P(xg + 16, pos.UP.z + pos.UP.T - 6);
    sh.rect('HIDDEN', a[0], b[1], b[0], a[1]);
    const c1 = P(xg, pos.LP.z - 4), c2 = P(xg, pos.UP.z + pos.UP.T + 4);
    sh.line('CENTER', c1[0], c1[1], c2[0], c2[1]);
  }
  // 泡泡图编号
  bubbles.forEach((b, i) => {
    const [x, y] = P(b.x, b.y);
    const bx = ox + die.BL * s + 18, by = y;
    sh.line('THIN', x, y, bx - 4, by);
    sh.circle('THIN', bx, by, 4);
    sh.text('TEXT', bx, by + 1.3, String(b.no ?? i + 1), 3.4, 'middle');
    sh.text('LABEL', bx + 6, by + 1.2, b.label, 2.6);
  });
  // 闭合高度
  const A = P(0, 0), B = P(0, z);
  dimV(sh, B[1], A[1], A[0], A[0] - 10, `闭合高度 ${f2(die.shutHeight)}`);
  // 叠层表
  const tx = 330, ty = 40;
  sh.text('TITLE', tx, ty, '模板叠层', 3.4);
  ['代号', '名称', '厚度', '材料'].forEach((h, i) => sh.text('LABEL', tx + [0, 14, 34, 46][i], ty + 7, h, 2.6));
  [...order].reverse().forEach((code, i) => {
    const p = die.plates.find(x => x.code === code);
    const yy = ty + 13 + i * 5.2;
    sh.text('TEXT', tx, yy, code, 2.8); sh.text('TEXT', tx + 14, yy, p.name, 2.8); sh.text('TEXT', tx + 34, yy, String(p.T), 2.8); sh.text('TEXT', tx + 46, yy, p.mat, 2.8);
  });
  sh.text('LABEL', tx, ty + 13 + order.length * 5.2 + 3, `冲裁间隙 单边 ${die.clearance}（5% t）`, 2.6);
  return { sh, layout };
}

// ---------------- 05 模板拆分与标注 ----------------
export function sheetPlate({ meta, die, plate }) {
  const s = fitScale(plate.L, plate.W, 250, 175);
  const { sh, layout } = frame('A3', { ...meta, material: plate.mat }, fmtScale(s), `${plate.name}（${plate.code}）`, 'P-' + plate.code);
  sh.text('HEAD', 30, 22, `第五步：模板拆分与标注尺寸 —— ${plate.name} / ${plate.code}`, 5);
  const ox = 45, oy = 50 + plate.W * s;
  const P = placer(ox, oy, s);
  rectC(sh, 'PART', P, 0, 0, plate.L, plate.W);
  // 孔
  const xs = new Set(), ys = new Set();
  for (const h of plate.holes) {
    const [x, y] = P(h.x, h.y);
    if (h.kind === 'circle') { sh.circle('HOLE', x, y, Math.max(0.35, (h.d / 2) * s)); if (h.d * s > 2.5) crossMark(sh, P, h.x, h.y, (h.d / 2) * s + 1.2); }
    else sh.rect('HOLE', x - (h.w * s) / 2, y - (h.h * s) / 2, x + (h.w * s) / 2, y + (h.h * s) / 2);
    const off = (h.kind === 'circle' ? (h.d / 2) * s : (h.w / 2) * s) + 0.8;
    sh.text('CODE', x + off, y - off * 0.6, h.code, 2.2, 'start', 0, { fill: '#c62828' });
    xs.add(Math.round(h.x * 100) / 100); ys.add(Math.round(h.y * 100) / 100);
  }
  // 坐标尺寸（基准：左下角）
  const ordX = [...xs].sort((a, b) => a - b), ordY = [...ys].sort((a, b) => a - b);
  const [bx, by] = P(0, 0);
  const topY = P(0, plate.W)[1];
  sh.text('DIMTXT', bx - 1, by + 4.5, '0', 2.4, 'middle');
  // 坐标值在图纸上至少相隔 3mm，避免标注重叠
  const spaced = (arr) => { const out = []; for (const v of arr) if (!out.length || (v - out[out.length - 1]) * s >= 3) out.push(v); return out; };
  for (const v of spaced(ordX)) { const [x] = P(v, 0); sh.line('DIM', x, topY - 2, x, topY - 8); sh.text('DIMTXT', x + 0.8, topY - 9, f2(v), 2.2, 'start', -90); }
  for (const v of spaced(ordY)) { const [, y] = P(0, v); sh.line('DIM', bx - 2, y, bx - 8, y); sh.text('DIMTXT', bx - 9, y + 0.8, f2(v), 2.2, 'end'); }
  const A = P(0, 0), B = P(plate.L, plate.W);
  dimH(sh, A[0], B[0], A[1], A[1] + 9, f2(plate.L));
  dimV(sh, B[1], A[1], B[0], B[0] + 9, f2(plate.W));
  // 侧视（板厚）
  const sx = B[0] + 18;
  sh.rect('PART', sx, B[1], sx + plate.T * s, A[1]);
  dimH(sh, sx, sx + plate.T * s, A[1], A[1] + 9, f2(plate.T));
  // 加工说明
  const nx = Math.max(300, sx + plate.T * s + 12), ny = 40;
  const wrap = Math.max(20, Math.floor((408 - nx) / 2.3));
  sh.text('TITLE', nx, ny, `加工说明（${plate.name}/${plate.code}）：`, 3);
  let yy = ny + 6;
  for (const n of plate.notes) {
    if (yy > 225) { sh.text('LABEL', nx, yy, '……（其余见 DXF）', 2.4); break; }
    const line = `${n.code}: ${n.n}-${n.note}`;
    const chunks = line.match(new RegExp(`.{1,${wrap}}`, 'g'));
    chunks.forEach((c, i) => { sh.text('TEXT', nx + (i ? 4 : 0), yy, c, 2.4); yy += 3.6; });
  }
  sh.text('TEXT', nx, yy + 2, '（备注：全周倒 C2）', 2.4);
  sh.text('LABEL', nx, yy + 8, `材料 ${plate.mat}   热处理 ${plate.heat}`, 2.4);
  return { sh, layout };
}

// ---------------- 06 标准件与加工零件清单 ----------------
export function sheetBOM({ meta, die }) {
  const { sh, layout } = frame('A3', meta, '—', '零件清单', 'ST06');
  sh.text('HEAD', 30, 22, '第六步：标准件与加工零件清单', 6);
  const cols = [['序号', 12], ['类别', 16], ['代号', 14], ['名称', 40], ['规格', 46], ['材料', 26], ['数量', 14], ['热处理/备注', 28]];
  const x0 = 30, y0 = 30, rh = 6;
  const tw = cols.reduce((s, c) => s + c[1], 0);
  const rows = die.bom;
  const maxRows = Math.min(rows.length, 30);
  const y1 = y0 + (maxRows + 1) * rh;
  sh.rect('FRAME', x0, y0, x0 + tw, y1);
  let x = x0;
  cols.forEach(([h, w], i) => { if (i) sh.line('THIN', x, y0, x, y1); sh.text('TITLE', x + w / 2, y0 + 4.3, h, 3, 'middle'); x += w; });
  rows.slice(0, maxRows).forEach((r, i) => {
    const yy = y0 + (i + 1) * rh;
    sh.line('THIN', x0, yy, x0 + tw, yy);
    const cells = [r.no, r.type, r.code, r.name, r.spec, r.mat, r.qty, r.heat];
    let cx = x0;
    cells.forEach((c, j) => { sh.text('TEXT', cx + cols[j][1] / 2, yy + 4.3, String(c), 2.7, 'middle'); cx += cols[j][1]; });
  });
  const nStd = rows.filter(r => r.type === '标准件').reduce((s, r) => s + r.qty, 0);
  const nMach = rows.filter(r => r.type === '加工件').reduce((s, r) => s + r.qty, 0);
  sh.text('TEXT', x0, y1 + 7, `合计：加工件 ${nMach} 件，标准件 ${nStd} 件；闭合高度 ${f2(die.shutHeight)} mm`, 3);
  sh.text('LABEL', x0, y1 + 12, '说明：模板尺寸、孔位与标准件按经验规则自动生成，供方案评审，正式出图前需设计确认。', 2.6);
  return { sh, layout };
}
