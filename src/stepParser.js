// 轻量 STEP (ISO 10303-21) 文本解析：提取文件头、单位、拓扑统计、曲面类型、圆柱特征
// 只解析出图需要的实体，不做完整的 EXPRESS 解析
import { now } from './clock.js';

const SURFACE_TYPES = {
  PLANE: '平面',
  CYLINDRICAL_SURFACE: '圆柱面',
  CONICAL_SURFACE: '圆锥面',
  SPHERICAL_SURFACE: '球面',
  TOROIDAL_SURFACE: '圆环面',
  B_SPLINE_SURFACE: 'B样条曲面',
  B_SPLINE_SURFACE_WITH_KNOTS: 'B样条曲面',
  RATIONAL_B_SPLINE_SURFACE: 'B样条曲面',
  SURFACE_OF_REVOLUTION: '回转面',
  SURFACE_OF_LINEAR_EXTRUSION: '拉伸面',
  OFFSET_SURFACE: '偏置面',
};

const CURVE_TYPES = {
  LINE: '直线',
  CIRCLE: '圆弧',
  ELLIPSE: '椭圆',
  B_SPLINE_CURVE_WITH_KNOTS: 'B样条曲线',
  B_SPLINE_CURVE: 'B样条曲线',
};

// 把 "a,(b,c),'x,y',#3" 这样的参数串按顶层逗号切分
function splitArgs(s) {
  const out = [];
  let depth = 0, inStr = false, cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      cur += ch;
      if (ch === "'") {
        if (s[i + 1] === "'") { cur += "'"; i++; } else inStr = false;
      }
      continue;
    }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const unq = s => (s && s.startsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s);
const ref = s => (s && s[0] === '#' ? parseInt(s.slice(1), 10) : null);
const nums = s => s.replace(/[()]/g, '').split(',').map(Number);

export function parseStep(text) {
  const t0 = now();
  const headerEnd = text.indexOf('ENDSEC;');
  const header = text.slice(0, headerEnd);
  const getHeader = (name) => {
    const m = header.match(new RegExp(name + '\\s*\\(([\\s\\S]*?)\\);'));
    return m ? splitArgs(m[1]) : [];
  };
  const fileName = getHeader('FILE_NAME');
  const fileDesc = getHeader('FILE_DESCRIPTION');
  const schema = getHeader('FILE_SCHEMA');

  const dataStart = text.indexOf('DATA;');
  const body = text.slice(dataStart + 5);

  // 实体：#id=TYPE(args); 复合实体 #id=(A(..)B(..)); 先按 ; 粗切，再修正字符串内的分号
  const entities = new Map();
  const typeCount = {};
  const re = /#(\d+)\s*=\s*([A-Z0-9_]*)\s*\(([\s\S]*?)\)\s*;(?=\s*(?:#|ENDSEC|\/\*|$))/g;
  let m;
  while ((m = re.exec(body))) {
    const id = +m[1];
    let type = m[2];
    const args = m[3];
    if (!type) {
      // 复合实体，记录其中的关键类型
      const inner = args.match(/[A-Z_]+(?=\s*\()/g) || [];
      type = inner.includes('B_SPLINE_SURFACE') ? 'B_SPLINE_SURFACE'
        : inner.includes('B_SPLINE_CURVE') ? 'B_SPLINE_CURVE'
        : inner.includes('LENGTH_UNIT') ? 'LENGTH_UNIT_COMPLEX'
        : 'COMPLEX';
      entities.set(id, { type, args, inner });
    } else {
      entities.set(id, { type, args });
    }
    typeCount[type] = (typeCount[type] || 0) + 1;
  }

  // ---- 单位 ----
  let unit = 'mm', unitScale = 1;
  for (const e of entities.values()) {
    if (e.type !== 'LENGTH_UNIT_COMPLEX') continue;
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(e.args)) { unit = 'inch'; unitScale = 25.4; break; }
    if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\./.test(e.args)) { unit = 'mm'; unitScale = 1; break; }
    if (/SI_UNIT\s*\(\s*\.CENTI\.\s*,\s*\.METRE\./.test(e.args)) { unit = 'cm'; unitScale = 10; break; }
    if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\./.test(e.args)) { unit = 'm'; unitScale = 1000; break; }
  }

  // ---- 产品名 ----
  const products = [];
  for (const e of entities.values()) {
    if (e.type === 'PRODUCT') {
      const a = splitArgs(e.args);
      products.push(unq(a[1]) || unq(a[0]));
    }
  }

  const point = (id) => nums(splitArgs(entities.get(id).args)[1]).map(v => v * unitScale);
  const dir = (id) => {
    const v = nums(splitArgs(entities.get(id).args)[1]);
    const l = Math.hypot(...v) || 1;
    return v.map(x => x / l);
  };
  const placement = (id) => {
    const a = splitArgs(entities.get(id).args);
    return {
      p: point(ref(a[1])),
      a: a[2] && a[2] !== '$' ? dir(ref(a[2])) : [0, 0, 1],
    };
  };

  // ---- 面 → 曲面类型 ----
  const surfaceStats = {};
  const cylinders = [];
  const cones = [];
  let faceCount = 0;
  for (const e of entities.values()) {
    if (e.type !== 'ADVANCED_FACE' && e.type !== 'FACE_SURFACE') continue;
    faceCount++;
    const a = splitArgs(e.args);
    const sid = ref(a[2]);
    const s = entities.get(sid);
    if (!s) continue;
    const label = SURFACE_TYPES[s.type] || '其他曲面';
    surfaceStats[label] = (surfaceStats[label] || 0) + 1;
    try {
      if (s.type === 'CYLINDRICAL_SURFACE') {
        const sa = splitArgs(s.args);
        const pl = placement(ref(sa[1]));
        cylinders.push({ ...pl, r: parseFloat(sa[2]) * unitScale, faceId: sid });
      } else if (s.type === 'CONICAL_SURFACE') {
        const sa = splitArgs(s.args);
        const pl = placement(ref(sa[1]));
        cones.push({ ...pl, r: parseFloat(sa[2]) * unitScale, angle: parseFloat(sa[3]) });
      }
    } catch { /* 跳过异常实体 */ }
  }

  const curveStats = {};
  for (const [k, label] of Object.entries(CURVE_TYPES)) {
    if (typeCount[k]) curveStats[label] = (curveStats[label] || 0) + typeCount[k];
  }

  const schemaName = (schema[0] || '').replace(/[()']/g, '');
  let ap = 'STEP';
  if (/AP242|MANAGED_MODEL_BASED_3D/i.test(schemaName)) ap = 'AP242';
  else if (/AUTOMOTIVE_DESIGN|AP214/i.test(schemaName)) ap = 'AP214';
  else if (/CONFIG_CONTROL|AP203|CONFIGURATION_CONTROLLED/i.test(schemaName)) ap = 'AP203';

  return {
    header: {
      description: unq(splitArgs((fileDesc[0] || '').replace(/^\(|\)$/g, ''))[0] || ''),
      name: unq(fileName[0] || ''),
      timestamp: unq(fileName[1] || ''),
      author: unq((fileName[2] || '').replace(/^\(|\)$/g, '')),
      organization: unq((fileName[3] || '').replace(/^\(|\)$/g, '')),
      preprocessor: unq(fileName[4] || ''),
      originatingSystem: unq(fileName[5] || ''),
      schema: schemaName,
      ap,
    },
    unit,
    unitScale,
    products,
    entityCount: entities.size,
    typeCount,
    headerText: text.slice(0, Math.min(headerEnd + 7, 2400)),
    topology: {
      solids: (typeCount.MANIFOLD_SOLID_BREP || 0) + (typeCount.BREP_WITH_VOIDS || 0),
      shells: (typeCount.CLOSED_SHELL || 0) + (typeCount.OPEN_SHELL || 0),
      faces: faceCount,
      edges: typeCount.EDGE_CURVE || 0,
      vertices: typeCount.VERTEX_POINT || 0,
    },
    surfaceStats,
    curveStats,
    cylinders,
    cones,
    pmi: {
      // AP242 语义 PMI 实体（若存在）
      dimensions: (typeCount.DIMENSIONAL_SIZE || 0) + (typeCount.DIMENSIONAL_LOCATION || 0),
      tolerances: Object.keys(typeCount).filter(k => k.endsWith('_TOLERANCE')).reduce((s, k) => s + typeCount[k], 0),
      datums: typeCount.DATUM || 0,
    },
    parseMs: now() - t0,
  };
}
