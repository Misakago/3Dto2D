// 逐帧确定性录制：虚拟时钟 + CDP 截图 + ffmpeg 合成
// 用法：npm run build && node scripts/record-demo.mjs [--fps 60] [--scale 1.3333] [--q 92] [--out out/xxx.mp4] [--max 0] [--snap 0] [--dry]
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const FPS = +arg('fps', 60), SCALE = +arg('scale', 4 / 3), Q = +arg('q', 92);
const DRY = process.argv.includes('--dry');
const OUT = arg('out', 'out/3D转2D工程图-Demo讲解.mp4'), MAX = +arg('max', 0), SNAP = +arg('snap', 0);
const PORT = 4174;
mkdirSync('out', { recursive: true });
if (SNAP) mkdirSync('out/snap', { recursive: true });

// 不额外安装依赖：依次尝试本项目、PLAYWRIGHT_DIR 指定目录、全局 Playwright
function loadPlaywright() {
  const candidates = [
    process.cwd(),
    process.env.PLAYWRIGHT_DIR,
    path.join(execSync('npm root -g').toString().trim(), 'playwright'),
  ];
  for (const base of candidates.filter(Boolean)) {
    for (const name of ['playwright-core', 'playwright']) {
      try { return createRequire(path.join(base, 'noop.js'))(name); } catch { /* 下一个 */ }
    }
  }
  throw new Error('未找到 playwright-core / playwright');
}
const { chromium } = loadPlaywright();

if (!existsSync('dist/index.html')) throw new Error('请先执行 npm run build');
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
process.on('exit', () => server.kill());
process.on('uncaughtException', (e) => { console.error(e); server.kill(); process.exit(1); });

const VCLOCK = `(() => {
  const realNow = performance.now.bind(performance)
  window.__realNow = realNow
  let now = 0; const t0 = Date.now(); let tid = 1, rid = 1
  const timers = new Map(), rafs = new Map()
  performance.now = () => now
  Date.now = () => t0 + now
  window.setTimeout = (fn, ms = 0, ...a) => { const id = tid++; timers.set(id, { at: now + Math.max(0, +ms || 0), fn, a, iv: 0 }); return id }
  window.setInterval = (fn, ms = 0, ...a) => { const iv = Math.max(1, +ms || 0); const id = tid++; timers.set(id, { at: now + iv, fn, a, iv }); return id }
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id) }
  window.requestAnimationFrame = (fn) => { const id = rid++; rafs.set(id, fn); return id }
  window.cancelAnimationFrame = (id) => { rafs.delete(id) }
  // Motion 检测到没有 Element.prototype.animate 时改用 JS 引擎（跟随虚拟时钟）；
  // Material Web 组件仍可调用 HTMLElement.animate，动画立即完成
  const nativeAnimate = Element.prototype.animate
  delete Element.prototype.animate
  HTMLElement.prototype.animate = function (k, o) { const a = nativeAnimate.call(this, k, o); try { a.finish() } catch (e) {} return a }
  const tick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0) })
  window.__advance = async (dt) => {
    const target = now + dt
    for (let guard = 0; guard < 500; guard++) {
      let best = null
      for (const [id, t] of timers) if (t.at <= target && (!best || t.at < best[1].at || (t.at === best[1].at && id < best[0]))) best = [id, t]
      if (!best) break
      const [id, t] = best
      now = Math.max(now, t.at)
      if (t.iv) t.at += t.iv; else timers.delete(id)
      try { typeof t.fn === 'function' ? t.fn(...t.a) : 0 } catch (e) { console.error(e) }
      await Promise.resolve(); await tick()
    }
    now = target
    for (let i = 0; i < 3; i++) await tick()
    const cbs = [...rafs.values()]; rafs.clear()
    for (const cb of cbs) { try { cb(now) } catch (e) { console.error(e) } }
    await tick()
    return now
  }
})()`;

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/External/Google Chrome.app/Contents/MacOS/Google Chrome', `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`].find(existsSync);
const browser = await chromium.launch({ ...(process.env.CHROME_PATH || CHROME ? { executablePath: process.env.CHROME_PATH || CHROME } : { channel: 'chrome' }), headless: true, args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--hide-scrollbars', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: SCALE, colorScheme: 'light' });
page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(VCLOCK);
// 新版 Chrome 下 Playwright 的视口模拟不生效，直接用 CDP 固定 1440×810 @4/3（输出 1920×1080）
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 810, deviceScaleFactor: SCALE, mobile: false });
await page.goto(`http://localhost:${PORT}/?demo`);
// 虚拟时钟接管了 rAF/setTimeout，在 Node 侧轮询就绪（字体、缩略图按真实时间加载）
for (let i = 0; ; i++) {
  const ok = await page.evaluate(() => window.__ctlReady === true && document.fonts.status === 'loaded'
    && document.fonts.check('24px "Material Symbols Outlined"')
    && [...document.querySelectorAll('.thumb')].every((im) => im.complete && im.naturalWidth > 0));
  if (ok) break;
  if (i > 300) throw new Error('页面未就绪');
  await page.evaluate(() => window.__advance(16.7));
  await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, 800));
await page.evaluate(() => { window.__startDemo(); });

const W = Math.round(1440 * SCALE), H = Math.round(810 * SCALE);
const ff = DRY ? null : spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
  '-vf', `scale=${W - (W % 2)}:${H - (H % 2)}:flags=lanczos:in_range=pc:out_range=tv,format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-tune', 'animation', '-r', String(FPS), '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });

const dt = 1000 / FPS;
let f = 0;
const t0 = Date.now();
while (true) {
  // 快进：长时间计算时页面时钟按真实时间推进，但不截帧
  if (await page.evaluate((d) => window.__advance(d).then(() => !!window.__ffwd), dt)) {
    const r0 = Date.now();
    while (await page.evaluate(() => !!window.__ffwd)) {
      await new Promise((r) => setTimeout(r, 100));
      await page.evaluate(() => window.__advance(100));
      if ((Date.now() - r0) % 10000 < 120) process.stdout.write(`\r快进中 · 真实 ${((Date.now() - r0) / 1000).toFixed(0)}s`.padEnd(90));
    }
  }
  if (DRY) await new Promise((r) => setTimeout(r, dt));
  else {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: Q, optimizeForSpeed: true });
    const buf = Buffer.from(data, 'base64');
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (SNAP && f % SNAP === 0) writeFileSync(`out/snap/${String(f).padStart(6, '0')}.jpg`, buf);
  }
  f++;
  if (f % (FPS * 10) === 0) {
    const st = await page.evaluate(() => ({ err: window.__demoError || '', cap: (window.__caps || []).slice(-1)[0] }));
    process.stdout.write(`\r${(f / FPS).toFixed(0)}s 视频 · 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s · ${st.cap?.text || st.cap?.chapter?.title || ''}`.padEnd(90));
    if (st.err) { console.log('\n脚本错误:', st.err); break; }
  }
  if (MAX && f >= MAX) break;
  if (f % FPS === 0 && await page.evaluate(() => !!(window.__demoDone || window.__demoError))) break;
}
const err = await page.evaluate(() => window.__demoError || '');
if (err) console.log('\n脚本错误:', err);
writeFileSync('out/timeline.json', JSON.stringify(await page.evaluate(() => window.__caps), null, 1));
if (ff) { ff.stdin.end(); await new Promise((r) => ff.on('close', r)); }
await browser.close();
server.kill();
console.log(`\n完成：${DRY ? '(dry run)' : OUT} · ${f} 帧 · ${(f / FPS).toFixed(1)}s`);
process.exit(0);
