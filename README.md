# 3D→2D 智能工程图引擎（Demo）

在浏览器里上传 3D CAD 模型。程序解析参数、识别孔/轴/圆角特征，用 HLR 消隐投影生成带标注的 2D 工程图，可导出 SVG / DXF / PNG / PDF。
UI 用的是 [Material Web](https://github.com/material-components/material-web)（Material 3）组件库。

```bash
npm install
npm run dev        # http://localhost:5199 ，?sample=ctc02 直接打开样例
npm run build      # 静态产物在 dist/，可直接部署
```

## 界面

- 顶栏的 6 个处理步骤都能点击，打开“处理详情”：总览耗时时间轴，以及各步骤的参数、统计、实体类型分布、特征明细表、每个视图的投影预览、图层统计
- 支持浅色 / 深色主题（默认跟随系统，右上角可切换）
- 右侧“模型参数”面板默认折叠（舞台右上角的按钮展开），面板内分组也可以单独折叠
- 样例缩略图是预先生成的静态文件，放在 `public/samples/thumbs/`。增加样例后，运行 `npm run dev`，在浏览器控制台执行 `await __app.generateThumbnails()` 重新生成

## 演示视频录制

`index.html?demo` 加载演示舞台（`src/demo/`，基于 [Motion](https://motion.dev)）：镜头、光标、字幕、章节卡由脚本驱动真实应用。
`scripts/record-demo.mjs` 注入虚拟时钟，逐帧截图后交给 ffmpeg 合成 1920×1080 / 60 fps 的 MP4，输出到 `out/`。

```bash
npm run build
PLAYWRIGHT_DIR=/path/to/dir-with-playwright-core node scripts/record-demo.mjs   # 需要本机安装 Chrome 与 ffmpeg
```

## 处理流水线

| 步骤 | 实现 | 说明 |
|---|---|---|
| STEP 实体解析 | `src/stepParser.js`（自研） | 提取文件头、AP 版本、单位、产品名、B-rep 拓扑（实体/面/边/顶点）、曲面与曲线类型统计 |
| B-rep 网格化 | [occt-import-js](https://github.com/kovacsv/occt-import-js)（OpenCASCADE → WASM，Web Worker） | 支持 STEP/IGES/BREP，保留 B-rep 面 ↔ 三角面映射；STL/OBJ/GLB/PLY 用 three.js 加载器 |
| 特征识别 | `src/features.js`（自研） | 对每个 B-rep 面做法向协方差分析（区分平面/圆柱面）和 Kåsa 圆拟合，再按同轴同径合并，判断孔、凸台/轴、圆角；不依赖单位和装配变换 |
| HLR 消隐投影 | [three-edge-projection](https://github.com/gkjohnson/three-edge-projection) + [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | 用 BVH 加速计算可见线和隐藏线；最复杂的 CTC-02（7.6 万三角面）四个视图约 2 s |
| 出图 | `src/drawing.js`（自研） | 支持 GB 第一角 / ASME 第三角布局，自动选标准比例并选轴测图摆位；生成外形尺寸、孔径引线（带避让）、中心线、孔表、技术要求、GB 风格标题栏和投影符号 |

## 调研：现成库与参考实现

- **opencascade.js**：完整的 OCCT WASM，可以用 `HLRBRep_Algo` 在精确 B-rep 上消隐，精度最高。缺点是体积 30MB+、API 偏底层，适合作为生产版的升级方向。
- **Drawlytic**（drawlytic.com）：基于 opencascade.js 的商业在线 STEP→2D 出图产品，说明浏览器内 HLR + 自动标注做得出来。
- **occt.ts**（LAU-MARS/opencascade-ts）：TypeScript 的 OCCT 绑定，自带 `hiddenLines()` → SVG。
- **FreeCAD TechDraw / CadQuery / build123d**：服务端 Python 方案，能做正式的带标注工程图，适合后端批量出图。
- **Online3DViewer**（kovacsv）：多格式 3D 浏览的参考实现，和 occt-import-js 是同一作者。

本 Demo 选的是 occt-import-js + three-edge-projection：加载快（WASM 7MB），全部在前端完成，不需要后端。

## 样例零件

`public/samples/` 里是美国 NIST *MBE PMI Validation and Conformance Testing Project* 的公开测试件（AP203 几何，CTC 复杂测试件 / FTC 全公差测试件），可以不受限制地使用。`public/samples/ref/` 是 NIST 的原始 PDF 工程图，2D 工具栏里的“对照”按钮能打开它，方便和自动生成的图纸对比。

## 已知限制

- 消隐基于三角网格，圆弧在图纸上是折线逼近（偏差 ≈ 包围盒的 0.08%）。要精确圆弧需要换 opencascade.js 的 HLRBRep。
- 尺寸只标外形和孔径，没有完整的 GD&T，也没有读取 AP242 的语义 PMI。
- DXF 是 R12 ASCII，中文写成 `\U+XXXX` 转义（AutoCAD、中望能识别）。
