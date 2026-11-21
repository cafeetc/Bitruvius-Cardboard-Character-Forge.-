import { useCallback, useEffect, useMemo, useState } from 'react';
import { DreamsParserView } from './components/DreamsParserView';
import { ExportView } from './components/ExportView';
import { HierarchySidebar } from './components/HierarchySidebar';
import { MaskCalibrationModal } from './components/MaskCalibrationModal';
import { RigTreeView } from './components/RigTreeView';
import { StageCanvas } from './components/StageCanvas';
import { TopBar } from './components/TopBar';
import {
  createStarterRig,
  loadAllBitruvianComponentsFromHtml,
} from './core/bitruvianEngine';
import {
  AppTab,
  AssembledModelsMap,
  BondStrainInfo,
  ComponentModelKey,
  RigNodeSpec,
  RigSpec,
  StageMode,
} from './core/types';
import { applyYorickPose, YorickPoseId } from './core/yorickPoses';

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('studio');
  const [stageMode, setStageMode] = useState<StageMode>('pose-test');
  const [dragOnceActive, setDragOnceActive] = useState(false);
  const [assembledModels, setAssembledModels] = useState<AssembledModelsMap>(() => ({
    bytruvyus: createStarterRig(),
  }));
  const [activeComponent, setActiveComponent] = useState<ComponentModelKey>('bytruvyus');
  const [activeTwinSide, setActiveTwinSide] = useState<'L' | 'R'>('L');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>('root');
  const [strainInfo, setStrainInfo] = useState<BondStrainInfo[]>([]);
  const [isLoadingCore, setIsLoadingCore] = useState(false);
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [activeYorickPose, setActiveYorickPose] = useState<YorickPoseId>('front-neutral');
  const [yorickBaseRig, setYorickBaseRig] = useState<RigSpec | null>(null);

  const rigSpec: RigSpec = useMemo(() => {
    return (
      assembledModels[activeComponent] ??
      assembledModels.bytruvyus ??
      Object.values(assembledModels).find(Boolean) ??
      createStarterRig()
    );
  }, [assembledModels, activeComponent]);

  const setActiveRigSpec = useCallback(
    (updater: (prev: RigSpec) => RigSpec) => {
      setAssembledModels((prevMap) => {
        const current =
          prevMap[activeComponent] ??
          prevMap.bytruvyus ??
          Object.values(prevMap).find(Boolean) ??
          createStarterRig();
        return {
          ...prevMap,
          [activeComponent]: updater(current),
        };
      });
    },
    [activeComponent]
  );

  const handleLoadBitruvianCore = useCallback(async () => {
    setIsLoadingCore(true);
    try {
      const { models } = await loadAllBitruvianComponentsFromHtml();
      setAssembledModels(models);
      if (models.yorick) {
        setYorickBaseRig(JSON.parse(JSON.stringify(models.yorick)));
        setActiveYorickPose('front-neutral');
      }
      setActiveComponent('bytruvyus');
      setActiveTwinSide('L');
      const primary = models.bytruvyus ?? Object.values(models).find(Boolean);
      if (primary) {
        setSelectedNodeId(primary.nodes.find((n) => !n.parent)?.id ?? primary.nodes[0]?.id ?? null);
      }
    } catch {
      // Retain existing rig if asset is unreachable
    } finally {
      setIsLoadingCore(false);
    }
  }, []);

  // Load all 4 Projyct.Bytruvyus core models (Bytruvyus, Gotz, Yorick, Piggy) on mount
  useEffect(() => {
    void handleLoadBitruvianCore();
  }, [handleLoadBitruvianCore]);

  const handleSelectComponent = useCallback(
    (component: ComponentModelKey, twinSide?: 'L' | 'R') => {
      const targetRig = assembledModels[component];
      if (!targetRig) return;
      setActiveComponent(component);
      if (twinSide) {
        setActiveTwinSide(twinSide);
      }
      setSelectedNodeId(
        targetRig.nodes.find((n) => !n.parent)?.id ?? targetRig.nodes[0]?.id ?? null
      );
    },
    [assembledModels]
  );

  const handleUpdateNode = useCallback(
    (nodeId: string, updater: (n: RigNodeSpec) => RigNodeSpec) => {
      setActiveRigSpec((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) => (n.id === nodeId ? updater(n) : n)),
      }));
    },
    [setActiveRigSpec]
  );

  const handleRenameNodeId = useCallback(
    (oldId: string, newId: string) => {
      setActiveRigSpec((prev) => {
        if (prev.nodes.some((n) => n.id === newId)) return prev;
        return {
          ...prev,
          nodes: prev.nodes.map((n) => ({
            ...n,
            id: n.id === oldId ? newId : n.id,
            parent: n.parent === oldId ? newId : n.parent,
            aim: n.aim
              ? { ...n.aim, to: n.aim.to === oldId ? newId : n.aim.to }
              : null,
          })),
        };
      });
      setSelectedNodeId((curr) => (curr === oldId ? newId : curr));
    },
    [setActiveRigSpec]
  );

  const handleAddNode = useCallback(
    (parentId: string | null) => {
      const used = new Set(rigSpec.nodes.map((n) => n.id));
      let idx = rigSpec.nodes.length + 1;
      let id = `bone_${idx}`;
      while (used.has(id)) {
        idx++;
        id = `bone_${idx}`;
      }
      const parent = parentId ? rigSpec.nodes.find((n) => n.id === parentId) : null;
      const pivot: [number, number] = parent
        ? [parent.pivot[0], parent.pivot[1] - 120]
        : [Math.round(rigSpec.W * 0.5), Math.round(rigSpec.H * 0.5)];

      const newNode: RigNodeSpec = {
        id,
        name: `Bone ${idx}`,
        parent: parent ? parent.id : null,
        pivot,
        aim: null,
        ang: 0,
        limits: [-180, 180],
        pieces: [],
      };
      setActiveRigSpec((prev) => ({
        ...prev,
        nodes: [...prev.nodes, newNode],
      }));
      setSelectedNodeId(id);
    },
    [rigSpec.nodes, rigSpec.W, rigSpec.H, setActiveRigSpec]
  );

  const handleDeleteNode = useCallback(
    (id: string) => {
      setActiveRigSpec((prev) => {
        const target = prev.nodes.find((n) => n.id === id);
        const fallbackParent = target?.parent ?? null;
        const remaining = prev.nodes
          .filter((n) => n.id !== id)
          .map((n) => ({
            ...n,
            parent: n.parent === id ? fallbackParent : n.parent,
            aim: n.aim?.to === id ? null : n.aim,
          }));
        return { ...prev, nodes: remaining };
      });
      setSelectedNodeId((curr) => (curr === id ? null : curr));
    },
    [setActiveRigSpec]
  );

  const handleMovePivot = useCallback(
    (nodeId: string, pivot: [number, number]) => {
      setActiveRigSpec((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, pivot } : n)),
      }));
    },
    [setActiveRigSpec]
  );

  const handleMoveBoneWithBondedPngs = useCallback(
    (nodeId: string, nextPivot: [number, number]) => {
      setActiveRigSpec((prev) => {
        const target = prev.nodes.find((n) => n.id === nodeId);
        if (!target) return prev;
        const dx = nextPivot[0] - target.pivot[0];
        const dy = nextPivot[1] - target.pivot[1];
        if (dx === 0 && dy === 0) return prev;
        return {
          ...prev,
          nodes: prev.nodes.map((n) => {
            if (n.id === nodeId) {
              return {
                ...n,
                pivot: nextPivot,
                pieces: n.pieces.map((p) => ({
                  ...p,
                  x: Math.round((p.x + dx) * 10) / 10,
                  y: Math.round((p.y + dy) * 10) / 10,
                })),
              };
            }
            if (n.aim && n.aim.to === nodeId) {
              return {
                ...n,
                aim: {
                  ...n.aim,
                  from: [
                    Math.round((n.aim.from[0] + dx) * 10) / 10,
                    Math.round((n.aim.from[1] + dy) * 10) / 10,
                  ],
                },
              };
            }
            return n;
          }),
        };
      });
    },
    [setActiveRigSpec]
  );

  const handleMovePiece = useCallback(
    (
      nodeId: string,
      pieceIndex: number,
      x: number,
      y: number,
      w?: number,
      h?: number
    ) => {
      setActiveRigSpec((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) => {
          if (n.id !== nodeId) return n;
          return {
            ...n,
            pieces: n.pieces.map((p, idx) =>
              idx === pieceIndex
                ? {
                    ...p,
                    x,
                    y,
                    ...(w !== undefined ? { w } : {}),
                    ...(h !== undefined ? { h } : {}),
                  }
                : p
            ),
          };
        }),
      }));
    },
    [setActiveRigSpec]
  );

  const handlePoseAngle = useCallback(
    (nodeId: string, ang: number) => {
      setActiveRigSpec((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, ang } : n)),
      }));
    },
    [setActiveRigSpec]
  );

  const handlePoseAngles = useCallback(
    (updates: Record<string, number>) => {
      setActiveRigSpec((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) =>
          updates[n.id] !== undefined ? { ...n, ang: updates[n.id] } : n
        ),
      }));
    },
    [setActiveRigSpec]
  );

  const handleApplyYorickPose = useCallback(
    (poseId: YorickPoseId) => {
      setAssembledModels((prevMap) => {
        const currentYorick = prevMap.yorick;
        if (!currentYorick) return prevMap;
        const base = yorickBaseRig ?? currentYorick;
        if (!yorickBaseRig) {
          setYorickBaseRig(JSON.parse(JSON.stringify(currentYorick)));
        }
        const posed = applyYorickPose(currentYorick, base, poseId);
        return {
          ...prevMap,
          yorick: posed,
        };
      });
      setActiveYorickPose(poseId);
    },
    [yorickBaseRig]
  );

  const handleResetPose = useCallback(() => {
    if (activeComponent === 'yorick' && yorickBaseRig) {
      setAssembledModels((prevMap) => {
        const currentYorick = prevMap.yorick;
        if (!currentYorick) return prevMap;
        return {
          ...prevMap,
          yorick: applyYorickPose(currentYorick, yorickBaseRig, 'front-neutral'),
        };
      });
      setActiveYorickPose('front-neutral');
      return;
    }
    setActiveRigSpec((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => ({ ...n, ang: 0 })),
    }));
  }, [activeComponent, yorickBaseRig, setActiveRigSpec]);

  const handleCommitSingleRig = useCallback((nextRig: RigSpec) => {
    const key: ComponentModelKey =
      nextRig.component && nextRig.component !== 'master'
        ? nextRig.component
        : 'bytruvyus';
    if (key === 'yorick') {
      setYorickBaseRig(JSON.parse(JSON.stringify(nextRig)));
      setActiveYorickPose('front-neutral');
    }
    setAssembledModels((prev) => ({ ...prev, [key]: nextRig }));
    setActiveComponent(key);
    setSelectedNodeId(nextRig.nodes.find((n) => !n.parent)?.id ?? nextRig.nodes[0]?.id ?? null);
    setActiveTab('studio');
  }, []);

  const handleCommitModels = useCallback(
    (models: AssembledModelsMap, initialComponent?: ComponentModelKey) => {
      setAssembledModels(models);
      if (models.yorick) {
        setYorickBaseRig(JSON.parse(JSON.stringify(models.yorick)));
        setActiveYorickPose('front-neutral');
      }
      const firstAvailable: ComponentModelKey =
        (initialComponent && models[initialComponent] ? initialComponent : undefined) ??
        (['bytruvyus', 'gotz', 'yorick', 'piggy'] as ComponentModelKey[]).find(
          (k) => Boolean(models[k])
        ) ??
        'bytruvyus';
      setActiveComponent(firstAvailable);
      setActiveTwinSide('L');
      const targetRig = models[firstAvailable];
      setSelectedNodeId(
        targetRig?.nodes.find((n) => !n.parent)?.id ?? targetRig?.nodes[0]?.id ?? null
      );
      setActiveTab('studio');
    },
    []
  );

  return (
    <div className="h-screen w-screen flex flex-col bg-[#111215] text-gray-100 overflow-hidden">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onQuickImport={() => setActiveTab('dreams-parser')}
      />

      {activeTab === 'studio' && (
        <div className="flex-1 flex min-h-0">
          <HierarchySidebar
            rigSpec={rigSpec}
            assembledModels={assembledModels}
            activeComponent={activeComponent}
            activeTwinSide={activeTwinSide}
            onSelectComponent={(c) => handleSelectComponent(c)}
            selectedNodeId={selectedNodeId}
            onSelectNode={(id) => setSelectedNodeId(id)}
            onAddNode={handleAddNode}
            onDeleteNode={handleDeleteNode}
            onLoadBitruvianCore={handleLoadBitruvianCore}
            onNewBlankRig={() => {
              const blank = createStarterRig();
              setActiveRigSpec(() => blank);
              setSelectedNodeId(blank.nodes[0].id);
            }}
            isLoadingCore={isLoadingCore}
            strainInfo={strainInfo}
            activeYorickPose={activeYorickPose}
            dragOnceActive={dragOnceActive}
            onToggleDragOnce={() => setDragOnceActive((v) => !v)}
            onApplyYorickPose={handleApplyYorickPose}
            onUpdateNode={handleUpdateNode}
            onRenameNodeId={handleRenameNodeId}
            onUpdateStageSize={(W, H) => setActiveRigSpec((prev) => ({ ...prev, W, H }))}
            onUpdatePoseAngle={handlePoseAngle}
            onOpenCalibration={() => setCalibrationOpen(true)}
          />

          <StageCanvas
            rigSpec={rigSpec}
            activeComponent={activeComponent}
            activeTwinSide={activeTwinSide}
            selectedNodeId={selectedNodeId}
            stageMode={stageMode}
            dragOnceActive={dragOnceActive}
            onToggleDragOnce={() => setDragOnceActive((v) => !v)}
            onCompleteDragOnce={() => setDragOnceActive(false)}
            onChangeStageMode={setStageMode}
            onChangeTwinSide={setActiveTwinSide}
            onActivateSubComponent={(comp, side) => {
              if (assembledModels[comp]) {
                handleSelectComponent(comp, side);
              }
            }}
            onBackToMaster={() => handleSelectComponent('bytruvyus')}
            onSelectNode={setSelectedNodeId}
            onMovePivot={handleMovePivot}
            onMoveBoneWithPngs={handleMoveBoneWithBondedPngs}
            onMovePiece={handleMovePiece}
            onPoseAngle={handlePoseAngle}
            onPoseAngles={handlePoseAngles}
            activeYorickPose={activeYorickPose}
            onApplyYorickPose={handleApplyYorickPose}
            onResetPose={handleResetPose}
            onOpenCalibration={() => setCalibrationOpen(true)}
            onStrainUpdate={setStrainInfo}
          />
        </div>
      )}

      {calibrationOpen && activeTab === 'studio' && (
        <MaskCalibrationModal
          rigSpec={rigSpec}
          initialNodeId={selectedNodeId}
          onUpdateNode={handleUpdateNode}
          onReplaceRig={(nextRig) => setActiveRigSpec(() => nextRig)}
          onClose={() => setCalibrationOpen(false)}
        />
      )}

      {activeTab === 'dreams-parser' && (
        <DreamsParserView
          onCommitModels={handleCommitModels}
          onCommitSingleRig={handleCommitSingleRig}
        />
      )}

      {activeTab === 'rig-tree' && (
        <RigTreeView
          rigSpec={rigSpec}
          onApplyRigJson={handleCommitSingleRig}
          onSelectNodeInStudio={(id) => {
            setSelectedNodeId(id);
            setActiveTab('studio');
          }}
        />
      )}

      {activeTab === 'export' && (
        <ExportView rigSpec={rigSpec} assembledModels={assembledModels} />
      )}
    </div>
  );
}
