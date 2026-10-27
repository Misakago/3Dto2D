// 冲模设计（规则生成）：料带排样 → 工位与冲头 → 模板外形 / 孔位 → 标准件与加工零件清单
// 坐标：料带送料方向为 X，料宽方向为 Y（载体在 Y 负侧）；零件展开图 x=宽（沿送料），y=长（沿料宽）

export const DEFAULT_PARAMS = {
  K: 0.4,          // 中性层系数
  rAdjust: 1.2,    // 尺寸调整：折弯内 R
  web: 2.0,        // 零件间搭边（最小）
  carrier: 5.0,    // 载体宽
  neckGap: 1.5,    // 零件与载体间距（连接颈长度）
  pilotD: 2.0,     // 导正孔径
  overlap: 0.05,   // 接刀搭接量
};

const ceilTo = (v, step) => Math.ceil(v / step - 1e-9) * step;
const r2 = (v) => Math.round(v * 100) / 100;

function polyArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a / 2);
}
function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}
// 圆度判断：内孔是否为圆
function asCircle(pts) {
  const b = bbox(pts);
  const r = (b.w + b.h) / 4;
  if (Math.abs(b.w - b.h) > 0.02 * r + 0.01) return null;
  let err = 0;
  for (const p of pts) err = Math.max(err, Math.abs(Math.hypot(p[0] - b.cx, p[1] - b.cy) - r));
  return err < 0.03 * r + 0.01 ? { cx: b.cx, cy: b.cy, r } : null;
}

/** 由钣金分析结果生成展开图（含尺寸调整后的长度缩放） */
export function flatPattern(sm, params) {
  const L0 = sm.length;                       // 当前 K 下的展开长度
  const L1 = sm.lengthFor(params.K, params.rAdjust); // 调整 R 后
  const Lk = sm.lengthFor(params.K);
  const sy = L1 / L0;
  const tf = (pts) => pts.map(p => [p[0], p[1] * sy]);
  const outer = tf(sm.outer);
  const inner = sm.inner.map(tf);
  const bendLines = sm.bendLines.map(s => s * sy);
  return {
    outer, inner, bendLines,
    width: sm.flatSize[0],
    length: L1,
    lengthK: Lk,
    lengthMid: sm.midLen,
    area: polyArea(outer) - inner.reduce((s, l) => s + polyArea(l), 0),
    holes: inner.map(l => ({ pts: l, circle: asCircle(l), box: bbox(l) })),
  };
}

/** 料带排样与工位 */
export function planStrip(sm, flat, params) {
  const t = sm.t;
  const W = flat.width, L = flat.length;
  const pitch = ceilTo(W + Math.max(params.web, 1.5 * t), 1);
  const C = Math.max(params.carrier, 2.5 * params.pilotD);
  const g = params.neckGap;
  const stripWidth = ceilTo(C + g + L + Math.max(t, 0.8), 0.5);
  const neckW = Math.min(4, Math.max(2, W * 0.25));
  // 工位：导正孔 → 冲孔 → 外形接刀① → 外形接刀② → 空步 → 折弯×n → 切断
  const stations = [];
  stations.push({ key: 'pilot', name: '冲导正孔', punch: true });
  if (flat.holes.length) stations.push({ key: 'pierce', name: '冲孔', punch: true });
  stations.push({ key: 'trim1', name: '冲外形 接刀①', punch: true });
  stations.push({ key: 'trim2', name: '冲外形 接刀②', punch: true });
  stations.push({ key: 'idle', name: '空步', punch: false });
  sm.bends.forEach((b, i) => stations.push({ key: 'bend' + i, name: `折弯${'①②③④⑤⑥'[i] || i + 1}`, punch: false, bend: i }));
  stations.push({ key: 'cut', name: '切断', punch: true });
  stations.forEach((s, i) => { s.i = i; s.x = i * pitch; });
  const N = stations.length;
  // 料带上的零件放置：零件 x ∈ [xc - W/2, xc + W/2]，y ∈ [g, g + L]；载体 y ∈ [-C, 0]
  const yPart0 = g;
  const split = yPart0 + L * 0.5; // 接刀分界
  const ov = params.overlap;
  const punches = [];
  stations.forEach((st) => {
    const xc = st.x;
    if (st.key === 'pilot') punches.push({ station: st.i, code: 'pilot', name: `导正孔冲头 Ø${params.pilotD}`, kind: 'circle', cx: xc, cy: -C / 2, r: params.pilotD / 2 });
    if (st.key === 'pierce') flat.holes.forEach((h, k) => {
      const c = h.circle;
      if (c) punches.push({ station: st.i, code: 'pierce' + k, name: `冲孔冲头 Ø${r2(c.r * 2)}`, kind: 'circle', cx: xc - W / 2 + c.cx, cy: yPart0 + c.cy, r: c.r });
      else punches.push({ station: st.i, code: 'pierce' + k, name: '异形冲孔冲头', kind: 'poly', pts: h.pts.map(p => [xc - W / 2 + p[0], yPart0 + p[1]]) });
    });
    if (st.key === 'trim1') punches.push({ station: st.i, code: 'trim1', name: '外形冲头（接刀①）', kind: 'scrap', x0: xc - pitch / 2, x1: xc + pitch / 2, y0: 0, y1: split + ov });
    if (st.key === 'trim2') punches.push({ station: st.i, code: 'trim2', name: '外形冲头（接刀②）', kind: 'scrap', x0: xc - pitch / 2, x1: xc + pitch / 2, y0: split - ov, y1: stripWidth - C });
    if (st.key === 'cut') punches.push({ station: st.i, code: 'cut', name: '切断冲头', kind: 'rect', x0: xc - neckW / 2 - 0.5, x1: xc + neckW / 2 + 0.5, y0: -0.3, y1: g + 0.3 });
  });
  const utilization = flat.area / (pitch * stripWidth);
  return {
    t, W, L, pitch, C, g, neckW, stripWidth, stations, N, punches, utilization, split,
    yPart0, stripLength: N * pitch,
    // 料带 Y 坐标从载体底边算起：y ∈ [-C, stripWidth - C]
    yMin: -C, yMax: stripWidth - C,
  };
}

// ---------------- 模具结构（规则生成） ----------------
const PLATE_DEFS = [
  { code: 'UP', name: '上模座', T: 40, mat: 'S50C', heat: '—', big: true },
  { code: 'UB', name: '上垫板', T: 15, mat: 'Cr12MoV', heat: 'HRC 52~55' },
  { code: 'PH', name: '上夹板', T: 20, mat: 'S50C', heat: '—' },
  { code: 'PPS', name: '止挡板', T: 12, mat: 'Cr12MoV', heat: 'HRC 52~55' },
  { code: 'PS', name: '脱料板', T: 18, mat: 'SKD11', heat: 'HRC 58~60' },
  { code: 'DIE', name: '下模板', T: 25, mat: 'SKD11', heat: 'HRC 58~60' },
  { code: 'LB', name: '下垫板', T: 20, mat: 'Cr12MoV', heat: 'HRC 52~55' },
  { code: 'LP', name: '下模座', T: 50, mat: 'S50C', heat: '—', big: true },
];

function evenly(a, b, n) { if (n <= 1) return [(a + b) / 2]; return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1)); }

export function designDie(strip, params) {
  const { pitch, N, stripWidth, C, t } = strip;
  const stripLen = (N + 1) * pitch;
  const PL = ceilTo(stripLen + 2 * 60, 10);
  const PW = ceilTo(stripWidth + 2 * 70, 10);
  const BL = PL + 120, BW = PW + 20;
  // 料带在模板上的位置：料带中心对模板中心
  const sx0 = -pitch, sx1 = (N) * pitch;
  const toPlate = (x, y, big) => {
    const ox = (big ? BL : PL) / 2 - (sx0 + sx1) / 2;
    const oy = (big ? BW : PW) / 2 - (strip.yMin + strip.yMax) / 2;
    return [x + ox, y + oy];
  };
  const plates = PLATE_DEFS.map(d => ({ ...d, L: d.big ? BL : PL, W: d.big ? BW : PW, holes: [] }));
  const P = Object.fromEntries(plates.map(p => [p.code, p]));
  const add = (codes, hole) => { for (const c of codes) P[c].holes.push({ ...hole }); };
  const addXY = (codes, list, mk) => {
    for (const c of codes) {
      const big = P[c].big;
      for (const [x, y] of list) {
        const off = big ? [(BL - PL) / 2, (BW - PW) / 2] : [0, 0];
        P[c].holes.push({ x: x + off[0], y: y + off[1], ...mk(c, x + off[0], y + off[1]) });
      }
    }
  };

  // 外导柱（模座四角）
  const outer = [[30, 40], [BL - 30, 40], [30, BW - 40], [BL - 30, BW - 40]];
  for (const [x, y] of outer) {
    P.LP.holes.push({ code: 'A2', x, y, d: 32, note: 'Ø32.000(0/-0.005)外导柱孔,割', kind: 'circle' });
    P.UP.holes.push({ code: 'A4', x, y, d: 45, note: 'Ø45.000(+0.02/0)外导套孔,割', kind: 'circle' });
  }
  // 内导柱
  const inner = [[22, 22], [PL - 22, 22], [22, PW - 22], [PL - 22, PW - 22]];
  addXY(['PH', 'PPS', 'PS', 'DIE'], inner, (c, x, y) => ({ code: 'B', x, y, d: 16, kind: 'circle', note: c === 'DIE' ? 'Ø16.000(+0.01/+0.005)内导柱孔,割' : 'Ø16.000(+0.02/+0.01)内导套孔,割' }));
  addXY(['UB', 'LB', 'UP', 'LP'], inner, () => ({ code: 'B', d: 20, kind: 'circle', note: 'Ø20.0内导柱避位,钻穿' }));
  // 合销
  const dowels = [[48, 16], [PL - 48, PW - 16]];
  addXY(['UP', 'UB', 'PH'], dowels, (c) => ({ code: 'C', d: 8, kind: 'circle', note: c === 'PH' ? 'Ø8.000(+0.01/+0.005)合销孔,割' : 'Ø8.000(+0.02/+0.01)合销孔,割' }));
  addXY(['DIE', 'LB', 'LP'], dowels.map(([x, y]) => [x, PW - y]), (c) => ({ code: 'C', d: 8, kind: 'circle', note: c === 'DIE' ? 'Ø8.000(+0.01/+0.005)合销孔,割' : 'Ø8.000(+0.02/+0.01)合销孔,割' }));
  // 螺丝（上组 UP-UB-PH，下组 LP-LB-DIE）
  const nScrew = Math.max(2, Math.ceil(PL / 90));
  const screws = [...evenly(40, PL - 40, nScrew).map(x => [x, 12]), ...evenly(40, PL - 40, nScrew).map(x => [x, PW - 12])];
  addXY(['UP'], screws, () => ({ code: 'E', d: 6.8, kind: 'circle', note: 'M8xP1.25螺纹孔,正攻牙深20.0' }));
  addXY(['UB'], screws, () => ({ code: 'E', d: 9, kind: 'circle', note: 'Ø9.0螺丝过孔,钻穿' }));
  addXY(['PH'], screws, () => ({ code: 'E', d: 9, kind: 'circle', note: 'Ø9.0螺丝过孔,钻穿 Ø14.0背沉深9.0' }));
  addXY(['DIE'], screws, () => ({ code: 'E', d: 6.8, kind: 'circle', note: 'M8xP1.25螺纹孔,攻穿' }));
  addXY(['LB'], screws, () => ({ code: 'E', d: 9, kind: 'circle', note: 'Ø9.0螺丝过孔,钻穿' }));
  addXY(['LP'], screws, () => ({ code: 'E', d: 9, kind: 'circle', note: 'Ø9.0螺丝过孔,钻穿 Ø15.0背沉深9.0' }));
  // 脱料组：等高套筒 + 弹簧
  const yStripC = PW / 2;
  const nSleeve = Math.max(2, Math.ceil(stripLen / 70));
  const sleeves = [...evenly(PL / 2 - stripLen / 2 + 10, PL / 2 + stripLen / 2 - 10, nSleeve).map(x => [x, yStripC - stripWidth / 2 - 26]), ...evenly(PL / 2 - stripLen / 2 + 10, PL / 2 + stripLen / 2 - 10, nSleeve).map(x => [x, yStripC + stripWidth / 2 + 26])];
  addXY(['UP', 'UB', 'PH'], sleeves, (c) => ({ code: 'D', d: c === 'UP' ? 16 : 11, kind: 'circle', note: c === 'UP' ? 'Ø16.0套筒过孔,钻穿' : 'Ø11.0等高套筒过孔,钻穿' }));
  addXY(['PPS'], sleeves, () => ({ code: 'D', d: 9, kind: 'circle', note: 'Ø9.0套筒过孔,钻穿' }));
  addXY(['PS'], sleeves, () => ({ code: 'D', d: 6.8, kind: 'circle', note: 'M8xP1.25螺纹孔,攻穿' }));
  const springs = sleeves.map(([x, y]) => [x + pitch * 0.9, y]);
  addXY(['UB', 'PH'], springs, () => ({ code: 'Q', d: 21, kind: 'circle', note: 'Ø21.0弹簧孔,钻穿' }));
  addXY(['PPS'], springs, () => ({ code: 'Q', d: 12, kind: 'circle', note: 'Ø12.0弹簧顶杆过孔,钻穿' }));
  // 止挡板-脱料板 锁付螺丝
  const nF = Math.max(2, Math.ceil(stripLen / 60));
  const fScrews = [...evenly(PL / 2 - stripLen / 2, PL / 2 + stripLen / 2, nF).map(x => [x, yStripC - stripWidth / 2 - 12]), ...evenly(PL / 2 - stripLen / 2, PL / 2 + stripLen / 2, nF).map(x => [x, yStripC + stripWidth / 2 + 12])];
  addXY(['PPS'], fScrews, () => ({ code: 'F', d: 6.6, kind: 'circle', note: 'Ø6.6螺丝过孔,钻穿 Ø11.0正沉深6.5' }));
  addXY(['PS'], fScrews, () => ({ code: 'F', d: 5, kind: 'circle', note: 'M6xP1.0螺纹孔,攻穿' }));

  // 冲头 / 刃口：按工位
  const clearance = r2(0.05 * t);
  const punchPlates = {
    PH: ['G', '冲头固定孔,单+0.005,割'],
    PPS: ['G', '冲头过孔,单+0.30,铣'],
    PS: ['G', '冲头导向孔,单+0.005,割,正面导入斜度1°'],
    DIE: ['G', `凹模刃口,单+${clearance.toFixed(3)},割,直3斜1°`],
    LB: ['G', '落料孔,单+0.50,铣'],
    LP: ['G', '落料孔,单+1.00,铣,穿'],
  };
  const punchParts = [];
  strip.punches.forEach((pu, k) => {
    punchParts.push({ ...pu, no: k + 1 });
    for (const [pc, [code, note]] of Object.entries(punchPlates)) {
      const big = P[pc].big;
      if (pu.kind === 'circle') {
        const [x, y] = toPlate(pu.cx, pu.cy, big);
        P[pc].holes.push({ code: code + (k + 1), x, y, d: pu.r * 2 + (pc === 'LB' ? 1 : pc === 'LP' ? 2 : pc === 'PPS' ? 0.6 : 0), kind: 'circle', note: `Ø${r2(pu.r * 2)} ${note}`, punch: k });
      } else {
        let x0, y0, x1, y1;
        if (pu.kind === 'poly') { const b = bbox(pu.pts); x0 = b.x0; y0 = b.y0; x1 = b.x1; y1 = b.y1; }
        else { x0 = pu.x0; x1 = pu.x1; y0 = pu.y0; y1 = pu.y1; }
        const grow = pc === 'LB' ? 0.5 : pc === 'LP' ? 1 : pc === 'PPS' ? 0.3 : 0;
        const [px0, py0] = toPlate(x0 - grow, y0 - grow, big);
        const [px1, py1] = toPlate(x1 + grow, y1 + grow, big);
        P[pc].holes.push({ code: code + (k + 1), x: (px0 + px1) / 2, y: (py0 + py1) / 2, w: px1 - px0, h: py1 - py0, kind: 'rect', note: `异形 ${note}`, punch: k });
      }
    }
  });
  // 导正销（脱料板 / 止挡板 / 夹板）
  const pilotSt = strip.stations.filter(s => s.i >= 1 && s.i % 2 === 1).map(s => s.x);
  for (const pc of ['PH', 'PPS', 'PS']) {
    for (const x of pilotSt) {
      const [px, py] = toPlate(x, -C / 2, false);
      P[pc].holes.push({ code: 'P', x: px, y: py, d: pc === 'PS' ? params.pilotD + 0.01 : params.pilotD + 2, kind: 'circle', note: pc === 'PS' ? `Ø${(params.pilotD + 0.01).toFixed(3)}导正销孔,单+0.000,割一修三` : `Ø${(params.pilotD + 2).toFixed(1)}导正销避位,钻穿` });
    }
  }
  // 浮升销（下模板 / 下垫板）
  const lifterX = [];
  for (let x = sx0 + pitch / 2; x < sx1; x += pitch * 2) lifterX.push(x);
  for (const x of lifterX) for (const y of [strip.yMin - 3, strip.yMax + 3]) {
    const [px, py] = toPlate(x, y, false);
    P.DIE.holes.push({ code: 'J', x: px, y: py, d: 6.02, kind: 'circle', note: 'Ø6.020浮升销孔,单+0.000,割' });
    P.LB.holes.push({ code: 'J', x: px, y: py, d: 8.9, kind: 'circle', note: 'Ø8.9浮升销弹簧孔,钻穿' });
  }
  // 误送检测销
  {
    const [px, py] = toPlate(strip.stations[strip.N - 2].x, -C / 2, false);
    P.PS.holes.push({ code: 'S', x: px, y: py, d: 4.02, kind: 'circle', note: 'Ø4.020误送检测销孔,单+0.000,割' });
    P.UB.holes.push({ code: 'S', x: px, y: py, d: 4.5, kind: 'circle', note: 'Ø4.5误送检测销过孔,钻穿' });
  }

  // 加工说明（按代号汇总）
  for (const p of plates) {
    const groups = new Map();
    for (const h of p.holes) {
      const key = h.code + '|' + h.note;
      if (!groups.has(key)) groups.set(key, { code: h.code, note: h.note, n: 0 });
      groups.get(key).n++;
    }
    p.notes = [...groups.values()].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  }

  // 闭合高度
  const shutHeight = plates.reduce((s, p) => s + p.T, 0) - 0 + t;
  const count = (pc, code) => P[pc].holes.filter(h => h.code === code).length;
  const guideLen = ceilTo(shutHeight - 10, 5);
  const bom = [];
  let no = 0;
  for (const p of plates) bom.push({ no: ++no, type: '加工件', code: p.code, name: p.name, spec: `${p.L}×${p.W}×${p.T}`, mat: p.mat, qty: 1, heat: p.heat });
  punchParts.forEach((pu) => bom.push({ no: ++no, type: '加工件', code: 'PU' + pu.no, name: pu.name, spec: pu.kind === 'circle' ? `Ø${r2(pu.r * 2)}×L50` : '异形 L50', mat: 'SKH51', qty: 1, heat: 'HRC 60~62' }));
  bom.push({ no: ++no, type: '加工件', code: 'BK', name: '折弯块', spec: `${ceilTo(strip.W + 4, 1)}×12×L45`, mat: 'SKD11', qty: strip.stations.filter(s => s.bend != null).length, heat: 'HRC 58~60' });
  const std = [
    ['外导柱', `Ø32×L${guideLen + 40}`, 'SUJ2', 4],
    ['滚珠导套', 'Ø32×Ø45×L80', 'SUJ2', 4],
    ['内导柱', `Ø16×L${ceilTo(guideLen * 0.6, 5)}`, 'SUJ2', 4],
    ['内导套', 'Ø16×Ø22×L20', 'SUJ2', 12],
    ['合销', 'Ø8×L40', 'SUJ2', count('UP', 'C') + count('LP', 'C')],
    ['内六角螺丝', 'M8×L50', '12.9 级', count('UP', 'E') + count('LP', 'E')],
    ['内六角螺丝', 'M6×L30', '12.9 级', count('PS', 'F')],
    ['等高套筒', 'Ø11×L60', 'SCM435', count('PH', 'D')],
    ['矩形弹簧（绿）', 'Ø20×L60', 'SWOSC-V', count('PH', 'Q')],
    ['导正销', `Ø${params.pilotD}×L40`, 'SKH51', count('PS', 'P')],
    ['浮升销', 'Ø6×L30', 'SKD11', count('DIE', 'J')],
    ['误送检测销', 'Ø4×L40', 'SKH51', count('PS', 'S')],
  ];
  for (const [name, spec, mat, qty] of std) if (qty) bom.push({ no: ++no, type: '标准件', code: '', name, spec, mat, qty, heat: '外购' });

  return { plates, PL, PW, BL, BW, shutHeight, bom, toPlate, punchParts, clearance, stripLen, sx0, sx1 };
}
