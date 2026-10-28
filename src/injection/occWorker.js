// OpenCASCADE（完整版 WASM）Worker：识别小圆角，用 BRepAlgoAPI_Defeaturing 逐链去除
// 每次只处理一条圆角链，成功后回传 BRep 快照；主线程超时会终止本 Worker 并从快照恢复
import ocFactory from 'opencascade.js/dist/opencascade.full.js';
import wasmUrl from 'opencascade.js/dist/opencascade.full.wasm?url';

let oc = null;
let shape = null;
let srcFaceCount = 0;
const chainFaces = new Map(); // 圆角链 id → 当前形状中的面对象

const post = (msg, tr) => self.postMessage(msg, tr || []);

async function load(wasmBinary) {
  if (oc) return;
  let buf = wasmBinary;
  if (!buf) {
    post({ type: 'progress', stage: '加载几何内核', frac: 0 });
    const res = await fetch(wasmUrl);
    const total = +res.headers.get('content-length') || 50e6;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      post({ type: 'progress', stage: `加载几何内核 ${(got / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`, frac: (got / total) * 0.9 });
    }
    buf = new Uint8Array(got);
    let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
    post({ type: 'wasm', bytes: buf.slice(0) }); // 主线程缓存，Worker 重启时复用
  }
  post({ type: 'progress', stage: '初始化几何内核', frac: 0.95 });
  oc = await new ocFactory({ wasmBinary: buf, locateFile: (p) => (p.endsWith('.wasm') ? wasmUrl : p) });
}

const progressRange = () => new oc.Message_ProgressRange_1();
function exploreFaces(sh) {
  const out = [];
  const ex = new oc.TopExp_Explorer_2(sh, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) out.push(oc.TopoDS.Face_1(ex.Current()));
  ex.delete();
  return out;
}
function edgesOf(f) {
  const out = [];
  const ex = new oc.TopExp_Explorer_2(f, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) out.push(ex.Current());
  ex.delete();
  return out;
}
// 面的几何签名：面积 + 形心（用于在恢复后的形状中重新定位）
function signature(f) {
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.SurfaceProperties_1(f, props, false, false);
  const c = props.CentreOfMass();
  const sig = [props.Mass(), c.X(), c.Y(), c.Z()];
  props.delete();
  return sig;
}
// 圆角链的稳定标识：链中面积最小的面的签名（四舍五入）
const chainKey = (sigs) => { const s = [...sigs].sort((x, y) => x[0] - y[0])[0]; return s.map(v => v.toFixed(3)).join(','); };
const sameSig = (a, b) => Math.abs(a[0] - b[0]) <= 1e-4 * Math.max(a[0], 1e-6) + 1e-7 && Math.hypot(a[1] - b[1], a[2] - b[2], a[3] - b[3]) < 1e-3;

// 圆角判定：圆柱 / 圆环 / 球面（非整圈）半径 ≤ R；B 样条面多点主曲率半径 ≤ R
function filletRadius(f, R) {
  const T = oc.GeomAbs_SurfaceType;
  const ad = new oc.BRepAdaptor_Surface_2(f, true);
  const ty = ad.GetType();
  let r = null, kind = null, span = 0;
  if (ty === T.GeomAbs_Cylinder) { r = ad.Cylinder().Radius(); span = ad.LastUParameter() - ad.FirstUParameter(); kind = '圆柱'; }
  else if (ty === T.GeomAbs_Torus) { r = ad.Torus().MinorRadius(); span = ad.LastVParameter() - ad.FirstVParameter(); kind = '圆环'; }
  else if (ty === T.GeomAbs_Sphere) { r = ad.Sphere().Radius(); kind = '球面'; }
  else if (ty === T.GeomAbs_BSplineSurface) {
    let rmin = Infinity, ok = 0;
    const u0 = ad.FirstUParameter(), u1 = ad.LastUParameter(), v0 = ad.FirstVParameter(), v1 = ad.LastVParameter();
    for (const [fu, fv] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]]) {
      const pr = new oc.BRepLProp_SLProps_1(ad, u0 + (u1 - u0) * fu, v0 + (v1 - v0) * fv, 2, 1e-7);
      if (pr.IsCurvatureDefined()) {
        const k = Math.max(Math.abs(pr.MaxCurvature()), Math.abs(pr.MinCurvature()));
        if (k > 1e-9) { rmin = Math.min(rmin, 1 / k); if (1 / k <= R * 1.05) ok++; }
      }
      pr.delete();
    }
    if (ok >= 3) { r = rmin; kind = '过渡面'; }
  }
  ad.delete();
  if (r == null || r > R * 1.05 + 1e-6 || span >= Math.PI * 0.99) return null;
  return { r, kind };
}

function scan(R) {
  const faces = exploreFaces(shape);
  const cands = [];
  faces.forEach((f, idx) => { const fr = filletRadius(f, R); if (fr) cands.push({ idx, ...fr, f, edges: edgesOf(f) }); });
  const n = cands.length, parent = [...Array(n).keys()];
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (find(i) === find(j)) continue;
    if (cands[i].edges.some(e => cands[j].edges.some(g => e.IsSame(g)))) parent[find(i)] = find(j);
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(cands[i]); }
  const chains = [...groups.values()].map((g, id) => { const sigs = g.map(c => signature(c.f)); return { id, faces: g.map(c => c.idx), sigs, key: chainKey(sigs), rmax: Math.max(...g.map(c => c.r)), rmin: Math.min(...g.map(c => c.r)) }; });
  chainFaces.clear();
  for (const ch of chains) chainFaces.set(ch.id, ch.faces.map(i => faces[i]));
  const list = cands.map(c => ({ idx: c.idx, r: c.r, kind: c.kind, chain: chains.find(ch => ch.faces.includes(c.idx)).id }));
  return { total: faces.length, cands: list, chains };
}

// 圆角链的相邻面类别：用于解释无法去除的原因
function chainNeighbors(chFaces, allFaces, R) {
  const T = oc.GeomAbs_SurfaceType;
  const own = new Set(chFaces);
  const edges = chFaces.flatMap(i => edgesOf(allFaces[i]));
  const cats = { bigFillet: 0, freeform: 0, simple: 0 };
  allFaces.forEach((g, gi) => {
    if (own.has(gi)) return;
    if (!edgesOf(g).some(e => edges.some(x => x.IsSame(e)))) return;
    const ad = new oc.BRepAdaptor_Surface_2(g, true);
    const ty = ad.GetType();
    let r = null;
    if (ty === T.GeomAbs_Cylinder) r = ad.Cylinder().Radius();
    else if (ty === T.GeomAbs_Torus) r = ad.Torus().MinorRadius();
    else if (ty === T.GeomAbs_Sphere) r = ad.Sphere().Radius();
    ad.delete();
    if (r != null && r > R * 1.05 && r <= 2) cats.bigFillet++;
    else if (ty === T.GeomAbs_BSplineSurface || ty === T.GeomAbs_BezierSurface || ty === T.GeomAbs_OtherSurface) cats.freeform++;
    else cats.simple++;
  });
  return cats;
}

function removeChain(id) {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, map);
  const before = map.Extent();
  const pick = (chainFaces.get(id) || []).filter(f => map.Contains(f));
  map.delete();
  if (!pick.length) return { ok: false, reason: '面已被相邻操作修改' };
  const df = new oc.BRepAlgoAPI_Defeaturing();
  df.SetShape(shape);
  for (const f of pick) df.AddFaceToRemove(f);
  df.SetRunParallel(false);
  df.SetToFillHistory(true);
  df.Build(progressRange());
  let ok = false;
  if (df.IsDone() && !df.HasErrors()) {
    const res = df.Shape();
    if (exploreFaces(res).length < before) {
      shape = res; ok = true;
      // 依据去特征历史更新其余圆角链的面：被修改的面换成新面，被删除的面剔除
      for (const [cid, fs] of chainFaces) {
        if (cid === id) continue;
        const next = [];
        for (const f of fs) {
          if (df.IsDeleted(f)) continue;
          const mod = df.Modified(f);
          if (mod.Size() > 0) next.push(oc.TopoDS.Face_1(mod.First_1())); else next.push(f);
        }
        chainFaces.set(cid, next);
      }
    }
  }
  df.delete();
  return { ok, reason: ok ? '' : '相邻面无法延伸求交' };
}

function snapshot() {
  oc.BRepTools.Write_3(shape, '/snap.brep', progressRange());
  return oc.FS.readFile('/snap.brep');
}
function restore(bytes, chains) {
  oc.FS.writeFile('/snap.brep', bytes);
  const sh = new oc.TopoDS_Shape();
  oc.BRepTools.Read_2(sh, '/snap.brep', new oc.BRep_Builder(), progressRange());
  shape = sh;
  // 恢复后按几何签名重新定位各圆角链的面（只做一次）
  const faces = exploreFaces(shape);
  const fsigs = faces.map(signature);
  chainFaces.clear();
  for (const ch of chains) {
    const fs = [];
    for (const sg of ch.sigs) { const i = fsigs.findIndex(x => sameSig(x, sg)); if (i >= 0) fs.push(faces[i]); }
    chainFaces.set(ch.id, fs);
  }
}

function meshShape(sh) {
  new oc.BRepMesh_IncrementalMesh_2(sh, 0.05, false, 0.35, false);
  const pos = [], idx = [];
  for (const f of exploreFaces(sh)) {
    const loc = new oc.TopLoc_Location_1();
    const triH = oc.BRep_Tool.Triangulation(f, loc, 0);
    if (triH.IsNull()) continue;
    const T = triH.get();
    const tr = loc.Transformation();
    const base = pos.length / 3;
    for (let i = 1; i <= T.NbNodes(); i++) { const p = T.Node(i).Transformed(tr); pos.push(p.X(), p.Y(), p.Z()); }
    const rev = f.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    for (let i = 1; i <= T.NbTriangles(); i++) {
      const t = T.Triangle(i);
      const a = t.Value(1) - 1, b = t.Value(2) - 1, c = t.Value(3) - 1;
      if (rev) idx.push(base + a, base + c, base + b); else idx.push(base + a, base + b, base + c);
    }
  }
  return { pos: Float32Array.from(pos), idx: Uint32Array.from(idx) };
}

function writeStep(sh) {
  const w = new oc.STEPControl_Writer_1();
  w.Transfer(sh, oc.STEPControl_StepModelType.STEPControl_AsIs, true, progressRange());
  w.Write('/out.step');
  const bytes = oc.FS.readFile('/out.step');
  w.delete();
  return bytes;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'open') {
      await load(m.wasm);
      post({ type: 'progress', stage: '读取 STEP', frac: 0.96 });
      oc.FS.writeFile('/in.step', m.step);
      const reader = new oc.STEPControl_Reader_1();
      reader.ReadFile('/in.step');
      reader.TransferRoots(progressRange());
      shape = reader.OneShape();
      srcFaceCount = exploreFaces(shape).length;
      post({ type: 'progress', stage: '识别圆角', frac: 0.98 });
      const r = scan(m.R);
      post({ type: 'scanned', ...r });
    } else if (m.type === 'restore') {
      await load(m.wasm);
      restore(m.brep, []);
      srcFaceCount = m.srcFaceCount;
      post({ type: 'restored' });
    } else if (m.type === 'step') {
      // 每步重新扫描当前形状，取下一条未尝试的圆角链（按面数从少到多）
      const sc = scan(m.R);
      const skip = new Set(m.skip);
      const next = sc.chains.filter(c => !skip.has(c.key)).sort((a, b) => a.faces.length - b.faces.length)[0];
      if (!next) { post({ type: 'stepDone', done: true, remaining: sc.cands.length, faces: sc.total }); return; }
      const nb = chainNeighbors(next.faces, exploreFaces(shape), m.R);
      post({ type: 'attempt', key: next.key, n: next.faces.length, nb, remaining: sc.cands.length });
      const t = performance.now();
      const r = removeChain(next.id);
      const snap = r.ok ? snapshot() : null;
      post({ type: 'stepDone', key: next.key, n: next.faces.length, nb, ...r, ms: performance.now() - t, faces: exploreFaces(shape).length, snap }, snap ? [snap.buffer] : []);
    } else if (m.type === 'finish') {
      const resFaces = exploreFaces(shape);
      let remaining = 0;
      for (const f of resFaces) if (filletRadius(f, m.R)) remaining++;
      const valid = new oc.BRepCheck_Analyzer(shape, true, false).IsValid_2();
      const mesh = meshShape(shape);
      const step = writeStep(shape);
      post({ type: 'finished', facesBefore: srcFaceCount, facesAfter: resFaces.length, remaining, valid, mesh, step }, [mesh.pos.buffer, mesh.idx.buffer, step.buffer]);
    }
  } catch (err) {
    post({ type: 'error', message: String(err?.message || err) });
  }
};
