// 演示剧本：片头 → 01 模型解析 → 02 特征识别 → 03 自动出图 → 04 投影规范 → 05 过程追溯 → 06 参数与导出 → 片尾
import { W, H } from './stage.js';

export async function run(ctl) {
  const { sleep, q } = ctl;
  const app = () => window.__app.state;

  async function say(text, sub, hold) {
    await ctl.caption(text, sub);
    await sleep(hold ?? Math.max(2000, 700 + text.length * 112));
  }
  async function chapter(no, icon, title, sub, p) {
    await ctl.caption(null);
    await ctl.cursorShow(false);
    await ctl.chapterOn({ no, icon, title, sub });
    ctl.setProgress(p);
    await sleep(2300);
    await ctl.chapterOff();
    await sleep(300);
  }
  // 在图纸视口派发滚轮事件，复用应用自身的缩放
  function wheel(factor, at, dur = 1.3) {
    const vp = q('#sheet-viewport');
    const total = -Math.log(factor) / 0.0015;
    const steps = Math.round(dur * 60);
    return (async () => {
      for (let i = 0; i < steps; i++) {
        const k0 = i / steps, k1 = (i + 1) / steps;
        const e = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
        vp.dispatchEvent(new WheelEvent('wheel', { deltaY: (e(k1) - e(k0)) * total, clientX: at[0], clientY: at[1], bubbles: true, cancelable: true }));
        await sleep(1000 / 60);
      }
    })();
  }
  function sheetPoint(mx, my) {
    const r = q('#sheet-canvas svg').getBoundingClientRect();
    const { PW, PH } = app().layout;
    return [r.left + (mx / PW) * r.width, r.top + (my / PH) * r.height];
  }
  function orbit(angle, dur) {
    const v = window.__app.viewer;
    const t = v.controls.target.clone();
    const off = v.camera.position.clone().sub(t);
    const steps = Math.round(dur * 60);
    return (async () => {
      for (let i = 1; i <= steps; i++) {
        const k = i / steps, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2, a = angle * e;
        const c = Math.cos(a), s = Math.sin(a);
        v.camera.position.set(t.x + off.x * c - off.y * s, t.y + off.x * s + off.y * c, t.z + off.z);
        v.camera.lookAt(t);
        await sleep(1000 / 60);
      }
    })();
  }
  const done = (k) => q(`.step[data-step="${k}"].done`);
  window.__demoPace = 650;

  // ---------- 片头 ----------
  await sleep(4200);
  await ctl.introOut();
  await say('左侧是复杂零件样例库，也可以上传自己的模型', '工作台');
  await ctl.hl('.panel.left');
  await say('支持 STEP、IGES、STL 等格式', '工作台', 2200);
  await ctl.hl(null);

  // ---------- 01 模型解析 ----------
  await chapter('01', 'data_array', '模型解析', '解析 STEP 并网格化', 0.1);
  await ctl.hl('#samples md-list-item[data-id="ctc02"]', 4);
  await ctl.caption('打开铸造壳体 CTC-02', '01 模型解析');
  await sleep(1600);
  await ctl.click('#samples md-list-item[data-id="ctc02"]');
  await ctl.hl(null);
  await ctl.cursorShow(false);
  await ctl.focus('#pipeline', { s: 1.7, dur: 0.9, dy: -120 });
  await ctl.caption('六个处理步骤依次完成，显示实际耗时', '01 模型解析');
  await ctl.waitFor(() => done('feature'));
  await sleep(1400);
  await ctl.unfocus(0.9);
  await ctl.waitFor(() => done('sheet'));
  await sleep(400);
  await say('全部在浏览器本地完成，文件不上传', '01 模型解析', 2400);

  // ---------- 02 特征识别 ----------
  const m = app().model;
  const nHole = m.features.filter(f => f.kind === 'hole').length;
  const nFillet = m.features.filter(f => f.kind === 'fillet').length;
  await chapter('02', 'adjust', '特征识别', '自动识别孔、凸台与圆角', 0.26);
  await ctl.click('#tg-features');
  await ctl.cursorShow(false);
  await ctl.focus('.pane-3d', { s: 1.25, dur: 1, dy: 0, margin: 40 });
  await ctl.caption(`识别出 ${nHole} 个孔、${nFillet} 处圆角`, '02 特征识别');
  await orbit(Math.PI * 0.6, 4);
  await sleep(600);
  await ctl.unfocus(0.9);
  await ctl.click('#tg-features');
  await say('识别结果直接用于标注和孔表', '02 特征识别', 2400);

  // ---------- 03 自动出图 ----------
  await chapter('03', 'architecture', '自动出图', '消隐投影，自动布局与标注', 0.44);
  await ctl.click('md-primary-tab[data-mode="2d"]');
  await ctl.cursorShow(false);
  await sleep(700);
  await say(`三视图 + 轴测图，比例 ${app().layout.scaleText}`, '03 自动出图', 2800);
  const L = app().layout;
  const fr = L.rects.top;
  await ctl.caption('隐藏线、中心线自动生成', '03 自动出图');
  await wheel(3, sheetPoint((fr.x0 + fr.x1) / 2, (fr.y0 + fr.y1) / 2));
  await sleep(2600);
  q('#btn-zoom-fit').click();
  await sleep(600);
  const t = L.title;
  await ctl.caption('孔径标注、孔表、标题栏一并生成', '03 自动出图');
  await wheel(2.6, sheetPoint(t.x0 + 70, t.y0 - 18));
  await sleep(2800);
  q('#btn-zoom-fit').click();
  await sleep(500);

  // ---------- 04 投影规范 ----------
  await chapter('04', 'swap_horiz', '投影规范', 'GB 第一角 ⇄ ASME 第三角', 0.6);
  await ctl.caption('切换到 ASME 第三角投影', '04 投影规范');
  await ctl.click('md-filter-chip[data-proj="third"]');
  await ctl.cursorShow(false);
  await ctl.waitFor(() => done('sheet'));
  await sleep(2400);
  await ctl.caption('切回 GB 第一角投影', '04 投影规范');
  await ctl.click('md-filter-chip[data-proj="first"]');
  await ctl.cursorShow(false);
  await ctl.waitFor(() => done('sheet'));
  await sleep(2400);

  // ---------- 05 过程追溯 ----------
  await chapter('05', 'timeline', '过程可追溯', '每一步都可查看', 0.76);
  await ctl.click('md-primary-tab[data-mode="split"]');
  await sleep(400);
  await ctl.caption('点击步骤查看处理详情', '05 过程追溯');
  await ctl.hl('.step[data-step="feature"]', 4);
  await sleep(900);
  await ctl.hl(null);
  await ctl.click('.step[data-step="feature"]', { raise: true });
  await sleep(500);
  await say('特征识别：每个特征的尺寸与位置', '05 过程追溯', 2800);
  await ctl.click('#inspector-nav md-list-item[data-key="hlr"]');
  await say('消隐投影：各视图的投影结果', '05 过程追溯', 2800);
  await ctl.click('#inspector-nav md-list-item[data-key="overview"]');
  await say('总览：各步骤耗时', '05 过程追溯', 2400);
  q('#step-dialog').close();
  await sleep(500);

  // ---------- 06 参数与导出 ----------
  await chapter('06', 'download', '参数与导出', '参数查看与图纸导出', 0.9);
  await ctl.click('#btn-params');
  await sleep(700);
  await ctl.cursorShow(false);
  await ctl.focus('#params', { s: 1.4, dur: 0.9, margin: 60 });
  await say('模型参数：尺寸、体积、拓扑、曲面类型', '06 参数与导出', 2800);
  await ctl.unfocus(0.8);
  await ctl.click('#btn-params');
  await sleep(500);
  await ctl.click('#btn-export', { raise: true });
  await say('导出 DXF、SVG、PNG、PDF', '06 参数与导出', 2600);
  q('#export-menu').open = false;
  await sleep(400);
  await ctl.caption('浅色 / 深色主题', '06 参数与导出');
  await ctl.click('#btn-theme');
  await sleep(2200);
  await ctl.click('#btn-theme');
  await sleep(900);

  // ---------- 片尾 ----------
  await ctl.caption(null);
  await ctl.cursorShow(false);
  ctl.setProgress(1);
  await ctl.outroIn();
  await sleep(6500);
}

export { W, H };
