import { PieceSpec, RigNodeSpec, RigSpec } from './types';

export interface AlphaMaskAnalysis {
  gridW: number;
  gridH: number;
  mask: Uint8Array;
  edgeMask: Uint8Array;
  uMin: number;
  vMin: number;
  uMax: number;
  vMax: number;
  centroidUV: [number, number];
  topSocketUV: [number, number];
  bottomSocketUV: [number, number];
  leftSocketUV: [number, number];
  rightSocketUV: [number, number];
  coverageRatio: number;
  orientation: 'vertical' | 'horizontal' | 'compact';
}

export interface CalibrationProposal {
  id: string;
  label: string;
  kind: 'anatomical-socket' | 'bone-span' | 'aim-tendon' | 'mirror-twin' | 'alpha-centroid';
  confidence: number;
  reason: string;
  patch: {
    x: number;
    y: number;
    w: number;
    h: number;
    scaleX?: number;
    scaleY?: number;
  };
}

export interface AnchorContextReport {
  anatomicalRole: string;
  childNode: RigNodeSpec | null;
  aimTargetNode: RigNodeSpec | null;
  parentNode: RigNodeSpec | null;
  twinNode: RigNodeSpec | null;
  spanDist: number | null;
  currentAnchorUV: [number, number];
  offsetFromPivot: [number, number];
  proposals: CalibrationProposal[];
}

export function getEffectivePieceBox(piece: PieceSpec): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const sx = piece.scaleX ?? 1;
  const sy = piece.scaleY ?? 1;
  const ew = piece.w * sx;
  const eh = piece.h * sy;
  return {
    x: piece.x + (piece.w - ew) * 0.5,
    y: piece.y + (piece.h - eh) * 0.5,
    w: ew,
    h: eh,
  };
}

export function getPieceAnchorUV(piece: PieceSpec, pivot: [number, number]): [number, number] {
  const box = getEffectivePieceBox(piece);
  const u = box.w > 0 ? (pivot[0] - box.x) / box.w : 0.5;
  const v = box.h > 0 ? (pivot[1] - box.y) / box.h : 0.5;
  return [Math.round(u * 1000) / 1000, Math.round(v * 1000) / 1000];
}

export function computeBoxForPinnedUV(
  piece: PieceSpec,
  pivot: [number, number],
  u: number,
  v: number,
  overrideW?: number,
  overrideH?: number
): { x: number; y: number; w: number; h: number } {
  const w = overrideW ?? piece.w;
  const h = overrideH ?? piece.h;
  const sx = piece.scaleX ?? 1;
  const sy = piece.scaleY ?? 1;
  const ew = w * sx;
  const eh = h * sy;
  const drawX = pivot[0] - u * ew;
  const drawY = pivot[1] - v * eh;
  const x = drawX - (w - ew) * 0.5;
  const y = drawY - (h - eh) * 0.5;
  return {
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
    w: Math.round(w),
    h: Math.round(h),
  };
}

export function findTwinNode(node: RigNodeSpec, rig: RigSpec): RigNodeSpec | null {
  const id = node.id;
  const candidates: string[] = [];
  if (id.endsWith('L')) candidates.push(`${id.slice(0, -1)}R`);
  else if (id.endsWith('R')) candidates.push(`${id.slice(0, -1)}L`);
  else if (/_L$/i.test(id)) candidates.push(id.replace(/_L$/i, '_R'));
  else if (/_R$/i.test(id)) candidates.push(id.replace(/_R$/i, '_L'));
  else if (/1$/.test(id)) candidates.push(id.replace(/1$/, '2'));
  else if (/2$/.test(id)) candidates.push(id.replace(/2$/, '1'));

  for (const cand of candidates) {
    const found = rig.nodes.find((n) => n.id.toLowerCase() === cand.toLowerCase());
    if (found && found.id !== node.id) return found;
  }
  return null;
}

export async function analyzeImageAlphaMask(
  src: string,
  threshold = 25
): Promise<AlphaMaskAnalysis | null> {
  if (!src || typeof document === 'undefined') return null;

  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = src;
  });
  if (!img || !img.naturalWidth || !img.naturalHeight) return null;

  const maxSide = 140;
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const gw = Math.max(8, Math.round(img.naturalWidth * scale));
  const gh = Math.max(8, Math.round(img.naturalHeight * scale));

  const cv = document.createElement('canvas');
  cv.width = gw;
  cv.height = gh;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(img, 0, 0, gw, gh);
  const rgba = ctx.getImageData(0, 0, gw, gh).data;
  const mask = new Uint8Array(gw * gh);
  const edgeMask = new Uint8Array(gw * gh);

  let minX = gw;
  let minY = gh;
  let maxX = -1;
  let maxY = -1;
  let sumX = 0;
  let sumY = 0;
  let count = 0;

  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const idx = y * gw + x;
      const opaque = rgba[idx * 4 + 3] > threshold ? 1 : 0;
      mask[idx] = opaque;
      if (opaque) {
        count++;
        sumX += x + 0.5;
        sumY += y + 0.5;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const idx = y * gw + x;
      if (!mask[idx]) continue;
      const isBorder =
        x === 0 ||
        y === 0 ||
        x === gw - 1 ||
        y === gh - 1 ||
        !mask[idx - 1] ||
        !mask[idx + 1] ||
        !mask[idx - gw] ||
        !mask[idx + gw];
      if (isBorder) edgeMask[idx] = 1;
    }
  }

  if (count === 0) {
    return {
      gridW: gw,
      gridH: gh,
      mask,
      edgeMask,
      uMin: 0,
      vMin: 0,
      uMax: 1,
      vMax: 1,
      centroidUV: [0.5, 0.5],
      topSocketUV: [0.5, 0.12],
      bottomSocketUV: [0.5, 0.88],
      leftSocketUV: [0.12, 0.5],
      rightSocketUV: [0.88, 0.5],
      coverageRatio: 0,
      orientation: 'compact',
    };
  }

  const bandCentroid = (
    uLo: number,
    uHi: number,
    vLo: number,
    vHi: number,
    fallback: [number, number]
  ): [number, number] => {
    const x0 = Math.max(0, Math.floor(uLo * gw));
    const x1 = Math.min(gw - 1, Math.ceil(uHi * gw));
    const y0 = Math.max(0, Math.floor(vLo * gh));
    const y1 = Math.min(gh - 1, Math.ceil(vHi * gh));
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (mask[y * gw + x]) {
          sx += (x + 0.5) / gw;
          sy += (y + 0.5) / gh;
          n++;
        }
      }
    }
    return n > 0
      ? [Math.round((sx / n) * 1000) / 1000, Math.round((sy / n) * 1000) / 1000]
      : fallback;
  };

  const uMin = minX / gw;
  const vMin = minY / gh;
  const uMax = (maxX + 1) / gw;
  const vMax = (maxY + 1) / gh;
  const spanU = Math.max(0.01, uMax - uMin);
  const spanV = Math.max(0.01, vMax - vMin);

  const worldAspect = (img.naturalWidth * spanU) / Math.max(1, img.naturalHeight * spanV);
  const orientation: AlphaMaskAnalysis['orientation'] =
    worldAspect < 0.72 ? 'vertical' : worldAspect > 1.38 ? 'horizontal' : 'compact';

  return {
    gridW: gw,
    gridH: gh,
    mask,
    edgeMask,
    uMin,
    vMin,
    uMax,
    vMax,
    centroidUV: [
      Math.round((sumX / count / gw) * 1000) / 1000,
      Math.round((sumY / count / gh) * 1000) / 1000,
    ],
    topSocketUV: bandCentroid(uMin, uMax, vMin, vMin + spanV * 0.2, [0.5, vMin + spanV * 0.1]),
    bottomSocketUV: bandCentroid(uMin, uMax, vMax - spanV * 0.2, vMax, [0.5, vMax - spanV * 0.1]),
    leftSocketUV: bandCentroid(uMin, uMin + spanU * 0.2, vMin, vMax, [uMin + spanU * 0.1, 0.5]),
    rightSocketUV: bandCentroid(uMax - spanU * 0.2, uMax, vMin, vMax, [uMax - spanU * 0.1, 0.5]),
    coverageRatio: Math.round((count / (gw * gh)) * 1000) / 1000,
    orientation,
  };
}

function inferRoleAndAnchorPrior(
  node: RigNodeSpec,
  alpha: AlphaMaskAnalysis | null
): {
  label: string;
  socketUV: [number, number];
  reason: string;
  confidence: number;
} {
  const key = `${node.id} ${node.name}`.toLowerCase();

  if (/(pelvis|hip_root|hips|\broot\b|skull|ankle)/i.test(key)) {
    return {
      label: 'Core Anchor / Root Socket',
      socketUV: alpha ? alpha.centroidUV : [0.5, 0.5],
      reason: 'Core root anatomy centers directly over its pivot via alpha mass centroid',
      confidence: 0.94,
    };
  }
  if (/(thorax|chest|rib|torso|lumbar|neck|\bhead\b|jaw|chin)/i.test(key)) {
    const uv: [number, number] = alpha ? alpha.bottomSocketUV : [0.5, 0.86];
    return {
      label: 'Upright Spinal / Cranial Socket',
      socketUV: uv,
      reason: 'Spinal/head segments articulate from their lower proximal joint socket',
      confidence: 0.91,
    };
  }
  if (/(brace|tendon|collar|clavicle)/i.test(key)) {
    const isRight = /(right|_r\b|r$)/i.test(node.id);
    const uv: [number, number] = alpha
      ? isRight
        ? alpha.rightSocketUV
        : alpha.leftSocketUV
      : [isRight ? 0.88 : 0.12, 0.5];
    return {
      label: 'Closed-Chain Brace / Tendon Origin',
      socketUV: uv,
      reason: 'Horizontal tendon brace pins at its medial origin socket and aims at shoulder',
      confidence: 0.93,
    };
  }
  if (/(foot|shoe|boot|footbone|piggy)/i.test(key)) {
    const isRight = /(right|_r\b|r$)/i.test(node.id);
    const uv: [number, number] = alpha
      ? [isRight ? alpha.rightSocketUV[0] : alpha.leftSocketUV[0], alpha.topSocketUV[1]]
      : [isRight ? 0.72 : 0.28, 0.25];
    return {
      label: 'Ankle / Heel Socket',
      socketUV: uv,
      reason: 'Foot segment anchors near upper-heel ankle socket',
      confidence: 0.9,
    };
  }
  if (/(humerus|forearm|ulna|radius|femur|shin|calf|tibia|fibula|hand|palm|prox|mid|dist|meta)/i.test(key)) {
    const uv: [number, number] = alpha ? alpha.topSocketUV : [0.5, 0.12];
    return {
      label: 'Suspended Limb Joint Socket',
      socketUV: uv,
      reason: 'Articulated limb hangs from its proximal upper joint cap silhouette',
      confidence: 0.92,
    };
  }
  if (/(eyeball|iris|pupil|socket)/i.test(key)) {
    return {
      label: 'Orbital Center Socket',
      socketUV: alpha ? alpha.centroidUV : [0.5, 0.5],
      reason: 'Radial orbital element centers around pivot for spherical swivel',
      confidence: 0.95,
    };
  }

  // Pure geometric silhouette heuristic when name is generic ("Inserted Image", "Bone 4")
  if (alpha) {
    if (alpha.orientation === 'vertical') {
      return {
        label: 'Vertical Silhouette Joint Cap',
        socketUV: alpha.topSocketUV,
        reason: 'Vertical silhouette detected; inferred proximal upper socket from alpha contour',
        confidence: 0.8,
      };
    }
    if (alpha.orientation === 'horizontal') {
      return {
        label: 'Horizontal Silhouette Origin',
        socketUV: alpha.leftSocketUV,
        reason: 'Horizontal silhouette detected; inferred proximal edge origin from alpha contour',
        confidence: 0.78,
      };
    }
    return {
      label: 'Alpha Mass Centroid',
      socketUV: alpha.centroidUV,
      reason: 'Compact mask geometry aligned to opaque pixel center of mass',
      confidence: 0.79,
    };
  }

  return {
    label: 'Default Joint Cap',
    socketUV: [0.5, 0.18],
    reason: 'Standard upper-center bone anchor prior',
    confidence: 0.7,
  };
}

export function buildContextRecognition(
  node: RigNodeSpec,
  piece: PieceSpec,
  rig: RigSpec,
  alpha: AlphaMaskAnalysis | null
): AnchorContextReport {
  const parentNode = node.parent
    ? rig.nodes.find((n) => n.id === node.parent) ?? null
    : null;
  const childNode = rig.nodes.find((n) => n.parent === node.id) ?? null;
  const aimTargetNode = node.aim
    ? rig.nodes.find((n) => n.id === node.aim!.to) ?? null
    : null;
  const twinNode = findTwinNode(node, rig);

  const targetAnchor = aimTargetNode ?? childNode;
  const spanDist = targetAnchor
    ? Math.round(
        Math.hypot(
          targetAnchor.pivot[0] - node.pivot[0],
          targetAnchor.pivot[1] - node.pivot[1]
        ) * 10
      ) / 10
    : null;

  const box = getEffectivePieceBox(piece);
  const currentAnchorUV = getPieceAnchorUV(piece, node.pivot);
  const offsetFromPivot: [number, number] = [
    Math.round((box.x - node.pivot[0]) * 10) / 10,
    Math.round((box.y - node.pivot[1]) * 10) / 10,
  ];

  const prior = inferRoleAndAnchorPrior(node, alpha);
  const proposals: CalibrationProposal[] = [];

  // Proposal 1: Anatomical + Alpha Socket Alignment
  const socketBox = computeBoxForPinnedUV(
    piece,
    node.pivot,
    prior.socketUV[0],
    prior.socketUV[1]
  );
  proposals.push({
    id: 'anatomical-socket',
    label: `Snap ${prior.label}`,
    kind: 'anatomical-socket',
    confidence: prior.confidence,
    reason: `${prior.reason} (${Math.round(prior.socketUV[0] * 100)}%, ${Math.round(
      prior.socketUV[1] * 100
    )}%)`,
    patch: {
      x: socketBox.x,
      y: socketBox.y,
      w: piece.w,
      h: piece.h,
      scaleX: piece.scaleX ?? 1,
      scaleY: piece.scaleY ?? 1,
    },
  });

  // Proposal 2: Bone Span Fit (stretch/place mask between node.pivot and child/aim target)
  if (targetAnchor && spanDist && spanDist > 24) {
    const dx = targetAnchor.pivot[0] - node.pivot[0];
    const dy = targetAnchor.pivot[1] - node.pivot[1];
    const isPrimarilyVertical = Math.abs(dy) >= Math.abs(dx);
    const padFactor = 1.18; // allow joint caps around both pivots

    if (isPrimarilyVertical) {
      const targetH = Math.max(24, Math.round(Math.abs(dy) * padFactor));
      const vPin = dy >= 0 ? 0.1 : 0.9;
      const fitted = computeBoxForPinnedUV(piece, node.pivot, prior.socketUV[0], vPin, piece.w, targetH);
      proposals.push({
        id: 'bone-span',
        label: `Fit ${node.id} → ${targetAnchor.id} Span (${Math.round(spanDist)}px)`,
        kind: aimTargetNode ? 'aim-tendon' : 'bone-span',
        confidence: aimTargetNode ? 0.94 : 0.87,
        reason: `Spans vertical bone vector (${Math.round(spanDist)}px) with joint cap overlap`,
        patch: {
          x: fitted.x,
          y: fitted.y,
          w: piece.w,
          h: targetH,
          scaleX: 1,
          scaleY: 1,
        },
      });
    } else {
      const targetW = Math.max(24, Math.round(Math.abs(dx) * padFactor));
      const uPin = dx >= 0 ? 0.1 : 0.9;
      const fitted = computeBoxForPinnedUV(piece, node.pivot, uPin, 0.5, targetW, piece.h);
      proposals.push({
        id: 'bone-span',
        label: `Fit ${node.id} → ${targetAnchor.id} Span (${Math.round(spanDist)}px)`,
        kind: aimTargetNode ? 'aim-tendon' : 'bone-span',
        confidence: aimTargetNode ? 0.95 : 0.86,
        reason: `Spans horizontal/aim bone vector (${Math.round(spanDist)}px)`,
        patch: {
          x: fitted.x,
          y: fitted.y,
          w: targetW,
          h: piece.h,
          scaleX: 1,
          scaleY: 1,
        },
      });
    }
  }

  // Proposal 3: Mirror from Opposite L/R Twin
  if (twinNode && twinNode.pieces.length > 0) {
    const twinPiece = twinNode.pieces[0];
    const twinUV = getPieceAnchorUV(twinPiece, twinNode.pivot);
    const mirroredU = Math.round((1 - twinUV[0]) * 1000) / 1000;
    const twinFitted = computeBoxForPinnedUV(
      piece,
      node.pivot,
      mirroredU,
      twinUV[1],
      twinPiece.w,
      twinPiece.h
    );
    proposals.push({
      id: 'mirror-twin',
      label: `Mirror Symmetry from ${twinNode.id}`,
      kind: 'mirror-twin',
      confidence: 0.89,
      reason: `Mirrors horizontal anchor offset (${Math.round(mirroredU * 100)}%, ${Math.round(
        twinUV[1] * 100
      )}%) and dimensions from twin ${twinNode.id}`,
      patch: {
        x: twinFitted.x,
        y: twinFitted.y,
        w: twinFitted.w,
        h: twinFitted.h,
        scaleX: twinPiece.scaleX ?? 1,
        scaleY: twinPiece.scaleY ?? 1,
      },
    });
  }

  // Proposal 4: Alpha Mass Centroid Snap
  if (alpha) {
    const centBox = computeBoxForPinnedUV(
      piece,
      node.pivot,
      alpha.centroidUV[0],
      alpha.centroidUV[1]
    );
    proposals.push({
      id: 'alpha-centroid',
      label: 'Center on Alpha Mass Centroid',
      kind: 'alpha-centroid',
      confidence: 0.76,
      reason: `Pins opaque mask center (${Math.round(alpha.centroidUV[0] * 100)}%, ${Math.round(
        alpha.centroidUV[1] * 100
      )}%) to joint pivot`,
      patch: {
        x: centBox.x,
        y: centBox.y,
        w: piece.w,
        h: piece.h,
      },
    });
  }

  proposals.sort((a, b) => b.confidence - a.confidence);

  return {
    anatomicalRole: prior.label,
    childNode,
    aimTargetNode,
    parentNode,
    twinNode,
    spanDist,
    currentAnchorUV,
    offsetFromPivot,
    proposals,
  };
}

/**
 * Pure Autonomy: Calibrates a single piece against its recognized bone/anchor context.
 */
export async function autoCalibratePiece(
  node: RigNodeSpec,
  piece: PieceSpec,
  rig: RigSpec
): Promise<{ nextPiece: PieceSpec; appliedProposal: CalibrationProposal }> {
  const alpha = await analyzeImageAlphaMask(piece.src, piece.maskThreshold ?? 25);
  const ctx = buildContextRecognition(node, piece, rig, alpha);
  const best = ctx.proposals[0];
  return {
    nextPiece: {
      ...piece,
      x: best.patch.x,
      y: best.patch.y,
      w: best.patch.w,
      h: best.patch.h,
      ...(best.patch.scaleX !== undefined ? { scaleX: best.patch.scaleX } : {}),
      ...(best.patch.scaleY !== undefined ? { scaleY: best.patch.scaleY } : {}),
    },
    appliedProposal: best,
  };
}

/**
 * Pure Autonomy Batch: Context-calibrates every piece in the active RigSpec against its anchor & twin.
 */
export async function autoCalibrateWholeRig(
  rig: RigSpec
): Promise<{
  nextRig: RigSpec;
  calibratedCount: number;
  summary: Array<{ nodeId: string; pieceName: string; proposalLabel: string; confidence: number }>;
}> {
  const summary: Array<{
    nodeId: string;
    pieceName: string;
    proposalLabel: string;
    confidence: number;
  }> = [];

  const nextNodes: RigNodeSpec[] = [];
  for (const node of rig.nodes) {
    if (!node.pieces.length) {
      nextNodes.push(node);
      continue;
    }
    const nextPieces: PieceSpec[] = [];
    for (const pc of node.pieces) {
      const { nextPiece, appliedProposal } = await autoCalibratePiece(node, pc, rig);
      nextPieces.push(nextPiece);
      summary.push({
        nodeId: node.id,
        pieceName: pc.name,
        proposalLabel: appliedProposal.label,
        confidence: appliedProposal.confidence,
      });
    }
    nextNodes.push({ ...node, pieces: nextPieces });
  }

  return {
    nextRig: { ...rig, nodes: nextNodes },
    calibratedCount: summary.length,
    summary,
  };
}
