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

## 冲模设计（冲压件）

加载等厚、单向折弯的钣金件后，“冲模设计”标签页按以下 6 步自动出图（流程参考级进模设计的常规步骤）：

1. **产品前期处理**：3D / 2D / 展开图 / 尺寸调整（调整折弯内 R）/ 接刀图
2. **料带生成**：步距、料宽、载体、导正孔、各工位冲头与截面成形过程，材料利用率
3. **零件与模板外形**：模板与模座外形、料带位置、导柱
4. **模具总装图**：8 块模板叠层、冲头、闭合高度、件号泡泡
5. **模板拆分与标注**：UP / UB / PH / PPS / PS / DIE / LB / LP 逐板出图，孔代号 + 坐标尺寸 + 加工说明
6. **标准件与加工零件清单**：模板、冲头、导柱导套、螺丝、合销、弹簧、导正销等

实现：`src/sheetmetal.js`（料厚识别、截面切片、折弯角 / 内 R、K 因子展开、展开轮廓映射；平板件直接投影），`src/stamping.js`（排样与模具结构规则），`src/stampingSheets.js`（图纸）。设计参数（K 因子、调整 R、搭边、载体宽、连接颈、导正孔径）可在页面左下修改，结果即时重算；可导出当前图纸 SVG / DXF、全部图纸合并 DXF、零件清单 CSV。模架与标准件为经验规则生成，供方案评审使用。

## 注塑前处理

“注塑前处理”标签页有两个工具：

- **去除小圆角**：识别半径 ≤ 阈值（默认 0.3 mm）的圆角面（圆柱 / 圆环 / 球面，以及曲率半径满足条件的 B 样条过渡面），按相连关系分组成链，用 opencascade.js 的 `BRepAlgoAPI_Defeaturing` 逐链删除并延伸相邻面重建实体。单链超过 20 秒会中止、回滚并跳过。删不掉的圆角按原因分类列出（与大圆角相接、相邻为自由曲面、超时、延伸后无法闭合）。结果可导出 STEP。实现见 `src/injection/occWorker.js`。
- **网格纵横比优化**：读取 STL / Nastran（.nas/.bdf）/ Patran（.pat）三角网格，或用当前 CAD 模型的三角化。纵横比按 Moldflow 定义计算（最长边 / 该边上的高，正三角形为 1.155）。先做带特征边约束的各向同性重网格，再对超标单元局部修复，目标是最大纵横比 ≤ 4。节点会投影回原始曲面，并报告偏差。结果可导出 NAS / STL。实现见 `src/meshopt.js`。

Moldflow 的 `.sdy` 工程文件是加密格式，无法直接读取，需要先在 Moldflow 中把网格导出为 STL / NAS / PAT / UDM。

本地样例：在 `public/samples/local/` 放入模型和 `manifest.json`（该目录不进仓库），会出现在样例库顶部。

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
