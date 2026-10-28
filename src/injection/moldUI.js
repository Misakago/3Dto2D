// 注塑前处理：① 去除小圆角（OpenCASCADE 去特征）② 模流网格纵横比优化
import { Viewer } from '../viewer.js';
import { weld, aspectStats, parseNastran, parsePatran, toNastran, toSTL } from '../meshopt.js';

const AR_COLORS = [[1.5, '#2e7d32'], [2, '#43a047'], [3, '#9ccc65'], [4, '#fbc02d'], [6, '#fb8c00'], [Infinity, '#d32f2f']];
const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const fmt = (v, d = 2) => Number(v).toLocaleString('zh-CN', { maximumFractionDigits: d, minimumFractionDigits: 0 });
const fmtS = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒` : `${(ms / 1000).toFixed(1)} 秒`);

export function initMold({ state, toast, download, baseName }) {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  let viewer = null;
  const ensureViewer = () => (viewer ||= new Viewer($('#mold-viewer')));
  let tool = 'defillet';
  let view = 'before';
  const df = { wasm: null, worker: null, scan: null, snap: null, result: null, running: false, chainState: new Map(), info: new Map() };
  const ms = { imported: null, result: null, running: false };

  // ---------- 通用 UI ----------
  const progress = (show, text = '', frac = 0) => {
    $('#mold-progress').hidden = !show;
    $('#mold-ptext').textContent = text;
    const bar = $('#mold-pbar');
    bar.indeterminate = frac < 0;
    bar.value = Math.max(0, frac);
  };
  const setView = (v, enableAfter) => {
    view = v;
    $$('#mold-view-chips md-filter-chip').forEach(c => { c.selected = c.dataset.view === v; if (c.dataset.view === 'after' && enableAfter != null) c.disabled = !enableAfter; });
  };
  $('#mold-view-chips').addEventListener('click', (e) => {
    const c = e.target.closest('md-filter-chip');
    if (!c || c.disabled) return;
    setView(c.dataset.view);
    render();
  });
  $$('.mold-tools button').forEach(b => b.addEventListener('click', () => {
    tool = b.dataset.tool;
    $$('.mold-tools button').forEach(x => x.classList.toggle('active', x === b));
    $('#mold-defillet').hidden = tool !== 'defillet';
    $('#mold-mesh').hidden = tool !== 'mesh';
    setView('before', tool === 'defillet' ? !!df.result : !!ms.result);
    render();
  }));

  // ---------- 渲染 ----------
  function modelBodies() {
    const m = state.model;
    if (!m) return [];
    return m.parts.map(p => ({ pos: p.positions, tris: p.index, brepFaces: p.brepFaces }));
  }
  function grayColors(n) { const c = new Float32Array(n * 3); c.fill(0.72); return c; }
  function concat(bodies) {
    let nv = 0, nt = 0;
    for (const b of bodies) { nv += b.pos.length; nt += b.tris.length; }
    const pos = new Float64Array(nv), tris = new Uint32Array(nt);
    let ov = 0, ot = 0;
    for (const b of bodies) { pos.set(b.pos, ov); for (let i = 0; i < b.tris.length; i++) tris[ot + i] = b.tris[i] + ov / 3; ov += b.pos.length; ot += b.tris.length; }
    return { pos, tris };
  }
  function arColors(ar) {
    const c = new Float32Array(ar.length * 3);
    for (let t = 0; t < ar.length; t++) { const col = hex(AR_COLORS.find(([lim]) => ar[t] <= lim)[1]); c.set(col, 3 * t); }
    return c;
  }
  // 按面索引（与 OCCT 遍历顺序一致）提取三角形坐标，用于高亮
  function facesTris(faceIdxSet) {
    const out = [];
    let base = 0;
    for (const p of state.model.parts) {
      p.brepFaces.forEach((bf, i) => {
        if (!faceIdxSet.has(base + i)) return;
        for (let t = bf.first; t <= bf.last; t++) for (let k = 0; k < 3; k++) { const v = p.index[3 * t + k]; out.push(p.positions[3 * v], p.positions[3 * v + 1], p.positions[3 * v + 2]); }
      });
      base += p.brepFaces.length;
    }
    return Float32Array.from(out);
  }

  function legend(items) {
    $('#mold-legend').innerHTML = items.map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join('');
  }

  function render() {
    const has = !!state.model || !!ms.imported;
    $('#mold-empty').hidden = has;
    if (!has) { $('#mold-result').hidden = true; legend([]); return; }
    ensureViewer();
    if (tool === 'defillet') {
      if (!state.model) return;
      if (view === 'after' && df.result) {
        const { pos, idx } = df.result.mesh;
        viewer.showMesh({ pos, tris: idx, colors: grayColors(idx.length / 3), edges: false });
        legend([['#b8b8b8', '去除圆角后的实体']]);
      } else {
        const { pos, tris } = concat(modelBodies());
        let hl = null;
        if (df.scan) {
          // 去除前：全部候选圆角；去除后：仅显示未能去除的圆角
          // 去除后：结果中仍存在的圆角链 = 初始扫描中未标记成功的链
          const okKeys = new Set([...df.chainState].filter(([, st]) => st === 'ok').map(([k]) => k));
          const keepIds = df.result ? new Set(df.scan.chains.filter(c => !okKeys.has(c.key)).map(c => c.id)) : null;
          const want = new Set(df.scan.cands.filter(c => !keepIds || keepIds.has(c.chain)).map(c => c.idx));
          if (want.size) hl = facesTris(want);
        }
        viewer.showMesh({ pos, tris, colors: grayColors(tris.length / 3), edges: false, highlight: hl });
        legend(df.scan ? [['#d32f2f', df.result ? '未能去除的圆角' : `待去除圆角（R ≤ ${df.R}）`]] : []);
      }
      renderDefilletResult();
    } else {
      const src = meshSource();
      if (!src) return;
      if (view === 'after' && ms.result) {
        const all = concat(ms.result.bodies.map(b => ({ pos: b.pos, tris: b.tris })));
        const ar = new Float64Array(all.tris.length / 3);
        let o = 0; for (const b of ms.result.bodies) { ar.set(b.after.ar, o); o += b.after.ar.length; }
        viewer.showMesh({ pos: all.pos, tris: all.tris, colors: arColors(ar), edges: true });
      } else {
        const all = concat(src.map(b => ({ pos: b.pos, tris: b.tris })));
        const s = aspectStats(all.pos, all.tris);
        viewer.showMesh({ pos: all.pos, tris: all.tris, colors: arColors(s.ar), edges: true });
      }
      legend(AR_COLORS.map(([lim, c], i) => [c, i === AR_COLORS.length - 1 ? `> ${AR_COLORS[i - 1][0]}` : `≤ ${lim}`]));
      renderMeshResult();
    }
    updateExport();
  }

  // ---------- ① 去除小圆角 ----------
  const R = () => parseFloat($('#df-r').value) || 0.3;
  function newWorker() {
    df.worker?.terminate();
    df.worker = new Worker(new URL('./occWorker.js', import.meta.url), { type: 'module' });
  }
  function call(msg, until, timeout = 0, transfer = []) {
    return new Promise((resolve, reject) => {
      const w = df.worker;
      const timer = timeout ? setTimeout(() => { w.removeEventListener('message', on); w.terminate(); resolve({ type: 'timeout' }); }, timeout) : null;
      const on = (e) => {
        const m = e.data;
        if (m.type === 'wasm') { df.wasm = m.bytes; return; }
        if (m.type === 'progress') { progress(true, m.stage, m.frac); return; }
        if (m.type === 'error') { clearTimeout(timer); w.removeEventListener('message', on); reject(new Error(m.message)); return; }
        if (until.includes(m.type)) { clearTimeout(timer); w.removeEventListener('message', on); resolve(m); }
      };
      w.addEventListener('message', on);
      w.postMessage(msg, transfer);
    });
  }
  const stepBytes = () => new Uint8Array(state.model.buffer.slice(0));
  const isStep = () => ['step', 'stp'].includes(state.model?.format);

  $('#df-scan').addEventListener('click', async () => {
    if (!state.model) return toast('请先加载 STEP 模型');
    if (!isStep()) return toast('去除圆角需要 STEP 实体模型');
    if (df.running) return;
    df.running = true;
    df.R = R();
    df.result = null; df.snap = null; df.chainState = new Map(); df.info = new Map();
    setView('before', false);
    try {
      newWorker();
      progress(true, '准备几何内核', -1);
      const t0 = performance.now();
      df.scan = await call({ type: 'open', step: stepBytes(), R: df.R, wasm: df.wasm }, ['scanned']);
      df.scan.ms = performance.now() - t0;
      for (const c of df.scan.chains) df.chainState.set(c.key, 'pending');
      $('#df-run').disabled = !df.scan.cands.length;
      toast(`识别到 ${df.scan.cands.length} 个圆角面（${df.scan.chains.length} 组），可执行去除`);
    } catch (err) { toast('识别失败：' + err.message, 5000); }
    df.running = false;
    progress(false);
    render();
  });

  $('#df-run').addEventListener('click', async () => {
    if (!df.scan || df.running) return;
    df.running = true;
    $('#df-run').disabled = true; $('#df-scan').disabled = true;
    const BUDGET = 20000;
    const total = df.scan.chains.length;
    const skip = [];           // 已尝试（成功的会从形状中消失，失败 / 超时的加入跳过列表）
    let attempting = null, okN = 0;
    const t0 = performance.now();
    try {
      for (let guard = 0; guard < total * 3; guard++) {
        const doneN = okN + skip.length;
        progress(true, `去除圆角 第 ${doneN + 1}/${total} 组 · 成功 ${okN} · 已用 ${fmtS(performance.now() - t0)}`, doneN / total);
        const w = df.worker;
        const onAttempt = (e) => { if (e.data.type === 'attempt') attempting = e.data; };
        w.addEventListener('message', onAttempt);
        const r = await call({ type: 'step', R: df.R, skip }, ['stepDone'], BUDGET);
        w.removeEventListener('message', onAttempt);
        if (r.type === 'timeout') {
          if (attempting) { skip.push(attempting.key); df.chainState.set(attempting.key, 'timeout'); df.info.set(attempting.key, { n: attempting.n, nb: attempting.nb, st: 'timeout' }); }
          newWorker();
          if (df.snap) await call({ type: 'restore', brep: df.snap, wasm: df.wasm, srcFaceCount: df.scan.total }, ['restored']);
          else await call({ type: 'open', step: stepBytes(), R: df.R, wasm: df.wasm }, ['scanned']);
          continue;
        }
        if (r.done) break;
        df.info.set(r.key, { n: r.n, nb: r.nb, st: r.ok ? 'ok' : 'fail', ms: r.ms });
        if (r.ok) { okN++; df.snap = r.snap; df.chainState.set(r.key, 'ok'); }
        else { skip.push(r.key); df.chainState.set(r.key, 'fail'); }
        attempting = null;
      }
      progress(true, '校验实体、三角化并写出 STEP', -1);
      const fin = await call({ type: 'finish', R: df.R }, ['finished']);
      df.result = { ...fin, ms: performance.now() - t0 };
      setView('after', true);
      toast('圆角去除完成');
    } catch (err) { toast('去除失败：' + err.message, 5000); }
    df.running = false;
    $('#df-run').disabled = false; $('#df-scan').disabled = false;
    progress(false);
    render();
  });

  // 未去除原因：按相邻面类别归类
  function reasonsHtml() {
    const groups = { bigFillet: { t: '与更大的圆角（R > 阈值）相接，需同时修改大圆角', n: 0, f: 0 }, freeform: { t: '相邻为自由曲面，无法延伸求交', n: 0, f: 0 }, timeout: { t: '计算超时（> 20 秒）', n: 0, f: 0 }, other: { t: '相邻面延伸后无法闭合', n: 0, f: 0 } };
    for (const it of df.info.values()) {
      if (it.st === 'ok') continue;
      const g = it.st === 'timeout' ? 'timeout' : it.nb?.bigFillet ? 'bigFillet' : it.nb?.freeform ? 'freeform' : 'other';
      groups[g].n++; groups[g].f += it.n;
    }
    const rows = Object.values(groups).filter(g => g.n).map(g => `<tr><td>${g.t}</td><td class="r">${g.n}</td><td class="r">${g.f}</td></tr>`).join('');
    return `<h4 style="margin-top:10px">未去除原因</h4><table class="tbl"><tr><th>原因</th><th class="r">链</th><th class="r">面</th></tr>${rows}</table>
      <p class="dim" style="margin:8px 0 0;line-height:1.6">“原始”视图中红色为未去除的圆角，需在 CAD 中人工处理或放宽条件。</p>`;
  }

  function renderDefilletResult() {
    const box = $('#mold-result');
    if (!df.scan) { box.hidden = true; $('#mold-status').innerHTML = ''; return; }
    box.hidden = false;
    const s = df.scan;
    const byR = new Map();
    for (const c of s.cands) { const k = `${c.kind} R${(+c.r.toFixed(2))}`; byR.set(k, (byR.get(k) || 0) + 1); }
    const states = [...df.chainState.values()];
    const cnt = (k) => states.filter(x => x === k).length;
    const facesOf = () => (df.result ? s.cands.length - df.result.remaining : 0);
    const r = df.result;
    box.innerHTML = `<h4>去除小圆角（R ≤ ${df.R} mm）</h4>
      <div class="big">
        <div><b>${s.cands.length}</b><span>识别圆角面</span></div>
        <div><b>${s.chains.length}</b><span>圆角链（连续圆角）</span></div>
        ${r ? `<div><b class="ok">${facesOf()}</b><span>已去除面</span></div><div><b class="${r.remaining ? 'bad' : 'ok'}">${r.remaining}</b><span>剩余 R ≤ ${df.R}</span></div>` : ''}
      </div>
      ${r ? `<dl class="kv">
        <dt>面数</dt><dd>${r.facesBefore} → ${r.facesAfter}</dd>
        <dt>成功 / 失败 / 超时（链）</dt><dd>${cnt('ok')} / ${cnt('fail')} / ${cnt('timeout')}</dd>
        <dt>实体有效性</dt><dd class="${r.valid ? 'ok' : 'bad'}">${r.valid ? '有效（BRepCheck 通过）' : '需修复'}</dd>
        <dt>耗时</dt><dd>${fmtS(r.ms)}</dd></dl>` : ''}
      <h4 style="margin-top:10px">圆角半径分布</h4>
      <div class="chips-wrap">${[...byR.entries()].sort().map(([k, v]) => `<span class="mini-chip">${k} × ${v}</span>`).join('')}</div>
      ${r && (cnt('fail') + cnt('timeout')) ? reasonsHtml() : ''}`;
    $('#mold-status').innerHTML = r
      ? `<span>面数 <b>${r.facesBefore} → ${r.facesAfter}</b></span><span>去除 <b>${facesOf()}</b> 面</span><span>剩余 R≤${df.R} <b>${r.remaining}</b></span><span>耗时 <b>${fmtS(r.ms)}</b></span>`
      : `<span>识别圆角面 <b>${s.cands.length}</b></span><span>圆角链 <b>${s.chains.length}</b></span><span>识别耗时 <b>${fmtS(s.ms)}</b></span>`;
  }

  // ---------- ② 网格纵横比优化 ----------
  function meshSource() {
    if (ms.imported) return ms.imported.bodies;
    const m = state.model;
    if (!m) return null;
    return (ms.fromModel ||= m.parts.map(p => { const w = weld(p.positions, p.index, 1e-5); return { pos: w.pos, tris: w.tris, welded: true }; }));
  }
  function defaultParams() {
    const src = meshSource();
    if (!src) return;
    let area = 0;
    for (const b of src) for (let t = 0; t < b.tris.length; t += 3) {
      const a = b.tris[t] * 3, c = b.tris[t + 1] * 3, d = b.tris[t + 2] * 3, P = b.pos;
      const ux = P[c] - P[a], uy = P[c + 1] - P[a + 1], uz = P[c + 2] - P[a + 2], vx = P[d] - P[a], vy = P[d + 1] - P[a + 1], vz = P[d + 2] - P[a + 2];
      area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    const L = Math.max(0.05, Math.sqrt(area / (0.433 * 80000)));
    $('#ms-len').value = L.toFixed(2);
    $('#ms-ctol').value = (0.25 * L).toFixed(2);
  }
  $('#ms-import').addEventListener('click', () => $('#ms-file').click());
  $('#ms-file').addEventListener('change', async () => {
    const f = $('#ms-file').files[0];
    $('#ms-file').value = '';
    if (!f) return;
    try {
      const ext = f.name.split('.').pop().toLowerCase();
      let mesh;
      if (ext === 'stl') {
        const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
        const g = new STLLoader().parse(await f.arrayBuffer());
        const p = g.attributes.position.array;
        mesh = weld(p, Uint32Array.from({ length: p.length / 3 }, (_, i) => i), 1e-5);
      } else {
        const text = await f.text();
        mesh = ext === 'pat' ? parsePatran(text) : parseNastran(text);
      }
      if (!mesh.tris.length) throw new Error('未读到三角形单元');
      ms.imported = { name: f.name, bodies: [{ pos: mesh.pos, tris: mesh.tris, welded: true }] };
      ms.result = null;
      defaultParams();
      $('#ms-run').disabled = false;
      setView('before', false);
      render();
      toast(`已导入 ${f.name}：${fmt(mesh.tris.length / 3, 0)} 个三角形单元`);
    } catch (err) { toast('导入失败：' + err.message, 5000); }
  });

  $('#ms-run').addEventListener('click', () => {
    const src = meshSource();
    if (!src || ms.running) return;
    ms.running = true;
    $('#ms-run').disabled = true;
    const w = new Worker(new URL('./meshWorker.js', import.meta.url), { type: 'module' });
    const params = {
      target: parseFloat($('#ms-target').value) || 4,
      edgeLength: parseFloat($('#ms-len').value) || 1,
      featureAngle: parseFloat($('#ms-feat').value) || 40,
      cornerTol: parseFloat($('#ms-ctol').value),
    };
    progress(true, '网格优化', 0);
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') progress(true, `${m.stage} · 第 ${m.body + 1}/${m.bodies} 个网格体`, m.frac);
      if (m.type === 'error') { toast('优化失败：' + m.message, 6000); finish(); }
      if (m.type === 'done') { ms.result = { bodies: m.bodies, ms: m.ms, params }; setView('after', true); finish(); toast('网格优化完成'); }
    };
    const finish = () => { w.terminate(); ms.running = false; $('#ms-run').disabled = false; progress(false); render(); };
    w.postMessage({ bodies: src.map(b => ({ pos: b.pos, tris: b.tris, welded: true })), ...params });
  });

  function renderMeshResult() {
    const box = $('#mold-result');
    const src = meshSource();
    if (!src) { box.hidden = true; return; }
    const target = parseFloat($('#ms-target').value) || 4;
    const all = concat(src.map(b => ({ pos: b.pos, tris: b.tris })));
    const s0 = aspectStats(all.pos, all.tris);
    const r = ms.result;
    let s1 = null;
    if (r) {
      const n = r.bodies.reduce((k, b) => k + b.after.n, 0);
      s1 = {
        n, max: Math.max(...r.bodies.map(b => b.after.max)),
        mean: r.bodies.reduce((k, b) => k + b.after.mean * b.after.n, 0) / n,
        over: r.bodies.reduce((k, b) => k + b.after.over, 0),
        hist: r.bodies[0].after.hist.map((_, i) => r.bodies.reduce((k, b) => k + b.after.hist[i], 0)),
        devMax: Math.max(...r.bodies.map(b => b.devMax)), devMean: r.bodies.reduce((k, b) => k + b.devMean, 0) / r.bodies.length,
      };
    }
    const bins = ['≤1.5', '≤2', '≤3', '≤4', '≤6', '≤10', '≤20', '≤50', '>50'];
    const histRow = (h, n, color) => h.map((v, i) => `<div class="row"><span>${bins[i]}</span><div class="bar2"><i style="width:${(v / n) * 100}%;background:${color}"></i></div><span>${fmt(v, 0)}</span></div>`).join('');
    box.hidden = false;
    box.innerHTML = `<h4>网格纵横比（目标 ≤ ${target}）</h4>
      <div class="big">
        <div><b class="${s0.max > target ? 'bad' : 'ok'}">${s0.max > 999 ? '>999' : fmt(s0.max)}</b><span>原始最大纵横比</span></div>
        <div><b class="${s1 ? (s1.max > target + 1e-6 ? 'bad' : 'ok') : ''}">${s1 ? fmt(s1.max) : '—'}</b><span>优化后最大纵横比</span></div>
        <div><b>${fmt(s0.countOver(target), 0)}</b><span>原始超标单元</span></div>
        <div><b class="${s1 ? (s1.over ? 'bad' : 'ok') : ''}">${s1 ? fmt(s1.over, 0) : '—'}</b><span>优化后超标单元</span></div>
      </div>
      <dl class="kv">
        <dt>来源</dt><dd>${ms.imported ? ms.imported.name : '当前模型表面网格（演示）'}</dd>
        <dt>单元数</dt><dd>${fmt(s0.n, 0)}${s1 ? ' → ' + fmt(s1.n, 0) : ''}</dd>
        <dt>平均纵横比</dt><dd>${fmt(s0.mean)}${s1 ? ' → ' + fmt(s1.mean) : ''}</dd>
        ${s1 ? `<dt>几何偏差（平均 / 最大）</dt><dd>${s1.devMean.toFixed(4)} / ${s1.devMax.toFixed(3)} mm</dd><dt>耗时</dt><dd>${fmtS(r.ms)}</dd>` : ''}
      </dl>
      <h4 style="margin-top:10px">分布（原始）</h4><div class="ar-hist">${histRow(s0.hist, s0.n, '#9e9e9e')}</div>
      ${s1 ? `<h4>分布（优化后）</h4><div class="ar-hist">${histRow(s1.hist, s1.n, '#2b5ea7')}</div>` : ''}
      <p class="dim" style="margin:6px 0 0;line-height:1.6">方法：保留特征边的各向同性重网格（分裂 / 塌陷 / 翻边 / 切向松弛并投影回原曲面），再对超标单元做局部翻边、塌陷与顶点寻优。</p>`;
    $('#mold-status').innerHTML = `<span>单元 <b>${fmt(s0.n, 0)}${s1 ? ' → ' + fmt(s1.n, 0) : ''}</b></span><span>最大纵横比 <b>${s0.max > 999 ? '>999' : fmt(s0.max)}${s1 ? ' → ' + fmt(s1.max) : ''}</b></span><span>超标 <b>${fmt(s0.countOver(target), 0)}${s1 ? ' → ' + fmt(s1.over, 0) : ''}</b></span>`;
  }

  // ---------- 导出 ----------
  const menu = $('#mold-export-menu');
  function updateExport() {
    const items = tool === 'defillet'
      ? (df.result ? [['step', 'image', '去圆角 STEP']] : [])
      : (ms.result ? [['nas', 'grid_on', 'Nastran 网格 (.nas)'], ['stl', 'deployed_code', 'STL 网格']] : []);
    menu.innerHTML = items.map(([k, ic, t]) => `<md-menu-item data-export="${k}"><md-icon slot="start">${ic}</md-icon><div slot="headline">${t}</div></md-menu-item>`).join('');
    $('#btn-mold-export').disabled = !items.length;
  }
  $('#btn-mold-export').addEventListener('click', () => { menu.open = !menu.open; });
  menu.addEventListener('close-menu', (e) => {
    const k = e.detail.initiator?.dataset.export;
    if (!k) return;
    const base = (ms.imported?.name || baseName()).replace(/\.[^.]+$/, '');
    if (k === 'step') download(`${baseName()}-去圆角R${df.R}.step`, new Blob([df.result.step], { type: 'application/step' }));
    const all = ms.result && concat(ms.result.bodies.map(b => ({ pos: b.pos, tris: b.tris })));
    if (k === 'nas') download(`${base}-AR优化.nas`, toNastran(all.pos, all.tris), 'text/plain');
    if (k === 'stl') download(`${base}-AR优化.stl`, new Blob([toSTL(all.pos, all.tris, 'optimized')]));
  });

  return {
    onModel() {
      df.worker?.terminate(); df.worker = null;
      df.scan = null; df.result = null; df.snap = null; df.chainState = new Map();
      ms.result = null; ms.fromModel = null;
      $('#df-run').disabled = true;
      $('#ms-run').disabled = !state.model && !ms.imported;
      defaultParams();
      setView('before', false);
      if ($('#stage-body').classList.contains('mode-mold')) render();
    },
    onShow() { render(); viewer?.resize(); },
    setTheme(dark) { viewer?.setTheme(dark); },
  };
}
