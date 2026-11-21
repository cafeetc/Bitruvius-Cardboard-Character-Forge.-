import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Crosshair,
  Layers,
  Lock,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import {
  AssembledModelsMap,
  BondStrainInfo,
  ComponentModelKey,
  RigNodeSpec,
  RigSpec,
} from '../core/types';
import { YorickPoseId } from '../core/yorickPoses';
import { InspectorPanel } from './InspectorPanel';

interface HierarchySidebarProps {
  rigSpec: RigSpec;
  assembledModels: AssembledModelsMap;
  activeComponent: ComponentModelKey;
  activeTwinSide: 'L' | 'R';
  onSelectComponent: (component: ComponentModelKey) => void;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onAddNode: (parentId: string | null) => void;
  onDeleteNode: (id: string) => void;
  onLoadBitruvianCore: () => void;
  onNewBlankRig: () => void;
  isLoadingCore: boolean;
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

const COMPONENT_TAGS: Array<{ key: ComponentModelKey; label: string }> = [
  { key: 'bytruvyus', label: 'Bytruvyus' },
  { key: 'gotz', label: 'Gotz' },
  { key: 'yorick', label: 'Yorick' },
  { key: 'piggy', label: 'Piggy' },
];

interface TreeEntry {
  node: RigNodeSpec;
  depth: number;
  hasChildren: boolean;
}

export const HierarchySidebar: React.FC<HierarchySidebarProps> = ({
  rigSpec,
  assembledModels,
  activeComponent,
  activeTwinSide,
  onSelectComponent,
  selectedNodeId,
  onSelectNode,
  onAddNode,
  onDeleteNode,
  onLoadBitruvianCore,
  onNewBlankRig,
  isLoadingCore,
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
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [drawerExpanded, setDrawerExpanded] = useState(true);
  const [showStageSize, setShowStageSize] = useState(false);
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
  const prevSelectedIdRef = useRef<string | null>(selectedNodeId);

  // When a new bone is selected (e.g. from canvas), expand its ancestors + inline controls and scroll it into view
  useEffect(() => {
    if (!selectedNodeId) return;
    if (prevSelectedIdRef.current !== selectedNodeId) {
      prevSelectedIdRef.current = selectedNodeId;
      setDrawerExpanded(true);

      const byId = new Map(rigSpec.nodes.map((n) => [n.id, n]));
      const ancestors: string[] = [];
      let cur = byId.get(selectedNodeId);
      const seen = new Set<string>();
      while (cur?.parent && !seen.has(cur.parent)) {
        seen.add(cur.parent);
        ancestors.push(cur.parent);
        cur = byId.get(cur.parent);
      }
      if (ancestors.length > 0) {
        setCollapsed((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const aid of ancestors) {
            if (next[aid]) {
              next[aid] = false;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }

      requestAnimationFrame(() => {
        selectedRowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }, [selectedNodeId, rigSpec.nodes]);

  const entries = useMemo(() => {
    const childrenMap = new Map<string | null, RigNodeSpec[]>();
    const byId = new Map<string, RigNodeSpec>();
    rigSpec.nodes.forEach((n) => byId.set(n.id, n));

    rigSpec.nodes.forEach((n) => {
      const parentKey = n.parent && byId.has(n.parent) ? n.parent : null;
      const list = childrenMap.get(parentKey) ?? [];
      list.push(n);
      childrenMap.set(parentKey, list);
    });

    const out: TreeEntry[] = [];
    const visited = new Set<string>();
    const walk = (parentId: string | null, depth: number) => {
      const children = childrenMap.get(parentId) ?? [];
      for (const node of children) {
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        const kids = childrenMap.get(node.id) ?? [];
        out.push({ node, depth, hasChildren: kids.length > 0 });
        if (!collapsed[node.id]) {
          walk(node.id, depth + 1);
        }
      }
    };
    walk(null, 0);

    for (const node of rigSpec.nodes) {
      if (!visited.has(node.id)) {
        out.push({ node, depth: 0, hasChildren: false });
      }
    }

    if (!query.trim()) return out;
    const q = query.trim().toLowerCase();
    return out.filter(
      (e) =>
        e.node.id.toLowerCase().includes(q) ||
        e.node.name.toLowerCase().includes(q) ||
        e.node.pieces.some((p) => p.name.toLowerCase().includes(q))
    );
  }, [rigSpec.nodes, collapsed, query]);

  const toggleCollapse = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const totalPieces = useMemo(
    () => rigSpec.nodes.reduce((sum, n) => sum + n.pieces.length, 0),
    [rigSpec.nodes]
  );

  return (
    <aside className="w-[340px] shrink-0 border-r border-white/[0.08] bg-[#16181D] flex flex-col h-full select-none">
      <div className="p-3.5 border-b border-white/[0.08] space-y-2.5">
        {/* 4-Model Component Tags */}
        <div className="grid grid-cols-2 gap-1.5" role="tablist" aria-label="Rig Components">
          {COMPONENT_TAGS.map((tag) => {
            const rig = assembledModels[tag.key];
            const active = activeComponent === tag.key;
            const twinSuffix =
              active && (tag.key === 'gotz' || tag.key === 'piggy')
                ? ` (${activeTwinSide})`
                : '';
            return (
              <button
                key={tag.key}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={!rig}
                onClick={() => onSelectComponent(tag.key)}
                className={`px-2.5 py-1.5 rounded-md text-xs font-medium flex items-center justify-between gap-1 border transition-colors cursor-pointer disabled:opacity-40 ${
                  active
                    ? 'bg-violet-600 text-white border-violet-500'
                    : 'bg-[#111215] text-gray-300 hover:bg-[#21242B] border-white/[0.06]'
                }`}
              >
                <span className="truncate">
                  {tag.label}
                  {twinSuffix}
                </span>
                <span
                  className={`font-mono tabular-nums text-[10px] ${
                    active ? 'text-violet-100' : 'text-gray-500'
                  }`}
                >
                  {rig?.nodes.length ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-100 truncate">
            {rigSpec.name || 'Untitled Rig'}
          </h2>
          <button
            type="button"
            onClick={() => onAddNode(selectedNodeId)}
            title="Add child bone"
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-gray-200 bg-[#21242B] hover:bg-[#2A2E37] border border-white/[0.08] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Bone
          </button>
        </div>

        <div className="text-xs text-gray-400 flex items-center justify-between gap-1.5 font-mono tabular-nums">
          <div className="flex items-center gap-1.5">
            <span>{rigSpec.nodes.length} bones</span>
            <span aria-hidden="true">·</span>
            <span>{totalPieces} pieces</span>
          </div>
          <button
            type="button"
            onClick={() => setShowStageSize((v) => !v)}
            title="Edit stage canvas dimensions"
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#111215] hover:bg-[#21242B] border border-white/[0.08] text-[11px] text-gray-300 cursor-pointer"
          >
            <SlidersHorizontal className="w-3 h-3 text-violet-400" />
            {rigSpec.W}×{rigSpec.H}
          </button>
        </div>

        {showStageSize && (
          <div className="rounded-md bg-[#111215] border border-white/[0.08]">
            <InspectorPanel
              rigSpec={rigSpec}
              selectedNode={null}
              strainInfo={strainInfo}
              onUpdateNode={onUpdateNode}
              onRenameNodeId={onRenameNodeId}
              onUpdateStageSize={onUpdateStageSize}
              onUpdatePoseAngle={onUpdatePoseAngle}
              onOpenCalibration={onOpenCalibration}
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onLoadBitruvianCore}
            disabled={isLoadingCore}
            className="px-2.5 py-1.5 text-xs font-medium text-violet-200 bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/30 rounded-md transition-colors whitespace-nowrap truncate cursor-pointer disabled:opacity-50"
          >
            {isLoadingCore ? 'Loading Core...' : 'All 4 Core Models'}
          </button>
          <button
            type="button"
            onClick={onNewBlankRig}
            className="px-2.5 py-1.5 text-xs font-medium text-gray-300 bg-[#21242B] hover:bg-[#2A2E37] border border-white/[0.08] rounded-md transition-colors whitespace-nowrap truncate cursor-pointer"
          >
            New Blueprint
          </button>
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter bones or pieces..."
            className="w-full bg-[#111215] border border-white/[0.08] rounded-md pl-8 pr-2.5 py-1.5 text-xs text-gray-200 placeholder:text-gray-500 focus:outline-none focus:border-violet-500"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {entries.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-gray-500">
            No matching bones found.
          </div>
        ) : (
          entries.map(({ node, depth, hasChildren }) => {
            const selected = node.id === selectedNodeId;
            return (
              <div key={node.id}>
                <div
                  ref={selected ? selectedRowRef : undefined}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (selected) {
                      setDrawerExpanded((v) => !v);
                    } else {
                      setDrawerExpanded(true);
                      onSelectNode(node.id);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      if (selected) {
                        setDrawerExpanded((v) => !v);
                      } else {
                        setDrawerExpanded(true);
                        onSelectNode(node.id);
                      }
                    }
                  }}
                  style={{ paddingLeft: `${8 + Math.min(depth, 5) * 12}px` }}
                  className={`group flex items-center justify-between gap-1.5 pr-2 py-1.5 rounded-md text-xs transition-colors cursor-pointer ${
                    selected
                      ? 'bg-violet-600/25 text-white border border-violet-500/50'
                      : 'text-gray-300 hover:bg-white/[0.04] border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    {hasChildren ? (
                      <button
                        type="button"
                        onClick={(e) => toggleCollapse(node.id, e)}
                        className="p-0.5 text-gray-500 hover:text-gray-200 shrink-0 cursor-pointer"
                        aria-label={collapsed[node.id] ? 'Expand bone' : 'Collapse bone'}
                      >
                        {collapsed[node.id] ? (
                          <ChevronRight className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )}
                      </button>
                    ) : (
                      <span className="w-4 shrink-0" />
                    )}

                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        node.aim
                          ? 'bg-violet-400'
                          : node.pieces.length > 0
                          ? 'bg-emerald-400'
                          : 'bg-gray-600'
                      }`}
                    />

                    <span className="truncate font-medium">{node.name || node.id}</span>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 text-gray-500">
                    {node.aim && (
                      <span title={`Aims at ${node.aim.to}`}>
                        <Crosshair className="w-3 h-3 text-violet-400" />
                      </span>
                    )}
                    {node.lock && (
                      <span title="Locked joint">
                        <Lock className="w-3 h-3 text-amber-400" />
                      </span>
                    )}
                    {node.pieces.length > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-[11px] font-mono text-gray-400">
                        <Layers className="w-3 h-3" />
                        {node.pieces.length}
                      </span>
                    )}
                    {rigSpec.nodes.length > 1 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteNode(node.id);
                        }}
                        title="Delete bone"
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-500 hover:text-rose-400 transition-opacity cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>

                {selected && drawerExpanded && (
                  <div className="mt-1 mb-2 ml-2 rounded-lg border border-violet-500/35 bg-[#13151B] shadow-inner overflow-hidden">
                    <InspectorPanel
                      rigSpec={rigSpec}
                      selectedNode={node}
                      strainInfo={strainInfo}
                      activeYorickPose={activeYorickPose}
                      dragOnceActive={dragOnceActive}
                      onToggleDragOnce={onToggleDragOnce}
                      onApplyYorickPose={onApplyYorickPose}
                      onUpdateNode={onUpdateNode}
                      onRenameNodeId={onRenameNodeId}
                      onUpdateStageSize={onUpdateStageSize}
                      onUpdatePoseAngle={onUpdatePoseAngle}
                      onOpenCalibration={onOpenCalibration}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
};
