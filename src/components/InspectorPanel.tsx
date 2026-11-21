import React, { useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  RotateCcw,
  Trash2,
  Upload,
} from 'lucide-react';
import { clampAnatomicalAngle } from '../core/bitruvianEngine';
import { BondStrainInfo, PieceSpec, RigNodeSpec, RigSpec } from '../core/types';
import { YORICK_POSE_PRESETS, YorickPoseId } from '../core/yorickPoses';

export interface InspectorPanelProps {
  rigSpec: RigSpec;
  selectedNode: RigNodeSpec | null;
  strainInfo: BondStrainInfo[];
  activeYorickPose?: YorickPoseId;
  dragOnceActive?: boolean;
  onToggleDragOnce?: () => void;
  onApplyYorickPose?: (poseId: YorickPoseId) => void;
  onUpdateNode: (nodeId: string, updater: (n: RigNodeSpec) => RigNodeSpec) => void;
  onRenameNodeId: (oldId: string, newId: string) => void;
  onUpdateStageSize: (w: number, h: number) => void;
  onUpdatePoseAngle: (nodeId: string, ang: number) => void;
  onOpenCalibration: () => void;
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  rigSpec,
  selectedNode,
  strainInfo,
  activeYorickPose,
  dragOnceActive = false,
  onToggleDragOnce,
  onApplyYorickPose,
  onUpdateNode,
  onRenameNodeId,
  onUpdateStageSize,
  onUpdatePoseAngle,
  onOpenCalibration,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetIdxRef = useRef<number | null>(null);
  const [showPivotDetails, setShowPivotDetails] = useState(false);
  const [showLimitsAim, setShowLimitsAim] = useState(false);

  const byMap = Object.fromEntries(rigSpec.nodes.map((n) => [n.id, n]));

  if (!selectedNode) {
    return (
      <div className="p-3 space-y-2.5 text-xs">
        <div className="font-semibold text-gray-200">Canvas Dimensions (px)</div>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-[11px] text-gray-400">Width</span>
            <input
              type="number"
              value={rigSpec.W}
              onChange={(e) =>
                onUpdateStageSize(Math.max(128, Number(e.target.value) || 2048), rigSpec.H)
              }
              className="w-full bg-[#111215] border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-gray-100 focus:outline-none focus:border-violet-500"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-gray-400">Height</span>
            <input
              type="number"
              value={rigSpec.H}
              onChange={(e) =>
                onUpdateStageSize(rigSpec.W, Math.max(128, Number(e.target.value) || 2048))
              }
              className="w-full bg-[#111215] border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-gray-100 focus:outline-none focus:border-violet-500"
            />
          </label>
        </div>
      </div>
    );
  }

  const limits = selectedNode.limits ?? [-180, 180];
  const nodeAng = selectedNode.ang ?? 0;
  const activeStrain = strainInfo.find((s) => s.nodeId === selectedNode.id);

  const handleSnapPivot = (preset: 'center' | 'top' | 'bottom' | 'parent') => {
    if (preset === 'parent' && selectedNode.parent) {
      const parent = rigSpec.nodes.find((n) => n.id === selectedNode.parent);
      if (parent) {
        onUpdateNode(selectedNode.id, (n) => ({
          ...n,
          pivot: [parent.pivot[0], parent.pivot[1]],
        }));
      }
      return;
    }
    const piece = selectedNode.pieces[0];
    if (!piece) return;
    const px = piece.x + piece.w * 0.5;
    let py = piece.y + piece.h * 0.5;
    if (preset === 'top') py = piece.y + piece.h * 0.12;
    if (preset === 'bottom') py = piece.y + piece.h * 0.88;
    onUpdateNode(selectedNode.id, (n) => ({
      ...n,
      pivot: [Math.round(px * 10) / 10, Math.round(py * 10) / 10],
    }));
  };

  const handleUploadPiece = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const targetIdx = uploadTargetIdxRef.current;
    uploadTargetIdxRef.current = null;
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth || 256;
        const h = img.naturalHeight || 256;
        onUpdateNode(selectedNode.id, (n) => {
          const anchorPiece =
            targetIdx !== null && n.pieces[targetIdx]
              ? n.pieces[targetIdx]
              : n.pieces[0];
          const centerX = anchorPiece
            ? anchorPiece.x + anchorPiece.w * 0.5
            : n.pivot[0];
          const centerY = anchorPiece
            ? anchorPiece.y + anchorPiece.h * 0.5
            : n.pivot[1];
          const allI = rigSpec.nodes.flatMap((node) => node.pieces).map((p) => p.i);
          const minI = allI.length ? Math.min(...allI) : 1;
          const nextI = anchorPiece
            ? Math.max(0, Math.round((anchorPiece.i - 0.5) * 10) / 10)
            : Math.max(0, minI - 1);

          const newPiece: PieceSpec = {
            i: nextI,
            name: file.name.replace(/\.[^.]+$/, ''),
            x: Math.round(centerX - w * 0.5),
            y: Math.round(centerY - h * 0.5),
            w,
            h,
            src,
            visible: true,
          };
          return {
            ...n,
            pieces: [...n.pieces, newPiece],
          };
        });
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const updatePiece = (index: number, patch: Partial<PieceSpec>) => {
    onUpdateNode(selectedNode.id, (n) => ({
      ...n,
      pieces: n.pieces.map((p, idx) => (idx === index ? { ...p, ...patch } : p)),
    }));
  };

  return (
    <div className="divide-y divide-white/[0.06] text-xs select-text">
      {/* Live Rotation & Yorick Presets */}
      <div className="p-3 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] font-semibold text-gray-300">FK Angle</span>
            {activeStrain?.strained && (
              <span className="text-[10px] font-mono text-rose-400 whitespace-nowrap">
                Strain {activeStrain.delta > 0 ? '+' : ''}
                {activeStrain.delta.toFixed(1)}°
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-violet-300">{nodeAng.toFixed(1)}°</span>
            <button
              type="button"
              onClick={() => onUpdatePoseAngle(selectedNode.id, 0)}
              className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-white cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              Zero
            </button>
          </div>
        </div>

        <input
          type="range"
          min={limits[0]}
          max={limits[1]}
          step={0.5}
          value={nodeAng}
          onChange={(e) => {
            const clamped = clampAnatomicalAngle(
              selectedNode.id,
              Number(e.target.value),
              limits,
              byMap,
              true
            );
            onUpdatePoseAngle(selectedNode.id, clamped);
          }}
          className="w-full accent-violet-500 cursor-pointer"
        />

        {rigSpec.component === 'yorick' && onApplyYorickPose && (
          <div className="p-2 rounded-md bg-[#111215] border border-white/[0.06] space-y-1.5">
            <div className="flex items-center justify-between text-[10px]">
              <span className="font-semibold text-gray-300">Yorick Pose Presets</span>
              <span className="font-mono text-emerald-300">Front · Side · Back</span>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {(['front-neutral', 'side-profile-l', 'back-neutral'] as YorickPoseId[]).map(
                (pid) => {
                  const preset = YORICK_POSE_PRESETS.find((p) => p.id === pid);
                  if (!preset) return null;
                  return (
                    <button
                      key={pid}
                      type="button"
                      onClick={() => onApplyYorickPose(pid)}
                      className={`px-2 py-1 text-[11px] rounded border capitalize cursor-pointer ${
                        activeYorickPose === pid
                          ? 'bg-violet-600/30 border-violet-500/60 text-violet-100'
                          : 'bg-[#181B20] border-white/[0.06] text-gray-300 hover:text-white'
                      }`}
                    >
                      {preset.group}
                    </button>
                  );
                }
              )}
            </div>
          </div>
        )}
      </div>

      {/* Attached Piece Assets */}
      <div className="p-3 space-y-2.5">
        <div className="flex items-center justify-between gap-1.5 flex-wrap">
          <span className="text-[11px] font-semibold text-gray-200">
            Assets ({selectedNode.pieces.length})
          </span>
          <div className="flex items-center gap-1 flex-wrap">
            {onToggleDragOnce && selectedNode.pieces.length > 0 && (
              <button
                type="button"
                onClick={onToggleDragOnce}
                title="Arm one-shot click & drag for positioning an asset; shuts off automatically after drag"
                className={`px-2 py-1 text-[11px] font-medium rounded border cursor-pointer transition-colors ${
                  dragOnceActive
                    ? 'bg-amber-500/25 border-amber-400/60 text-amber-200'
                    : 'text-gray-300 bg-[#21242B] hover:bg-[#2A2E37] border-white/[0.08]'
                }`}
              >
                {dragOnceActive ? 'Drag Armed' : 'Drag Once'}
              </button>
            )}
            {selectedNode.pieces.length > 0 && (
              <button
                type="button"
                onClick={onOpenCalibration}
                className="px-2 py-1 text-[11px] font-medium text-violet-200 bg-violet-600/20 hover:bg-violet-600/35 border border-violet-500/35 rounded cursor-pointer"
              >
                Calibrate
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                uploadTargetIdxRef.current = 0;
                fileInputRef.current?.click();
              }}
              title="Upload PNG centered directly over the current asset"
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-gray-200 bg-[#21242B] hover:bg-[#2A2E37] border border-white/[0.08] rounded cursor-pointer"
            >
              <Upload className="w-3 h-3" />
              Add PNG
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={handleUploadPiece}
            className="hidden"
          />
        </div>

        {selectedNode.pieces.length === 0 ? (
          <div className="p-2.5 rounded border border-dashed border-white/[0.08] text-center text-[11px] text-gray-500">
            No sprite pieces attached to this bone.
          </div>
        ) : (
          <div className="space-y-2">
            {selectedNode.pieces.map((pc, idx) => (
              <div
                key={`${pc.name}-${idx}`}
                className="p-2 rounded bg-[#111215] border border-white/[0.06] space-y-1.5"
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {pc.src && (
                      <img
                        src={pc.src}
                        alt={pc.name}
                        className="w-6 h-6 object-contain bg-[#1C1E24] rounded p-0.5 shrink-0"
                      />
                    )}
                    <input
                      type="text"
                      value={pc.name}
                      onChange={(e) => updatePiece(idx, { name: e.target.value })}
                      className="min-w-0 bg-transparent text-[11px] font-medium text-gray-200 focus:outline-none border-b border-transparent focus:border-violet-500 truncate"
                    />
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        uploadTargetIdxRef.current = idx;
                        fileInputRef.current?.click();
                      }}
                      title="Upload PNG centered over this asset"
                      className="p-1 text-gray-400 hover:text-violet-300 cursor-pointer"
                    >
                      <Upload className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        updatePiece(idx, { visible: pc.visible === false ? true : false })
                      }
                      title={pc.visible === false ? 'Show asset' : 'Hide asset'}
                      className="p-1 text-gray-400 hover:text-white cursor-pointer"
                    >
                      {pc.visible === false ? (
                        <EyeOff className="w-3 h-3" />
                      ) : (
                        <Eye className="w-3 h-3" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => updatePiece(idx, { i: Math.max(0, pc.i - 1) })}
                      title="Bring forward (lower i)"
                      className="p-1 text-gray-400 hover:text-white cursor-pointer"
                    >
                      <ArrowUp className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => updatePiece(idx, { i: pc.i + 1 })}
                      title="Send backward (higher i)"
                      className="p-1 text-gray-400 hover:text-white cursor-pointer"
                    >
                      <ArrowDown className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateNode(selectedNode.id, (n) => ({
                          ...n,
                          pieces: n.pieces.filter((_, pIdx) => pIdx !== idx),
                        }))
                      }
                      title="Remove piece"
                      className="p-1 text-gray-400 hover:text-rose-400 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-1 text-[10px]">
                  <label className="space-y-0.5">
                    <span className="text-gray-500">X</span>
                    <input
                      type="number"
                      value={Math.round(pc.x)}
                      onChange={(e) => updatePiece(idx, { x: Number(e.target.value) || 0 })}
                      className="w-full bg-[#181A1F] border border-white/[0.06] rounded px-1.5 py-0.5 font-mono text-gray-200"
                    />
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-gray-500">Y</span>
                    <input
                      type="number"
                      value={Math.round(pc.y)}
                      onChange={(e) => updatePiece(idx, { y: Number(e.target.value) || 0 })}
                      className="w-full bg-[#181A1F] border border-white/[0.06] rounded px-1.5 py-0.5 font-mono text-gray-200"
                    />
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-gray-500">Z (i)</span>
                    <input
                      type="number"
                      step="0.5"
                      value={pc.i}
                      onChange={(e) => updatePiece(idx, { i: Number(e.target.value) || 0 })}
                      className="w-full bg-[#181A1F] border border-white/[0.06] rounded px-1.5 py-0.5 font-mono text-gray-200"
                    />
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-gray-500">W</span>
                    <input
                      type="number"
                      value={Math.round(pc.w)}
                      onChange={(e) =>
                        updatePiece(idx, { w: Math.max(8, Number(e.target.value) || 8) })
                      }
                      className="w-full bg-[#181A1F] border border-white/[0.06] rounded px-1.5 py-0.5 font-mono text-gray-200"
                    />
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-gray-500">H</span>
                    <input
                      type="number"
                      value={Math.round(pc.h)}
                      onChange={(e) =>
                        updatePiece(idx, { h: Math.max(8, Number(e.target.value) || 8) })
                      }
                      className="w-full bg-[#181A1F] border border-white/[0.06] rounded px-1.5 py-0.5 font-mono text-gray-200"
                    />
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-gray-500">Stretch X</span>
                    <input
                      type="number"
                      step="0.05"
                      min="0.1"
                      max="4"
                      value={pc.scaleX ?? 1}
                      onChange={(e) =>
                        updatePiece(idx, {
                          scaleX: Math.max(0.1, Number(e.target.value) || 1),
                        })
                      }
                      className="w-full bg-[#181A1F] border border-white/[0.06] rounded px-1.5 py-0.5 font-mono text-gray-200"
                    />
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-gray-500">Stretch Y</span>
                    <input
                      type="number"
                      step="0.05"
                      min="0.1"
                      max="4"
                      value={pc.scaleY ?? 1}
                      onChange={(e) =>
                        updatePiece(idx, {
                          scaleY: Math.max(0.1, Number(e.target.value) || 1),
                        })
                      }
                      className="w-full bg-[#181A1F] border border-white/[0.06] rounded px-1.5 py-0.5 font-mono text-gray-200"
                    />
                  </label>
                  <div className="col-span-2 flex items-center justify-between pt-1">
                    <label className="inline-flex items-center gap-1 text-[10px] text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={pc.swivelStretch !== false}
                        onChange={(e) =>
                          updatePiece(idx, { swivelStretch: e.target.checked })
                        }
                        className="accent-violet-500"
                      />
                      Swivel Stretch
                    </label>
                    {(pc.scaleX && pc.scaleX !== 1) || (pc.scaleY && pc.scaleY !== 1) ? (
                      <button
                        type="button"
                        onClick={() => updatePiece(idx, { scaleX: 1, scaleY: 1 })}
                        className="text-[10px] text-violet-300 hover:text-violet-200 cursor-pointer"
                      >
                        Reset 1.0×
                      </button>
                    ) : (
                      <span className="text-[10px] text-gray-500">Rigid on export</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Collapsible Bone Identity & Anchor Pivot */}
      <div>
        <button
          type="button"
          onClick={() => setShowPivotDetails((v) => !v)}
          className="w-full px-3 py-2 flex items-center justify-between text-[11px] font-semibold text-gray-300 hover:text-white hover:bg-white/[0.03] cursor-pointer"
        >
          <span>Bone Identity &amp; Anchor Pivot</span>
          {showPivotDetails ? (
            <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-gray-500" />
          )}
        </button>

        {showPivotDetails && (
          <div className="px-3 pb-3 space-y-2.5">
            <div className="grid grid-cols-2 gap-1.5">
              <label className="space-y-0.5">
                <span className="text-[10px] text-gray-400">Bone ID</span>
                <input
                  type="text"
                  defaultValue={selectedNode.id}
                  key={selectedNode.id}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next && next !== selectedNode.id) {
                      onRenameNodeId(selectedNode.id, next);
                    }
                  }}
                  className="w-full bg-[#111215] border border-white/[0.08] rounded px-2 py-1 text-[11px] font-mono text-gray-200 focus:outline-none focus:border-violet-500"
                />
              </label>
              <label className="space-y-0.5">
                <span className="text-[10px] text-gray-400">Parent Bone</span>
                <select
                  value={selectedNode.parent ?? ''}
                  onChange={(e) =>
                    onUpdateNode(selectedNode.id, (n) => ({
                      ...n,
                      parent: e.target.value || null,
                    }))
                  }
                  className="w-full bg-[#111215] border border-white/[0.08] rounded px-1.5 py-1 text-[11px] text-gray-200 focus:outline-none focus:border-violet-500"
                >
                  <option value="">(Root / None)</option>
                  {rigSpec.nodes
                    .filter((n) => n.id !== selectedNode.id)
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.id}
                      </option>
                    ))}
                </select>
              </label>
            </div>

            <label className="block space-y-0.5">
              <span className="text-[10px] text-gray-400">Display Name</span>
              <input
                type="text"
                value={selectedNode.name}
                onChange={(e) =>
                  onUpdateNode(selectedNode.id, (n) => ({ ...n, name: e.target.value }))
                }
                className="w-full bg-[#111215] border border-white/[0.08] rounded px-2 py-1 text-[11px] text-gray-200 focus:outline-none focus:border-violet-500"
              />
            </label>

            <div className="flex items-center gap-4 text-[11px] text-gray-300">
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!selectedNode.lock}
                  onChange={(e) =>
                    onUpdateNode(selectedNode.id, (n) => ({ ...n, lock: e.target.checked }))
                  }
                  className="accent-violet-500"
                />
                Lock
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!selectedNode.ghost}
                  onChange={(e) =>
                    onUpdateNode(selectedNode.id, (n) => ({ ...n, ghost: e.target.checked }))
                  }
                  className="accent-violet-500"
                />
                Ghost
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!selectedNode.flipX}
                  onChange={(e) =>
                    onUpdateNode(selectedNode.id, (n) => ({ ...n, flipX: e.target.checked }))
                  }
                  className="accent-violet-500"
                />
                Flip X
              </label>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <label className="space-y-0.5">
                <span className="text-[10px] text-gray-400">Pivot X</span>
                <input
                  type="number"
                  step="0.5"
                  value={selectedNode.pivot[0]}
                  onChange={(e) =>
                    onUpdateNode(selectedNode.id, (n) => ({
                      ...n,
                      pivot: [Number(e.target.value) || 0, n.pivot[1]],
                    }))
                  }
                  className="w-full bg-[#111215] border border-white/[0.08] rounded px-2 py-1 text-[11px] font-mono text-gray-100 focus:outline-none focus:border-violet-500"
                />
              </label>
              <label className="space-y-0.5">
                <span className="text-[10px] text-gray-400">Pivot Y</span>
                <input
                  type="number"
                  step="0.5"
                  value={selectedNode.pivot[1]}
                  onChange={(e) =>
                    onUpdateNode(selectedNode.id, (n) => ({
                      ...n,
                      pivot: [n.pivot[0], Number(e.target.value) || 0],
                    }))
                  }
                  className="w-full bg-[#111215] border border-white/[0.08] rounded px-2 py-1 text-[11px] font-mono text-gray-100 focus:outline-none focus:border-violet-500"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                disabled={!selectedNode.pieces.length}
                onClick={() => handleSnapPivot('center')}
                className="px-2 py-1 text-[10px] text-gray-300 bg-[#21242B] hover:bg-[#2A2E37] disabled:opacity-40 rounded border border-white/[0.06] cursor-pointer"
              >
                Snap Center
              </button>
              <button
                type="button"
                disabled={!selectedNode.pieces.length}
                onClick={() => handleSnapPivot('top')}
                className="px-2 py-1 text-[10px] text-gray-300 bg-[#21242B] hover:bg-[#2A2E37] disabled:opacity-40 rounded border border-white/[0.06] cursor-pointer"
              >
                Snap Top
              </button>
              <button
                type="button"
                disabled={!selectedNode.pieces.length}
                onClick={() => handleSnapPivot('bottom')}
                className="px-2 py-1 text-[10px] text-gray-300 bg-[#21242B] hover:bg-[#2A2E37] disabled:opacity-40 rounded border border-white/[0.06] cursor-pointer"
              >
                Snap Bottom
              </button>
              <button
                type="button"
                disabled={!selectedNode.parent}
                onClick={() => handleSnapPivot('parent')}
                className="px-2 py-1 text-[10px] text-gray-300 bg-[#21242B] hover:bg-[#2A2E37] disabled:opacity-40 rounded border border-white/[0.06] cursor-pointer"
              >
                Match Parent
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Collapsible Limits & Closed-Chain Aim Rule */}
      <div>
        <button
          type="button"
          onClick={() => setShowLimitsAim((v) => !v)}
          className="w-full px-3 py-2 flex items-center justify-between text-[11px] font-semibold text-gray-300 hover:text-white hover:bg-white/[0.03] cursor-pointer"
        >
          <span>Limits &amp; Aim Bond</span>
          {showLimitsAim ? (
            <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-gray-500" />
          )}
        </button>

        {showLimitsAim && (
          <div className="px-3 pb-3 space-y-2.5">
            <div className="grid grid-cols-2 gap-1.5">
              <label className="space-y-0.5">
                <span className="text-[10px] text-gray-400">Min Limit (°)</span>
                <input
                  type="number"
                  value={limits[0]}
                  onChange={(e) =>
                    onUpdateNode(selectedNode.id, (n) => ({
                      ...n,
                      limits: [Number(e.target.value) || -180, limits[1]],
                    }))
                  }
                  className="w-full bg-[#111215] border border-white/[0.08] rounded px-2 py-1 text-[11px] font-mono text-gray-100 focus:outline-none focus:border-violet-500"
                />
              </label>
              <label className="space-y-0.5">
                <span className="text-[10px] text-gray-400">Max Limit (°)</span>
                <input
                  type="number"
                  value={limits[1]}
                  onChange={(e) =>
                    onUpdateNode(selectedNode.id, (n) => ({
                      ...n,
                      limits: [limits[0], Number(e.target.value) || 180],
                    }))
                  }
                  className="w-full bg-[#111215] border border-white/[0.08] rounded px-2 py-1 text-[11px] font-mono text-gray-100 focus:outline-none focus:border-violet-500"
                />
              </label>
            </div>

            <div className="pt-1.5 space-y-2 border-t border-white/[0.06]">
              <label className="flex items-center justify-between text-[11px] cursor-pointer">
                <span className="inline-flex items-center gap-1.5 font-medium text-gray-300">
                  <Crosshair className="w-3.5 h-3.5 text-violet-400" />
                  Closed-Chain Aim Rule
                </span>
                <input
                  type="checkbox"
                  checked={!!selectedNode.aim}
                  onChange={(e) => {
                    if (e.target.checked) {
                      const target =
                        rigSpec.nodes.find((n) => n.id !== selectedNode.id) || selectedNode;
                      onUpdateNode(selectedNode.id, (n) => ({
                        ...n,
                        aim: {
                          to: target.id,
                          from: [target.pivot[0], target.pivot[1]],
                          min: 0.7,
                          max: 1.1,
                        },
                      }));
                    } else {
                      onUpdateNode(selectedNode.id, (n) => ({ ...n, aim: null }));
                    }
                  }}
                  className="accent-violet-500"
                />
              </label>

              {selectedNode.aim && (
                <div className="space-y-1.5">
                  <label className="block space-y-0.5">
                    <span className="text-[10px] text-gray-400">Target Node (to)</span>
                    <select
                      value={selectedNode.aim.to}
                      onChange={(e) => {
                        const target = rigSpec.nodes.find((n) => n.id === e.target.value);
                        onUpdateNode(selectedNode.id, (n) => ({
                          ...n,
                          aim: n.aim
                            ? {
                                ...n.aim,
                                to: e.target.value,
                                from: target ? [...target.pivot] : n.aim.from,
                              }
                            : null,
                        }));
                      }}
                      className="w-full bg-[#111215] border border-white/[0.08] rounded px-2 py-1 text-[11px] text-gray-200 focus:outline-none focus:border-violet-500"
                    >
                      {rigSpec.nodes
                        .filter((n) => n.id !== selectedNode.id)
                        .map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.id}
                          </option>
                        ))}
                    </select>
                  </label>

                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="space-y-0.5">
                      <span className="text-[10px] text-gray-400">Min Stretch</span>
                      <input
                        type="number"
                        step="0.05"
                        value={selectedNode.aim.min}
                        onChange={(e) =>
                          onUpdateNode(selectedNode.id, (n) => ({
                            ...n,
                            aim: n.aim ? { ...n.aim, min: Number(e.target.value) || 0.7 } : null,
                          }))
                        }
                        className="w-full bg-[#111215] border border-white/[0.08] rounded px-2 py-1 text-[11px] font-mono text-gray-100"
                      />
                    </label>
                    <label className="space-y-0.5">
                      <span className="text-[10px] text-gray-400">Max Stretch</span>
                      <input
                        type="number"
                        step="0.05"
                        value={selectedNode.aim.max}
                        onChange={(e) =>
                          onUpdateNode(selectedNode.id, (n) => ({
                            ...n,
                            aim: n.aim ? { ...n.aim, max: Number(e.target.value) || 1.1 } : null,
                          }))
                        }
                        className="w-full bg-[#111215] border border-white/[0.08] rounded px-2 py-1 text-[11px] font-mono text-gray-100"
                      />
                    </label>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
