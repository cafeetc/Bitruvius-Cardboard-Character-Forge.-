import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Anchor,
  ArrowLeft,
  Hand,
  Maximize2,
  Move,
  Play,
  RotateCcw,
  SlidersHorizontal,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  buildBitmapHitMask,
  clampAnatomicalAngle,
  computeWorld,
  DEG_TO_RAD,
  fitStageViewport,
  getBondStrain,
  hitTestPieces,
  hydrateRig,
  IDENTITY_MAT,
  localToWorldPoint,
  worldPt,
  worldToLocalPoint,
  wrapAngleDeg,
} from '../core/bitruvianEngine';
import {
  BondStrainInfo,
  ComponentModelKey,
  HydratedRig,
  RigSpec,
  StageMode,
} from '../core/types';
import {
  YORICK_POSE_PRESETS,
  YorickPoseId,
  YorickViewGroup,
} from '../core/yorickPoses';

interface StageCanvasProps {
  rigSpec: RigSpec;
  activeComponent: ComponentModelKey;
  activeTwinSide: 'L' | 'R';
  selectedNodeId: string | null;
  stageMode: StageMode;
  dragOnceActive: boolean;
  onToggleDragOnce: () => void;
  onCompleteDragOnce: () => void;
  onChangeStageMode: (mode: StageMode) => void;
  onChangeTwinSide: (side: 'L' | 'R') => void;
  onActivateSubComponent: (component: ComponentModelKey, twinSide?: 'L' | 'R') => void;
  onBackToMaster: () => void;
  onSelectNode: (id: string | null) => void;
  onMovePivot: (nodeId: string, pivot: [number, number]) => void;
  onMoveBoneWithPngs: (nodeId: string, pivot: [number, number]) => void;
  onMovePiece: (
    nodeId: string,
    pieceIndex: number,
    x: number,
    y: number,
    w?: number,
    h?: number
  ) => void;
  onPoseAngle: (nodeId: string, ang: number) => void;
  onPoseAngles: (updates: Record<string, number>) => void;
  activeYorickPose: YorickPoseId;
  onApplyYorickPose: (poseId: YorickPoseId) => void;
  onResetPose: () => void;
  onOpenCalibration: () => void;
  onStrainUpdate: (strain: BondStrainInfo[]) => void;
}

type ResizeHandleDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type DragOperation =
  | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | {
      kind: 'pivot';
      nodeId: string;
      offsetX: number;
      offsetY: number;
      origPivot: [number, number];
      carryPng: boolean;
    }
  | {
      kind: 'piece-move';
      nodeId: string;
      pieceIndex: number;
      startLocal: [number, number];
      origX: number;
      origY: number;
    }
  | {
      kind: 'piece-resize';
      nodeId: string;
      pieceIndex: number;
      dir: ResizeHandleDir;
      startLocal: [number, number];
      origX: number;
      origY: number;
      origW: number;
      origH: number;
    }
  | {
      kind: 'pose-rotate';
      nodeId: string;
      pivWorld: [number, number];
      startMouseAng: number;
      startNodeAng: number;
      parDetSign: number;
      startSwivelAng?: number;
    }
  | {
      kind: 'pose-hip';
      side: 'L' | 'R';
      sAng: number;
      hip0: number;
      femur0: number;
    }
  | {
      kind: 'pose-shoulder';
      side: 'L' | 'R';
      guide: 'wing' | 'tendon' | 'acromion' | 'swivel';
      sSwivel: number;
      sNeck: number;
      swivel0: number;
      acro0: number;
      brace0: number;
    };

function getHandleLocalPos(
  dir: ResizeHandleDir,
  x: number,
  y: number,
  w: number,
  h: number
): [number, number] {
  const cx = x + w * 0.5;
  const cy = y + h * 0.5;
  switch (dir) {
    case 'nw':
      return [x, y];
    case 'n':
      return [cx, y];
    case 'ne':
      return [x + w, y];
    case 'e':
      return [x + w, cy];
    case 'se':
      return [x + w, y + h];
    case 's':
      return [cx, y + h];
    case 'sw':
      return [x, y + h];
    case 'w':
      return [x, cy];
  }
}

const ALL_HANDLE_DIRS: ResizeHandleDir[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function detectSubComponentTrigger(
  nodeId: string,
  nodeName: string
): { component: ComponentModelKey; side?: 'L' | 'R' } | null {
  const combined = `${nodeId} ${nodeName}`.toLowerCase();
  const isRight = /(?:^|[^a-z])r(?:ight)?$|_r\b|\bright\b|r$/i.test(nodeId) || /\bright\b/i.test(nodeName);
  const side: 'L' | 'R' = isRight ? 'R' : 'L';

  if (/\b(head|skull|yorick)\b/i.test(combined) || /^head/i.test(nodeId)) {
    return { component: 'yorick' };
  }
  if (/\b(hand|palm|gotz|wrist)\b/i.test(combined) || /^hand/i.test(nodeId)) {
    return { component: 'gotz', side };
  }
  if (/\b(foot|shoe|boot|piggy|ankle)\b/i.test(combined) || /^foot/i.test(nodeId)) {
    return { component: 'piggy', side };
  }
  return null;
}

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-6) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lenSq));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function hitTestDigitalBone(
  wx: number,
  wy: number,
  hydrated: HydratedRig,
  tol: number
) {
  let bestNode: HydratedRig['nodes'][number] | null = null;
  let bestDist = tol;

  for (const n of hydrated.nodes) {
    if (n.ghost) continue;
    const [nwx, nwy] = worldPt(n, hydrated.by);

    // 1. Leaf tip segment (owned by n)
    if (n.at && !n.lock) {
      const [tx, ty] = localToWorldPoint(n.w, n.at[0], n.at[1]);
      const d = distToSegment(wx, wy, nwx, nwy, tx, ty);
      if (d < bestDist) {
        bestDist = d;
        bestNode = n;
      }
    }

    // 2. Aim sightline shaft (owned by aim node n, e.g. braceL -> acromionL)
    if (n.aim && hydrated.by[n.aim.to] && !n.lock) {
      const [tx, ty] = worldPt(hydrated.by[n.aim.to], hydrated.by);
      const d = distToSegment(wx, wy, nwx, nwy, tx, ty);
      if (d < bestDist) {
        bestDist = d;
        bestNode = n;
      }
    }

    // 3. Crossbar bone segment (e.g. pelvis femurR<->femurL, thorax ribR<->ribL)
    if (n.bar && n.bar.length >= 2 && hydrated.by[n.bar[0]] && hydrated.by[n.bar[1]] && !n.lock) {
      const [ax, ay] = worldPt(hydrated.by[n.bar[0]], hydrated.by);
      const [bx, by] = worldPt(hydrated.by[n.bar[1]], hydrated.by);
      const d = distToSegment(wx, wy, ax, ay, bx, by);
      if (d < bestDist) {
        bestDist = d;
        bestNode = n;
      }
    }

    // 4. Parent-to-child digital bone segment
    if (n.parent && hydrated.by[n.parent]) {
      const par = hydrated.by[n.parent];
      if (!par.ghost) {
        const [pwx, pwy] = worldPt(par, hydrated.by);
        const owner =
          n.lock || par.bar?.includes(n.id) || par.pieces.length > 0 ? par : n;
        if (!owner.lock) {
          const d = distToSegment(wx, wy, pwx, pwy, nwx, nwy);
          if (d < bestDist) {
            bestDist = d;
            bestNode = owner;
          }
        }
      }
    }
  }

  return bestNode;
}

export const StageCanvas: React.FC<StageCanvasProps> = ({
  rigSpec,
  activeComponent,
  activeTwinSide,
  selectedNodeId,
  stageMode,
  dragOnceActive,
  onToggleDragOnce,
  onCompleteDragOnce,
  onChangeStageMode,
  onChangeTwinSide,
  onActivateSubComponent,
  onBackToMaster,
  onSelectNode,
  onMovePivot,
  onMoveBoneWithPngs,
  onMovePiece,
  onPoseAngle,
  onPoseAngles,
  activeYorickPose,
  onApplyYorickPose,
  onResetPose,
  onOpenCalibration,
  onStrainUpdate,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [showBones, setShowBones] = useState(true);
  const [showGuides, setShowGuides] = useState(true);
  const [constrainLimits, setConstrainLimits] = useState(true);
  const [bondOn, setBondOn] = useState(true);
  const [swivelStretch, setSwivelStretch] = useState(true);
  const [boneBondsPng, setBoneBondsPng] = useState(true);
  const [zoomPct, setZoomPct] = useState(10);
  const [cursorCoords, setCursorCoords] = useState<[number, number] | null>(null);
  const [yorickGroup, setYorickGroup] = useState<YorickViewGroup>('front');

  useEffect(() => {
    const found = YORICK_POSE_PRESETS.find((p) => p.id === activeYorickPose);
    if (found) setYorickGroup(found.group);
  }, [activeYorickPose]);

  const camRef = useRef({ z: 0.1, ox: 0, oy: 0 });
  const dragRef = useRef<DragOperation | null>(null);
  const hoveredBoneIdRef = useRef<string | null>(null);
  const spaceDownRef = useRef(false);
  const imgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const rigSigRef = useRef<string | undefined>(undefined);
  const hasFittedRef = useRef(false);

  const isMirroredTwin =
    (activeComponent === 'gotz' || activeComponent === 'piggy') && activeTwinSide === 'R';

  const hydrated: HydratedRig = useMemo(() => {
    const rig = hydrateRig(rigSpec);
    computeWorld(rig.nodes, rig.by, bondOn);
    return rig;
  }, [rigSpec, bondOn]);

  useEffect(() => {
    onStrainUpdate(getBondStrain(hydrated.nodes, bondOn));
  }, [hydrated, bondOn, onStrainUpdate]);

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cw = cv.clientWidth;
    const ch = cv.clientHeight;
    if (cw === 0 || ch === 0) return;

    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
      cv.width = Math.round(cw * dpr);
      cv.height = Math.round(ch * dpr);
    }

    const { z, ox, oy } = camRef.current;
    computeWorld(hydrated.nodes, hydrated.by, bondOn);

    // Base clear
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#111215';
    ctx.fillRect(0, 0, cv.width, cv.height);

    // Apply twin mirror transform in stage world if viewing Right twin of Gotz / Piggy
    const applyStageWorldTransform = (localMat?: Float64Array | number[]) => {
      const m = localMat ?? IDENTITY_MAT;
      if (!isMirroredTwin) {
        ctx.setTransform(
          m[0] * z * dpr,
          m[1] * z * dpr,
          m[2] * z * dpr,
          m[3] * z * dpr,
          (m[4] * z + ox) * dpr,
          (m[5] * z + oy) * dpr
        );
      } else {
        // Mirror X across stage center W/2: wx' = W - wx
        ctx.setTransform(
          -m[0] * z * dpr,
          m[1] * z * dpr,
          -m[2] * z * dpr,
          m[3] * z * dpr,
          ((hydrated.W - m[4]) * z + ox) * dpr,
          (m[5] * z + oy) * dpr
        );
      }
    };

    // Stage grid & bounds
    if (showGuides) {
      applyStageWorldTransform();
      ctx.fillStyle = '#15171C';
      ctx.fillRect(0, 0, hydrated.W, hydrated.H);

      const step = Math.max(100, Math.round(hydrated.W / 10));
      ctx.beginPath();
      for (let gx = 0; gx <= hydrated.W; gx += step) {
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, hydrated.H);
      }
      for (let gy = 0; gy <= hydrated.H; gy += step) {
        ctx.moveTo(0, gy);
        ctx.lineTo(hydrated.W, gy);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.035)';
      ctx.lineWidth = 1 / (z * dpr);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(hydrated.W * 0.5, 0);
      ctx.lineTo(hydrated.W * 0.5, hydrated.H);
      ctx.strokeStyle = 'rgba(139, 92, 246, 0.16)';
      ctx.lineWidth = 1.5 / (z * dpr);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1.5 / (z * dpr);
      ctx.strokeRect(0, 0, hydrated.W, hydrated.H);
    }

    // Draw sprite pieces back-to-front (moving with bone swivels & supporting Forge stretch)
    for (const piece of hydrated.pieces) {
      if (piece.visible === false) continue;
      const img = piece.src ? imgCacheRef.current.get(piece.src) : undefined;
      const node = piece.node;
      applyStageWorldTransform(node.w);

      // Compute Forge stretch factors: explicit scaleX/scaleY + pivot-anchored bone-swivel stretch
      const baseW = piece.w * (piece.scaleX ?? 1);
      const baseH = piece.h * (piece.scaleY ?? 1);
      let drawW = baseW;
      let drawH = baseH;
      let drawX = piece.x + (piece.w - baseW) * 0.5;
      let drawY = piece.y + (piece.h - baseH) * 0.5;
      const isBackWing = piece.name === 'Backshoulder';

      if (swivelStretch && (piece.swivelStretch || node.aim) && node.aim && !isBackWing) {
        const target = hydrated.by[node.aim.to];
        if (target) {
          const origin = worldPt(node, hydrated.by);
          const pm = target.parent ? hydrated.by[target.parent]?.w ?? IDENTITY_MAT : IDENTITY_MAT;
          const tx = pm[0] * target.piv[0] + pm[2] * target.piv[1] + pm[4];
          const ty = pm[1] * target.piv[0] + pm[3] * target.piv[1] + pm[5];
          const dist = Math.hypot(tx - origin[0], ty - origin[1]);
          const restLen = Math.max(
            1,
            Math.hypot(node.aim.from[0] - node.piv[0], node.aim.from[1] - node.piv[1])
          );
          const ratio = Math.max(node.aim.min, Math.min(node.aim.max * 1.15, dist / restLen));
          // Anchor stretch around node.piv so proximal neck/thorax joint stays locked
          if (baseW >= baseH) {
            drawW = baseW * ratio;
            drawX = node.piv[0] + (drawX - node.piv[0]) * ratio;
          } else {
            drawH = baseH * ratio;
            drawY = node.piv[1] + (drawY - node.piv[1]) * ratio;
          }
        }
      }

      if (img && img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
      } else if (showGuides) {
        ctx.fillStyle = 'rgba(139, 92, 246, 0.09)';
        ctx.fillRect(drawX, drawY, drawW, drawH);
        ctx.strokeStyle = 'rgba(139, 92, 246, 0.35)';
        ctx.lineWidth = 1.2 / (z * dpr);
        ctx.strokeRect(drawX, drawY, drawW, drawH);
      }

      if (node.id === selectedNodeId && (stageMode !== 'pose-test' || dragOnceActive)) {
        ctx.strokeStyle = dragOnceActive ? '#F59E0B' : '#8B5CF6';
        ctx.lineWidth = 2 / (z * dpr);
        ctx.strokeRect(drawX, drawY, drawW, drawH);

        if (stageMode === 'place-pieces' || dragOnceActive) {
          const hs = 9 / (z * dpr);
          ctx.fillStyle = '#FFFFFF';
          ctx.strokeStyle = dragOnceActive ? '#F59E0B' : '#8B5CF6';
          ctx.lineWidth = 1.5 / (z * dpr);
          for (const dir of ALL_HANDLE_DIRS) {
            const [hx, hy] = getHandleLocalPos(dir, drawX, drawY, drawW, drawH);
            ctx.fillRect(hx - hs * 0.5, hy - hs * 0.5, hs, hs);
            ctx.strokeRect(hx - hs * 0.5, hy - hs * 0.5, hs, hs);
          }
        }
      }
    }

    // Guides: Aim Sightlines & Selected Joint Limit Arc
    if (showGuides) {
      applyStageWorldTransform();
      for (const n of hydrated.nodes) {
        if (!n.aim) continue;
        const target = hydrated.by[n.aim.to];
        if (!target) continue;
        const a = worldPt(n, hydrated.by);
        const b = worldPt(target, hydrated.by);
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([6 / (z * dpr), 5 / (z * dpr)]);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.strokeStyle = '#A78BFA';
        ctx.lineWidth = 1.6 / (z * dpr);
        ctx.stroke();
        ctx.restore();
      }

      if (selectedNodeId && hydrated.by[selectedNodeId]) {
        const sel = hydrated.by[selectedNodeId];
        const [wx, wy] = worldPt(sel, hydrated.by);
        const [minDeg, maxDeg] = sel.limits;
        if (maxDeg - minDeg < 358) {
          const r = 42 / (z * dpr);
          ctx.beginPath();
          ctx.moveTo(wx, wy);
          ctx.arc(wx, wy, r, (minDeg - 90) * DEG_TO_RAD, (maxDeg - 90) * DEG_TO_RAD);
          ctx.closePath();
          ctx.fillStyle = 'rgba(139, 92, 246, 0.14)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(139, 92, 246, 0.5)';
          ctx.lineWidth = 1.2 / (z * dpr);
          ctx.stroke();
        }
      }
    }

    // Bones & Pivot Anchors
    if (showBones) {
      applyStageWorldTransform();
      const invScale = 1 / (z * dpr);
      const hovId = hoveredBoneIdRef.current;

      for (const n of hydrated.nodes) {
        if (n.ghost) continue;
        const [wx, wy] = worldPt(n, hydrated.by);

        if (n.parent && hydrated.by[n.parent]) {
          const par = hydrated.by[n.parent];
          const [px, py] = worldPt(par, hydrated.by);
          const ownerId =
            n.lock || par.bar?.includes(n.id) || par.pieces.length > 0 ? par.id : n.id;
          const isHovOrSel = ownerId === selectedNodeId || ownerId === hovId;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(wx, wy);
          ctx.strokeStyle = isHovOrSel
            ? '#34D399'
            : n.aim
            ? '#A78BFA'
            : '#10B981';
          ctx.lineWidth = (isHovOrSel ? 3.2 : 2.2) * invScale;
          ctx.stroke();
        }

        if (n.bar && n.bar.length >= 2 && hydrated.by[n.bar[0]] && hydrated.by[n.bar[1]]) {
          const [ax, ay] = worldPt(hydrated.by[n.bar[0]], hydrated.by);
          const [bx, by] = worldPt(hydrated.by[n.bar[1]], hydrated.by);
          const isHovOrSel = n.id === selectedNodeId || n.id === hovId;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.strokeStyle = isHovOrSel ? '#34D399' : '#10B981';
          ctx.lineWidth = (isHovOrSel ? 3.2 : 2.2) * invScale;
          ctx.stroke();
        }

        if (n.aim && hydrated.by[n.aim.to]) {
          const [tx, ty] = worldPt(hydrated.by[n.aim.to], hydrated.by);
          const isHovOrSel = n.id === selectedNodeId || n.id === hovId;
          const strained = Math.abs(n.eff - n.ang) > 0.05;
          ctx.beginPath();
          ctx.moveTo(wx, wy);
          ctx.lineTo(tx, ty);
          ctx.strokeStyle = strained
            ? '#FB7185'
            : isHovOrSel
            ? '#34D399'
            : '#A78BFA';
          ctx.lineWidth = (isHovOrSel ? 3.2 : 2.2) * invScale;
          ctx.stroke();
        }

        if (n.at) {
          const [tx, ty] = localToWorldPoint(n.w, n.at[0], n.at[1]);
          const isHovOrSel = n.id === selectedNodeId || n.id === hovId;
          ctx.beginPath();
          ctx.moveTo(wx, wy);
          ctx.lineTo(tx, ty);
          ctx.strokeStyle = isHovOrSel ? '#34D399' : 'rgba(16, 185, 129, 0.72)';
          ctx.lineWidth = (isHovOrSel ? 3 : 2) * invScale;
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(tx, ty, 3.6 * invScale, 0, Math.PI * 2);
          ctx.fillStyle = isHovOrSel ? '#34D399' : '#10B981';
          ctx.fill();
        }
      }

      for (const n of hydrated.nodes) {
        if (n.ghost) continue;
        const [wx, wy] = worldPt(n, hydrated.by);
        const isSel = n.id === selectedNodeId;
        const strained = n.bond ? Math.abs(n.eff - n.ang) > 0.05 : false;
        const subTrig =
          activeComponent === 'bytruvyus' ? detectSubComponentTrigger(n.id, n.name) : null;
        const rad = (isSel ? 7.5 : subTrig ? 6.2 : 5) * invScale;

        ctx.beginPath();
        ctx.arc(wx, wy, rad, 0, Math.PI * 2);
        ctx.fillStyle = isSel ? '#8B5CF6' : strained ? '#E11D48' : '#111215';
        ctx.fill();
        ctx.strokeStyle = isSel
          ? '#FFFFFF'
          : strained
          ? '#FDA4AF'
          : subTrig
          ? '#FBBF24'
          : n.aim
          ? '#A78BFA'
          : '#10B981';
        ctx.lineWidth = (isSel ? 2.2 : 1.6) * invScale;
        ctx.stroke();

        if (isSel && stageMode === 'design-anchors') {
          const tick = 15 * invScale;
          ctx.beginPath();
          ctx.moveTo(wx - tick, wy);
          ctx.lineTo(wx - rad * 1.3, wy);
          ctx.moveTo(wx + rad * 1.3, wy);
          ctx.lineTo(wx + tick, wy);
          ctx.moveTo(wx, wy - tick);
          ctx.lineTo(wx, wy - rad * 1.3);
          ctx.moveTo(wx, wy + rad * 1.3);
          ctx.lineTo(wx, wy + tick);
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 1.4 * invScale;
          ctx.stroke();
        }
      }
    }
  }, [
    hydrated,
    bondOn,
    showGuides,
    showBones,
    swivelStretch,
    isMirroredTwin,
    activeComponent,
    selectedNodeId,
    stageMode,
    dragOnceActive,
  ]);

  useEffect(() => {
    let active = true;
    for (const piece of hydrated.pieces) {
      if (!piece.src) continue;
      const existing = imgCacheRef.current.get(piece.src);
      if (existing) {
        if (existing.complete && existing.naturalWidth > 0 && !piece.mask) {
          buildBitmapHitMask(piece, existing);
        }
        continue;
      }
      const img = new Image();
      img.onload = () => {
        if (!active) return;
        buildBitmapHitMask(piece, img);
        draw();
      };
      img.src = piece.src;
      imgCacheRef.current.set(piece.src, img);
    }
    return () => {
      active = false;
    };
  }, [hydrated, draw]);

  const fitCamera = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || cv.clientWidth === 0 || cv.clientHeight === 0) return;
    computeWorld(hydrated.nodes, hydrated.by, bondOn);
    const { z, ox, oy } = fitStageViewport(hydrated, cv.clientWidth, cv.clientHeight);
    camRef.current = { z, ox, oy };
    setZoomPct(Math.round(z * 100));
    draw();
  }, [hydrated, bondOn, draw]);

  useEffect(() => {
    const sig = `${activeComponent}|${rigSpec.name}|${rigSpec.W}x${rigSpec.H}|${rigSpec.nodes.length}`;
    if (!hasFittedRef.current || rigSigRef.current !== sig) {
      rigSigRef.current = sig;
      hasFittedRef.current = true;
      requestAnimationFrame(() => fitCamera());
    } else {
      draw();
    }
  }, [activeComponent, rigSpec, fitCamera, draw]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName)) {
        spaceDownRef.current = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDownRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const screenToWorld = (clientX: number, clientY: number): [number, number] => {
    const cv = canvasRef.current!;
    const rect = cv.getBoundingClientRect();
    const { z, ox, oy } = camRef.current;
    const rawWx = (clientX - rect.left - ox) / z;
    const wy = (clientY - rect.top - oy) / z;
    return [isMirroredTwin ? hydrated.W - rawWx : rawWx, wy];
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const [wx, wy] = screenToWorld(e.clientX, e.clientY);
    const { z } = camRef.current;
    const hitTol = 18 / z;

    // 1. Check joint pivots first
    for (const n of hydrated.nodes) {
      if (n.ghost) continue;
      const [px, py] = worldPt(n, hydrated.by);
      if (Math.hypot(wx - px, wy - py) < hitTol) {
        if (activeComponent === 'bytruvyus') {
          const trig = detectSubComponentTrigger(n.id, n.name);
          if (trig) {
            onActivateSubComponent(trig.component, trig.side);
            return;
          }
        }
      }
    }

    // 2. Check pieces
    const pieceHit = hitTestPieces([wx, wy], hydrated.pieces);
    if (pieceHit && activeComponent === 'bytruvyus') {
      const trig = detectSubComponentTrigger(pieceHit.node.id, pieceHit.node.name);
      if (trig) {
        onActivateSubComponent(trig.component, trig.side);
      }
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const [wx, wy] = screenToWorld(e.clientX, e.clientY);

    if (spaceDownRef.current || e.button === 1) {
      dragRef.current = {
        kind: 'pan',
        sx: e.clientX,
        sy: e.clientY,
        ox: camRef.current.ox,
        oy: camRef.current.oy,
      };
      return;
    }

    const { z } = camRef.current;
    const hitTol = 16 / z;

    // 1. 8-handle stretch / resize check in place-pieces mode or one-shot drag mode
    if (
      (stageMode === 'place-pieces' || dragOnceActive) &&
      selectedNodeId &&
      hydrated.by[selectedNodeId]
    ) {
      const selNode = hydrated.by[selectedNodeId];
      for (let idx = 0; idx < selNode.pieces.length; idx++) {
        const pc = selNode.pieces[idx];
        for (const dir of ALL_HANDLE_DIRS) {
          const [lhx, lhy] = getHandleLocalPos(dir, pc.x, pc.y, pc.w, pc.h);
          const [hx, hy] = localToWorldPoint(selNode.w, lhx, lhy);
          if (Math.hypot(wx - hx, wy - hy) < hitTol) {
            dragRef.current = {
              kind: 'piece-resize',
              nodeId: selNode.id,
              pieceIndex: idx,
              dir,
              startLocal: worldToLocalPoint(selNode.w, wx, wy),
              origX: pc.x,
              origY: pc.y,
              origW: pc.w,
              origH: pc.h,
            };
            return;
          }
        }
      }
    }

    // 1b. One-shot click-and-drag PNG positioning takes priority when armed
    if (dragOnceActive) {
      const oneShotHit = hitTestPieces([wx, wy], hydrated.pieces);
      if (oneShotHit) {
        onSelectNode(oneShotHit.node.id);
        const specNode = rigSpec.nodes.find((n) => n.id === oneShotHit.node.id);
        let specPieceIdx = specNode
          ? specNode.pieces.findIndex(
              (p) =>
                p.name === oneShotHit.piece.name &&
                Math.abs(p.x - oneShotHit.piece.x) < 1 &&
                Math.abs(p.y - oneShotHit.piece.y) < 1
            )
          : -1;
        if (specPieceIdx < 0 && specNode) {
          specPieceIdx = specNode.pieces.findIndex((p) => p.name === oneShotHit.piece.name);
        }
        if (specPieceIdx >= 0) {
          dragRef.current = {
            kind: 'piece-move',
            nodeId: oneShotHit.node.id,
            pieceIndex: specPieceIdx,
            startLocal: worldToLocalPoint(oneShotHit.node.w, wx, wy),
            origX: oneShotHit.piece.x,
            origY: oneShotHit.piece.y,
          };
          return;
        }
      }
    }

    // 2. Check pivot joint circles
    let hitNode = null as (typeof hydrated.nodes)[number] | null;
    let bestD = hitTol;
    for (const n of hydrated.nodes) {
      if (n.ghost) continue;
      const [px, py] = worldPt(n, hydrated.by);
      const d = Math.hypot(wx - px, wy - py);
      if (d < bestD) {
        bestD = d;
        hitNode = n;
      }
    }

    const startCoupledShoulderDrag = (
      nodeId: string,
      pieceName?: string
    ): boolean => {
      const side: 'L' | 'R' | null = nodeId.endsWith('L')
        ? 'L'
        : nodeId.endsWith('R')
        ? 'R'
        : null;
      if (!side) return false;
      let guide: 'wing' | 'tendon' | 'acromion' | 'swivel' | null = null;
      if (pieceName === 'Backshoulder' || nodeId === `wing${side}`) guide = 'wing';
      else if (pieceName === 'Shouldertendon' || nodeId === `brace${side}`) guide = 'tendon';
      else if (pieceName === 'Shoulderbone' || nodeId === `acromion${side}`) guide = 'acromion';
      else if (pieceName === 'Shoulderswivel' || nodeId === `swivel${side}`) guide = 'swivel';
      if (!guide) return false;

      const swivel = hydrated.by[`swivel${side}`];
      const acromion = hydrated.by[`acromion${side}`];
      const brace = hydrated.by[`brace${side}`];
      if (!swivel || !acromion || !brace) return false;

      const sPt = worldPt(swivel, hydrated.by);
      const bPt = worldPt(brace, hydrated.by);
      dragRef.current = {
        kind: 'pose-shoulder',
        side,
        guide,
        sSwivel: Math.atan2(wy - sPt[1], wx - sPt[0]),
        sNeck: Math.atan2(wy - bPt[1], wx - bPt[0]),
        swivel0: swivel.ang,
        acro0: acromion.ang,
        brace0: brace.ang,
      };
      return true;
    };

    const startPoseRotateForNode = (
      node: (typeof hydrated.nodes)[number],
      pieceName?: string
    ): boolean => {
      const resolved =
        node.lock && node.parent && hydrated.by[node.parent]
          ? hydrated.by[node.parent]
          : node;
      if (resolved.lock) return false;

      if (resolved.id === 'hipR' || resolved.id === 'hipL') {
        const side: 'L' | 'R' = resolved.id === 'hipL' ? 'L' : 'R';
        const femur = hydrated.by[`femur${side}`];
        if (femur) {
          const hPt = worldPt(resolved, hydrated.by);
          dragRef.current = {
            kind: 'pose-hip',
            side,
            sAng: Math.atan2(wy - hPt[1], wx - hPt[0]) / DEG_TO_RAD,
            hip0: resolved.ang,
            femur0: femur.ang,
          };
          return true;
        }
      }

      if (startCoupledShoulderDrag(resolved.id, pieceName)) return true;

      const pivWorld = worldPt(resolved, hydrated.by);
      const parMat = resolved.parent
        ? hydrated.by[resolved.parent]?.w ?? IDENTITY_MAT
        : IDENTITY_MAT;
      const parDetSign = parMat[0] * parMat[3] - parMat[1] * parMat[2] < 0 ? -1 : 1;
      const humerusSide =
        resolved.id === 'humerusL' ? 'L' : resolved.id === 'humerusR' ? 'R' : null;
      dragRef.current = {
        kind: 'pose-rotate',
        nodeId: resolved.id,
        pivWorld,
        startMouseAng: Math.atan2(wy - pivWorld[1], wx - pivWorld[0]) / DEG_TO_RAD,
        startNodeAng: resolved.ang,
        parDetSign,
        startSwivelAng: humerusSide
          ? hydrated.by[`swivel${humerusSide}`]?.ang
          : undefined,
      };
      return true;
    };

    if (hitNode) {
      const activeBone =
        hitNode.lock && hitNode.parent && hydrated.by[hitNode.parent] && stageMode === 'pose-test'
          ? hydrated.by[hitNode.parent]
          : hitNode;
      onSelectNode(activeBone.id);
      if (stageMode === 'design-anchors') {
        const [px, py] = worldPt(hitNode, hydrated.by);
        const specNode = rigSpec.nodes.find((n) => n.id === hitNode.id);
        dragRef.current = {
          kind: 'pivot',
          nodeId: hitNode.id,
          offsetX: wx - px,
          offsetY: wy - py,
          origPivot: specNode
            ? [specNode.pivot[0], specNode.pivot[1]]
            : [hitNode.piv[0], hitNode.piv[1]],
          carryPng: boneBondsPng && !e.altKey,
        };
        return;
      }
      if (stageMode === 'pose-test' && startPoseRotateForNode(hitNode)) {
        return;
      }
    }

    // 2b. Check digital bone shafts (drags bone + bonded PNG cleanly in Design Anchors & Pose Test)
    if (showBones && stageMode !== 'place-pieces') {
      const boneShaftHit = hitTestDigitalBone(wx, wy, hydrated, hitTol);
      if (boneShaftHit) {
        onSelectNode(boneShaftHit.id);
        if (startPoseRotateForNode(boneShaftHit)) {
          return;
        }
      }
    }

    // 3. Hit test sprite pieces
    const pieceHit = hitTestPieces([wx, wy], hydrated.pieces);
    if (pieceHit) {
      onSelectNode(pieceHit.node.id);
      const specNode = rigSpec.nodes.find((n) => n.id === pieceHit.node.id);
      const specPieceIdx = specNode
        ? specNode.pieces.findIndex(
            (p) => p.name === pieceHit.piece.name && Math.abs(p.x - pieceHit.piece.x) < 1
          )
        : 0;

      if (stageMode === 'place-pieces' && specPieceIdx >= 0) {
        dragRef.current = {
          kind: 'piece-move',
          nodeId: pieceHit.node.id,
          pieceIndex: specPieceIdx,
          startLocal: worldToLocalPoint(pieceHit.node.w, wx, wy),
          origX: pieceHit.piece.x,
          origY: pieceHit.piece.y,
        };
        return;
      }

      if (
        (stageMode === 'pose-test' || (stageMode === 'design-anchors' && boneBondsPng)) &&
        startPoseRotateForNode(pieceHit.node, pieceHit.piece.name)
      ) {
        return;
      }
    }

    // 4. Empty space -> Pan
    if (!hitNode && !pieceHit) {
      dragRef.current = {
        kind: 'pan',
        sx: e.clientX,
        sy: e.clientY,
        ox: camRef.current.ox,
        oy: camRef.current.oy,
      };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [wx, wy] = screenToWorld(e.clientX, e.clientY);
    setCursorCoords([Math.round(wx), Math.round(wy)]);

    const drag = dragRef.current;
    if (!drag) {
      if (showBones && stageMode !== 'place-pieces') {
        const hitTol = 16 / camRef.current.z;
        const hov = hitTestDigitalBone(wx, wy, hydrated, hitTol);
        const nextId = hov?.id ?? null;
        if (hoveredBoneIdRef.current !== nextId) {
          hoveredBoneIdRef.current = nextId;
          draw();
        }
      }
      return;
    }

    if (drag.kind === 'pan') {
      camRef.current.ox = drag.ox + (e.clientX - drag.sx);
      camRef.current.oy = drag.oy + (e.clientY - drag.sy);
      draw();
      return;
    }

    if (drag.kind === 'pivot') {
      const target = hydrated.by[drag.nodeId];
      if (!target) return;
      const parentMat = target.parent ? hydrated.by[target.parent]?.w : null;
      let nextWorldX = wx - drag.offsetX;
      let nextWorldY = wy - drag.offsetY;
      if (e.shiftKey) {
        nextWorldX = Math.round(nextWorldX / 10) * 10;
        nextWorldY = Math.round(nextWorldY / 10) * 10;
      }
      const [lx, ly] = parentMat
        ? worldToLocalPoint(parentMat, nextWorldX, nextWorldY)
        : [nextWorldX, nextWorldY];
      const roundedPivot: [number, number] = [
        Math.round(lx * 10) / 10,
        Math.round(ly * 10) / 10,
      ];
      if (drag.carryPng) {
        onMoveBoneWithPngs(drag.nodeId, roundedPivot);
      } else {
        onMovePivot(drag.nodeId, roundedPivot);
      }
      return;
    }

    if (drag.kind === 'piece-move') {
      const node = hydrated.by[drag.nodeId];
      if (!node) return;
      const curLocal = worldToLocalPoint(node.w, wx, wy);
      let nx = drag.origX + (curLocal[0] - drag.startLocal[0]);
      let ny = drag.origY + (curLocal[1] - drag.startLocal[1]);
      if (e.shiftKey) {
        nx = Math.round(nx / 10) * 10;
        ny = Math.round(ny / 10) * 10;
      }
      onMovePiece(drag.nodeId, drag.pieceIndex, Math.round(nx), Math.round(ny));
      return;
    }

    if (drag.kind === 'piece-resize') {
      const node = hydrated.by[drag.nodeId];
      if (!node) return;
      const curLocal = worldToLocalPoint(node.w, wx, wy);
      const dx = curLocal[0] - drag.startLocal[0];
      const dy = curLocal[1] - drag.startLocal[1];

      let nx = drag.origX;
      let ny = drag.origY;
      let nw = drag.origW;
      let nh = drag.origH;

      if (drag.dir.includes('e')) {
        nw = Math.max(16, drag.origW + dx);
      }
      if (drag.dir.includes('s')) {
        nh = Math.max(16, drag.origH + dy);
      }
      if (drag.dir.includes('w')) {
        const clampedDx = Math.min(dx, drag.origW - 16);
        nx = drag.origX + clampedDx;
        nw = drag.origW - clampedDx;
      }
      if (drag.dir.includes('n')) {
        const clampedDy = Math.min(dy, drag.origH - 16);
        ny = drag.origY + clampedDy;
        nh = drag.origH - clampedDy;
      }

      onMovePiece(
        drag.nodeId,
        drag.pieceIndex,
        Math.round(nx),
        Math.round(ny),
        Math.round(nw),
        Math.round(nh)
      );
      return;
    }

    if (drag.kind === 'pose-shoulder') {
      const swivel = hydrated.by[`swivel${drag.side}`];
      const acromion = hydrated.by[`acromion${drag.side}`];
      const brace = hydrated.by[`brace${drag.side}`];
      if (!swivel || !acromion || !brace) return;

      const sPt = worldPt(swivel, hydrated.by);
      const bPt = worldPt(brace, hydrated.by);
      const dSwivel = wrapAngleDeg(
        (Math.atan2(wy - sPt[1], wx - sPt[0]) - drag.sSwivel) / DEG_TO_RAD
      );
      const dNeck = wrapAngleDeg(
        (Math.atan2(wy - bPt[1], wx - bPt[0]) - drag.sNeck) / DEG_TO_RAD
      );

      let rawSwivel = drag.swivel0;
      let rawAcro = drag.acro0;
      let rawBrace = drag.brace0;

      if (drag.guide === 'wing') {
        rawSwivel = drag.swivel0 + dSwivel;
        rawBrace = drag.brace0 + dSwivel * 0.35;
        rawAcro = drag.acro0 - dSwivel * 0.45;
      } else if (drag.guide === 'tendon') {
        rawSwivel = drag.swivel0 + dSwivel * 0.85;
        rawBrace = drag.brace0 + dNeck * 0.55;
        rawAcro = drag.acro0 - dSwivel * 0.25;
      } else if (drag.guide === 'acromion') {
        rawAcro = drag.acro0 + dNeck * 0.9;
        rawSwivel = drag.swivel0 + dSwivel * 0.55;
        rawBrace = drag.brace0 + dSwivel * 0.25;
      } else {
        rawSwivel = drag.swivel0 + dSwivel;
        rawBrace = drag.brace0 + dSwivel * 0.28;
        rawAcro = drag.acro0 - dSwivel * 0.35;
      }

      const nextSwivel = clampAnatomicalAngle(
        swivel.id,
        rawSwivel,
        swivel.limits,
        hydrated.by,
        constrainLimits
      );
      const nextAcro = clampAnatomicalAngle(
        acromion.id,
        rawAcro,
        acromion.limits,
        hydrated.by,
        constrainLimits
      );
      const nextBrace = clampAnatomicalAngle(
        brace.id,
        rawBrace,
        brace.limits,
        hydrated.by,
        constrainLimits
      );

      onPoseAngles({
        [swivel.id]: Math.round(nextSwivel * 10) / 10,
        [acromion.id]: Math.round(nextAcro * 10) / 10,
        [brace.id]: Math.round(nextBrace * 10) / 10,
      });
      return;
    }

    if (drag.kind === 'pose-hip') {
      const hip = hydrated.by[`hip${drag.side}`];
      const femur = hydrated.by[`femur${drag.side}`];
      if (!hip || !femur) return;
      const hPt = worldPt(hip, hydrated.by);
      const curAng = Math.atan2(wy - hPt[1], wx - hPt[0]) / DEG_TO_RAD;
      const delta = wrapAngleDeg(curAng - drag.sAng);
      const nextFemur = clampAnatomicalAngle(
        femur.id,
        drag.femur0 + delta,
        femur.limits,
        hydrated.by,
        constrainLimits
      );
      const nextHip = clampAnatomicalAngle(
        hip.id,
        drag.hip0 + delta * 0.25,
        hip.limits,
        hydrated.by,
        constrainLimits
      );
      onPoseAngles({
        [femur.id]: Math.round(nextFemur * 10) / 10,
        [hip.id]: Math.round(nextHip * 10) / 10,
      });
      return;
    }

    if (drag.kind === 'pose-rotate') {
      const node = hydrated.by[drag.nodeId];
      if (!node) return;
      const curMouseAng =
        Math.atan2(wy - drag.pivWorld[1], wx - drag.pivWorld[0]) / DEG_TO_RAD;
      const delta = wrapAngleDeg(curMouseAng - drag.startMouseAng) * drag.parDetSign;
      const nextAng = clampAnatomicalAngle(
        node.id,
        drag.startNodeAng + delta,
        node.limits,
        hydrated.by,
        constrainLimits
      );

      // Gentle clavicle/scapula elevation coupling when raising humerus
      if (
        (node.id === 'humerusL' || node.id === 'humerusR') &&
        drag.startSwivelAng !== undefined
      ) {
        const side = node.id.endsWith('L') ? 'L' : 'R';
        const swivel = hydrated.by[`swivel${side}`];
        if (swivel) {
          const sideSign = side === 'R' ? -1 : 1;
          const lift = nextAng * sideSign;
          if (Math.abs(lift) > 14) {
            const excess = (Math.abs(lift) - 14) / 90;
            const couple = Math.max(-1, Math.min(1, excess)) * (lift > 0 ? 1 : -0.5);
            const nextSwivel = clampAnatomicalAngle(
              swivel.id,
              sideSign * -12 * couple,
              swivel.limits,
              hydrated.by,
              constrainLimits
            );
            onPoseAngles({
              [node.id]: Math.round(nextAng * 10) / 10,
              [swivel.id]: Math.round(nextSwivel * 10) / 10,
            });
            return;
          }
        }
      }

      onPoseAngle(drag.nodeId, Math.round(nextAng * 10) / 10);
    }
  };

  const handlePointerUp = () => {
    const finished = dragRef.current;
    dragRef.current = null;
    if (
      dragOnceActive &&
      finished &&
      (finished.kind === 'piece-move' || finished.kind === 'piece-resize')
    ) {
      onCompleteDragOnce();
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const oldZ = camRef.current.z;
    const newZ = Math.max(0.02, Math.min(8, oldZ * factor));
    camRef.current.ox = sx - (sx - camRef.current.ox) * (newZ / oldZ);
    camRef.current.oy = sy - (sy - camRef.current.oy) * (newZ / oldZ);
    camRef.current.z = newZ;
    setZoomPct(Math.round(newZ * 100));
    draw();
  };

  const zoomBy = (factor: number) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const sx = cv.clientWidth * 0.5;
    const sy = cv.clientHeight * 0.5;
    const oldZ = camRef.current.z;
    const newZ = Math.max(0.02, Math.min(8, oldZ * factor));
    camRef.current.ox = sx - (sx - camRef.current.ox) * (newZ / oldZ);
    camRef.current.oy = sy - (sy - camRef.current.oy) * (newZ / oldZ);
    camRef.current.z = newZ;
    setZoomPct(Math.round(newZ * 100));
    draw();
  };

  return (
    <div ref={containerRef} className="flex-1 relative bg-[#111215] overflow-hidden select-none">
      {/* Stage Toolbar */}
      <div className="absolute top-3 left-3 right-3 z-10 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
        <div className="flex items-center gap-2 pointer-events-auto">
          {activeComponent !== 'bytruvyus' && (
            <button
              type="button"
              onClick={onBackToMaster}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-100 bg-[#181A1F]/95 hover:bg-[#242830] border border-white/[0.1] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to Bytruvyus
            </button>
          )}

          {(activeComponent === 'gotz' || activeComponent === 'piggy') && (
            <div className="flex items-center gap-1 p-1 bg-[#181A1F]/95 border border-white/[0.08] rounded-lg">
              <button
                type="button"
                onClick={() => onChangeTwinSide('L')}
                className={`px-2.5 py-1 text-xs font-mono rounded transition-colors cursor-pointer ${
                  activeTwinSide === 'L'
                    ? 'bg-violet-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                L Twin
              </button>
              <button
                type="button"
                onClick={() => onChangeTwinSide('R')}
                className={`px-2.5 py-1 text-xs font-mono rounded transition-colors cursor-pointer ${
                  activeTwinSide === 'R'
                    ? 'bg-violet-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                R Twin
              </button>
            </div>
          )}

          {/* Mode Segmented Control */}
          <div className="flex items-center gap-1 p-1 bg-[#181A1F]/95 backdrop-blur border border-white/[0.08] rounded-lg">
            <button
              type="button"
              onClick={() => onChangeStageMode('design-anchors')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                stageMode === 'design-anchors'
                  ? 'bg-violet-600 text-white'
                  : 'text-gray-300 hover:text-white hover:bg-white/[0.05]'
              }`}
            >
              <Anchor className="w-3.5 h-3.5" />
              Design Anchors
            </button>
            <button
              type="button"
              onClick={() => onChangeStageMode('place-pieces')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                stageMode === 'place-pieces'
                  ? 'bg-violet-600 text-white'
                  : 'text-gray-300 hover:text-white hover:bg-white/[0.05]'
              }`}
            >
              <Move className="w-3.5 h-3.5" />
              Place &amp; Stretch
            </button>
            <button
              type="button"
              onClick={() => onChangeStageMode('pose-test')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                stageMode === 'pose-test'
                  ? 'bg-violet-600 text-white'
                  : 'text-gray-300 hover:text-white hover:bg-white/[0.05]'
              }`}
            >
              <Play className="w-3.5 h-3.5" />
              Pose / FK
            </button>
          </div>

          <button
            type="button"
            onClick={onToggleDragOnce}
            title="Click and drag an asset when active; automatically shuts off after one drag"
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap cursor-pointer ${
              dragOnceActive
                ? 'bg-amber-500/25 border-amber-400/60 text-amber-200'
                : 'bg-[#181A1F]/95 border-white/[0.08] text-gray-300 hover:text-white hover:bg-white/[0.06]'
            }`}
          >
            <Hand className="w-3.5 h-3.5" />
            {dragOnceActive ? 'Drag Once (Active)' : 'Drag Once'}
          </button>
        </div>

        {/* Viewport & Kinematic Toggles */}
        <div className="pointer-events-auto flex items-center gap-1 p-1 bg-[#181A1F]/95 backdrop-blur border border-white/[0.08] rounded-lg">
          <button
            type="button"
            onClick={() => setShowBones((v) => !v)}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              showBones ? 'bg-white/[0.1] text-emerald-300' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Bones
          </button>
          <button
            type="button"
            onClick={() => setShowGuides((v) => !v)}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              showGuides ? 'bg-white/[0.1] text-gray-100' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Guides
          </button>
          <button
            type="button"
            onClick={() => setConstrainLimits((v) => !v)}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              constrainLimits ? 'bg-white/[0.1] text-gray-100' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Limits
          </button>
          <button
            type="button"
            onClick={() => setBondOn((v) => !v)}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              bondOn ? 'bg-white/[0.1] text-violet-300' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Aim Bonds
          </button>
          <button
            type="button"
            onClick={() => setSwivelStretch((v) => !v)}
            title="Allow PNGs to stretch dynamically with bone swivels in Forge (rigid on export)"
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              swivelStretch ? 'bg-white/[0.1] text-amber-300' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Swivel Stretch
          </button>
          <button
            type="button"
            onClick={() => setBoneBondsPng((v) => !v)}
            title="Keep PNGs bonded when dragging digital bones or joints (hold Alt to move pivot alone)"
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              boneBondsPng ? 'bg-white/[0.1] text-emerald-300' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Bone Bonds PNG
          </button>

          <span className="h-4 w-px bg-white/[0.08] mx-0.5" />

          <button
            type="button"
            onClick={onOpenCalibration}
            title="Open Mask & Anchor Calibration Window"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-violet-200 bg-violet-600/25 hover:bg-violet-600/40 border border-violet-500/35 rounded-md whitespace-nowrap cursor-pointer"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Calibrate Masks
          </button>

          <button
            type="button"
            onClick={onResetPose}
            title="Reset all pose angles to rest"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-300 hover:text-white hover:bg-white/[0.05] rounded-md whitespace-nowrap cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Pose
          </button>
        </div>
      </div>

      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => {
          if (hoveredBoneIdRef.current !== null) {
            hoveredBoneIdRef.current = null;
            draw();
          }
        }}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
        className={`w-full h-full block ${dragOnceActive ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'}`}
      />

      {/* Yorick View & Pose Bar (Front / Side / Back) */}
      {activeComponent === 'yorick' && (
        <div className="absolute top-16 left-3 z-10 pointer-events-auto flex flex-wrap items-center gap-1.5 p-1.5 bg-[#181A1F]/95 backdrop-blur border border-white/[0.08] rounded-lg max-w-[calc(100%-24px)]">
          <div className="flex items-center gap-0.5 p-0.5 bg-[#111215] border border-white/[0.06] rounded-md">
            {(['front', 'side', 'back'] as const).map((grp) => (
              <button
                key={grp}
                type="button"
                onClick={() => {
                  setYorickGroup(grp);
                  const first = YORICK_POSE_PRESETS.find((p) => p.group === grp);
                  if (first) onApplyYorickPose(first.id);
                }}
                className={`px-2.5 py-1 text-[11px] font-medium rounded capitalize transition-colors cursor-pointer ${
                  yorickGroup === grp
                    ? 'bg-violet-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {grp}
              </button>
            ))}
          </div>

          <span className="h-4 w-px bg-white/[0.08]" />

          <div className="flex flex-wrap items-center gap-1">
            {YORICK_POSE_PRESETS.filter((p) => p.group === yorickGroup).map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => onApplyYorickPose(preset.id)}
                title={preset.description}
                className={`px-2.5 py-1 text-[11px] rounded border transition-colors whitespace-nowrap cursor-pointer ${
                  activeYorickPose === preset.id
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-200 font-medium'
                    : 'bg-[#111215] border-white/[0.06] text-gray-300 hover:border-white/20 hover:text-white'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Bottom Stage Controls & Coordinates */}
      <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between pointer-events-none">
        <div className="pointer-events-auto px-3 py-1.5 rounded-lg bg-[#181A1F]/90 border border-white/[0.08] text-xs text-gray-400 flex items-center gap-2">
          <span>
            {dragOnceActive
              ? 'One-shot asset drag armed: click & drag any PNG piece (auto-disables when released)'
              : stageMode === 'design-anchors'
              ? boneBondsPng
                ? 'Drag digital bones or PNGs to swivel · Drag joint pivots to carry bone + bonded PNG (Alt = pivot only)'
                : 'Drag pivot crosshairs to re-anchor joints (Shift snaps 10px) · Drag bone shafts to swivel'
              : stageMode === 'place-pieces'
              ? 'Drag PNG pieces to position or drag any of 8 handles to stretch non-uniformly'
              : 'Drag digital bones, joints, or PNGs to swivel FK + aim bonds'}
          </span>
          {cursorCoords && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-gray-300">
                {cursorCoords[0]}, {cursorCoords[1]} px
              </span>
            </>
          )}
        </div>

        <div className="pointer-events-auto flex items-center gap-1 p-1 rounded-lg bg-[#181A1F]/90 border border-white/[0.08]">
          <button
            type="button"
            onClick={() => zoomBy(0.85)}
            title="Zoom out"
            className="p-1.5 text-gray-300 hover:text-white hover:bg-white/[0.06] rounded cursor-pointer"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="px-2 text-xs font-mono tabular-nums text-gray-300 min-w-[46px] text-center">
            {zoomPct}%
          </span>
          <button
            type="button"
            onClick={() => zoomBy(1.18)}
            title="Zoom in"
            className="p-1.5 text-gray-300 hover:text-white hover:bg-white/[0.06] rounded cursor-pointer"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={fitCamera}
            title="Fit rig to stage"
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-gray-300 hover:text-white hover:bg-white/[0.06] rounded whitespace-nowrap cursor-pointer"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            Fit
          </button>
        </div>
      </div>
    </div>
  );
};
