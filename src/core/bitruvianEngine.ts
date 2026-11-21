import {
  AssembledModelsMap,
  BondStrainInfo,
  ComponentModelKey,
  HydratedRig,
  PieceSpec,
  RigNodeSpec,
  RigSpec,
  RuntimeNode,
  RuntimePiece,
} from './types';

export const DEG_TO_RAD = Math.PI / 180;
export const IDENTITY_MAT = [1, 0, 0, 1, 0, 0];

/**
 * Standard Bitruvian anatomical limits imported directly from Projyct.Bytruvyus.
 * Custom nodes default to [-180, 180] unless specified on the node itself.
 */
export const BITRUVIAN_ANATOMICAL_LIMITS: Record<string, [number, number]> = {
  pelvis: [-180, 180],
  hipR: [-12, 12],
  hipL: [-12, 12],
  lumbar: [-48, 48],
  thorax: [-42, 42],
  ribR: [-28, 28],
  ribL: [-28, 28],
  neck: [-45, 45],
  head: [-65, 65],
  lip: [-35, 18],
  braceL: [-18, 18],
  braceR: [-18, 18],
  swivelL: [-42, 42],
  swivelR: [-42, 42],
  acromionL: [-45, 60],
  acromionR: [-60, 45],
  humerusL: [-175, 165],
  humerusR: [-165, 175],
  forearmL: [-155, 15],
  forearmR: [-15, 155],
  handL: [-85, 85],
  handR: [-85, 85],
  thumbL: [-75, 75],
  thumbR: [-75, 75],
  fingerL: [-95, 45],
  fingerR: [-45, 95],
  femurL: [-135, 120],
  femurR: [-120, 135],
  shinL: [-15, 150],
  shinR: [-150, 15],
  footL: [-65, 75],
  footR: [-75, 65],
};

export function wrapAngleDeg(deg: number): number {
  return (((deg + 180) % 360) + 360) % 360 - 180;
}

export function clampAngle(
  node: RuntimeNode,
  deg: number,
  constrainLimits: boolean
): number {
  const wrapped = wrapAngleDeg(deg);
  if (!constrainLimits) return wrapped;
  const [min, max] = node.limits;
  return Math.max(min, Math.min(max, wrapped));
}

/**
 * Anatomical shoulder & hip guardrails matching Projyct.Bytruvyus `z()` + `R()`.
 * Prevents brace, swivel, acromion, and hip joints from tearing past the closed-chain
 * thorax/clavicle envelope when limits are enabled.
 */
export function clampAnatomicalAngle(
  nodeId: string,
  deg: number,
  limits: [number, number],
  by: Record<string, { ang?: number }> | null,
  constrainLimits: boolean
): number {
  let d = wrapAngleDeg(deg);
  if (constrainLimits) {
    if (nodeId === 'hipR' || nodeId === 'hipL') {
      d = Math.max(-12, Math.min(12, d));
    } else if (nodeId === 'braceL' || nodeId === 'braceR') {
      d = Math.max(-12, Math.min(12, d));
    } else if (nodeId === 'swivelL' || nodeId === 'swivelR') {
      const thoraxAng = by?.thorax?.ang ?? 0;
      d = wrapAngleDeg(thoraxAng + Math.max(-28, Math.min(28, wrapAngleDeg(d - thoraxAng))));
    } else if (nodeId === 'acromionL' || nodeId === 'acromionR') {
      d = Math.max(-35, Math.min(35, d));
    }
    const [min, max] = limits;
    d = Math.max(min, Math.min(max, d));
  }
  return d;
}

export function parentOf(
  node: RuntimeNode,
  by: Record<string, RuntimeNode>
): RuntimeNode | null {
  return node.parent ? by[node.parent] ?? null : null;
}

export function worldPt(
  node: RuntimeNode,
  by: Record<string, RuntimeNode>,
  out: [number, number] = [0, 0]
): [number, number] {
  const p = parentOf(node, by);
  const m = p ? p.w : IDENTITY_MAT;
  const lx = node.piv[0] + (node.parent ? 0 : node.tx);
  const ly = node.piv[1] + (node.parent ? 0 : node.ty);
  out[0] = m[0] * lx + m[2] * ly + m[4];
  out[1] = m[1] * lx + m[3] * ly + m[5];
  return out;
}

export function localToWorldPoint(
  mat: Float64Array | number[],
  x: number,
  y: number
): [number, number] {
  return [mat[0] * x + mat[2] * y + mat[4], mat[1] * x + mat[3] * y + mat[5]];
}

export function worldToLocalPoint(
  mat: Float64Array | number[],
  wx: number,
  wy: number
): [number, number] {
  const det = mat[0] * mat[3] - mat[1] * mat[2];
  if (!det) return [wx, wy];
  const dx = wx - mat[4];
  const dy = wy - mat[5];
  return [(mat[3] * dx - mat[2] * dy) / det, (-mat[1] * dx + mat[0] * dy) / det];
}

function setTransform(
  node: RuntimeNode,
  rad: number,
  by: Record<string, RuntimeNode>
): void {
  const p = parentOf(node, by);
  const pm = p ? p.w : IDENTITY_MAT;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const fx = node.flipX ? -1 : 1;
  const px = node.piv[0];
  const py = node.piv[1];
  const tx = px - fx * c * px + s * py + node.tx;
  const ty = py - fx * s * px - c * py + node.ty;
  const a = fx * c;
  const b = -s;
  const d = fx * s;
  const e = c;
  const w = node.w;
  w[0] = pm[0] * a + pm[2] * d;
  w[1] = pm[1] * a + pm[3] * d;
  w[2] = pm[0] * b + pm[2] * e;
  w[3] = pm[1] * b + pm[3] * e;
  w[4] = pm[0] * tx + pm[2] * ty + pm[4];
  w[5] = pm[1] * tx + pm[3] * ty + pm[5];
}

function bondAng(
  node: RuntimeNode,
  by: Record<string, RuntimeNode>,
  bondOn: boolean
): number {
  const bond = node.bond;
  if (!bond || !bondOn || !bond.aim) return node.ang;
  const target = by[bond.aim.to];
  if (!target || !node.parent || !bond.parent) return node.ang;
  const parentMat = by[node.parent]?.w;
  const bondParentMat = by[bond.parent]?.w;
  if (!parentMat || !bondParentMat) return node.ang;

  const bc = bond.piv;
  const bx = bondParentMat[0] * bc[0] + bondParentMat[2] * bc[1] + bondParentMat[4];
  const byCoord = bondParentMat[1] * bc[0] + bondParentMat[3] * bc[1] + bondParentMat[5];

  const from = bond.aim.from;
  const restLen = Math.max(1e-4, Math.hypot(from[0] - bc[0], from[1] - bc[1]));
  const minLen = bond.aim.min * restLen;
  const maxLen = bond.aim.max * restLen;
  // Minimum lateral clearance along bond parent's local X axis so shoulder never collapses across neck/spine
  const minLateral = Math.min(240, Math.max(40, Math.abs(from[0] - bc[0]) * 0.43));

  const px = node.piv[0];
  const py = node.piv[1];
  const vx = target.piv[0] - px;
  const vy = target.piv[1] - py;
  const sideSign = node.id.endsWith('L') ? 1 : -1;
  const bondParentAng = by[bond.parent]?.ang ?? 0;

  const evalPenalty = (deg: number) => {
    const rad = deg * DEG_TO_RAD;
    const cc = Math.cos(rad);
    const ss = Math.sin(rad);
    const lx = px + cc * vx - ss * vy;
    const ly = py + ss * vx + cc * vy;
    const wx = parentMat[0] * lx + parentMat[2] * ly + parentMat[4];
    const wy = parentMat[1] * lx + parentMat[3] * ly + parentMat[5];
    const dist = Math.hypot(wx - bx, wy - byCoord);
    const softMin = minLen * 0.92;
    const softMax = maxLen * 1.12;
    const distPen = dist < softMin ? softMin - dist : dist > softMax ? dist - softMax : 0;

    // Lateral offset projected onto bond parent's local X axis
    const lat = ((wx - bx) * bondParentMat[0] + (wy - byCoord) * bondParentMat[1]) * sideSign;
    const sidePen = lat < minLateral ? (minLateral - lat) * 4 : 0;

    // Keep swivel within +/-32 deg of thorax rotation
    const relAbs = Math.abs(wrapAngleDeg(deg - bondParentAng));
    const relPen = relAbs > 32 ? (relAbs - 32) * 25 : 0;

    return distPen + sidePen + relPen;
  };

  const startDeg = wrapAngleDeg(
    bondParentAng + Math.max(-28, Math.min(28, wrapAngleDeg(node.ang - bondParentAng)))
  );
  if (evalPenalty(startDeg) === 0) return startDeg;

  // Radial search outward in 0.5 deg steps, then 22-step bisection to boundary
  for (let step = 1; step <= 720; step++) {
    for (const dir of [1, -1]) {
      const cand = startDeg + dir * step * 0.5;
      if (evalPenalty(cand) === 0) {
        let lo = cand - dir * 0.5;
        let hi = cand;
        for (let k = 0; k < 22; k++) {
          const mid = (lo + hi) * 0.5;
          if (evalPenalty(mid) === 0) hi = mid;
          else lo = mid;
        }
        return wrapAngleDeg(hi);
      }
    }
  }

  let best = startDeg;
  let bestVal = evalPenalty(best);
  for (let i = -360; i <= 360; i++) {
    const cand = startDeg + i * 0.5;
    const val = evalPenalty(cand);
    if (val < bestVal) {
      bestVal = val;
      best = cand;
    }
  }
  return wrapAngleDeg(best);
}

function setAim(
  node: RuntimeNode,
  by: Record<string, RuntimeNode>,
  bondOn: boolean
): void {
  const aim = node.aim;
  if (!aim) return;
  const target = by[aim.to];
  if (!target) {
    setTransform(node, node.ang * DEG_TO_RAD, by);
    return;
  }

  const origin = worldPt(node, by);
  const pm = target.parent ? by[target.parent]?.w ?? IDENTITY_MAT : IDENTITY_MAT;
  const tx = pm[0] * target.piv[0] + pm[2] * target.piv[1] + pm[4];
  const ty = pm[1] * target.piv[0] + pm[3] * target.piv[1] + pm[5];

  const dx = tx - origin[0];
  const dy = ty - origin[1];
  const dist = Math.hypot(dx, dy);
  const refVec = [aim.from[0] - node.piv[0], aim.from[1] - node.piv[1]];
  const restLen = Math.max(1e-4, Math.hypot(refVec[0], refVec[1]));

  const maxDelta = 14;
  const clampedAng = Math.max(-maxDelta, Math.min(maxDelta, wrapAngleDeg(node.ang)));
  let rad =
    Math.atan2(dy, dx) - Math.atan2(refVec[1], refVec[0]) + clampedAng * DEG_TO_RAD;

  if (bondOn) {
    const parentWorldMat = node.parent ? by[node.parent]?.w ?? IDENTITY_MAT : IDENTITY_MAT;
    const baseRad = Math.atan2(parentWorldMat[1], parentWorldMat[0]);
    const diff = Math.atan2(Math.sin(rad - baseRad), Math.cos(rad - baseRad));
    const maxSpread = 24 * DEG_TO_RAD;
    rad = baseRad + Math.max(-maxSpread, Math.min(maxSpread, diff));
  }

  const ux = dx / Math.max(1e-4, dist);
  const uy = dy / Math.max(1e-4, dist);
  const deltaDist = (dist - restLen) * 0.5;
  const [minShift, maxShift] = bondOn
    ? [-0.24 * restLen, 0.14 * restLen]
    : [-0.14 * restLen, 0.08 * restLen];
  const halfSpan = Math.max(1, (maxShift - minShift) * 0.5);
  const mid = (minShift + maxShift) * 0.5;
  const slide = mid + halfSpan * Math.tanh((deltaDist - mid) / halfSpan);

  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const w = node.w;
  w[0] = c;
  w[1] = s;
  w[2] = -s;
  w[3] = c;
  w[4] = origin[0] + ux * slide - (c * node.piv[0] - s * node.piv[1]);
  w[5] = origin[1] + uy * slide - (s * node.piv[0] + c * node.piv[1]);
  node.eff = wrapAngleDeg(rad / DEG_TO_RAD);
}

export function computeWorld(
  nodes: RuntimeNode[],
  by: Record<string, RuntimeNode>,
  bondOn: boolean
): void {
  for (const n of nodes) {
    if (n.aim) {
      setAim(n, by, bondOn);
    } else {
      n.eff = bondAng(n, by, bondOn);
      setTransform(n, n.eff * DEG_TO_RAD, by);
    }
  }
}

export function getBondStrain(
  nodes: RuntimeNode[],
  bondOn: boolean
): BondStrainInfo[] {
  if (!bondOn) return [];
  const out: BondStrainInfo[] = [];
  for (const n of nodes) {
    if (n.bond) {
      const delta = n.eff - n.ang;
      out.push({
        nodeId: n.id,
        side: n.id.slice(-1),
        delta,
        strained: Math.abs(delta) > 0.05,
      });
    }
  }
  return out;
}

export function hydrateRig(spec: RigSpec): HydratedRig {
  const copy: RigSpec = JSON.parse(JSON.stringify(spec));
  const rawNodes: RuntimeNode[] = copy.nodes.map((n) => ({
    id: n.id,
    name: n.name || n.id,
    parent: n.parent || null,
    aim: n.aim ? { ...n.aim, from: [n.aim.from[0], n.aim.from[1]] } : null,
    pieces: [],
    piv: [n.pivot[0], n.pivot[1]],
    rest: [n.pivot[0], n.pivot[1]],
    ang: n.ang || 0,
    tx: 0,
    ty: 0,
    w: new Float64Array(6),
    eff: n.ang || 0,
    bond: null,
    lock: !!n.lock,
    ghost: !!n.ghost,
    flipX: !!n.flipX,
    bar: n.bar ? [...n.bar] : null,
    at: null,
    limits: n.limits
      ? [n.limits[0], n.limits[1]]
      : BITRUVIAN_ANATOMICAL_LIMITS[n.id] ?? [-180, 180],
  }));

  const by: Record<string, RuntimeNode> = {};
  rawNodes.forEach((n) => {
    by[n.id] = n;
  });

  // Wire closed-chain bonds (identical to Projyct.Bytruvyus)
  rawNodes.forEach((n) => {
    if (n.aim) {
      const target = by[n.aim.to];
      const driver = target?.parent ? by[target.parent] : null;
      if (driver) driver.bond = n;
    }
  });

  // Topological sort honoring parent, aim.to, and bond.parent dependencies
  const ordered: RuntimeNode[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (n: RuntimeNode) => {
    if (visited.has(n.id) || visiting.has(n.id)) return;
    visiting.add(n.id);
    const deps: Array<string | null> = [n.parent];
    if (n.aim) deps.push(n.aim.to);
    if (n.bond?.parent) deps.push(n.bond.parent);
    for (const depId of deps) {
      if (depId && by[depId]) visit(by[depId]);
    }
    visiting.delete(n.id);
    visited.add(n.id);
    ordered.push(n);
  };
  rawNodes.forEach(visit);

  // Hydrate pieces and sort back-to-front (highest `i` draws first, lowest `i` draws on top)
  const pieces: RuntimePiece[] = [];
  const nodePiecesById: Record<string, PieceSpec[]> = {};
  copy.nodes.forEach((n) => {
    nodePiecesById[n.id] = n.pieces || [];
  });

  ordered.forEach((n) => {
    const list = nodePiecesById[n.id] || [];
    list.forEach((p) => {
      const rp: RuntimePiece = {
        ...p,
        i0: p.i,
        node: n,
      };
      n.pieces.push(rp);
      pieces.push(rp);
    });
  });

  pieces.sort((a, b) => b.i - a.i);

  // Compute default end-tip positions for bone drawing
  for (const n of ordered) {
    if (!n.pieces.length || n.aim || n.bar || ordered.some((c) => c.parent === n.id)) {
      continue;
    }
    let minX = 1e9;
    let minY = 1e9;
    let maxX = -1e9;
    let maxY = -1e9;
    for (const p of n.pieces) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.w);
      maxY = Math.max(maxY, p.y + p.h);
    }
    const candidates: [number, number][] = [
      [minX, minY],
      [maxX, minY],
      [minX, maxY],
      [maxX, maxY],
      [(minX + maxX) / 2, minY],
      [(minX + maxX) / 2, maxY],
      [minX, (minY + maxY) / 2],
      [maxX, (minY + maxY) / 2],
    ];
    let best: [number, number] | null = null;
    let bestD = 30;
    for (const pt of candidates) {
      const d = Math.hypot(pt[0] - n.piv[0], pt[1] - n.piv[1]);
      if (d > bestD) {
        bestD = d;
        best = pt;
      }
    }
    n.at = best;
  }

  const root = ordered.find((n) => !n.parent) || ordered[0];
  return {
    W: copy.W || 2500,
    H: copy.H || 2500,
    nodes: ordered,
    by,
    root,
    pieces,
  };
}

export function buildBitmapHitMask(
  piece: RuntimePiece,
  img: HTMLImageElement | HTMLCanvasElement
): void {
  piece.bm = img;
  const w = Math.max(1, Math.round(piece.w));
  const h = Math.max(1, Math.round(piece.h));
  const step = Math.max(1, Math.min(8, Math.floor(Math.min(w, h) / 16)));
  const mw = Math.max(1, Math.ceil(w / step));
  const mh = Math.max(1, Math.ceil(h / step));

  const cv = document.createElement('canvas');
  cv.width = mw;
  cv.height = mh;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  ctx.drawImage(img, 0, 0, mw, mh);
  const data = ctx.getImageData(0, 0, mw, mh).data;
  const mask = new Uint8Array(mw * mh);
  const threshold = piece.maskThreshold ?? 25;
  for (let i = 0; i < mask.length; i++) {
    mask[i] = data[i * 4 + 3] > threshold ? 1 : 0;
  }
  piece.mask = mask;
  piece.mw = mw;
  piece.mh = mh;
  piece.st = step;
}

export function hitTestPieces(
  worldPos: [number, number],
  pieces: RuntimePiece[]
): { node: RuntimeNode; piece: RuntimePiece } | null {
  for (let idx = pieces.length - 1; idx >= 0; idx--) {
    const p = pieces[idx];
    if (p.visible === false || !p.node) continue;
    const [lx, ly] = worldToLocalPoint(p.node.w, worldPos[0], worldPos[1]);
    const ux = lx - p.x;
    const uy = ly - p.y;
    if (ux < 0 || uy < 0 || ux >= p.w || uy >= p.h) continue;
    if (p.mask && p.mw && p.mh && p.st) {
      const mx = Math.min(p.mw - 1, Math.max(0, (ux / p.st) | 0));
      const my = Math.min(p.mh - 1, Math.max(0, (uy / p.st) | 0));
      if (p.mask[my * p.mw + mx]) {
        return { node: p.node, piece: p };
      }
    } else {
      return { node: p.node, piece: p };
    }
  }
  return null;
}

export function fitStageViewport(
  rig: HydratedRig,
  viewW: number,
  viewH: number
): { z: number; ox: number; oy: number } {
  let minX = 1e9;
  let maxX = -1e9;
  let minY = 1e9;
  let maxY = -1e9;
  let found = false;

  for (const p of rig.pieces) {
    if (p.visible === false) continue;
    found = true;
    const corners: [number, number][] = [
      [p.x, p.y],
      [p.x + p.w, p.y],
      [p.x, p.y + p.h],
      [p.x + p.w, p.y + p.h],
    ];
    for (const [cx, cy] of corners) {
      const [wx, wy] = localToWorldPoint(p.node.w, cx, cy);
      minX = Math.min(minX, wx);
      maxX = Math.max(maxX, wx);
      minY = Math.min(minY, wy);
      maxY = Math.max(maxY, wy);
    }
  }

  for (const n of rig.nodes) {
    const [wx, wy] = worldPt(n, rig.by);
    if (Number.isFinite(wx) && Number.isFinite(wy)) {
      found = true;
      minX = Math.min(minX, wx);
      maxX = Math.max(maxX, wx);
      minY = Math.min(minY, wy);
      maxY = Math.max(maxY, wy);
    }
  }

  if (!found || maxX <= minX || maxY <= minY) {
    minX = 0;
    minY = 0;
    maxX = rig.W;
    maxY = rig.H;
  }

  const boxW = Math.max(100, maxX - minX);
  const boxH = Math.max(100, maxY - minY);
  const pad = 0.86;
  const z = Math.min((viewW * pad) / boxW, (viewH * pad) / boxH);
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  return {
    z,
    ox: viewW * 0.5 - cx * z,
    oy: viewH * 0.5 - cy * z,
  };
}

export interface PartHierarchyPieceSpec {
  i: number;
  id: string;
  label: string;
  asset: string;
  parent: string | null;
  pivot: [number, number] | string | null;
  z: number;
}

export interface PartHierarchyEntry {
  joints: Record<string, [number, number]>;
  pieces: PartHierarchyPieceSpec[];
}

export interface PartHierarchyDoc {
  schema: string;
  parts: Record<'head' | 'hand' | 'foot', PartHierarchyEntry>;
}

function decodeBase64Json<T>(b64: string): T {
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  const decoded = new TextDecoder('utf-8').decode(bytes);
  return JSON.parse(decoded) as T;
}

function buildSubRigFromPart(
  component: ComponentModelKey,
  title: string,
  pieces: PieceSpec[],
  hierarchy?: PartHierarchyEntry
): RigSpec {
  const pieceByI = new Map<number, PieceSpec>();
  pieces.forEach((p) => pieceByI.set(p.i, p));

  let maxX = 0;
  let maxY = 0;
  pieces.forEach((p) => {
    maxX = Math.max(maxX, p.x + p.w);
    maxY = Math.max(maxY, p.y + p.h);
  });
  const W = Math.max(2048, Math.ceil((maxX + 240) / 100) * 100);
  const H = Math.max(2048, Math.ceil((maxY + 240) / 100) * 100);

  const nodes: RigNodeSpec[] = [];
  if (hierarchy) {
    const maxHierarchyZ = hierarchy.pieces.reduce(
      (m, s) => Math.max(m, s.z ?? 0),
      0
    );
    for (const spec of hierarchy.pieces) {
      const piece = pieceByI.get(spec.i);
      let resolvedPivot: [number, number];
      if (Array.isArray(spec.pivot)) {
        resolvedPivot = [spec.pivot[0], spec.pivot[1]];
      } else if (typeof spec.pivot === 'string' && hierarchy.joints[spec.pivot]) {
        resolvedPivot = [...hierarchy.joints[spec.pivot]] as [number, number];
      } else if (piece) {
        resolvedPivot = [
          Math.round((piece.x + piece.w * 0.5) * 10) / 10,
          Math.round((piece.y + piece.h * 0.5) * 10) / 10,
        ];
      } else {
        resolvedPivot = [W * 0.5, H * 0.5];
      }

      nodes.push({
        id: spec.id,
        name: spec.label || spec.id,
        parent: spec.parent,
        pivot: resolvedPivot,
        aim: null,
        ang: 0,
        limits: [-90, 90],
        pieces: piece
          ? [
              {
                ...piece,
                i: spec.z !== undefined ? maxHierarchyZ - spec.z : piece.i,
              },
            ]
          : [],
      });
    }
  } else {
    pieces.forEach((p, idx) => {
      nodes.push({
        id: `${component}_${idx}`,
        name: p.name,
        parent: idx === 0 ? null : `${component}_0`,
        pivot: [p.x + p.w * 0.5, p.y + p.h * 0.5],
        aim: null,
        ang: 0,
        limits: [-90, 90],
        pieces: [p],
      });
    });
  }

  const rawRig: RigSpec = {
    name: title,
    source: 'Projyct.Bytruvyus Core',
    component,
    W,
    H,
    nodes,
  };
  return component === 'yorick' ? normalizeYorickHierarchy(rawRig) : rawRig;
}

/**
 * Normalizes Yorick skull hierarchy:
 * 1. Anchors `crownpin` to originate at `furlbone` (`parent = furlbone`, `pivot = furlbone.pivot`).
 * 2. Moves `furlbone` behind `forehead` and all eye assets (`eyeframe`, `socket`, `eyeball`, `iris`, `pupil`)
 *    in draw order (higher `i` renders further back, lower `i` renders in front) while keeping it ahead of `skull`.
 */
export function normalizeYorickHierarchy(spec: RigSpec): RigSpec {
  const copy: RigSpec = JSON.parse(JSON.stringify(spec));
  const furl = copy.nodes.find((n) => /furlbone/i.test(`${n.id} ${n.name}`));
  const crown = copy.nodes.find((n) => /crownpin/i.test(`${n.id} ${n.name}`));
  const forehead = copy.nodes.find((n) => /forehead/i.test(`${n.id} ${n.name}`));
  const skull = copy.nodes.find((n) => /^skull$/i.test(n.id) || /skullbone|skullplate/i.test(n.name));

  if (furl && crown) {
    crown.parent = furl.id;
    crown.pivot = [furl.pivot[0], furl.pivot[1]];
  }

  if (furl) {
    const eyeNodes = copy.nodes.filter((n) =>
      /(eyeframe|socket|eyeball|iris|pupil)/i.test(`${n.id} ${n.name}`)
    );
    const frontGroup = [forehead, ...eyeNodes].filter(
      (n): n is RigNodeSpec => Boolean(n && n.pieces.length > 0)
    );
    const maxFrontI = frontGroup.reduce(
      (m, n) => Math.max(m, ...n.pieces.map((p) => p.i)),
      0
    );

    const desiredFurlI = maxFrontI + 1;
    const desiredCrownI = maxFrontI + 2;
    const minBehindFurlI = desiredCrownI + 1;

    // Shift skull and any posterior backing pieces (e.g. spinepin/chinpoint) further back if needed
    const skullCurrentMinI = skull?.pieces.length
      ? Math.min(...skull.pieces.map((p) => p.i))
      : Infinity;

    for (const n of copy.nodes) {
      if (n === furl || n === crown) continue;
      const isBehindThreshold =
        n === skull ||
        /(spinepin|chinpin|chinpoint|chinrest)/i.test(`${n.id} ${n.name}`) ||
        n.pieces.some((p) => p.i >= skullCurrentMinI && p.i > maxFrontI && !frontGroup.includes(n));
      if (isBehindThreshold) {
        for (const p of n.pieces) {
          if (p.i >= maxFrontI && p.i < minBehindFurlI + 4) {
            p.i += 4;
          }
        }
      }
    }

    for (const p of furl.pieces) {
      p.i = desiredFurlI;
    }
    if (crown) {
      for (const p of crown.pieces) {
        p.i = desiredCrownI;
      }
    }
  }

  return copy;
}

/**
 * Normalizes core Bytruvyus shoulder & torso anchor geometry (matching Projyct.Bytruvyus `Pe()`)
 * so `braceL/braceR` originate cleanly at `neck.pivot`, `Backshoulder` dorsal wings align,
 * dual pelvis/ribcage pieces get dedicated `hipL/R` & `ribL/R` pivots, and `swivelTipL/R`
 * guide bones terminate cleanly at the acromion tips.
 */
export function normalizeBitruvianCoreJoints(spec: RigSpec): RigSpec {
  const copy: RigSpec = JSON.parse(JSON.stringify(spec));
  const by: Record<string, RigNodeSpec> = {};
  for (const n of copy.nodes) by[n.id] = n;

  // Align femur & hip pivots and split pelvis hip pieces
  if (by.femurR && by.femurL && by.pelvis) {
    by.femurR.pivot = [990, 3598];
    by.femurL.pivot = [1521, 3598];
    by.pelvis.bar = ['femurR', 'femurL'];
    if (by.pelvis.pieces && by.pelvis.pieces.length >= 2 && !by.hipR && !by.hipL) {
      const sorted = [...by.pelvis.pieces].sort((a, b) => a.x - b.x);
      by.pelvis.pieces = [];
      const hipR: RigNodeSpec = {
        id: 'hipR',
        name: 'Right hip',
        parent: 'pelvis',
        pivot: [990, 3598],
        aim: null,
        limits: [-12, 12],
        pieces: [sorted[0]],
      };
      const hipL: RigNodeSpec = {
        id: 'hipL',
        name: 'Left hip',
        parent: 'pelvis',
        pivot: [1521, 3598],
        aim: null,
        limits: [-12, 12],
        pieces: [sorted[1]],
      };
      copy.nodes.push(hipR, hipL);
      by.hipR = hipR;
      by.hipL = hipL;
    }
  }

  // Split Ribcage pieces off thorax onto ribR / ribL nodes
  if (by.thorax && by.thorax.pieces && !by.ribR && !by.ribL) {
    const ribs = by.thorax.pieces
      .filter((p) => p.name === 'Ribcage')
      .sort((a, b) => a.x - b.x);
    if (ribs.length >= 2) {
      by.thorax.pieces = by.thorax.pieces.filter((p) => p.name !== 'Ribcage');
      by.thorax.bar = ['ribR', 'ribL'];
      const ribR: RigNodeSpec = {
        id: 'ribR',
        name: 'Right ribcage',
        parent: 'thorax',
        pivot: [1215, 1327],
        aim: null,
        limits: [-28, 28],
        pieces: [ribs[0]],
      };
      const ribL: RigNodeSpec = {
        id: 'ribL',
        name: 'Left ribcage',
        parent: 'thorax',
        pivot: [1299, 1271],
        aim: null,
        limits: [-28, 28],
        pieces: [ribs[1]],
      };
      copy.nodes.push(ribR, ribL);
      by.ribR = ribR;
      by.ribL = ribL;
    }
  }

  // Anchor braceL & braceR cleanly to neck.pivot, align Backshoulder pieces, add swivelTipL/R
  for (const side of ['L', 'R'] as const) {
    const brace = by[`brace${side}`];
    if (brace && by.neck) {
      brace.pivot = [by.neck.pivot[0], by.neck.pivot[1]];
      if (brace.aim && by[`acromion${side}`]) {
        brace.aim.from = [by[`acromion${side}`].pivot[0], by[`acromion${side}`].pivot[1]];
      }
      const backWing = brace.pieces?.find((p) => p.name === 'Backshoulder');
      if (backWing) {
        backWing.x = side === 'L' ? 1147 : 643;
        backWing.y = 1115;
      }
    }
    const tipId = `swivelTip${side}`;
    if (by[`swivel${side}`] && !by[tipId]) {
      copy.nodes.push({
        id: tipId,
        name: `Swivel tip ${side}`,
        parent: `swivel${side}`,
        pivot: side === 'L' ? [2031, 1334] : [483, 1390],
        aim: null,
        lock: true,
        limits: [0, 0],
        pieces: [],
      });
    }
  }

  return copy;
}

let cachedCoreBundle: {
  models: AssembledModelsMap;
  partHierarchy: PartHierarchyDoc | null;
} | null = null;

/**
 * Fetches and extracts all 4 models (Bytruvyus, Gotz, Yorick, Piggy) and `/part-hierarchy.json`
 * from the bundled Projyct.Bytruvyus HTML artifact in `/public/assets/aistudio/`.
 */
export async function loadAllBitruvianComponentsFromHtml(): Promise<{
  models: AssembledModelsMap;
  partHierarchy: PartHierarchyDoc | null;
}> {
  if (cachedCoreBundle) return cachedCoreBundle;
  const res = await fetch('/assets/aistudio/Projyct.Bytruvyus_88166b11.html');
  if (!res.ok) {
    throw new Error(`Could not load Bitruvian core HTML (${res.status})`);
  }
  const html = await res.text();
  const rigMatch = html.match(/"\/rig-data\.json":"([^"]+)"/);
  if (!rigMatch) {
    throw new Error('Embedded /rig-data.json payload not found in core HTML.');
  }
  const rigDoc = decodeBase64Json<{
    rig: RigSpec;
    parts?: Record<string, { title: string; views: Array<{ name: string; pieces: PieceSpec[] }> }>;
  }>(rigMatch[1]);

  const phMatch = html.match(/"\/part-hierarchy\.json":"([^"]+)"/);
  const partHierarchy = phMatch ? decodeBase64Json<PartHierarchyDoc>(phMatch[1]) : null;

  const bytruvyus: RigSpec = normalizeBitruvianCoreJoints({
    ...rigDoc.rig,
    name: 'Bytruvyus (Body Puppet)',
    source: 'Projyct.Bytruvyus Core',
    component: 'bytruvyus',
  });

  const models: AssembledModelsMap = { bytruvyus };
  if (rigDoc.parts?.hand?.views?.[0]?.pieces) {
    models.gotz = buildSubRigFromPart(
      'gotz',
      'Gotz (Hand Rig)',
      rigDoc.parts.hand.views[0].pieces,
      partHierarchy?.parts.hand
    );
  }
  if (rigDoc.parts?.head?.views?.[0]?.pieces) {
    models.yorick = buildSubRigFromPart(
      'yorick',
      'Yorick (Skull & Face Rig)',
      rigDoc.parts.head.views[0].pieces,
      partHierarchy?.parts.head
    );
  }
  if (rigDoc.parts?.foot?.views?.[0]?.pieces) {
    models.piggy = buildSubRigFromPart(
      'piggy',
      'Piggy (Foot Rig)',
      rigDoc.parts.foot.views[0].pieces,
      partHierarchy?.parts.foot
    );
  }

  cachedCoreBundle = { models, partHierarchy };
  return cachedCoreBundle;
}

export async function loadBitruvianCoreFromHtml(): Promise<RigSpec> {
  const { models } = await loadAllBitruvianComponentsFromHtml();
  return models.bytruvyus!;
}

export function createStarterRig(): RigSpec {
  return {
    name: 'New Custom Rig',
    source: 'Blank Blueprint',
    W: 2048,
    H: 2048,
    nodes: [
      {
        id: 'root',
        name: 'Pelvis / Root',
        parent: null,
        pivot: [1024, 1120],
        aim: null,
        limits: [-180, 180],
        pieces: [],
      },
      {
        id: 'torso',
        name: 'Torso / Thorax',
        parent: 'root',
        pivot: [1024, 860],
        aim: null,
        limits: [-42, 42],
        pieces: [],
      },
      {
        id: 'head',
        name: 'Head',
        parent: 'torso',
        pivot: [1024, 520],
        aim: null,
        limits: [-65, 65],
        pieces: [],
      },
    ],
  };
}

export interface BoneExportSchema {
  id: string;
  name: string;
  version: string;
  width: number;
  height: number;
  bones: Array<{
    name: string;
    parent?: string;
    x: number;
    y: number;
    rotation: number;
  }>;
  slots: Array<{
    name: string;
    bone: string;
    attachment: string;
  }>;
  ik: Array<{
    name: string;
    bones: string[];
    target: string;
  }>;
}

export function exportBonesSchema(spec: RigSpec): BoneExportSchema {
  const by: Record<string, RigNodeSpec> = {};
  spec.nodes.forEach((n) => {
    by[n.id] = n;
  });
  return {
    id: (spec.name || 'custom-rig').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: spec.name || 'Bytruvyus Custom Rig',
    version: '1.0',
    width: spec.W,
    height: spec.H,
    bones: spec.nodes.map((n) => {
      const p = n.parent && by[n.parent] ? by[n.parent].pivot : [0, 0];
      return {
        name: n.id,
        ...(n.parent ? { parent: n.parent } : {}),
        x: Math.round((n.pivot[0] - p[0]) * 100) / 100,
        y: Math.round((n.pivot[1] - p[1]) * 100) / 100,
        rotation: Math.round((n.ang || 0) * 100) / 100,
      };
    }),
    slots: spec.nodes.flatMap((n) =>
      n.pieces.map((pc) => ({
        name: pc.name,
        bone: n.id,
        attachment: pc.name,
      }))
    ),
    ik: spec.nodes
      .filter((n) => n.aim)
      .map((n) => ({
        name: `aim_${n.id}`,
        bones: [n.id],
        target: n.aim!.to,
      })),
  };
}

export function importBonesSchema(raw: BoneExportSchema): RigSpec {
  const bones = raw.bones || [];
  const by: Record<string, (typeof bones)[number]> = {};
  bones.forEach((b) => {
    by[b.name] = b;
  });
  const worldPos: Record<string, [number, number]> = {};
  const resolve = (b: (typeof bones)[number]): [number, number] => {
    if (worldPos[b.name]) return worldPos[b.name];
    if (b.parent && by[b.parent]) {
      const p = resolve(by[b.parent]);
      worldPos[b.name] = [p[0] + (b.x || 0), p[1] + (b.y || 0)];
    } else {
      worldPos[b.name] = [b.x || 0, b.y || 0];
    }
    return worldPos[b.name];
  };
  bones.forEach(resolve);

  return {
    name: raw.name || 'Imported Bone Skeleton',
    source: 'Bones JSON Import',
    W: raw.width || 2500,
    H: raw.height || 2500,
    nodes: bones.map((b) => ({
      id: b.name,
      name: b.name,
      parent: b.parent || null,
      pivot: worldPos[b.name],
      aim: null,
      ang: b.rotation || 0,
      limits: BITRUVIAN_ANATOMICAL_LIMITS[b.name] ?? [-180, 180],
      pieces: [],
    })),
  };
}

/**
 * Bakes Forge-stage non-uniform stretches (scaleX / scaleY / swivelStretch) into rigid
 * [x, y, w, h] sprite rectangles compatible with the main Projyct.Bytruvyus app.
 */
export function bakeRigForMainApp(spec: RigSpec): RigSpec {
  return {
    ...spec,
    nodes: spec.nodes.map((n) => ({
      ...n,
      pieces: n.pieces.map((p) => {
        const sx = p.scaleX ?? 1;
        const sy = p.scaleY ?? 1;
        const nextW = Math.max(8, Math.round(p.w * sx));
        const nextH = Math.max(8, Math.round(p.h * sy));
        const nextX = Math.round(p.x + (p.w - nextW) * 0.5);
        const nextY = Math.round(p.y + (p.h - nextH) * 0.5);
        return {
          i: p.i,
          name: p.name,
          x: nextX,
          y: nextY,
          w: nextW,
          h: nextH,
          src: p.src,
          ...(p.visible === false ? { visible: false } : {}),
        };
      }),
    })),
  };
}

/**
 * Generates a standalone, zero-dependency HTML5 Canvas poser with embedded
 * PNG assets and the exact Bitruvian FK + Closed-Chain Aim Bond solver.
 */
export function exportPoseableHtml(spec: RigSpec): string {
  const baked = bakeRigForMainApp(spec);
  const safeSpec = JSON.stringify({ rig: baked }).replace(/<\/script>/gi, '<\\/script>');
  const title = (baked.name || 'Bitruvian Rig').replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title} — Poseable Rig</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #111215; color: #f3f4f6; font-family: system-ui, -apple-system, sans-serif; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
  header { height: 48px; padding: 0 20px; border-bottom: 1px solid #262932; display: flex; align-items: center; justify-content: space-between; background: #16181d; }
  .title { font-weight: 600; font-size: 14px; }
  .controls { display: flex; align-items: center; gap: 10px; }
  button { background: #23262f; color: #e5e7eb; border: 1px solid #323642; padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; }
  button:hover { background: #2e323d; }
  button.active { background: #7c3aed; border-color: #8b5cf6; color: #fff; }
  main { flex: 1; position: relative; }
  canvas { width: 100%; height: 100%; display: block; cursor: grab; }
  canvas:active { cursor: grabbing; }
  .hud { position: absolute; bottom: 16px; left: 16px; background: rgba(22,24,29,0.9); border: 1px solid #2c303a; padding: 8px 12px; border-radius: 8px; font-size: 12px; color: #9ca3af; pointer-events: none; }
</style>
</head>
<body>
<header>
  <div class="title">${title}</div>
  <div class="controls">
    <button id="btnBones" class="active">Bones</button>
    <button id="btnLimits" class="active">Limits</button>
    <button id="btnBond" class="active">Aim Bonds</button>
    <button id="btnReset">Reset Pose</button>
    <button id="btnExportPose">Export Pose JSON</button>
  </div>
</header>
<main>
  <canvas id="stage"></canvas>
  <div class="hud" id="hud">Drag any piece or joint to pose · Scroll to zoom · Space+Drag to pan</div>
</main>
<script>
const RIG_DATA = ${safeSpec};
const P = Math.PI / 180;
const F = [1, 0, 0, 1, 0, 0];
const cv = document.getElementById('stage');
const ctx = cv.getContext('2d');
const hud = document.getElementById('hud');

let showBones = true, constrainLimits = true, bondOn = true;
let z = 0.1, ox = 0, oy = 0, spaceDown = false;
let sel = null, dragMode = null, dragStartAngle = 0, nodeStartAngle = 0, dragPanStart = null;

function wrap(d) { return (((d + 180) % 360) + 360) % 360 - 180; }
function clampLim(n, d) {
  let w = wrap(d);
  if (!constrainLimits) return w;
  if (n.id === 'hipR' || n.id === 'hipL') w = Math.max(-12, Math.min(12, w));
  else if (n.id === 'braceL' || n.id === 'braceR') w = Math.max(-12, Math.min(12, w));
  else if (n.id === 'swivelL' || n.id === 'swivelR') {
    const tAng = by.thorax ? by.thorax.ang : 0;
    w = wrap(tAng + Math.max(-28, Math.min(28, wrap(w - tAng))));
  } else if (n.id === 'acromionL' || n.id === 'acromionR') w = Math.max(-35, Math.min(35, w));
  return Math.max(n.limits[0], Math.min(n.limits[1], w));
}
function worldPt(n, by) {
  const p = n.parent ? by[n.parent] : null;
  const m = p ? p.w : F;
  const lx = n.piv[0] + (n.parent ? 0 : n.tx);
  const ly = n.piv[1] + (n.parent ? 0 : n.ty);
  return [m[0] * lx + m[2] * ly + m[4], m[1] * lx + m[3] * ly + m[5]];
}
function setTf(n, rad, by) {
  const p = n.parent ? by[n.parent] : null;
  const pm = p ? p.w : F;
  const c = Math.cos(rad), s = Math.sin(rad), fx = n.flipX ? -1 : 1;
  const px = n.piv[0], py = n.piv[1];
  const tx = px - fx * c * px + s * py + n.tx;
  const ty = py - fx * s * px - c * py + n.ty;
  const a = fx * c, b = -s, d = fx * s, e = c;
  n.w[0] = pm[0] * a + pm[2] * d;
  n.w[1] = pm[1] * a + pm[3] * d;
  n.w[2] = pm[0] * b + pm[2] * e;
  n.w[3] = pm[1] * b + pm[3] * e;
  n.w[4] = pm[0] * tx + pm[2] * ty + pm[4];
  n.w[5] = pm[1] * tx + pm[3] * ty + pm[5];
}
function bondAng(n, by) {
  const bond = n.bond;
  if (!bond || !bondOn || !bond.aim) return n.ang;
  const target = by[bond.aim.to];
  if (!target || !n.parent || !bond.parent) return n.ang;
  const pMat = by[n.parent]?.w, bpMat = by[bond.parent]?.w;
  if (!pMat || !bpMat) return n.ang;
  const bc = bond.piv;
  const bx = bpMat[0] * bc[0] + bpMat[2] * bc[1] + bpMat[4];
  const byCoord = bpMat[1] * bc[0] + bpMat[3] * bc[1] + bpMat[5];
  const from = bond.aim.from, restLen = Math.max(1e-4, Math.hypot(from[0] - bc[0], from[1] - bc[1]));
  const minLen = bond.aim.min * restLen, maxLen = bond.aim.max * restLen;
  const minLat = Math.min(240, Math.max(40, Math.abs(from[0] - bc[0]) * 0.43));
  const px = n.piv[0], py = n.piv[1], vx = target.piv[0] - px, vy = target.piv[1] - py;
  const sideSign = n.id.endsWith('L') ? 1 : -1, bpAng = by[bond.parent]?.ang ?? 0;
  const pen = (deg) => {
    const rad = deg * P, cc = Math.cos(rad), ss = Math.sin(rad);
    const lx = px + cc * vx - ss * vy, ly = py + ss * vx + cc * vy;
    const wx = pMat[0] * lx + pMat[2] * ly + pMat[4], wy = pMat[1] * lx + pMat[3] * ly + pMat[5];
    const dist = Math.hypot(wx - bx, wy - byCoord), sMin = minLen * 0.92, sMax = maxLen * 1.12;
    const distP = dist < sMin ? sMin - dist : dist > sMax ? dist - sMax : 0;
    const lat = ((wx - bx) * bpMat[0] + (wy - byCoord) * bpMat[1]) * sideSign;
    const sideP = lat < minLat ? (minLat - lat) * 4 : 0;
    const rel = Math.abs(wrap(deg - bpAng));
    return distP + sideP + (rel > 32 ? (rel - 32) * 25 : 0);
  };
  const sDeg = wrap(bpAng + Math.max(-28, Math.min(28, wrap(n.ang - bpAng))));
  if (pen(sDeg) === 0) return sDeg;
  for (let s = 1; s <= 720; s++) for (const dir of [1, -1]) {
    const c = sDeg + dir * s * 0.5;
    if (pen(c) === 0) {
      let lo = c - dir * 0.5, hi = c;
      for (let k = 0; k < 22; k++) { const m = (lo + hi) * 0.5; if (pen(m) === 0) hi = m; else lo = m; }
      return wrap(hi);
    }
  }
  let best = sDeg, bestV = pen(best);
  for (let i = -360; i <= 360; i++) { const c = sDeg + i * 0.5, v = pen(c); if (v < bestV) { bestV = v; best = c; } }
  return wrap(best);
}
function setAim(n, by) {
  const aim = n.aim, target = by[aim.to];
  if (!target) { setTf(n, n.ang * P, by); return; }
  const origin = worldPt(n, by);
  const pm = target.parent ? by[target.parent].w : F;
  const tx = pm[0] * target.piv[0] + pm[2] * target.piv[1] + pm[4];
  const ty = pm[1] * target.piv[0] + pm[3] * target.piv[1] + pm[5];
  const dx = tx - origin[0], dy = ty - origin[1], dist = Math.hypot(dx, dy);
  const rx = aim.from[0] - n.piv[0], ry = aim.from[1] - n.piv[1];
  const restLen = Math.max(1e-4, Math.hypot(rx, ry));
  let rad = Math.atan2(dy, dx) - Math.atan2(ry, rx) + Math.max(-14, Math.min(14, wrap(n.ang))) * P;
  if (bondOn) {
    const pMat = n.parent ? by[n.parent].w : F;
    const baseRad = Math.atan2(pMat[1], pMat[0]);
    const diff = Math.atan2(Math.sin(rad - baseRad), Math.cos(rad - baseRad));
    rad = baseRad + Math.max(-24 * P, Math.min(24 * P, diff));
  }
  const ux = dx / Math.max(1e-4, dist), uy = dy / Math.max(1e-4, dist);
  const slide = Math.max(-0.24 * restLen, Math.min(0.14 * restLen, (dist - restLen) * 0.5));
  const c = Math.cos(rad), s = Math.sin(rad);
  n.w[0] = c; n.w[1] = s; n.w[2] = -s; n.w[3] = c;
  n.w[4] = origin[0] + ux * slide - (c * n.piv[0] - s * n.piv[1]);
  n.w[5] = origin[1] + uy * slide - (s * n.piv[0] + c * n.piv[1]);
  n.eff = wrap(rad / P);
}

const by = {};
const nodes = RIG_DATA.rig.nodes.map(n => ({
  ...n, piv: [...n.pivot], rest: [...n.pivot], ang: n.ang || 0, tx: 0, ty: 0,
  w: new Float64Array(6), eff: n.ang || 0, bond: null, limits: n.limits || [-180, 180]
}));
nodes.forEach(n => by[n.id] = n);
nodes.forEach(n => { if (n.aim && by[n.aim.to]?.parent) by[by[n.aim.to].parent].bond = n; });
const ordered = [], vis = new Set();
function visit(n) {
  if (vis.has(n.id)) return; vis.add(n.id);
  if (n.parent && by[n.parent]) visit(by[n.parent]);
  if (n.aim && by[n.aim.to]) visit(by[n.aim.to]);
  if (n.bond?.parent && by[n.bond.parent]) visit(by[n.bond.parent]);
  ordered.push(n);
}
nodes.forEach(visit);
const pieces = [];
ordered.forEach(n => (n.pieces || []).forEach(p => pieces.push({ ...p, node: n, img: null })));
pieces.sort((a, b) => b.i - a.i);
pieces.forEach(p => {
  if (!p.src) return;
  const img = new Image();
  img.onload = () => { p.img = img; draw(); };
  img.src = p.src;
});

function solve() {
  for (const n of ordered) {
    if (n.aim) setAim(n, by);
    else { n.eff = bondAng(n, by); setTf(n, n.eff * P, by); }
  }
}

function fit() {
  const dpr = window.devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
  solve();
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const n of ordered) {
    const [wx, wy] = worldPt(n, by);
    minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
    minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
  }
  for (const p of pieces) {
    const m = p.node.w;
    for (const [cx, cy] of [[p.x,p.y],[p.x+p.w,p.y],[p.x,p.y+p.h],[p.x+p.w,p.y+p.h]]) {
      const wx = m[0]*cx + m[2]*cy + m[4], wy = m[1]*cx + m[3]*cy + m[5];
      minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
      minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
    }
  }
  if (maxX <= minX) { minX = 0; maxX = RIG_DATA.rig.W; minY = 0; maxY = RIG_DATA.rig.H; }
  z = Math.min((cv.width * 0.85) / (maxX - minX), (cv.height * 0.85) / (maxY - minY));
  ox = cv.width * 0.5 - ((minX + maxX) * 0.5) * z;
  oy = cv.height * 0.5 - ((minY + maxY) * 0.5) * z;
  draw();
}

function draw() {
  solve();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#111215';
  ctx.fillRect(0, 0, cv.width, cv.height);

  for (const p of pieces) {
    if (!p.img) continue;
    const m = p.node.w;
    ctx.setTransform(m[0] * z, m[1] * z, m[2] * z, m[3] * z, m[4] * z + ox, m[5] * z + oy);
    ctx.drawImage(p.img, p.x, p.y, p.w, p.h);
  }

  if (showBones) {
    ctx.setTransform(z, 0, 0, z, ox, oy);
    for (const n of ordered) {
      if (n.ghost || !n.parent || !by[n.parent]) continue;
      const a = worldPt(by[n.parent], by), b = worldPt(n, by);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      ctx.strokeStyle = n.aim ? '#a78bfa' : '#10b981';
      ctx.lineWidth = Math.max(2, 2.2 / z);
      ctx.stroke();
    }
    for (const n of ordered) {
      if (n.ghost) continue;
      const [wx, wy] = worldPt(n, by);
      ctx.beginPath();
      ctx.arc(wx, wy, Math.max(4, (sel === n ? 7 : 5) / z), 0, Math.PI * 2);
      ctx.fillStyle = sel === n ? '#8b5cf6' : '#111215';
      ctx.fill();
      ctx.strokeStyle = sel === n ? '#ffffff' : '#10b981';
      ctx.lineWidth = Math.max(1.5, 2 / z);
      ctx.stroke();
    }
  }
}

function toWorld(e) {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return [((e.clientX - r.left) * dpr - ox) / z, ((e.clientY - r.top) * dpr - oy) / z];
}

cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  const [wx, wy] = toWorld(e);
  if (spaceDown || e.button === 1) {
    dragMode = 'pan'; dragPanStart = [e.clientX, e.clientY, ox, oy]; return;
  }
  let best = null, bestD = 18 / z;
  for (const n of ordered) {
    if (n.ghost) continue;
    const [px, py] = worldPt(n, by);
    const d = Math.hypot(wx - px, wy - py);
    if (d < bestD) { bestD = d; best = n; }
  }
  if (!best) {
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i], m = p.node.w;
      const det = m[0]*m[3] - m[1]*m[2];
      const dx = wx - m[4], dy = wy - m[5];
      const lx = (m[3]*dx - m[2]*dy)/det - p.x, ly = (-m[1]*dx + m[0]*dy)/det - p.y;
      if (lx >= 0 && ly >= 0 && lx <= p.w && ly <= p.h) { best = p.node; break; }
    }
  }
  sel = best;
  if (sel) {
    if (!sel.parent && e.shiftKey) {
      dragMode = 'move-root'; dragPanStart = [wx, wy, sel.tx, sel.ty];
    } else {
      dragMode = 'rotate';
      const [px, py] = worldPt(sel, by);
      dragStartAngle = Math.atan2(wy - py, wx - px) / P;
      nodeStartAngle = sel.ang;
    }
    hud.textContent = sel.name + ' (' + Math.round(sel.ang) + '°)';
  } else {
    dragMode = 'pan'; dragPanStart = [e.clientX, e.clientY, ox, oy];
  }
  draw();
});

cv.addEventListener('pointermove', (e) => {
  if (!dragMode) return;
  const dpr = window.devicePixelRatio || 1;
  if (dragMode === 'pan') {
    ox = dragPanStart[2] + (e.clientX - dragPanStart[0]) * dpr;
    oy = dragPanStart[3] + (e.clientY - dragPanStart[1]) * dpr;
    draw(); return;
  }
  const [wx, wy] = toWorld(e);
  if (dragMode === 'move-root' && sel) {
    sel.tx = dragPanStart[2] + (wx - dragPanStart[0]);
    sel.ty = dragPanStart[3] + (wy - dragPanStart[1]);
    draw(); return;
  }
  if (dragMode === 'rotate' && sel && !sel.lock) {
    const [px, py] = worldPt(sel, by);
    const cur = Math.atan2(wy - py, wx - px) / P;
    sel.ang = clampLim(sel, nodeStartAngle + wrap(cur - dragStartAngle));
    hud.textContent = sel.name + ' (' + Math.round(sel.ang * 10) / 10 + '°)';
    draw();
  }
});

window.addEventListener('pointerup', () => { dragMode = null; });
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const sx = (e.clientX - r.left) * dpr, sy = (e.clientY - r.top) * dpr;
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  const nz = Math.max(0.02, Math.min(8, z * factor));
  ox = sx - (sx - ox) * (nz / z);
  oy = sy - (sy - oy) * (nz / z);
  z = nz;
  draw();
}, { passive: false });

window.addEventListener('keydown', (e) => { if (e.code === 'Space') spaceDown = true; });
window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });
window.addEventListener('resize', fit);

document.getElementById('btnBones').onclick = (e) => { showBones = !showBones; e.target.classList.toggle('active', showBones); draw(); };
document.getElementById('btnLimits').onclick = (e) => { constrainLimits = !constrainLimits; e.target.classList.toggle('active', constrainLimits); draw(); };
document.getElementById('btnBond').onclick = (e) => { bondOn = !bondOn; e.target.classList.toggle('active', bondOn); draw(); };
document.getElementById('btnReset').onclick = () => { ordered.forEach(n => { n.ang = 0; n.tx = 0; n.ty = 0; }); draw(); };
document.getElementById('btnExportPose').onclick = () => {
  const pose = {};
  ordered.forEach(n => pose[n.id] = Math.round(n.ang * 10) / 10);
  const blob = new Blob([JSON.stringify({ pose, root: [ordered[0].tx, ordered[0].ty] }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pose.json'; a.click();
};
fit();
</script>
</body>
</html>`;
}
