import '@material/web/button/filled-button.js';
import '@material/web/button/filled-tonal-button.js';
import '@material/web/button/outlined-button.js';
import '@material/web/button/text-button.js';
import '@material/web/iconbutton/icon-button.js';
import '@material/web/icon/icon.js';
import '@material/web/tabs/tabs.js';
import '@material/web/tabs/primary-tab.js';
import '@material/web/list/list.js';
import '@material/web/list/list-item.js';
import '@material/web/progress/linear-progress.js';
import '@material/web/progress/circular-progress.js';
import '@material/web/select/outlined-select.js';
import '@material/web/select/select-option.js';
import '@material/web/chips/chip-set.js';
import '@material/web/chips/filter-chip.js';
import '@material/web/dialog/dialog.js';
import '@material/web/ripple/ripple.js';
import '@material/web/focus/md-focus-ring.js';
import '@material/web/slider/slider.js';
import '@material/web/menu/menu.js';
import '@material/web/menu/menu-item.js';
import { styles as typescaleStyles } from '@material/web/typography/md-typescale-styles.js';
import 'material-symbols/outlined.css';
import './style.css';

import * as THREE from 'three';
import { loadModel, partsToGeometries, measure, ACCEPT, OCCT_PARAMS } from './loader.js';
import { analyzeFeatures, summarizeFeatures } from './features.js';
import { Viewer } from './viewer.js';
import { computeLayout, projectView, prepareGeometries, buildSheet, sheetToSVG, sheetToDXF, getViews, countSegments } from './drawing.js';
import { SAMPLES } from './samples.js';
import { now } from './clock.js';

document.adoptedStyleSheets.push(typescaleStyles.styleSheet);
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const BASE = import.meta.env.BASE_URL;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (v, d = 2) => Number(v).toLocaleString('zh-CN', { maximumFractionDigits: d, minimumFractionDigits: 0 });
const fmtMs = (t) => (t == null ? '' : t >= 1000 ? (t / 1000).toFixed(2) + ' s' : Math.max(0, Math.round(t)) + ' ms');
const vec = (a, d = 3) => '(' + [...a].map(v => { const r = +Number(v).toFixed(d); return fmt(r === 0 ? 0 : r, d); }).join(', ') + ')';

// ---------------- 状态 ----------------
const state = {
  model: null,
  q: new THREE.Quaternion(),
  results: {},
  cache: new Map(),
  layout: null,
  sheet: null,
  abort: null,
  trace: {},
  opts: { projection: 'first', paper: 'A3', up: 'Z', hidden: true, centerlines: true, dims: true, holeTable: true, notes: true },
};

const viewer = new Viewer($('#viewer'));

// ---------------- 主题 ----------------
function applyTheme(theme, persist = false) {
  document.documentElement.dataset.theme = theme;
  if (persist) localStorage.setItem('theme', theme);
  $('#btn-theme md-icon').textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
  viewer.setTheme(theme === 'dark');
}
applyTheme(document.documentElement.dataset.theme);
$('#btn-theme').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => { if (!localStorage.getItem('theme')) applyTheme(e.matches ? 'dark' : 'light'); });

// ---------------- 流水线 ----------------
const STEPS = [
  { key: 'read', label: '读取文件', icon: 'description' },
  { key: 'parse', label: 'STEP 解析', icon: 'data_array' },
  { key: 'mesh', label: 'B-rep 网格化', icon: 'deployed_code' },
  { key: 'feature', label: '特征识别', icon: 'adjust' },
  { key: 'hlr', label: '消隐投影', icon: 'layers' },
  { key: 'sheet', label: '标注出图', icon: 'architecture' },
];
const stepStatus = {};
function renderPipeline() {
  $('#pipeline').innerHTML = STEPS.map((s, i) => {
    const st = stepStatus[s.key] || {};
    const badge = st.status === 'active' ? '<md-circular-progress indeterminate></md-circular-progress>'
      : st.status === 'done' ? '<md-icon>check</md-icon>'
      : st.status === 'error' ? '<md-icon>priority_high</md-icon>'
      : st.status === 'skip' ? '<md-icon>remove</md-icon>' : String(i + 1);
    const cls = st.status === 'skip' ? 'done' : st.status || '';
    const clickable = st.status === 'done' || st.status === 'skip' || st.status === 'error';
    return (i ? '<md-icon class="chev">chevron_right</md-icon>' : '') +
      `<button class="step ${cls}" data-step="${s.key}" ${clickable ? '' : 'disabled'} title="${s.label}${clickable ? ' · 点击查看详情' : ''}">
        <md-focus-ring></md-focus-ring><md-ripple></md-ripple>
        <span class="badge">${badge}</span><span class="label">${s.label}</span><span class="ms">${st.status === 'done' ? fmtMs(st.ms) : ''}</span>
      </button>`;
  }).join('');
}
function setStep(key, status, ms) {
  stepStatus[key] = { status, ms };
  renderPipeline();
}
function resetPipeline() { for (const k of Object.keys(stepStatus)) delete stepStatus[k]; renderPipeline(); }
renderPipeline();
$('#pipeline').addEventListener('click', (e) => {
  const b = e.target.closest('.step');
  if (b && !b.disabled) openInspector(b.dataset.step);
});
const progress = $('#progress');
function setProgress(v) { progress.indeterminate = v < 0; progress.value = Math.max(0, v); progress.style.opacity = v >= 1 ? 0 : 1; }

let toastTimer;
function toast(msg, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------- 样例库（缩略图为预生成静态文件） ----------------
function renderSamples(activeId) {
  $('#samples').innerHTML = SAMPLES.map(s => `<md-list-item type="button" data-id="${s.id}" class="${s.id === activeId ? 'active' : ''}">
      <img slot="start" class="thumb" src="${BASE}samples/thumbs/${s.id}.webp" alt="" loading="eager" decoding="async">
      <div slot="headline">${s.name}</div>
    </md-list-item>`).join('');
}
renderSamples();
async function openSample(s) {
  setProgress(-1);
  const res = await fetch(BASE + 'samples/' + s.file);
  if (!res.ok) throw new Error(res.statusText);
  await openFile(new File([await res.blob()], s.file), s);
}
$('#samples').addEventListener('click', (e) => {
  const item = e.target.closest('md-list-item');
  if (!item) return;
  openSample(SAMPLES.find(x => x.id === item.dataset.id)).catch(err => toast('加载样例失败：' + err.message));
});

// ---------------- 上传 ----------------
const fileInput = $('#file-input');
fileInput.accept = ACCEPT;
$('#btn-upload').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) openFile(fileInput.files[0]); fileInput.value = ''; });
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (!e.dataTransfer?.types.includes('Files')) return; e.preventDefault(); dragDepth++; $('#drop-overlay').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#drop-overlay').hidden = true;
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});

// ---------------- 主流程 ----------------
async function openFile(file, sample = null) {
  state.abort?.abort();
  resetPipeline();
  state.results = {};
  state.cache.clear();
  state.trace = { file: { name: file.name, size: file.size, lastModified: file.lastModified } };
  renderSamples(sample?.id);
  $('#btn-ref').disabled = !sample;
  setProgress(-1);
  let cur = null;
  try {
    const loaded = await loadModel(file, (key) => { if (cur) setStep(cur, 'done'); cur = key; setStep(key, 'active'); });
    cur = null;
    setStep('read', 'done', loaded.timings.read);
    if (loaded.step) setStep('parse', 'done', loaded.timings.parse); else setStep('parse', 'skip');
    setStep('mesh', 'done', loaded.timings.mesh);

    cur = 'feature';
    setStep('feature', 'active');
    const tf = now();
    const geometries = partsToGeometries(loaded.parts);
    const metrics = measure(loaded.parts);
    const hasBrep = loaded.parts.some(p => p.brepFaces.length);
    const { features, faceTypes } = hasBrep ? analyzeFeatures(loaded.parts, metrics.diag) : { features: [], faceTypes: null };
    const summary = summarizeFeatures(features);
    const featureMs = now() - tf;
    setStep('feature', hasBrep ? 'done' : 'skip', featureMs);
    cur = null;

    const name = loaded.step?.products?.[0] || file.name.replace(/\.[^.]+$/, '');
    state.model = { ...loaded, geometries, metrics, features, faceTypes, summary, name, fileName: file.name, sample };

    const defUp = ['glb', 'gltf', 'obj'].includes(loaded.format) ? 'Y' : 'Z';
    state.opts.up = defUp;
    $('#sel-up').value = defUp;
    state.q = upQuaternion(defUp);

    $('#empty-3d').hidden = true;
    viewer.setModel(geometries, loaded.parts, features);
    viewer.setOrientation(state.q);
    viewer.setFeatures($('#tg-features').selected);
    $('#legend').hidden = !$('#tg-features').selected;
    $('#model-label').textContent = `${file.name} · ${fmt(loaded.size / 1024, 0)} KB`;
    renderParams();
    $('#btn-json').disabled = false;
    cur = 'hlr';
    await generateDrawing();
  } catch (err) {
    console.error(err);
    setProgress(0);
    if (cur) { setStep(cur, 'error'); state.trace.error = { step: STEPS.find(s => s.key === cur)?.label, message: err.message }; }
    toast('处理失败：' + err.message, 5000);
  }
}

function upQuaternion(up) {
  const q = new THREE.Quaternion();
  if (up === 'Y') q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  if (up === 'X') q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
  return q;
}

function sheetMeta() {
  const m = state.model;
  const date = new Date();
  const ds = `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
  let h = 0;
  for (const c of m.fileName) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return {
    company: '示例公司',
    companySub: 'DEMO COMPANY',
    title: m.name,
    drawingNo: `DWG-${String(date.getFullYear()).slice(2)}${String(date.getMonth() + 1).padStart(2, '0')}-${(h % 100000).toString().padStart(5, '0')}`,
    material: '',
    revision: 'A',
    designer: '自动生成',
    date: ds,
  };
}

function rebuildSheet(fresh = null) {
  const m = state.model;
  if (!m || !state.layout) return;
  const t = now();
  state.sheet = buildSheet({
    layout: state.layout, results: state.results, q: state.q, features: m.features, holeSummary: m.summary,
    meta: sheetMeta(), options: state.opts,
  });
  const svg = sheetToSVG(state.sheet, state.layout, { fresh });
  state.trace.sheetMs = now() - t;
  const canvas = $('#sheet-canvas');
  const firstRender = !canvas.firstElementChild;
  canvas.innerHTML = svg;
  $('#empty-2d').hidden = true;
  if (firstRender || canvas.dataset.paper !== state.layout.paper) { canvas.dataset.paper = state.layout.paper; zoomFit(); }
  else applyZoom();
  const seg = countSegments(state.results);
  $('#sheet-status').innerHTML = `<span>比例 <b>${state.layout.scaleText}</b></span><span>图幅 <b>${state.layout.paper}</b></span>` +
    `<span>可见线 <b>${seg.visible.toLocaleString()}</b></span><span>隐藏线 <b>${seg.hidden.toLocaleString()}</b></span>` +
    `<span>孔/轴 <b>${m.summary.holes.reduce((s, h) => s + h.count, 0)}</b></span>`;
}

async function generateDrawing() {
  const m = state.model;
  if (!m) return;
  state.abort?.abort();
  const abort = state.abort = new AbortController();
  const { opts } = state;
  try {
    state.layout = computeLayout({ box: m.metrics.box, q: state.q, projection: opts.projection, paper: opts.paper });
  } catch (err) {
    toast(err.message + '，请选择更大图幅'); return;
  }
  const views = getViews(opts.projection);
  state.results = {};
  const order = ['front', 'top', 'side', 'iso'];
  for (const k of order) {
    const c = state.cache.get(`${opts.up}|${views[k].label}`);
    if (c) state.results[k] = c;
  }
  const todo = order.filter(k => !state.results[k]);
  rebuildSheet();
  $('#btn-export').disabled = true;
  if (todo.length) {
    setStep('hlr', 'active');
    setStep('sheet', null);
    prepareGeometries(m.geometries);
    let hlrMs = 0;
    for (let i = 0; i < todo.length; i++) {
      const k = todo[i];
      const view = views[k];
      viewer.flyTo(view.d, view.u, 600);
      const tv = now();
      const res = await projectView(m.geometries, view, state.q, {
        signal: abort.signal,
        onProgress: (p) => setProgress((i + p) / todo.length),
      }).catch(err => { if (abort.signal.aborted) return null; throw err; });
      if (!res || abort.signal.aborted) return;
      res.ms = now() - tv;
      hlrMs += res.ms;
      state.results[k] = res;
      state.cache.set(`${opts.up}|${view.label}`, res);
      rebuildSheet(new Set([k]));
      if (window.__demoPace) await new Promise(r => setTimeout(r, window.__demoPace));
    }
    state.trace.hlrMs = hlrMs;
    viewer.flyTo(new THREE.Vector3(1, -1.25, 0.85), new THREE.Vector3(0, 0, 1), 800);
  }
  setStep('hlr', 'done', state.trace.hlrMs ?? 0);
  rebuildSheet();
  setStep('sheet', 'done', state.trace.sheetMs);
  setProgress(1);
  $('#btn-export').disabled = false;
}

// ---------------- 参数面板 ----------------
const openSecs = new Set(JSON.parse(localStorage.getItem('openSecs') || '["file","geom","feature"]'));
const sec = (id, icon, title, body) => `<details class="sec" data-sec="${id}" ${openSecs.has(id) ? 'open' : ''}>
  <summary><md-icon>${icon}</md-icon>${title}<md-icon class="chevron">expand_more</md-icon></summary><div class="sec-body">${body}</div></details>`;

function renderParams() {
  const m = state.model;
  const st = m.step;
  const box = m.metrics.box.clone().applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(state.q));
  const size = box.getSize(new THREE.Vector3());
  const html = [];

  html.push(sec('file', 'description', '文件', `<dl class="kv">
    <dt>文件名</dt><dd>${esc(m.fileName)}</dd>
    <dt>格式</dt><dd>${m.format.toUpperCase()}${st ? ' · ' + st.header.ap : ''}</dd>
    <dt>大小</dt><dd>${fmt(m.size / 1024, 0)} KB</dd>
    ${st ? `<dt>产品名</dt><dd>${esc(st.products[0] || '—')}</dd>
    <dt>原始单位</dt><dd>${st.unit}${st.unit !== 'mm' ? ' → mm' : ''}</dd>
    <dt>创建时间</dt><dd>${esc(st.header.timestamp || '—')}</dd>` : '<dt>拓扑</dt><dd>网格格式，无 B-rep</dd>'}
  </dl>`));

  html.push(sec('geom', 'straighten', '几何尺寸', `
    <div class="metric-row"><div class="metric"><b>${fmt(size.x, 2)}</b><span>X 长</span></div><div class="metric"><b>${fmt(size.y, 2)}</b><span>Y 宽</span></div><div class="metric"><b>${fmt(size.z, 2)}</b><span>Z 高</span></div></div>
    <dl class="kv">
    <dt>体积</dt><dd>${fmt(m.metrics.volume / 1000, 3)} cm³</dd>
    <dt>表面积</dt><dd>${fmt(m.metrics.area / 100, 2)} cm²</dd>
    <dt>形心</dt><dd>${vec(m.metrics.centroid, 2)}</dd>
    <dt>包围盒最小点</dt><dd>${vec(m.metrics.box.min.toArray(), 2)}</dd>
    <dt>包围盒最大点</dt><dd>${vec(m.metrics.box.max.toArray(), 2)}</dd>
    </dl>`));

  const topo = st?.topology;
  const faces = topo?.faces || m.parts.reduce((s, p) => s + p.brepFaces.length, 0);
  html.push(sec('topo', 'hub', 'B-rep 拓扑', `<dl class="kv">
    <dt>实体</dt><dd>${topo ? topo.solids : m.parts.length}</dd>
    <dt>面</dt><dd>${fmt(faces, 0)}</dd>
    <dt>边</dt><dd>${topo ? fmt(topo.edges, 0) : '—'}</dd>
    <dt>顶点</dt><dd>${topo ? fmt(topo.vertices, 0) : '—'}</dd>
    <dt>网格体</dt><dd>${m.parts.length}</dd>
    <dt>三角面片</dt><dd>${fmt(m.metrics.tris, 0)}</dd></dl>`));

  if (st) {
    const entries = Object.entries(st.surfaceStats).sort((a, b) => b[1] - a[1]);
    const max = Math.max(...entries.map(e => e[1]), 1);
    html.push(sec('surf', 'stacked_bar_chart', '曲面类型', `<div class="bars">
      ${entries.map(([k, v]) => `<div class="bar"><span>${k}</span><div class="track"><div class="fill" style="width:${v / max * 100}%"></div></div><span class="n">${v}</span></div>`).join('')}</div>
      <div class="chips-wrap">${Object.entries(st.curveStats).map(([k, v]) => `<span class="mini-chip">${k} ${v}</span>`).join('')}</div>`));
  }

  const { holes, fillets } = m.summary;
  if (holes.length || fillets.length) {
    html.push(sec('feature', 'adjust', '孔 / 轴 / 圆角', `<table class="tbl"><tr><th>类型</th><th class="r">直径</th><th class="r">数量</th><th class="r">长度</th></tr>
      ${holes.map(h => `<tr><td><span class="dot" style="background:${h.kind === 'hole' ? '#0891b2' : '#d97706'}"></span>${h.kind === 'hole' ? '孔' : '凸台/轴'}</td><td class="r">Ø${fmt(h.d)}</td><td class="r">${h.count}</td><td class="r">${fmt(h.depth, 1)}</td></tr>`).join('')}
      </table>
      ${fillets.length ? `<div class="md-typescale-label-medium dim" style="margin-top:10px">圆角 / 圆弧面 ${fillets.reduce((s, f) => s + f.count, 0)} 处</div>
      <div class="chips-wrap">${fillets.slice(0, 30).map(f => `<span class="mini-chip">${f.count}×R${fmt(f.r)}</span>`).join('')}</div>` : ''}`));
  }
  $('#params-body').innerHTML = html.join('');
}
$('#params-body').addEventListener('toggle', (e) => {
  const d = e.target.closest?.('details.sec');
  if (!d) return;
  if (d.open) openSecs.add(d.dataset.sec); else openSecs.delete(d.dataset.sec);
  localStorage.setItem('openSecs', JSON.stringify([...openSecs]));
}, true);

// 右侧面板折叠
const btnParams = $('#btn-params');
function setParamsOpen(open) {
  $('#layout').classList.toggle('params-open', open);
  btnParams.selected = open;
  localStorage.setItem('paramsOpen', open ? '1' : '0');
}
setParamsOpen(localStorage.getItem('paramsOpen') === '1');
btnParams.addEventListener('change', () => setParamsOpen(btnParams.selected));

// ---------------- 处理详情 ----------------
let inspectorKey = 'read';
function openInspector(key) {
  inspectorKey = key;
  renderInspector();
  $('#step-dialog').show();
}
function renderInspector() {
  $('#step-file').textContent = state.trace.file?.name || '';
  $('#inspector-nav').innerHTML = [{ key: 'overview', label: '总览', icon: 'timeline' }, ...STEPS].map(s => {
    const st = stepStatus[s.key];
    const ms = s.key === 'overview' ? totalMs() : st?.status === 'done' ? st.ms : null;
    const disabled = s.key !== 'overview' && !(st && ['done', 'skip', 'error'].includes(st.status));
    return `<md-list-item type="button" data-key="${s.key}" class="${s.key === inspectorKey ? 'active' : ''}" ${disabled ? 'disabled' : ''}>
      <md-icon slot="start">${st?.status === 'error' ? 'error' : s.icon}</md-icon>
      <div slot="headline">${s.label}</div>
      <span slot="end" class="ms">${st?.status === 'skip' ? '跳过' : fmtMs(ms)}</span></md-list-item>`;
  }).join('');
  const body = $('#inspector-body');
  try { body.innerHTML = INSPECTORS[inspectorKey]?.() || ''; } catch (e) { console.error(e); body.innerHTML = `<p class="desc">暂无详情：${esc(e.message)}</p>`; }
}
$('#inspector-nav').addEventListener('click', (e) => {
  const it = e.target.closest('md-list-item');
  if (!it || it.disabled) return;
  inspectorKey = it.dataset.key;
  renderInspector();
});
function totalMs() {
  return STEPS.reduce((s, x) => s + (stepStatus[x.key]?.status === 'done' ? stepStatus[x.key].ms || 0 : 0), 0);
}
const kpis = (list) => `<div class="kpis">${list.map(([k, v]) => `<div class="kpi"><span>${k}</span><b>${v}</b></div>`).join('')}</div>`;
const kvl = (list) => `<dl class="kv" style="max-width:620px">${list.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
const STEP_COLORS = ['#2b5ea7', '#5b8bd6', '#0f766e', '#d97706', '#7c3aed', '#be185d'];
const IMPL = {
  read: 'File API', parse: '自研 ISO 10303-21 解析器', mesh: 'occt-import-js（OCCT WASM）',
  feature: '法向 PCA + Kåsa 圆拟合', hlr: 'three-edge-projection + BVH', sheet: '自研布局 / 标注引擎',
};

function viewPreview(res) {
  const a = res.visible, h = res.hidden;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const arr of [a, h]) for (let i = 0; i < arr.length; i += 2) { x0 = Math.min(x0, arr[i]); x1 = Math.max(x1, arr[i]); y0 = Math.min(y0, arr[i + 1]); y1 = Math.max(y1, arr[i + 1]); }
  if (!isFinite(x0)) return '<svg></svg>';
  const pad = Math.max(x1 - x0, y1 - y0) * 0.06;
  const path = (arr) => { let d = ''; for (let i = 0; i < arr.length; i += 4) d += `M${arr[i].toFixed(1)} ${(-arr[i + 1]).toFixed(1)}L${arr[i + 2].toFixed(1)} ${(-arr[i + 3]).toFixed(1)}`; return d; };
  return `<svg viewBox="${x0 - pad} ${-y1 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}" preserveAspectRatio="xMidYMid meet">
    ${h.length ? `<path d="${path(h)}" stroke="#94a3b8" stroke-width="0.8" stroke-dasharray="3 2" fill="none" vector-effect="non-scaling-stroke"/>` : ''}
    <path d="${path(a)}" stroke="#111827" stroke-width="1" fill="none" vector-effect="non-scaling-stroke"/></svg>`;
}

const INSPECTORS = {
  overview() {
    const parts = STEPS.map((s, i) => ({ ...s, ms: stepStatus[s.key]?.status === 'done' ? stepStatus[s.key].ms || 0 : 0, color: STEP_COLORS[i] }));
    const total = parts.reduce((s, p) => s + p.ms, 0) || 1;
    const m = state.model;
    return `<h4>处理耗时</h4>
      ${kpis([['总耗时', fmtMs(total)], ['三角面片', m ? fmt(m.metrics.tris, 0) : '—'], ['识别特征', m ? m.features.length : '—'], ['图纸比例', state.layout?.scaleText || '—']])}
      <div class="timeline">${parts.map(p => `<span style="width:${p.ms / total * 100}%;background:${p.color}" title="${p.label} ${fmtMs(p.ms)}"></span>`).join('')}</div>
      <div class="timeline-legend">${parts.map(p => `<span><i style="background:${p.color}"></i>${p.label} ${fmtMs(p.ms)}</span>`).join('')}</div>
      <h4>流水线</h4>
      <table class="tbl"><tr><th>#</th><th>步骤</th><th>实现</th><th class="r">耗时</th><th class="r">占比</th></tr>
      ${parts.map((p, i) => `<tr><td>${i + 1}</td><td>${p.label}</td><td class="dim">${IMPL[p.key]}</td><td class="r">${stepStatus[p.key]?.status === 'skip' ? '跳过' : fmtMs(p.ms)}</td><td class="r">${fmt(p.ms / total * 100, 1)}%</td></tr>`).join('')}</table>
      ${state.trace.error ? `<h4>错误</h4><p class="desc" style="color:var(--md-sys-color-error)">${esc(state.trace.error.step)}：${esc(state.trace.error.message)}</p>` : ''}`;
  },
  read() {
    const f = state.trace.file, m = state.model;
    const parser = !m ? '—' : m.parts.some(p => p.brepFaces.length) || m.step ? 'OCCT (WASM)' : 'three.js';
    return `<p class="desc">在浏览器本地把文件读为 ArrayBuffer，按扩展名分派解析器；文件不会上传到任何服务器。</p>
      ${kpis([['文件大小', fmt(f.size / 1024, 1) + ' KB'], ['格式', (m?.format || '—').toUpperCase()], ['解析器', parser], ['耗时', fmtMs(stepStatus.read?.ms)]])}
      <h4>文件信息</h4>${kvl([['文件名', esc(f.name)], ['字节数', fmt(f.size, 0)], ['修改时间', f.lastModified ? new Date(f.lastModified).toLocaleString('zh-CN') : '—']])}
      ${m?.step?.headerText ? `<h4>文件头（ISO 10303-21 HEADER 段）</h4><pre class="code mono">${esc(m.step.headerText)}</pre>` : ''}`;
  },
  parse() {
    const st = state.model?.step;
    if (!st) return '<p class="desc">该格式不是 STEP 文本文件，跳过实体解析。</p>';
    const top = Object.entries(st.typeCount).sort((a, b) => b[1] - a[1]).slice(0, 18);
    const max = top[0]?.[1] || 1;
    return `<p class="desc">逐条解析 DATA 段中的实体实例（#id = TYPE(...)），识别长度单位、产品与拓扑，并从 ADVANCED_FACE 回溯到曲面定义，得到曲面类型分布。</p>
      ${kpis([['实体实例', fmt(st.entityCount, 0)], ['实体类型', Object.keys(st.typeCount).length], ['应用协议', st.header.ap], ['长度单位', st.unit], ['耗时', fmtMs(st.parseMs)]])}
      <h4>文件头字段</h4>${kvl([['描述', esc(st.header.description || '—')], ['文件名', esc(st.header.name || '—')], ['时间戳', esc(st.header.timestamp || '—')], ['预处理器', esc(st.header.preprocessor || '—')], ['源系统', esc(st.header.originatingSystem || '—')], ['Schema', `<span class="mono">${esc(st.header.schema)}</span>`], ['产品', esc(st.products.join('、') || '—')]])}
      <h4>拓扑统计</h4>${kpis([['实体', st.topology.solids], ['壳', st.topology.shells], ['面', st.topology.faces], ['边', st.topology.edges], ['顶点', st.topology.vertices]])}
      <h4>实体类型 Top ${top.length}</h4>
      <div class="bars">${top.map(([k, v]) => `<div class="bar" style="grid-template-columns:240px 1fr 56px"><span class="mono" style="font-size:11.5px">${k}</span><div class="track"><div class="fill" style="width:${v / max * 100}%"></div></div><span class="n">${fmt(v, 0)}</span></div>`).join('')}</div>`;
  },
  mesh() {
    const m = state.model;
    const isOcct = m.parts.some(p => p.brepFaces.length);
    return `<p class="desc">${isOcct ? 'OpenCASCADE（WASM，在 Web Worker 中运行）读取 B-rep，按弦高与角度公差三角化；每个 B-rep 面保留对应的三角面区间，供特征识别和高亮使用。' : 'three.js 加载器解析网格，合并重复顶点并重新计算法向。'}</p>
      ${kpis([['网格体', m.parts.length], ['顶点', fmt(m.parts.reduce((s, p) => s + p.positions.length / 3, 0), 0)], ['三角面片', fmt(m.metrics.tris, 0)], ['B-rep 面', fmt(m.parts.reduce((s, p) => s + p.brepFaces.length, 0), 0)], ['耗时', fmtMs(stepStatus.mesh?.ms)]])}
      ${isOcct ? `<h4>三角化参数</h4>${kvl([['输出单位', OCCT_PARAMS.linearUnit], ['弦高公差', `${OCCT_PARAMS.linearDeflection} × 包围盒对角线 ≈ ${fmt(OCCT_PARAMS.linearDeflection * m.metrics.diag, 3)} mm`], ['角度公差', `${OCCT_PARAMS.angularDeflection} rad（${fmt(OCCT_PARAMS.angularDeflection * 180 / Math.PI, 1)}°）`]])}` : ''}
      <h4>网格体</h4><table class="tbl"><tr><th>#</th><th>名称</th><th>颜色</th><th class="r">顶点</th><th class="r">三角面</th><th class="r">B-rep 面</th></tr>
      ${m.parts.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td>${p.color ? `<span class="dot" style="background:rgb(${p.color.map(c => Math.round(c * 255)).join(',')})"></span>` : '—'}</td><td class="r">${fmt(p.positions.length / 3, 0)}</td><td class="r">${fmt(p.index.length / 3, 0)}</td><td class="r">${p.brepFaces.length}</td></tr>`).join('')}</table>`;
  },
  feature() {
    const m = state.model;
    if (!m.faceTypes) return '<p class="desc">网格格式不含 B-rep 面信息，跳过特征识别（需要 STEP / IGES / BREP）。</p>';
    const ft = m.faceTypes;
    const cnt = (k) => m.features.filter(f => f.kind === k).length;
    const ORDER = { hole: 0, boss: 1, fillet: 2 };
    const list = [...m.features].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b.r - a.r);
    const KIND = { hole: ['孔', '#0891b2'], boss: ['凸台/轴', '#d97706'], fillet: ['圆角/弧面', '#7c3aed'] };
    return `<p class="desc">对每个 B-rep 面的顶点法向做协方差特征分解：法向集中在一个方向判为平面；法向都垂直于同一轴判为圆柱面，再用 Kåsa 代数圆拟合求轴线和半径（残差 &lt; 0.5% R）。同轴同径的面合并后，覆盖角 &gt; 290° 视为完整圆柱：法向朝轴心为孔，背离为凸台/轴；其余为圆角/弧面。</p>
      ${kpis([['分析面数', ft.plane + ft.cylinder + ft.freeform], ['平面', ft.plane], ['圆柱面', ft.cylinder], ['其他曲面', ft.freeform], ['孔', cnt('hole')], ['凸台/轴', cnt('boss')], ['圆角/弧面', cnt('fillet')], ['耗时', fmtMs(stepStatus.feature?.ms)]])}
      <h4>识别结果（${list.length}）</h4>
      <table class="tbl"><tr><th>#</th><th>类型</th><th class="r">Ø / R</th><th>轴向</th><th>中心 (mm)</th><th class="r">长度</th><th class="r">覆盖角</th><th class="r">面数</th></tr>
      ${list.slice(0, 150).map((f, i) => `<tr><td>${i + 1}</td><td><span class="dot" style="background:${KIND[f.kind][1]}"></span>${KIND[f.kind][0]}</td><td class="r">${f.kind === 'fillet' ? 'R' + fmt(f.r) : 'Ø' + fmt(f.d)}</td><td class="mono">${vec(f.a, 2)}</td><td class="mono">${vec(f.center, 1)}</td><td class="r">${fmt(f.length, 2)}</td><td class="r">${fmt(f.coverage * 360, 0)}°</td><td class="r">${f.faces.length}</td></tr>`).join('')}</table>
      ${list.length > 150 ? '<p class="desc">仅显示前 150 项，完整数据可通过参数面板导出 JSON。</p>' : ''}`;
  },
  hlr() {
    const views = getViews(state.opts.projection);
    const keys = ['front', 'top', 'side', 'iso'].filter(k => state.results[k]);
    const seg = countSegments(state.results);
    return `<p class="desc">每个视图先把模型变换到视线坐标系，提取轮廓边、折角大于 28° 的棱边和 B-rep 面边界；再用 BVH 找出每条边上方可能遮挡它的三角形，把边裁成可见段和被遮挡段（隐藏线）。</p>
      ${kpis([['视图', keys.length], ['可见线段', fmt(seg.visible, 0)], ['隐藏线段', fmt(seg.hidden, 0)], ['投影法', state.opts.projection === 'first' ? '第一角' : '第三角'], ['耗时', fmtMs(stepStatus.hlr?.ms)]])}
      <h4>各视图结果</h4>
      <div class="view-grid">${keys.map(k => {
        const r = state.results[k], v = views[k];
        return `<div class="view-card">${viewPreview(r)}<div class="meta"><span><b>${v.label}</b> · 视线 ${vec(v.d.toArray(), 2)}</span><span>可见 ${fmt(r.visible.length / 4, 0)} · 隐藏 ${fmt(r.hidden.length / 4, 0)} · ${r.ms ? fmtMs(r.ms) : '缓存'}</span></div></div>`;
      }).join('')}</div>`;
  },
  sheet() {
    const L = state.layout, sh = state.sheet;
    const byLayer = {};
    let texts = 0, arrows = 0;
    for (const it of sh.items) {
      if (it.t === 'line') byLayer[it.layer] = (byLayer[it.layer] || 0) + 1;
      else if (it.t === 'segs') byLayer[it.layer] = (byLayer[it.layer] || 0) + it.arr.length / 4;
      else if (it.t === 'text') texts++;
      else if (it.t === 'solid') arrows++;
    }
    const LAYER = { VISIBLE: ['粗实线', '0.5'], HIDDEN: ['细虚线', '0.25'], CENTER: ['细点画线', '0.18'], DIM: ['尺寸线', '0.18'], FRAME: ['图框线', '0.7'], FRAME_THIN: ['图纸边界', '0.25'], THIN: ['细实线', '0.25'] };
    const slot = { row1: '第一行右侧', row2: '第二行右侧', corner: '右上角', aboveTitle: '标题栏上方' }[L.isoSlot] || L.isoSlot;
    return `<p class="desc">按投影规则排布三视图（长对正、高平齐、宽相等）。比例从标准系列中由大到小搜索，并尝试多种轴测图摆位，取能放进图框且不压标题栏的最大比例。随后生成外形尺寸、孔径引线（自动避让）、中心线、孔表、技术要求和标题栏。</p>
      ${kpis([['图幅', `${L.paper}（${L.PW}×${L.PH}）`], ['比例', L.scaleText], ['轴测图位置', slot], ['文字', texts], ['箭头', arrows], ['耗时', fmtMs(stepStatus.sheet?.ms)]])}
      <h4>图层与线型</h4>
      <table class="tbl"><tr><th>图层</th><th>线型</th><th class="r">线宽 mm</th><th class="r">图元数</th></tr>
      ${Object.entries(byLayer).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td class="mono">${k}</td><td>${LAYER[k]?.[0] || '—'}</td><td class="r">${LAYER[k]?.[1] || '—'}</td><td class="r">${fmt(v, 0)}</td></tr>`).join('')}</table>
      <h4>视图位置（图纸坐标，mm）</h4>
      <table class="tbl"><tr><th>视图</th><th class="r">X</th><th class="r">Y</th><th class="r">宽</th><th class="r">高</th><th class="r">模型尺寸 (mm)</th></tr>
      ${Object.entries(L.rects).map(([k, r]) => `<tr><td>${L.views[k].label}</td><td class="r">${fmt(r.x0, 1)}</td><td class="r">${fmt(r.y0, 1)}</td><td class="r">${fmt(r.x1 - r.x0, 1)}</td><td class="r">${fmt(r.y1 - r.y0, 1)}</td><td class="r">${fmt(L.ext[k].w, 2)} × ${fmt(L.ext[k].h, 2)}</td></tr>`).join('')}</table>`;
  },
};

// ---------------- 3D 工具栏 ----------------
$$('.viewer-toolbar [data-view]').forEach(b => b.addEventListener('click', () => {
  const v = getViews(state.opts.projection)[b.dataset.view];
  viewer.flyTo(v.d, v.u);
}));
$('#tg-edges').addEventListener('change', e => viewer.setEdges(e.target.selected));
$('#tg-wire').addEventListener('change', e => viewer.setWireframe(e.target.selected));
$('#tg-features').addEventListener('change', e => { viewer.setFeatures(e.target.selected); $('#legend').hidden = !e.target.selected; });
$('#tg-clip').addEventListener('change', e => { $('#clip-box').hidden = !e.target.selected; viewer.setClip(e.target.selected, $('#clip-slider').value / 100); });
$('#clip-slider').addEventListener('input', e => viewer.setClip(true, e.target.value / 100));

$('#mode-tabs').addEventListener('change', (e) => {
  $('#stage-body').className = 'stage-body mode-' + e.target.activeTab.dataset.mode;
  requestAnimationFrame(() => { viewer.resize(); zoomFit(); });
});

// ---------------- 2D 选项 ----------------
$('#proj-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('md-filter-chip');
  if (!chip) return;
  $$('#proj-chips md-filter-chip').forEach(c => { c.selected = c === chip; });
  if (state.opts.projection !== chip.dataset.proj) { state.opts.projection = chip.dataset.proj; generateDrawing(); }
});
$('#sel-paper').addEventListener('change', (e) => { state.opts.paper = e.target.value; generateDrawing(); });
$('#sel-up').addEventListener('change', (e) => {
  if (!state.model || state.opts.up === e.target.value) return;
  state.opts.up = e.target.value;
  state.q = upQuaternion(state.opts.up);
  viewer.setOrientation(state.q);
  renderParams();
  generateDrawing();
});
const layerMenu = $('#layer-menu');
$('#btn-layers').addEventListener('click', () => { layerMenu.open = !layerMenu.open; });
layerMenu.addEventListener('click', (e) => {
  const item = e.target.closest('md-menu-item');
  if (!item) return;
  const k = item.dataset.opt;
  state.opts[k] = !state.opts[k];
  item.querySelector('md-icon').textContent = state.opts[k] ? 'check_box' : 'check_box_outline_blank';
  rebuildSheet();
});
$('#btn-ref').addEventListener('click', () => {
  const s = state.model?.sample;
  if (s) window.open(BASE + 'samples/ref/' + s.file.replace('.stp', '.pdf'), '_blank');
});

// ---------------- 图纸缩放平移 ----------------
const vp = $('#sheet-viewport');
const zoom = { s: 1, x: 0, y: 0 };
function applyZoom() { $('#sheet-canvas').style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`; }
function zoomFit() {
  if (!$('#sheet-canvas svg') || !state.layout) return;
  const { PW, PH } = state.layout;
  const k = 96 / 25.4;
  const w = vp.clientWidth, h = vp.clientHeight;
  if (!w || !h) return;
  zoom.s = Math.min((w - 24) / (PW * k), (h - 24) / (PH * k));
  zoom.x = (w - PW * k * zoom.s) / 2;
  zoom.y = (h - PH * k * zoom.s) / 2;
  applyZoom();
}
function zoomAt(f, cx = vp.clientWidth / 2, cy = vp.clientHeight / 2) {
  const ns = Math.min(40, Math.max(0.05, zoom.s * f));
  zoom.x = cx - (cx - zoom.x) * (ns / zoom.s);
  zoom.y = cy - (cy - zoom.y) * (ns / zoom.s);
  zoom.s = ns;
  applyZoom();
}
vp.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = vp.getBoundingClientRect();
  zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
let drag = null;
vp.addEventListener('pointerdown', (e) => { if (e.target.closest('.sheet-tools')) return; drag = { x: e.clientX - zoom.x, y: e.clientY - zoom.y }; vp.classList.add('dragging'); vp.setPointerCapture(e.pointerId); });
vp.addEventListener('pointermove', (e) => { if (!drag) return; zoom.x = e.clientX - drag.x; zoom.y = e.clientY - drag.y; applyZoom(); });
vp.addEventListener('pointerup', () => { drag = null; vp.classList.remove('dragging'); });
$('#btn-zoom-in').addEventListener('click', () => zoomAt(1.4));
$('#btn-zoom-out').addEventListener('click', () => zoomAt(1 / 1.4));
$('#btn-zoom-fit').addEventListener('click', zoomFit);
new ResizeObserver(() => zoomFit()).observe(vp);

// ---------------- 导出 ----------------
const menu = $('#export-menu');
$('#btn-export').addEventListener('click', () => { menu.open = !menu.open; });
function download(name, data, type) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const baseName = () => (state.model?.fileName || 'drawing').replace(/\.[^.]+$/, '');
menu.addEventListener('close-menu', async (e) => {
  const kind = e.detail.initiator?.dataset.export;
  if (!kind || !state.sheet) return;
  const svg = sheetToSVG(state.sheet, state.layout);
  if (kind === 'svg') download(baseName() + '.svg', svg, 'image/svg+xml');
  if (kind === 'dxf') download(baseName() + '.dxf', sheetToDXF(state.sheet, state.layout), 'application/dxf');
  if (kind === 'png') {
    const { PW, PH } = state.layout;
    const sc = 300 / 25.4;
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(PW * sc), height: Math.round(PH * sc) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    c.toBlob(b => download(baseName() + '.png', b), 'image/png');
  }
  if (kind === 'pdf') {
    const w = window.open('', '_blank');
    const { PW, PH } = state.layout;
    w.document.write(`<!doctype html><title>${baseName()}</title><style>@page{size:${PW}mm ${PH}mm;margin:0}html,body{margin:0}svg{display:block;width:${PW}mm;height:${PH}mm}</style>${svg}<script>setTimeout(()=>print(),300)<\/script>`);
    w.document.close();
  }
});
$('#btn-json').addEventListener('click', () => {
  const m = state.model;
  if (!m) return;
  const data = {
    file: m.fileName, format: m.format, header: m.step?.header, unit: m.step?.unit, products: m.step?.products,
    topology: m.step?.topology, surfaceStats: m.step?.surfaceStats, curveStats: m.step?.curveStats,
    bbox: { min: m.metrics.box.min.toArray(), max: m.metrics.box.max.toArray() },
    volume_mm3: m.metrics.volume, area_mm2: m.metrics.area, triangles: m.metrics.tris,
    features: m.features.map(f => ({ type: f.kind, diameter: +f.d.toFixed(4), axis: f.a.map(v => +v.toFixed(5)), center: f.center.map(v => +v.toFixed(4)), length: +f.length.toFixed(4) })),
  };
  download(baseName() + '.params.json', JSON.stringify(data, null, 2), 'application/json');
});

// ---------------- 关于 ----------------
$('#about-content').innerHTML = `
<h4>处理流水线</h4>
<ul>
<li><b>STEP 实体解析</b>：自研 ISO 10303-21 解析器，提取文件头、单位、产品名、B-rep 拓扑与曲面类型统计。</li>
<li><b>B-rep 网格化</b>：<a href="https://github.com/kovacsv/occt-import-js" target="_blank">occt-import-js</a>（OpenCASCADE → WebAssembly，Web Worker），支持 STEP / IGES / BREP。</li>
<li><b>特征识别</b>：B-rep 面法向协方差分析 + Kåsa 圆拟合，识别孔 / 凸台 / 圆角。</li>
<li><b>消隐投影</b>：<a href="https://github.com/gkjohnson/three-edge-projection" target="_blank">three-edge-projection</a> + <a href="https://github.com/gkjohnson/three-mesh-bvh" target="_blank">three-mesh-bvh</a>。</li>
<li><b>出图</b>：GB 第一角 / ASME 第三角，自动比例、尺寸、孔表、标题栏；导出 SVG / DXF / PNG / PDF。</li>
<li><b>UI</b>：<a href="https://github.com/material-components/material-web" target="_blank">Material Web</a> + three.js。</li>
</ul>
<h4>参考实现</h4>
<ul>
<li><a href="https://github.com/donalffons/opencascade.js" target="_blank">opencascade.js</a>：完整 OCCT WASM，可用 HLRBRep 做精确 B-rep 消隐。</li>
<li><a href="https://drawlytic.com/" target="_blank">Drawlytic</a>：基于 opencascade.js 的在线 STEP→2D 出图产品。</li>
<li><a href="https://github.com/LAU-MARS/opencascade-ts" target="_blank">occt.ts</a>：TypeScript OCCT 绑定，内置 hiddenLines → SVG。</li>
<li>FreeCAD TechDraw / CadQuery / build123d：服务端 Python 出图方案。</li>
</ul>
<h4>样例数据</h4>
<p>NIST MBE PMI Validation and Conformance Testing Project 公开 CAD 模型（CTC / FTC），无使用限制。</p>`;
$('#btn-about').addEventListener('click', () => $('#about-dialog').show());

const qs = new URLSearchParams(location.search).get('sample');
if (qs) { const s = SAMPLES.find(x => x.id === qs); if (s) openSample(s).catch(err => toast(err.message)); }

// ---------------- 开发工具：预生成样例缩略图（npm run dev 后在控制台执行 __app.generateThumbnails()） ----------------
const demoMode = new URLSearchParams(location.search).has('demo');
if (demoMode) import('./demo/stage.js');
if (import.meta.env.DEV || demoMode) {
  window.__app = {
    state, viewer, sheetToSVG, sheetToDXF,
    async generateThumbnails() {
      const done = [];
      for (const s of SAMPLES) {
        await openSample(s);
        await new Promise(r => setTimeout(r, 900));
        const data = viewer.renderThumbnail(360, 248);
        const r = await fetch('/__thumb', { method: 'POST', body: JSON.stringify({ id: s.id, data }) });
        done.push([s.id, r.status]);
      }
      renderSamples(state.model?.sample?.id);
      return done;
    },
  };
}
