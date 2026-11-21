import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Crosshair,
  FlipHorizontal2,
  Maximize2,
  RotateCcw,
  Sparkles,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  AlphaMaskAnalysis,
  analyzeImageAlphaMask,
  autoCalibratePiece,
  autoCalibrateWholeRig,
  buildContextRecognition,
  computeBoxForPinnedUV,
  getEffectivePieceBox,
} from '../core/maskCalibrator';
import { PieceSpec, RigNodeSpec, RigSpec } from '../core/types';

interface MaskCalibrationModalProps {
  rigSpec: RigSpec;
  initialNodeId: string | null;
  onUpdateNode: (nodeId: string, updater: (n: RigNodeSpec) => RigNodeSpec) => void;
  onReplaceRig: (nextRig: RigSpec) => void;
  onClose: () => void;
}

type AutonomyMode = 'assisted' | 'autonomous';
type ResizeDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type DragState =
  | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'move-piece'; startWx: number; startWy: number; origX: number; origY: number }
  | {
      kind: 'resize-piece';
      dir: ResizeDir;
      startWx: number;
      startWy: number;
      origX: number;
      origY: number;
      origW: number;
      origH: number;
    };

const DIRS: ResizeDir[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function handlePos(dir: ResizeDir, x: number, y: number, w: number, h: number): [number, number] {
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

export const MaskCalibrationModal: React.FC<MaskCalibrationModalProps> = ({
  rigSpec,
  initialNodeId,
  onUpdateNode,
  onReplaceRig,
  onClose,
}) => {
  const nodesWithPieces = useMemo(
    () => rigSpec.nodes.filter((n) => n.pieces.length > 0),
    [rigSpec.nodes]
  );

  const [nodeId, setNodeId] = useState<string>(() => {
    if (initialNodeId && rigSpec.nodes.some((n) => n.id === initialNodeId && n.pieces.length > 0)) {
      return initialNodeId;
    }
    return nodesWithPieces[0]?.id ?? rigSpec.nodes[0]?.id ?? '';
  });
  const [pieceIdx, setPieceIdx] = useState(0);
  const [autonomyMode, setAutonomyMode] = useState<AutonomyMode>('assisted');
  const [autoSnapOnSwitch, setAutoSnapOnSwitch] = useState(false);
  const [showContour, setShowContour] = useState(true);
  const [showGhost, setShowGhost] = useState(true);
  const [alphaAnalysis, setAlphaAnalysis] = useState<AlphaMaskAnalysis | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<RigSpec[]>([]);
  const [nudgeStep, setNudgeStep] = useState<1 | 10>(1);
  const [zoomPct, setZoomPct] = useState(100);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const camRef = useRef({ z: 1, ox: 0, oy: 0 });
  const dragRef = useRef<DragState | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const fittedKeyRef = useRef<string>('');

  const activeNode = useMemo(
    () => rigSpec.nodes.find((n) => n.id === nodeId) ?? null,
    [rigSpec.nodes, nodeId]
  );

  const activePiece: PieceSpec | null = useMemo(() => {
    if (!activeNode || !activeNode.pieces.length) return null;
    return activeNode.pieces[Math.min(pieceIdx, activeNode.pieces.length - 1)] ?? null;
  }, [activeNode, pieceIdx]);

  const contextReport = useMemo(() => {
    if (!activeNode || !activePiece) return null;
    return buildContextRecognition(activeNode, activePiece, rigSpec, alphaAnalysis);
  }, [activeNode, activePiece, rigSpec, alphaAnalysis]);

  const pushUndo = useCallback(() => {
    setUndoStack((prev) => [...prev.slice(-11), JSON.parse(JSON.stringify(rigSpec)) as RigSpec]);
  }, [rigSpec]);

  const handleUndo = () => {
    if (!undoStack.length) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    onReplaceRig(prev);
    setStatusBanner('Reverted to previous calibration snapshot.');
  };

  const patchActivePiece = useCallback(
    (patch: Partial<PieceSpec>, recordUndo = false) => {
      if (!activeNode || !activePiece) return;
      if (recordUndo) pushUndo();
      const targetIdx = Math.min(pieceIdx, activeNode.pieces.length - 1);
      onUpdateNode(activeNode.id, (n) => ({
        ...n,
        pieces: n.pieces.map((p, idx) => (idx === targetIdx ? { ...p, ...patch } : p)),
      }));
    },
    [activeNode, activePiece, pieceIdx, pushUndo, onUpdateNode]
  );

  // Analyze mask alpha contour whenever piece src or maskThreshold changes
  useEffect(() => {
    let alive = true;
    if (!activePiece?.src) {
      setAlphaAnalysis(null);
      imgRef.current = null;
      return;
    }
    const img = new Image();
    img.onload = () => {
      if (!alive) return;
      imgRef.current = img;
    };
    img.src = activePiece.src;

    analyzeImageAlphaMask(activePiece.src, activePiece.maskThreshold ?? 25).then((res) => {
      if (alive) setAlphaAnalysis(res);
    });
    return () => {
      alive = false;
    };
  }, [activePiece?.src, activePiece?.maskThreshold]);

  const fitViewport = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !activeNode || !activePiece || cv.clientWidth === 0 || cv.clientHeight === 0) {
      return;
    }
    const box = getEffectivePieceBox(activePiece);
    let minX = Math.min(box.x, activeNode.pivot[0]) - 80;
    let maxX = Math.max(box.x + box.w, activeNode.pivot[0]) + 80;
    let minY = Math.min(box.y, activeNode.pivot[1]) - 80;
    let maxY = Math.max(box.y + box.h, activeNode.pivot[1]) + 80;

    if (contextReport?.childNode) {
      minX = Math.min(minX, contextReport.childNode.pivot[0] - 60);
      maxX = Math.max(maxX, contextReport.childNode.pivot[0] + 60);
      minY = Math.min(minY, contextReport.childNode.pivot[1] - 60);
      maxY = Math.max(maxY, contextReport.childNode.pivot[1] + 60);
    }
    if (contextReport?.aimTargetNode) {
      minX = Math.min(minX, contextReport.aimTargetNode.pivot[0] - 60);
      maxX = Math.max(maxX, contextReport.aimTargetNode.pivot[0] + 60);
      minY = Math.min(minY, contextReport.aimTargetNode.pivot[1] - 60);
      maxY = Math.max(maxY, contextReport.aimTargetNode.pivot[1] + 60);
    }

    const spanW = Math.max(120, maxX - minX);
    const spanH = Math.max(120, maxY - minY);
    const z = Math.min((cv.clientWidth * 0.78) / spanW, (cv.clientHeight * 0.78) / spanH);
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    camRef.current = {
      z,
      ox: cv.clientWidth * 0.5 - cx * z,
      oy: cv.clientHeight * 0.5 - cy * z,
    };
    setZoomPct(Math.round(z * 100));
  }, [activeNode, activePiece, contextReport]);

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
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0E0F12';
    ctx.fillRect(0, 0, cv.width, cv.height);

    ctx.setTransform(z * dpr, 0, 0, z * dpr, ox * dpr, oy * dpr);
    const inv = 1 / (z * dpr);

    // Coordinate crosshairs at stage origin/axes
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = inv;
    ctx.strokeRect(0, 0, rigSpec.W, rigSpec.H);

    if (!activeNode || !activePiece) return;

    const box = getEffectivePieceBox(activePiece);

    // Subtle transparency checkerboard behind piece area
    const tile = Math.max(12, Math.round(Math.min(box.w, box.h) / 10));
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    ctx.fillStyle = '#181A20';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = '#20232B';
    for (let y = box.y; y < box.y + box.h; y += tile) {
      for (let x = box.x; x < box.x + box.w; x += tile) {
        if (((Math.floor((x - box.x) / tile) + Math.floor((y - box.y) / tile)) & 1) === 0) {
          ctx.fillRect(x, y, tile, tile);
        }
      }
    }
    ctx.restore();

    // Draw sprite image
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, box.x, box.y, box.w, box.h);
    }

    // Alpha hit-mask edge contour highlight
    if (showContour && alphaAnalysis) {
      const { gridW, gridH, edgeMask } = alphaAnalysis;
      const cellW = box.w / gridW;
      const cellH = box.h / gridH;
      ctx.fillStyle = 'rgba(16, 185, 129, 0.78)';
      for (let gy = 0; gy < gridH; gy++) {
        for (let gx = 0; gx < gridW; gx++) {
          if (edgeMask[gy * gridW + gx]) {
            ctx.fillRect(box.x + gx * cellW, box.y + gy * cellH, cellW * 1.1, cellH * 1.1);
          }
        }
      }
      // Alpha mass centroid marker
      const [cu, cvNorm] = alphaAnalysis.centroidUV;
      const cx = box.x + cu * box.w;
      const cy = box.y + cvNorm * box.h;
      ctx.beginPath();
      ctx.arc(cx, cy, 4 * inv, 0, Math.PI * 2);
      ctx.fillStyle = '#10B981';
      ctx.fill();
    }

    // Ghost context proposal preview (top recommendation)
    if (showGhost && contextReport && contextReport.proposals.length > 0) {
      const top = contextReport.proposals[0].patch;
      const gsX = top.scaleX ?? 1;
      const gsY = top.scaleY ?? 1;
      const gw = top.w * gsX;
      const gh = top.h * gsY;
      const gx = top.x + (top.w - gw) * 0.5;
      const gy = top.y + (top.h - gh) * 0.5;

      const delta =
        Math.abs(gx - box.x) +
        Math.abs(gy - box.y) +
        Math.abs(gw - box.w) +
        Math.abs(gh - box.h);

      if (delta > 3) {
        ctx.save();
        ctx.setLineDash([7 * inv, 5 * inv]);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.78)';
        ctx.lineWidth = 1.6 * inv;
        ctx.strokeRect(gx, gy, gw, gh);
        ctx.restore();
      }
    }

    // Piece border + 8 resize/stretch handles
    ctx.strokeStyle = '#8B5CF6';
    ctx.lineWidth = 1.8 * inv;
    ctx.strokeRect(box.x, box.y, box.w, box.h);

    const hs = 9 * inv;
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#8B5CF6';
    ctx.lineWidth = 1.5 * inv;
    for (const dir of DIRS) {
      const [hx, hy] = handlePos(dir, box.x, box.y, box.w, box.h);
      ctx.fillRect(hx - hs * 0.5, hy - hs * 0.5, hs, hs);
      ctx.strokeRect(hx - hs * 0.5, hy - hs * 0.5, hs, hs);
    }

    // Parent / Child / Aim skeletal lines around active anchor
    const [px, py] = activeNode.pivot;
    if (contextReport?.parentNode) {
      const [ppx, ppy] = contextReport.parentNode.pivot;
      ctx.beginPath();
      ctx.moveTo(ppx, ppy);
      ctx.lineTo(px, py);
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.55)';
      ctx.lineWidth = 2 * inv;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(ppx, ppy, 5 * inv, 0, Math.PI * 2);
      ctx.fillStyle = '#111215';
      ctx.fill();
      ctx.strokeStyle = '#10B981';
      ctx.stroke();
    }

    const distalTarget = contextReport?.aimTargetNode ?? contextReport?.childNode ?? null;
    if (distalTarget) {
      const [tx, ty] = distalTarget.pivot;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(tx, ty);
      ctx.strokeStyle = contextReport?.aimTargetNode ? '#A78BFA' : '#10B981';
      ctx.lineWidth = 2.4 * inv;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(tx, ty, 6 * inv, 0, Math.PI * 2);
      ctx.fillStyle = '#111215';
      ctx.fill();
      ctx.strokeStyle = contextReport?.aimTargetNode ? '#A78BFA' : '#10B981';
      ctx.lineWidth = 2 * inv;
      ctx.stroke();
    }

    // Active Bone Pivot Anchor Crosshair
    const rad = 8 * inv;
    const tick = 20 * inv;
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(139, 92, 246, 0.35)';
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2 * inv;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(px - tick, py);
    ctx.lineTo(px - rad * 1.2, py);
    ctx.moveTo(px + rad * 1.2, py);
    ctx.lineTo(px + tick, py);
    ctx.moveTo(px, py - tick);
    ctx.lineTo(px, py - rad * 1.2);
    ctx.moveTo(px, py + rad * 1.2);
    ctx.lineTo(px, py + tick);
    ctx.strokeStyle = '#FBBF24';
    ctx.lineWidth = 1.6 * inv;
    ctx.stroke();
  }, [activeNode, activePiece, alphaAnalysis, contextReport, rigSpec.H, rigSpec.W, showContour, showGhost]);

  useEffect(() => {
    const key = `${nodeId}|${pieceIdx}`;
    if (fittedKeyRef.current !== key && activeNode && activePiece) {
      fittedKeyRef.current = key;
      requestAnimationFrame(() => {
        fitViewport();
        draw();
      });
    } else {
      draw();
    }
  }, [nodeId, pieceIdx, activeNode, activePiece, fitViewport, draw]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  const screenToWorld = (clientX: number, clientY: number): [number, number] => {
    const cv = canvasRef.current!;
    const rect = cv.getBoundingClientRect();
    const { z, ox, oy } = camRef.current;
    return [(clientX - rect.left - ox) / z, (clientY - rect.top - oy) / z];
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!activeNode || !activePiece) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const [wx, wy] = screenToWorld(e.clientX, e.clientY);
    const { z } = camRef.current;
    const tol = 14 / z;
    const box = getEffectivePieceBox(activePiece);

    if (e.button === 1 || e.altKey) {
      dragRef.current = {
        kind: 'pan',
        sx: e.clientX,
        sy: e.clientY,
        ox: camRef.current.ox,
        oy: camRef.current.oy,
      };
      return;
    }

    for (const dir of DIRS) {
      const [hx, hy] = handlePos(dir, box.x, box.y, box.w, box.h);
      if (Math.hypot(wx - hx, wy - hy) <= tol) {
        pushUndo();
        dragRef.current = {
          kind: 'resize-piece',
          dir,
          startWx: wx,
          startWy: wy,
          origX: activePiece.x,
          origY: activePiece.y,
          origW: activePiece.w,
          origH: activePiece.h,
        };
        return;
      }
    }

    if (
      wx >= box.x - tol &&
      wx <= box.x + box.w + tol &&
      wy >= box.y - tol &&
      wy <= box.y + box.h + tol
    ) {
      pushUndo();
      dragRef.current = {
        kind: 'move-piece',
        startWx: wx,
        startWy: wy,
        origX: activePiece.x,
        origY: activePiece.y,
      };
      return;
    }

    dragRef.current = {
      kind: 'pan',
      sx: e.clientX,
      sy: e.clientY,
      ox: camRef.current.ox,
      oy: camRef.current.oy,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || !activeNode || !activePiece) return;

    if (drag.kind === 'pan') {
      camRef.current.ox = drag.ox + (e.clientX - drag.sx);
      camRef.current.oy = drag.oy + (e.clientY - drag.sy);
      draw();
      return;
    }

    const [wx, wy] = screenToWorld(e.clientX, e.clientY);
    if (drag.kind === 'move-piece') {
      let nx = drag.origX + (wx - drag.startWx);
      let ny = drag.origY + (wy - drag.startWy);
      if (e.shiftKey) {
        // Magnetic snap piece top-center or center to active pivot if close
        const pivX = activeNode.pivot[0];
        const pivY = activeNode.pivot[1];
        if (Math.abs(nx + activePiece.w * 0.5 - pivX) < 18) {
          nx = pivX - activePiece.w * 0.5;
        } else {
          nx = Math.round(nx / 5) * 5;
        }
        if (Math.abs(ny - pivY) < 18) ny = pivY;
        else ny = Math.round(ny / 5) * 5;
      }
      patchActivePiece({ x: Math.round(nx * 10) / 10, y: Math.round(ny * 10) / 10 });
      return;
    }

    if (drag.kind === 'resize-piece') {
      const sx = activePiece.scaleX ?? 1;
      const sy = activePiece.scaleY ?? 1;
      const dx = (wx - drag.startWx) / sx;
      const dy = (wy - drag.startWy) / sy;

      let nx = drag.origX;
      let ny = drag.origY;
      let nw = drag.origW;
      let nh = drag.origH;

      if (drag.dir.includes('e')) nw = Math.max(12, drag.origW + dx);
      if (drag.dir.includes('s')) nh = Math.max(12, drag.origH + dy);
      if (drag.dir.includes('w')) {
        const clamped = Math.min(dx, drag.origW - 12);
        nx = drag.origX + clamped;
        nw = drag.origW - clamped;
      }
      if (drag.dir.includes('n')) {
        const clamped = Math.min(dy, drag.origH - 12);
        ny = drag.origY + clamped;
        nh = drag.origH - clamped;
      }
      patchActivePiece({
        x: Math.round(nx),
        y: Math.round(ny),
        w: Math.round(nw),
        h: Math.round(nh),
      });
    }
  };

  const handlePointerUp = () => {
    dragRef.current = null;
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const oldZ = camRef.current.z;
    const newZ = Math.max(0.05, Math.min(12, oldZ * factor));
    camRef.current.ox = sx - (sx - camRef.current.ox) * (newZ / oldZ);
    camRef.current.oy = sy - (sy - camRef.current.oy) * (newZ / oldZ);
    camRef.current.z = newZ;
    setZoomPct(Math.round(newZ * 100));
    draw();
  };

  const handleAutonomousBone = async (targetNode?: RigNodeSpec) => {
    const n = targetNode ?? activeNode;
    if (!n || !n.pieces.length) return;
    const p = n === activeNode && activePiece ? activePiece : n.pieces[0];
    pushUndo();
    const { nextPiece, appliedProposal } = await autoCalibratePiece(n, p, rigSpec);
    onUpdateNode(n.id, (curr) => ({
      ...curr,
      pieces: curr.pieces.map((item, idx) =>
        idx === (n === activeNode ? pieceIdx : 0) ? nextPiece : item
      ),
    }));
    setStatusBanner(
      `Autonomous calibration applied to ${n.id}: ${appliedProposal.label} (${Math.round(
        appliedProposal.confidence * 100
      )}%)`
    );
  };

  const handleAutonomousWholeRig = async () => {
    pushUndo();
    const { nextRig, calibratedCount } = await autoCalibrateWholeRig(rigSpec);
    onReplaceRig(nextRig);
    setStatusBanner(
      `Autonomously calibrated ${calibratedCount} mask(s) across ${rigSpec.name || 'rig'} against bone anchors & twin symmetry.`
    );
  };

  const handleSelectBone = async (nextId: string) => {
    setNodeId(nextId);
    setPieceIdx(0);
    if (autonomyMode === 'autonomous' && autoSnapOnSwitch) {
      const target = rigSpec.nodes.find((n) => n.id === nextId);
      if (target && target.pieces.length > 0) {
        await handleAutonomousBone(target);
      }
    }
  };

  const handlePinUV = (u: number, v: number) => {
    if (!activeNode || !activePiece) return;
    const box = computeBoxForPinnedUV(activePiece, activeNode.pivot, u, v);
    patchActivePiece({ x: box.x, y: box.y }, true);
  };

  const handleMirrorToTwin = () => {
    if (!activeNode || !activePiece || !contextReport?.twinNode) return;
    const twin = contextReport.twinNode;
    if (!twin.pieces.length) return;
    pushUndo();
    const uv = contextReport.currentAnchorUV;
    const mirroredU = Math.round((1 - uv[0]) * 1000) / 1000;
    const twinTargetBox = computeBoxForPinnedUV(
      twin.pieces[0],
      twin.pivot,
      mirroredU,
      uv[1],
      activePiece.w,
      activePiece.h
    );
    onUpdateNode(twin.id, (n) => ({
      ...n,
      pieces: n.pieces.map((p, idx) =>
        idx === 0
          ? {
              ...p,
              x: twinTargetBox.x,
              y: twinTargetBox.y,
              w: twinTargetBox.w,
              h: twinTargetBox.h,
              scaleX: activePiece.scaleX ?? 1,
              scaleY: activePiece.scaleY ?? 1,
              maskThreshold: activePiece.maskThreshold,
            }
          : p
      ),
    }));
    setStatusBanner(`Synced mirrored anchor calibration onto twin bone ${twin.id}.`);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Mask & Anchor Calibration Window"
    >
      <div className="w-full max-w-[1200px] h-[86vh] rounded-xl bg-[#16181D] border border-white/[0.12] flex flex-col overflow-hidden shadow-2xl">
        {/* Top Modal Bar */}
        <div className="h-14 shrink-0 px-5 border-b border-white/[0.08] flex items-center justify-between gap-4 bg-[#181A1F]">
          <div className="flex items-center gap-3 min-w-0">
            <Crosshair className="w-4 h-4 text-violet-400 shrink-0" />
            <h2 className="text-sm font-semibold text-white whitespace-nowrap">
              Mask &amp; Anchor Calibration
            </h2>

            <select
              value={nodeId}
              onChange={(e) => void handleSelectBone(e.target.value)}
              className="bg-[#111215] border border-white/[0.1] rounded-md px-2.5 py-1 text-xs font-mono text-gray-100 max-w-[210px] focus:outline-none focus:border-violet-500"
            >
              {rigSpec.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.id} ({n.pieces.length})
                </option>
              ))}
            </select>

            {activeNode && activeNode.pieces.length > 1 && (
              <select
                value={pieceIdx}
                onChange={(e) => setPieceIdx(Number(e.target.value))}
                className="bg-[#111215] border border-white/[0.1] rounded-md px-2 py-1 text-xs text-gray-200"
              >
                {activeNode.pieces.map((pc, idx) => (
                  <option key={`${pc.name}-${idx}`} value={idx}>
                    {pc.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Assisted vs Pure Autonomy Toggle */}
            <div className="flex items-center gap-1 p-1 bg-[#111215] border border-white/[0.08] rounded-lg">
              <button
                type="button"
                onClick={() => setAutonomyMode('assisted')}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                  autonomyMode === 'assisted'
                    ? 'bg-violet-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                Context Assist
              </button>
              <button
                type="button"
                onClick={() => setAutonomyMode('autonomous')}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                  autonomyMode === 'autonomous'
                    ? 'bg-emerald-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                Pure Autonomy
              </button>
            </div>

            <button
              type="button"
              disabled={undoStack.length === 0}
              onClick={handleUndo}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-200 bg-[#21242B] hover:bg-[#2A2E37] disabled:opacity-40 border border-white/[0.08] rounded-md cursor-pointer"
            >
              <Undo2 className="w-3.5 h-3.5" />
              Undo
            </button>

            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-violet-600 hover:bg-violet-500 rounded-md cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              Done
            </button>
          </div>
        </div>

        {/* Main Workspace Split */}
        <div className="flex-1 flex min-h-0">
          {/* Left Interactive Calibration Canvas */}
          <div ref={containerRef} className="flex-1 relative bg-[#0E0F12] overflow-hidden">
            {!activePiece ? (
              <div className="h-full flex items-center justify-center text-xs text-gray-500 p-6">
                Select a bone with an attached PNG mask from the dropdown above to calibrate.
              </div>
            ) : (
              <>
                <div className="absolute top-3 left-3 right-3 z-10 flex items-center justify-between gap-2 pointer-events-none">
                  <div className="pointer-events-auto flex items-center gap-1 p-1 rounded-lg bg-[#181A1F]/90 border border-white/[0.08]">
                    <button
                      type="button"
                      onClick={() => setShowContour((v) => !v)}
                      className={`px-2.5 py-1 text-xs rounded transition-colors cursor-pointer ${
                        showContour
                          ? 'bg-white/[0.1] text-emerald-300'
                          : 'text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      Mask Contour
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowGhost((v) => !v)}
                      className={`px-2.5 py-1 text-xs rounded transition-colors cursor-pointer ${
                        showGhost
                          ? 'bg-white/[0.1] text-sky-300'
                          : 'text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      Context Ghost
                    </button>
                  </div>

                  <div className="pointer-events-auto flex items-center gap-1 p-1 rounded-lg bg-[#181A1F]/90 border border-white/[0.08]">
                    <button
                      type="button"
                      onClick={() => {
                        camRef.current.z = Math.max(0.05, camRef.current.z * 0.85);
                        setZoomPct(Math.round(camRef.current.z * 100));
                        draw();
                      }}
                      className="p-1 text-gray-300 hover:text-white cursor-pointer"
                    >
                      <ZoomOut className="w-3.5 h-3.5" />
                    </button>
                    <span className="px-2 text-xs font-mono tabular-nums text-gray-300">
                      {zoomPct}%
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        camRef.current.z = Math.min(12, camRef.current.z * 1.18);
                        setZoomPct(Math.round(camRef.current.z * 100));
                        draw();
                      }}
                      className="p-1 text-gray-300 hover:text-white cursor-pointer"
                    >
                      <ZoomIn className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        fitViewport();
                        draw();
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-300 hover:text-white cursor-pointer"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                      Fit
                    </button>
                  </div>
                </div>

                <canvas
                  ref={canvasRef}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  onWheel={handleWheel}
                  className="w-full h-full block cursor-crosshair"
                />

                <div className="absolute bottom-3 left-3 right-3 pointer-events-none flex items-center justify-between gap-2">
                  <div className="px-3 py-1.5 rounded-lg bg-[#181A1F]/90 border border-white/[0.08] text-xs text-gray-400">
                    Drag mask against amber pivot reticle · Shift+Drag snaps to pivot · Alt+Drag pans
                  </div>
                  {statusBanner && (
                    <div className="px-3 py-1.5 rounded-lg bg-emerald-950/80 border border-emerald-500/40 text-xs text-emerald-200">
                      {statusBanner}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Right Context & Calibration Controls */}
          <aside className="w-[385px] shrink-0 border-l border-white/[0.08] bg-[#16181D] overflow-y-auto p-4 space-y-5">
            {activeNode && activePiece && contextReport && (
              <>
                {/* Section 1: Context Recognition & Autonomy */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-white">
                      Context Recognition
                    </span>
                    <span className="text-[11px] font-mono text-emerald-300">
                      {contextReport.anatomicalRole}
                    </span>
                  </div>

                  <div className="p-2.5 rounded-lg bg-[#111215] border border-white/[0.08] text-[11px] font-mono tabular-nums text-gray-300 space-y-1">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Bone Pivot:</span>
                      <span>
                        [{activeNode.pivot[0]}, {activeNode.pivot[1]}]
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Mask Anchor (U, V):</span>
                      <span className="text-violet-300">
                        ({(contextReport.currentAnchorUV[0] * 100).toFixed(1)}%,{' '}
                        {(contextReport.currentAnchorUV[1] * 100).toFixed(1)}%)
                      </span>
                    </div>
                    {contextReport.spanDist !== null && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">
                          Span → {(contextReport.aimTargetNode ?? contextReport.childNode)?.id}:
                        </span>
                        <span>{contextReport.spanDist} px</span>
                      </div>
                    )}
                    {alphaAnalysis && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">Alpha Shape:</span>
                        <span>
                          {alphaAnalysis.orientation} · {Math.round(alphaAnalysis.coverageRatio * 100)}% fill
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Autonomous Controls */}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => void handleAutonomousBone()}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors cursor-pointer"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      Auto-Calibrate Bone
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleAutonomousWholeRig()}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-violet-200 bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/30 rounded-lg transition-colors cursor-pointer"
                    >
                      Auto-Calibrate All
                    </button>
                  </div>

                  {autonomyMode === 'autonomous' && (
                    <label className="flex items-center justify-between text-xs text-gray-300 p-2 rounded bg-[#111215] border border-emerald-500/30 cursor-pointer">
                      <span>Auto-calibrate when switching bones</span>
                      <input
                        type="checkbox"
                        checked={autoSnapOnSwitch}
                        onChange={(e) => setAutoSnapOnSwitch(e.target.checked)}
                        className="accent-emerald-500"
                      />
                    </label>
                  )}

                  {/* Context Proposals */}
                  <div className="space-y-2">
                    <div className="text-[11px] font-medium text-gray-400">
                      Detected Anchor Alignments
                    </div>
                    {contextReport.proposals.map((prop) => (
                      <div
                        key={prop.id}
                        className="p-2.5 rounded-lg bg-[#111215] border border-white/[0.08] flex items-start justify-between gap-2"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="text-xs font-medium text-gray-100 flex items-center gap-2">
                            <span className="truncate">{prop.label}</span>
                            <span className="text-[10px] font-mono tabular-nums text-emerald-300 shrink-0">
                              {Math.round(prop.confidence * 100)}%
                            </span>
                          </div>
                          <div className="text-[11px] text-gray-400 leading-snug">
                            {prop.reason}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            patchActivePiece(prop.patch, true);
                            setStatusBanner(`Applied "${prop.label}".`);
                          }}
                          className="px-2.5 py-1 text-xs font-medium text-violet-200 bg-violet-600/25 hover:bg-violet-600 border border-violet-500/40 rounded cursor-pointer shrink-0"
                        >
                          Apply
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Section 2: Manual Pin-to-Pivot & Precision Nudge */}
                <div className="pt-4 border-t border-white/[0.08] space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white">
                      Pin Mask Point → Pivot
                    </span>
                    <div className="flex items-center gap-1 text-[11px]">
                      <button
                        type="button"
                        onClick={() => setNudgeStep(1)}
                        className={`px-1.5 py-0.5 rounded font-mono cursor-pointer ${
                          nudgeStep === 1 ? 'bg-violet-600 text-white' : 'text-gray-400'
                        }`}
                      >
                        1px
                      </button>
                      <button
                        type="button"
                        onClick={() => setNudgeStep(10)}
                        className={`px-1.5 py-0.5 rounded font-mono cursor-pointer ${
                          nudgeStep === 10 ? 'bg-violet-600 text-white' : 'text-gray-400'
                        }`}
                      >
                        10px
                      </button>
                    </div>
                  </div>

                  {/* 3x3 Anchor Pin Grid + Nudge Pad */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="grid grid-cols-3 gap-1">
                      {[
                        [0, 0, 'TL'],
                        [0.5, 0, 'T'],
                        [1, 0, 'TR'],
                        [0, 0.5, 'L'],
                        [0.5, 0.5, 'C'],
                        [1, 0.5, 'R'],
                        [0, 1, 'BL'],
                        [0.5, 1, 'B'],
                        [1, 1, 'BR'],
                      ].map(([u, v, lbl]) => (
                        <button
                          key={String(lbl)}
                          type="button"
                          onClick={() => handlePinUV(Number(u), Number(v))}
                          className="w-9 h-7 text-[10px] font-mono bg-[#111215] hover:bg-violet-600/30 border border-white/[0.08] rounded text-gray-300 hover:text-white cursor-pointer"
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>

                    <div className="grid grid-cols-3 gap-1">
                      <span />
                      <button
                        type="button"
                        onClick={() => patchActivePiece({ y: activePiece.y - nudgeStep }, true)}
                        className="w-8 h-7 text-xs bg-[#111215] hover:bg-[#21242B] border border-white/[0.08] rounded text-gray-200 cursor-pointer"
                      >
                        ↑
                      </button>
                      <span />
                      <button
                        type="button"
                        onClick={() => patchActivePiece({ x: activePiece.x - nudgeStep }, true)}
                        className="w-8 h-7 text-xs bg-[#111215] hover:bg-[#21242B] border border-white/[0.08] rounded text-gray-200 cursor-pointer"
                      >
                        ←
                      </button>
                      <button
                        type="button"
                        onClick={() => handlePinUV(0.5, 0.5)}
                        title="Center mask on pivot"
                        className="w-8 h-7 text-[10px] font-mono bg-[#111215] hover:bg-violet-600/30 border border-white/[0.08] rounded text-violet-300 cursor-pointer"
                      >
                        •
                      </button>
                      <button
                        type="button"
                        onClick={() => patchActivePiece({ x: activePiece.x + nudgeStep }, true)}
                        className="w-8 h-7 text-xs bg-[#111215] hover:bg-[#21242B] border border-white/[0.08] rounded text-gray-200 cursor-pointer"
                      >
                        →
                      </button>
                      <span />
                      <button
                        type="button"
                        onClick={() => patchActivePiece({ y: activePiece.y + nudgeStep }, true)}
                        className="w-8 h-7 text-xs bg-[#111215] hover:bg-[#21242B] border border-white/[0.08] rounded text-gray-200 cursor-pointer"
                      >
                        ↓
                      </button>
                      <span />
                    </div>
                  </div>

                  {/* Fine Anchor UV & Dimensions */}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <label className="space-y-1">
                      <span className="text-[11px] text-gray-400">Pin Anchor U (0..1)</span>
                      <input
                        type="number"
                        step="0.02"
                        value={contextReport.currentAnchorUV[0]}
                        onChange={(e) =>
                          handlePinUV(Number(e.target.value) || 0, contextReport.currentAnchorUV[1])
                        }
                        className="w-full bg-[#111215] border border-white/[0.08] rounded px-2 py-1 font-mono tabular-nums text-gray-100"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[11px] text-gray-400">Pin Anchor V (0..1)</span>
                      <input
                        type="number"
                        step="0.02"
                        value={contextReport.currentAnchorUV[1]}
                        onChange={(e) =>
                          handlePinUV(contextReport.currentAnchorUV[0], Number(e.target.value) || 0)
                        }
                        className="w-full bg-[#111215] border border-white/[0.08] rounded px-2 py-1 font-mono tabular-nums text-gray-100"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[11px] text-gray-400">Stretch X</span>
                      <input
                        type="number"
                        step="0.05"
                        min="0.1"
                        max="4"
                        value={activePiece.scaleX ?? 1}
                        onChange={(e) =>
                          patchActivePiece(
                            { scaleX: Math.max(0.1, Number(e.target.value) || 1) },
                            true
                          )
                        }
                        className="w-full bg-[#111215] border border-white/[0.08] rounded px-2 py-1 font-mono tabular-nums text-gray-100"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[11px] text-gray-400">Stretch Y</span>
                      <input
                        type="number"
                        step="0.05"
                        min="0.1"
                        max="4"
                        value={activePiece.scaleY ?? 1}
                        onChange={(e) =>
                          patchActivePiece(
                            { scaleY: Math.max(0.1, Number(e.target.value) || 1) },
                            true
                          )
                        }
                        className="w-full bg-[#111215] border border-white/[0.08] rounded px-2 py-1 font-mono tabular-nums text-gray-100"
                      />
                    </label>
                  </div>

                  {/* Mask Alpha Cutoff Calibration */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-400">Mask Alpha Cutoff</span>
                      <span className="font-mono tabular-nums text-emerald-300">
                        {activePiece.maskThreshold ?? 25} / 255
                      </span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={240}
                      value={activePiece.maskThreshold ?? 25}
                      onChange={(e) =>
                        patchActivePiece({ maskThreshold: Number(e.target.value) })
                      }
                      className="w-full accent-emerald-500 cursor-pointer"
                    />
                  </div>

                  {/* Twin Symmetry & Reset */}
                  <div className="flex items-center gap-2 pt-1">
                    {contextReport.twinNode && contextReport.twinNode.pieces.length > 0 && (
                      <button
                        type="button"
                        onClick={handleMirrorToTwin}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-200 bg-[#21242B] hover:bg-[#2A2E37] border border-white/[0.08] rounded-md cursor-pointer"
                      >
                        <FlipHorizontal2 className="w-3.5 h-3.5" />
                        Mirror to {contextReport.twinNode.id}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        patchActivePiece({ scaleX: 1, scaleY: 1, maskThreshold: 25 }, true)
                      }
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-400 hover:text-white bg-[#111215] border border-white/[0.06] rounded-md cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Reset
                    </button>
                  </div>
                </div>
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
};
