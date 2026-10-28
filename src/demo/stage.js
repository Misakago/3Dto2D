// 演示舞台：在应用外包一层镜头，并叠加光标、高亮框、字幕、章节卡、片头片尾与进度条
// 由 index.html?demo 加载；录制脚本调用 window.__startDemo()
import { animate } from 'motion';
import './stage.css';

export const W = 1440, H = 810;
const EASE = [0.22, 1, 0.36, 1];
const CAM_EASE = [0.65, 0, 0.35, 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- DOM ----------
const app = document.getElementById('app');
const cam = document.createElement('div');
cam.className = 'demo-cam';
app.parentNode.insertBefore(cam, app);
cam.appendChild(app);
document.body.classList.add('demo-mode');

const hl = el('div', 'demo-hl', cam);
// 所有叠加层放进一个 popover，保证在对话框 / 菜单（浏览器顶层）之上
const overlay = el('div', 'demo-overlay', document.body);
overlay.popover = 'manual';
overlay.showPopover();
const cursor = el('div', 'demo-cursor', overlay);
cursor.innerHTML = '<svg width="26" height="30" viewBox="0 0 26 30"><path d="M4 3 L4 24 L9.5 18.6 L13.4 27 L17 25.4 L13.2 17.2 L21 17.2 Z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
const caption = el('div', 'demo-caption', overlay);
const progress = el('div', 'demo-progress', overlay);
const progressFill = el('div', 'demo-progress-fill', progress);
const chapter = el('div', 'demo-chapter', overlay);
const intro = el('div', 'demo-card demo-intro', overlay);
const outro = el('div', 'demo-card demo-outro', overlay);

function el(tag, cls, parent) { const e = document.createElement(tag); e.className = cls; parent.appendChild(e); return e; }

intro.innerHTML = `
  <div class="logo"><span class="ms">architecture</span></div>
  <div class="t1">3D→2D 工程图生成</div>
  <div class="t2">3D 模型自动生成工程图</div>
  <div class="pills">${['参数解析', '特征识别', 'HLR 消隐投影', 'GB / ASME 投影', '冲模设计', '注塑前处理', 'DXF 导出'].map(t => `<span>${t}</span>`).join('')}</div>
  <div class="foot">演示零件：NIST CTC-02</div>`;
outro.innerHTML = `
  <div class="t1">3D 模型到工程图，几秒完成</div>
  <div class="grid">${[
    ['data_array', '参数解析', '尺寸、体积、拓扑、曲面类型'],
    ['adjust', '特征识别', '孔、凸台、圆角'],
    ['architecture', '标准出图', '三视图、尺寸、孔表、标题栏'],
    ['precision_manufacturing', '冲模设计', '展开 · 排样 · 模板 · 清单'],
    ['water_drop', '注塑前处理', '去小圆角 · 网格纵横比 ≤ 4'],
    ['download', '多格式导出', 'DXF · SVG · PNG · PDF'],
  ].map(([ic, t, d]) => `<div class="cell"><span class="ms">${ic}</span><b>${t}</b><span class="d">${d}</span></div>`).join('')}</div>
  <div class="foot">浏览器本地运行</div>`;

// ---------- 状态 ----------
const camState = { x: 0, y: 0, s: 1 };
const curState = { x: W * 0.62, y: H * 0.66, s: 1, o: 0 };
const hlState = { x: 0, y: 0, w: 0, h: 0, o: 0 };
const applyCam = () => { cam.style.transform = `translate(${camState.x}px, ${camState.y}px) scale(${camState.s})`; };
const applyCur = () => { cursor.style.transform = `translate(${curState.x}px, ${curState.y}px) scale(${curState.s})`; cursor.style.opacity = curState.o; };
const applyHl = () => Object.assign(hl.style, { left: hlState.x + 'px', top: hlState.y + 'px', width: hlState.w + 'px', height: hlState.h + 'px', opacity: hlState.o });
applyCur();
let captionShown = false;

// 对普通对象做补间（Motion 的 JS 动画引擎，跟随页面帧循环）
function tween(obj, to, opts, apply) {
  return animate(obj, to, { ...opts, onUpdate: apply });
}

const q = (sel) => (typeof sel === 'string' ? document.querySelector(sel) : sel);
// 应用坐标（未经镜头变换），用于镜头与高亮框
function appRect(target) {
  const r = q(target).getBoundingClientRect();
  return { x: (r.left - camState.x) / camState.s, y: (r.top - camState.y) / camState.s, w: r.width / camState.s, h: r.height / camState.s };
}
const unionRect = (list) => {
  const rs = list.map(appRect);
  const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y));
  return { x: x0, y: y0, w: Math.max(...rs.map(r => r.x + r.w)) - x0, h: Math.max(...rs.map(r => r.y + r.h)) - y0 };
};

export const ctl = {
  sleep, q,
  async waitFor(test, timeout = 60000) {
    const fn = typeof test === 'string' ? () => q(test) : test;
    const t0 = performance.now();
    while (!fn()) {
      if (performance.now() - t0 > timeout) throw new Error('waitFor 超时：' + test);
      await sleep(50);
    }
    await sleep(60);
    return fn();
  },

  // 镜头
  camera({ x = 0, y = 0, s = 1, dur = 1.2 } = {}) {
    return tween(camState, { x, y, s }, { duration: dur, ease: CAM_EASE }, applyCam);
  },
  async focus(targets, { s = 1.4, dur = 1.1, dy = -20, margin = 120 } = {}) {
    const r = unionRect(Array.isArray(targets) ? targets : [targets]);
    const fit = Math.min((W - margin) / r.w, (H - margin - 90) / r.h);
    const sc = Math.max(1, Math.min(s, fit));
    let x = W / 2 - (r.x + r.w / 2) * sc, y = H / 2 + dy - (r.y + r.h / 2) * sc;
    x = Math.min(0, Math.max(W - W * sc, x));
    y = Math.min(0, Math.max(H - H * sc, y));
    await ctl.camera({ x, y, s: sc, dur });
  },
  unfocus(dur = 1.0) { return ctl.camera({ x: 0, y: 0, s: 1, dur }); },

  // 高亮框（在镜头层内，随镜头缩放）
  async hl(targets, pad = 8) {
    if (!targets) { await tween(hlState, { o: 0 }, { duration: 0.35 }, applyHl); return; }
    const r = unionRect(Array.isArray(targets) ? targets : [targets]);
    const to = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
    if (hlState.o < 0.05) { Object.assign(hlState, to); applyHl(); }
    else tween(hlState, to, { duration: 0.6, ease: EASE }, applyHl);
    await tween(hlState, { o: 1 }, { duration: 0.4 }, applyHl);
  },

  // 光标（屏幕坐标）
  cursorShow(v = true) { return tween(curState, { o: v ? 1 : 0 }, { duration: 0.35 }, applyCur); },
  async moveTo(target, { dx = 0, dy = 0, dur } = {}) {
    const e = await ctl.waitFor(() => q(target));
    const r = e.getBoundingClientRect();
    const tx = r.left + r.width / 2 + dx, ty = r.top + r.height / 2 + dy;
    const dist = Math.hypot(tx - curState.x, ty - curState.y);
    const d = dur ?? Math.min(1.1, Math.max(0.5, 0.35 + dist / 1100));
    if (curState.o < 1) tween(curState, { o: 1 }, { duration: 0.3 }, applyCur);
    // 轻微弧线
    const mx = (curState.x + tx) / 2 + (ty - curState.y) * 0.08, my = (curState.y + ty) / 2 - (tx - curState.x) * 0.08;
    await tween(curState, { x: [curState.x, mx, tx], y: [curState.y, my, ty] }, { duration: d, ease: [0.55, 0.05, 0.25, 1], times: [0, 0.5, 1] }, applyCur);
    return e;
  },
  async click(target, opt = {}) {
    const e = await ctl.moveTo(target, opt);
    await sleep(opt.pre ?? 140);
    await tween(curState, { s: 0.82 }, { duration: 0.09 }, applyCur);
    const ring = el('span', 'demo-ripple', overlay);
    ring.style.left = curState.x - 26 + 'px';
    ring.style.top = curState.y - 26 + 'px';
    animate(ring, { scale: [0.2, 1], opacity: [0.55, 0] }, { duration: 0.75, ease: 'easeOut' }).then(() => ring.remove());
    e.click();
    if (opt.raise) { await sleep(30); ctl.raise(); }
    await tween(curState, { s: 1 }, { type: 'spring', stiffness: 500, damping: 30 }, applyCur);
    await sleep(opt.post ?? 260);
    return e;
  },

  // 叠加层重新置顶（打开对话框 / 菜单后调用）
  raise() { overlay.hidePopover(); overlay.showPopover(); },

  // 字幕
  async caption(text, sub) {
    (window.__caps ||= []).push({ t: performance.now(), text, sub });
    if (captionShown) await animate(caption, { opacity: 0, y: -6 }, { duration: 0.25, ease: EASE });
    captionShown = !!text;
    if (!text) return;
    caption.innerHTML = (sub ? `<span class="sub">${sub}</span>` : '') + `<span class="txt">${text}</span>`;
    await animate(caption, { opacity: [0, 1], y: [14, 0] }, { duration: 0.45, ease: EASE });
  },

  // 章节卡
  async chapterOn({ no, title, sub, icon }) {
    (window.__caps ||= []).push({ t: performance.now(), chapter: { no, title, sub } });
    chapter.innerHTML = `<div class="inner"><span class="no">${no}</span><span class="bar"></span><div class="txts">
      <span class="t">${title}</span><span class="s"><span class="ms">${icon}</span>${sub}</span></div></div>`;
    await animate(chapter, { opacity: [0, 1] }, { duration: 0.5, ease: EASE });
    animate(chapter.querySelector('.no'), { opacity: [0, 1], x: [-24, 0] }, { duration: 0.6, ease: EASE });
    animate(chapter.querySelector('.bar'), { scaleY: [0, 1] }, { duration: 0.5, ease: EASE, delay: 0.1 });
    animate(chapter.querySelector('.t'), { opacity: [0, 1], y: [16, 0] }, { duration: 0.6, ease: EASE, delay: 0.18 });
    animate(chapter.querySelector('.s'), { opacity: [0, 1], y: [10, 0] }, { duration: 0.6, ease: EASE, delay: 0.32 });
  },
  chapterOff() { return animate(chapter, { opacity: 0 }, { duration: 0.45, ease: EASE }); },

  setProgress(p) { return animate(progressFill, { scaleX: p }, { duration: 0.9, ease: EASE }); },
  async introOut() {
    await animate(intro, { opacity: 0, scale: 1.03 }, { duration: 0.8, ease: EASE });
    intro.remove();
    animate(progress, { opacity: 1 }, { duration: 0.4 });
  },
  async introIn() {
    const kids = [...intro.children];
    kids.forEach(k => { k.style.opacity = 0; });
    kids.forEach((k, i) => animate(k, { opacity: [0, 1], y: [18, 0] }, { duration: 0.8, ease: EASE, delay: 0.2 + i * 0.18 }));
  },
  async outroIn() {
    await animate(progress, { opacity: 0 }, { duration: 0.3 });
    outro.style.display = 'grid';
    await animate(outro, { opacity: [0, 1] }, { duration: 0.7, ease: EASE });
    [...outro.querySelectorAll('.cell')].forEach((c, i) => animate(c, { opacity: [0, 1], y: [16, 0] }, { duration: 0.6, ease: EASE, delay: 0.15 + i * 0.12 }));
  },
};

window.__ctl = ctl;
window.__startDemo = async () => {
  try {
    const { run } = await import('./director.js');
    await run(ctl);
    window.__demoDone = true;
  } catch (e) {
    console.error(e);
    window.__demoError = String(e?.stack || e);
  }
};
ctl.introIn();
window.__ctlReady = true;
if (new URLSearchParams(location.search).has('autoplay')) window.__startDemo();
