import React, { useRef, useState } from 'react';
import {
  Binary,
  CheckCircle2,
  Database,
  Download,
  FileArchive,
  FolderOpen,
  GitCompare,
  Image as ImageIcon,
  Layers,
  Paperclip,
  SlidersHorizontal,
  Upload,
} from 'lucide-react';
import { assembleFourComponentModels } from '../core/componentAssembler';
import {
  buildRigSpecFromReport,
  generateSampleDreamsDrm,
  pairCompanionFilesToReport,
  parseDreamsFiles,
  recomputeReportWithTuning,
} from '../core/dreamsParser';
import {
  AnchorConvention,
  AssembledModelsMap,
  ComponentModelKey,
  DeducedTrackRule,
  DreamsInspectionReport,
  RigSpec,
  TuningConfig,
} from '../core/types';

interface DreamsParserViewProps {
  onCommitModels: (models: AssembledModelsMap, initialComponent?: ComponentModelKey) => void;
  onCommitSingleRig: (rig: RigSpec) => void;
}

const CONVENTIONS: Array<{ id: AnchorConvention; label: string }> = [
  { id: 'auto', label: 'Auto-Detect' },
  { id: 'normalized-tl', label: 'Normalized 0..1 (Top-Left)' },
  { id: 'normalized-center', label: 'Normalized Center (-0.5..0.5)' },
  { id: 'layer-offset', label: 'Layer Pixel Offset' },
  { id: 'stage-world', label: 'Stage World Coordinates' },
];

const COMPONENT_META: Array<{
  key: ComponentModelKey;
  title: string;
  subtitle: string;
}> = [
  { key: 'bytruvyus', title: 'Bytruvyus', subtitle: 'Body Puppet' },
  { key: 'gotz', title: 'Gotz', subtitle: 'Hand Sub-Rig' },
  { key: 'yorick', title: 'Yorick', subtitle: 'Skull & Face' },
  { key: 'piggy', title: 'Piggy', subtitle: 'Foot Sub-Rig' },
];

export const DreamsParserView: React.FC<DreamsParserViewProps> = ({
  onCommitModels,
  onCommitSingleRig,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const companionInputRef = useRef<HTMLInputElement>(null);

  const [report, setReport] = useState<DreamsInspectionReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [progressStatus, setProgressStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<
    'rules' | 'valkyrie' | 'matches' | 'assets' | 'tables'
  >('rules');
  const [selectedTableIdx, setSelectedTableIdx] = useState(0);
  const [componentFilter, setComponentFilter] = useState<ComponentModelKey | 'all'>('all');

  const handleFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (!files.length) return;
    setLoading(true);
    setProgressPct(5);
    setProgressStatus(`Preparing ${files[0].name}...`);
    setError(null);
    try {
      const parsed = await parseDreamsFiles(
        files,
        report?.tuning ?? 'auto',
        (pct, status) => {
          setProgressPct(pct);
          setProgressStatus(status);
        }
      );
      setReport(parsed);
      setSelectedTableIdx(0);
      if (parsed.valkyrie?.isValkyrie && parsed.tracks.length === 0) {
        setActiveSubTab('valkyrie');
      } else {
        setActiveSubTab('rules');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to deconstruct save files.');
    } finally {
      setLoading(false);
    }
  };

  const handlePairCompanion = async (fileList: FileList | null) => {
    if (!report || !fileList?.length) return;
    setLoading(true);
    setProgressPct(25);
    setProgressStatus('Pairing companion assets...');
    setError(null);
    try {
      const merged = await pairCompanionFilesToReport(
        report,
        Array.from(fileList),
        (pct, status) => {
          setProgressPct(pct);
          setProgressStatus(status);
        }
      );
      setReport(merged);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Companion pairing failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleLoadSampleDrm = async () => {
    setLoading(true);
    setProgressPct(20);
    setProgressStatus('Generating 4-component sample .drm save...');
    setError(null);
    try {
      const sampleFile = await generateSampleDreamsDrm();
      const parsed = await parseDreamsFiles([sampleFile], 'auto', (pct, status) => {
        setProgressPct(pct);
        setProgressStatus(status);
      });
      setReport(parsed);
      setSelectedTableIdx(0);
      setActiveSubTab('rules');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate sample .drm.');
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadSampleDrm = async () => {
    const sampleFile = await generateSampleDreamsDrm();
    const url = URL.createObjectURL(sampleFile);
    const a = document.createElement('a');
    a.href = url;
    a.download = sampleFile.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleTuningChange = (patch: Partial<TuningConfig>) => {
    if (!report) return;
    const nextTuning: TuningConfig = { ...report.tuning, ...patch };
    setReport(recomputeReportWithTuning(report, nextTuning));
  };

  const updateTrack = (trackIdx: number, patch: Partial<DeducedTrackRule>) => {
    if (!report) return;
    const nextTracks = report.tracks.map((tr, i) =>
      i === trackIdx ? { ...tr, ...patch } : tr
    );
    const assembledModels = assembleFourComponentModels(
      report.fileName.replace(/\.[^.]+$/, ''),
      report.stageWidth,
      report.stageHeight,
      nextTracks,
      report.assets
    );
    setReport({
      ...report,
      tracks: nextTracks,
      assembledModels,
    });
  };

  const filteredTracks = report
    ? report.tracks
        .map((tr, index) => ({ tr, index }))
        .filter(({ tr }) => componentFilter === 'all' || tr.component === componentFilter)
    : [];

  return (
    <div className="flex-1 overflow-y-auto bg-[#111215] p-6">
      <div className="max-w-[1320px] mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-white">
              Procreate Dreams (.drm) &amp; Rig Deconstructor
            </h1>
            <p className="text-sm text-gray-400 mt-1 max-w-3xl">
              Streams Valkyrie 64KB <span className="font-mono text-gray-300">.drm</span> containers, SQLite saves, or tunable{' '}
              <span className="font-mono text-gray-300">.procreate</span> files to carve assets, match identical/mirrored twins, deduce anchor rules, and assemble Bytruvyus, Gotz, Yorick, and Piggy.
            </p>
          </div>
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={handleLoadSampleDrm}
              disabled={loading}
              className="px-3.5 py-2 text-xs font-medium text-violet-200 bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/30 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              Inspect 4-Model Sample .drm
            </button>
            <button
              type="button"
              onClick={handleDownloadSampleDrm}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-gray-300 bg-[#181A1F] hover:bg-[#21242B] border border-white/[0.08] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Download Sample .drm
            </button>
          </div>
        </div>

        {/* Dropzone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files?.length) {
              void handleFiles(e.dataTransfer.files);
            }
          }}
          className={`rounded-xl border border-dashed p-7 text-center transition-colors ${
            dragOver
              ? 'border-violet-400 bg-violet-600/10'
              : 'border-white/[0.14] bg-[#16181D]'
          }`}
        >
          <div className="max-w-xl mx-auto space-y-4">
            <div className="w-10 h-10 rounded-lg bg-[#21242B] border border-white/[0.08] mx-auto flex items-center justify-center text-violet-400">
              <FileArchive className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-100">
                {loading
                  ? progressStatus || 'Streaming binary blocks to deconstructor...'
                  : 'Drop your .drm file here (or .procreate / PNG stack / Bitruvian JSON)'}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                Supports streaming Valkyrie 64KB .drm deconstruction, bplist00/LZ4 carving, and identical/mirrored-twin part matching.
              </p>
            </div>

            {loading && (
              <div className="max-w-md mx-auto space-y-1.5">
                <div className="h-1.5 w-full rounded-full bg-[#111215] overflow-hidden border border-white/[0.06]">
                  <div
                    className="h-full bg-violet-500 transition-all duration-200"
                    style={{ width: `${Math.max(4, progressPct)}%` }}
                  />
                </div>
                <div className="text-[11px] font-mono tabular-nums text-gray-400">
                  {progressPct}% · {progressStatus}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                disabled={loading}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-violet-600 hover:bg-violet-500 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
              >
                <Upload className="w-3.5 h-3.5" />
                Select .drm / .procreate / Rig
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => folderInputRef.current?.click()}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-gray-200 bg-[#21242B] hover:bg-[#2A2E37] border border-white/[0.08] rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                Select Folder
              </button>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".drm,.procreate,.sqlite,.db,.zip,.json,image/png,image/jpeg,image/webp"
              onChange={(e) => e.target.files && void handleFiles(e.target.files)}
              className="hidden"
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              // @ts-expect-error webkitdirectory is supported in Chromium/Safari/Firefox
              webkitdirectory=""
              onChange={(e) => e.target.files && void handleFiles(e.target.files)}
              className="hidden"
            />
          </div>
        </div>

        {error && (
          <div className="p-4 rounded-lg bg-rose-950/40 border border-rose-500/30 text-sm text-rose-200">
            {error}
          </div>
        )}

        {/* Inspection Report */}
        {report && (
          <div className="space-y-5">
            {/* Summary + Primary Commit CTA */}
            <div className="p-4 rounded-xl bg-[#16181D] border border-white/[0.08] flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <span>{report.fileName}</span>
                  <span className="text-xs font-normal font-mono tabular-nums text-gray-400">
                    ({(report.fileSize / (1024 * 1024) >= 1
                      ? `${(report.fileSize / (1024 * 1024)).toFixed(2)} MB`
                      : `${(report.fileSize / 1024).toFixed(1)} KB`)})
                  </span>
                </div>
                <div className="text-xs text-gray-400 flex flex-wrap items-center gap-2 font-mono tabular-nums">
                  <span>Container: {report.containerType}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Stage: {report.stageWidth}×{report.stageHeight}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{report.tracks.length} nodes</span>
                  <span aria-hidden="true">·</span>
                  <span>{report.assets.length} assets</span>
                  {report.partMatches && report.partMatches.length > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-emerald-300">
                        {report.partMatches.length} twin/part matches
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => companionInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-200 bg-[#21242B] hover:bg-[#2A2E37] border border-white/[0.08] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Paperclip className="w-3.5 h-3.5" />
                  Pair Companion .procreate / PNGs
                </button>
                <input
                  ref={companionInputRef}
                  type="file"
                  multiple
                  accept=".procreate,image/png,image/jpeg,image/webp"
                  onChange={(e) => {
                    void handlePairCompanion(e.target.files);
                    e.target.value = '';
                  }}
                  className="hidden"
                />

                <button
                  type="button"
                  onClick={() => {
                    const models = report.assembledModels;
                    if (Object.keys(models).length > 0) {
                      onCommitModels(models, models.bytruvyus ? 'bytruvyus' : undefined);
                    } else {
                      onCommitSingleRig(buildRigSpecFromReport(report));
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-violet-600 hover:bg-violet-500 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  Commit All Models to Studio
                </button>
              </div>
            </div>

            {/* 4-Component Assembly Matrix */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {COMPONENT_META.map((meta) => {
                const rig = report.assembledModels[meta.key];
                const boneCount = rig?.nodes.length ?? 0;
                const pieceCount =
                  rig?.nodes.reduce((sum, n) => sum + n.pieces.length, 0) ?? 0;
                return (
                  <div
                    key={meta.key}
                    className={`rounded-xl border p-4 flex flex-col justify-between gap-3 ${
                      rig
                        ? 'bg-[#16181D] border-white/[0.1]'
                        : 'bg-[#14161A] border-white/[0.05] opacity-65'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-white">{meta.title}</span>
                        <span className="text-[11px] font-mono text-gray-400">
                          {meta.subtitle}
                        </span>
                      </div>
                      <div className="mt-1.5 text-xs font-mono tabular-nums text-gray-400">
                        {rig ? (
                          <span className="text-emerald-300">
                            {boneCount} bones · {pieceCount} pieces
                          </span>
                        ) : (
                          <span>No matching tracks detected</span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={!rig}
                        onClick={() =>
                          rig && onCommitModels(report.assembledModels, meta.key)
                        }
                        className="flex-1 px-3 py-1.5 text-xs font-medium text-gray-100 bg-[#21242B] hover:bg-violet-600 disabled:hover:bg-[#21242B] border border-white/[0.08] rounded-md transition-colors cursor-pointer disabled:opacity-40"
                      >
                        Open in Studio
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setComponentFilter((curr) =>
                            curr === meta.key ? 'all' : meta.key
                          )
                        }
                        className={`px-2.5 py-1.5 text-xs rounded-md border transition-colors cursor-pointer ${
                          componentFilter === meta.key
                            ? 'bg-violet-600/25 border-violet-500/50 text-violet-200'
                            : 'bg-[#111215] border-white/[0.06] text-gray-400 hover:text-gray-200'
                        }`}
                      >
                        Filter
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Parser Tuning Bar (for .drm & .procreate adjustments) */}
            <div className="p-4 rounded-xl bg-[#16181D] border border-white/[0.08] flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-1.5 text-xs font-medium text-gray-200">
                <SlidersHorizontal className="w-3.5 h-3.5 text-violet-400" />
                <span>Rig Tuning</span>
              </div>

              <label className="flex items-center gap-2 text-xs text-gray-300">
                <span className="text-gray-400">Anchor Space:</span>
                <select
                  value={report.tuning.anchorConvention}
                  onChange={(e) =>
                    handleTuningChange({ anchorConvention: e.target.value as AnchorConvention })
                  }
                  className="bg-[#111215] border border-white/[0.1] rounded-md px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-violet-500"
                >
                  {CONVENTIONS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex items-center gap-1.5 text-xs text-gray-300">
                <span className="text-gray-400">Scale:</span>
                <input
                  type="number"
                  step="0.05"
                  min="0.1"
                  max="5"
                  value={report.tuning.scaleFactor}
                  onChange={(e) =>
                    handleTuningChange({
                      scaleFactor: Math.max(0.1, Number(e.target.value) || 1),
                    })
                  }
                  className="w-16 bg-[#111215] border border-white/[0.1] rounded px-2 py-1 text-xs font-mono tabular-nums text-gray-100"
                />
              </label>

              <label className="flex items-center gap-1.5 text-xs text-gray-300">
                <span className="text-gray-400">Offset X:</span>
                <input
                  type="number"
                  step="10"
                  value={report.tuning.offsetX}
                  onChange={(e) =>
                    handleTuningChange({ offsetX: Number(e.target.value) || 0 })
                  }
                  className="w-20 bg-[#111215] border border-white/[0.1] rounded px-2 py-1 text-xs font-mono tabular-nums text-gray-100"
                />
              </label>

              <label className="flex items-center gap-1.5 text-xs text-gray-300">
                <span className="text-gray-400">Offset Y:</span>
                <input
                  type="number"
                  step="10"
                  value={report.tuning.offsetY}
                  onChange={(e) =>
                    handleTuningChange({ offsetY: Number(e.target.value) || 0 })
                  }
                  className="w-20 bg-[#111215] border border-white/[0.1] rounded px-2 py-1 text-xs font-mono tabular-nums text-gray-100"
                />
              </label>

              <label className="inline-flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={report.tuning.reverseZ}
                  onChange={(e) => handleTuningChange({ reverseZ: e.target.checked })}
                  className="accent-violet-500"
                />
                <span>Reverse Z-Order</span>
              </label>
            </div>

            {report.notes.length > 0 && (
              <div className="px-4 py-3 rounded-lg bg-[#16181D] border border-white/[0.08] space-y-1 text-xs text-gray-300">
                {report.notes.map((note, idx) => (
                  <div key={idx}>{note}</div>
                ))}
              </div>
            )}

            {/* Sub-Navigation Tabs */}
            <div className="flex flex-wrap items-center gap-1 p-1 bg-[#16181D] border border-white/[0.08] rounded-lg w-fit">
              <button
                type="button"
                onClick={() => setActiveSubTab('rules')}
                className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  activeSubTab === 'rules'
                    ? 'bg-violet-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                Deduced Rules ({filteredTracks.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveSubTab('valkyrie')}
                className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  activeSubTab === 'valkyrie'
                    ? 'bg-violet-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <Binary className="w-3.5 h-3.5" />
                Valkyrie Diagnostics ({report.valkyrie?.blockCount ?? 0})
              </button>
              <button
                type="button"
                onClick={() => setActiveSubTab('matches')}
                className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  activeSubTab === 'matches'
                    ? 'bg-violet-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <GitCompare className="w-3.5 h-3.5" />
                Part &amp; Twin Matches ({report.partMatches?.length ?? 0})
              </button>
              <button
                type="button"
                onClick={() => setActiveSubTab('assets')}
                className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  activeSubTab === 'assets'
                    ? 'bg-violet-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <ImageIcon className="w-3.5 h-3.5" />
                Assets ({report.assets.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveSubTab('tables')}
                className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  activeSubTab === 'tables'
                    ? 'bg-violet-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <Database className="w-3.5 h-3.5" />
                SQLite Tables ({report.tables.length})
              </button>
            </div>

            {/* Tab 1: Deduced Rules */}
            {activeSubTab === 'rules' && (
              <div className="rounded-xl border border-white/[0.08] bg-[#16181D] overflow-x-auto">
                {filteredTracks.length === 0 ? (
                  <div className="p-8 text-center text-xs text-gray-500">
                    No deduced track rows in this filter. Check Valkyrie Diagnostics or pair companion PNG/.procreate layers above.
                  </div>
                ) : (
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-white/[0.08] text-gray-400 bg-[#1B1E24]">
                        <th className="py-2.5 px-3 font-medium">Source Track</th>
                        <th className="py-2.5 px-3 font-medium">Model</th>
                        <th className="py-2.5 px-3 font-medium">Node ID</th>
                        <th className="py-2.5 px-3 font-medium">Parent</th>
                        <th className="py-2.5 px-3 font-medium">Layer Box</th>
                        <th className="py-2.5 px-3 font-medium">Pivot</th>
                        <th className="py-2.5 px-3 font-medium">Limits (°)</th>
                        <th className="py-2.5 px-3 font-medium">Aim Target</th>
                        <th className="py-2.5 px-3 font-medium">Asset</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.06]">
                      {filteredTracks.map(({ tr, index }) => (
                        <tr key={`${tr.trackId}-${index}`} className="hover:bg-white/[0.02]">
                          <td className="py-2.5 px-3">
                            <div className="font-medium text-gray-200">{tr.rawName}</div>
                            <div className="text-[11px] text-gray-500 truncate max-w-[200px]">
                              {tr.inferenceReason}
                            </div>
                          </td>
                          <td className="py-2.5 px-3">
                            <select
                              value={tr.component}
                              onChange={(e) =>
                                updateTrack(index, {
                                  component: e.target.value as ComponentModelKey,
                                })
                              }
                              className="bg-[#111215] border border-white/[0.08] rounded px-2 py-1 text-gray-200"
                            >
                              <option value="bytruvyus">Bytruvyus</option>
                              <option value="gotz">Gotz</option>
                              <option value="yorick">Yorick</option>
                              <option value="piggy">Piggy</option>
                            </select>
                          </td>
                          <td className="py-2.5 px-3">
                            <input
                              type="text"
                              value={tr.suggestedNodeId}
                              onChange={(e) =>
                                updateTrack(index, { suggestedNodeId: e.target.value })
                              }
                              className="w-28 bg-[#111215] border border-white/[0.08] rounded px-2 py-1 font-mono text-violet-300"
                            />
                          </td>
                          <td className="py-2.5 px-3">
                            <select
                              value={tr.suggestedParentId ?? ''}
                              onChange={(e) =>
                                updateTrack(index, {
                                  suggestedParentId: e.target.value || null,
                                })
                              }
                              className="bg-[#111215] border border-white/[0.08] rounded px-2 py-1 text-gray-200"
                            >
                              <option value="">(Root)</option>
                              {report.tracks
                                .filter(
                                  (o) =>
                                    o.component === tr.component &&
                                    o.suggestedNodeId !== tr.suggestedNodeId
                                )
                                .map((o) => (
                                  <option key={o.suggestedNodeId} value={o.suggestedNodeId}>
                                    {o.suggestedNodeId}
                                  </option>
                                ))}
                            </select>
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-gray-300 whitespace-nowrap">
                            {Math.round(tr.layerBox.x)}, {Math.round(tr.layerBox.y)} ·{' '}
                            {Math.round(tr.layerBox.w)}×{Math.round(tr.layerBox.h)}
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-emerald-300 whitespace-nowrap">
                            [{tr.computedPivot[0]}, {tr.computedPivot[1]}]
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-gray-300 whitespace-nowrap">
                            [{tr.limits[0]}°, {tr.limits[1]}°]
                          </td>
                          <td className="py-2.5 px-3">
                            <select
                              value={tr.aimTargetId ?? ''}
                              onChange={(e) =>
                                updateTrack(index, { aimTargetId: e.target.value || null })
                              }
                              className="bg-[#111215] border border-white/[0.08] rounded px-2 py-1 text-gray-200"
                            >
                              <option value="">None</option>
                              {report.tracks
                                .filter(
                                  (o) =>
                                    o.component === tr.component &&
                                    o.suggestedNodeId !== tr.suggestedNodeId
                                )
                                .map((o) => (
                                  <option key={o.suggestedNodeId} value={o.suggestedNodeId}>
                                    {o.suggestedNodeId}
                                  </option>
                                ))}
                            </select>
                          </td>
                          <td className="py-2.5 px-3">
                            <select
                              value={tr.matchedAssetId ?? ''}
                              onChange={(e) =>
                                updateTrack(index, { matchedAssetId: e.target.value || null })
                              }
                              className="bg-[#111215] border border-white/[0.08] rounded px-2 py-1 text-gray-200 max-w-[140px]"
                            >
                              <option value="">No sprite</option>
                              {report.assets.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* Tab 2: Valkyrie Block Diagnostics */}
            {activeSubTab === 'valkyrie' && (
              <div className="space-y-4">
                {!report.valkyrie ? (
                  <div className="p-8 text-center text-xs text-gray-500 rounded-xl bg-[#16181D] border border-white/[0.08]">
                    This container did not use Valkyrie block framing.
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                      <div className="p-3 rounded-lg bg-[#16181D] border border-white/[0.08]">
                        <div className="text-[11px] text-gray-400">Valkyrie Blocks</div>
                        <div className="text-base font-mono tabular-nums text-white mt-0.5">
                          {report.valkyrie.blockCount}
                        </div>
                      </div>
                      <div className="p-3 rounded-lg bg-[#16181D] border border-white/[0.08]">
                        <div className="text-[11px] text-gray-400">Block Stride</div>
                        <div className="text-base font-mono tabular-nums text-white mt-0.5">
                          {report.valkyrie.blockStride} B
                        </div>
                      </div>
                      <div className="p-3 rounded-lg bg-[#16181D] border border-white/[0.08]">
                        <div className="text-[11px] text-gray-400">Carved SQLite</div>
                        <div className="text-base font-mono tabular-nums text-emerald-300 mt-0.5">
                          {report.valkyrie.carvedSqliteCount}
                        </div>
                      </div>
                      <div className="p-3 rounded-lg bg-[#16181D] border border-white/[0.08]">
                        <div className="text-[11px] text-gray-400">Carved bplist00</div>
                        <div className="text-base font-mono tabular-nums text-violet-300 mt-0.5">
                          {report.valkyrie.carvedPlistCount}
                        </div>
                      </div>
                      <div className="p-3 rounded-lg bg-[#16181D] border border-white/[0.08]">
                        <div className="text-[11px] text-gray-400">Zlib / LZ4</div>
                        <div className="text-base font-mono tabular-nums text-gray-200 mt-0.5">
                          {report.valkyrie.carvedZlibCount} / {report.valkyrie.carvedLz4Count}
                        </div>
                      </div>
                      <div className="p-3 rounded-lg bg-[#16181D] border border-white/[0.08]">
                        <div className="text-[11px] text-gray-400">Carved Images</div>
                        <div className="text-base font-mono tabular-nums text-white mt-0.5">
                          {report.valkyrie.carvedImageCount}
                        </div>
                      </div>
                    </div>

                    {report.valkyrie.blocks.length > 0 && (
                      <div className="rounded-xl border border-white/[0.08] bg-[#16181D] overflow-x-auto">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead>
                            <tr className="border-b border-white/[0.08] bg-[#1B1E24] text-gray-400">
                              <th className="py-2 px-3 font-medium">Block #</th>
                              <th className="py-2 px-3 font-medium">Offset</th>
                              <th className="py-2 px-3 font-medium">Size</th>
                              <th className="py-2 px-3 font-medium">Detected Signatures</th>
                              <th className="py-2 px-3 font-medium">Header Hex</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-white/[0.06]">
                            {report.valkyrie.blocks.map((blk) => (
                              <tr key={blk.index}>
                                <td className="py-2 px-3 font-mono tabular-nums text-gray-300">
                                  #{blk.index}
                                </td>
                                <td className="py-2 px-3 font-mono tabular-nums text-gray-400">
                                  0x{blk.offset.toString(16).toUpperCase()}
                                </td>
                                <td className="py-2 px-3 font-mono tabular-nums text-gray-300">
                                  {blk.size} B
                                </td>
                                <td className="py-2 px-3 font-mono text-violet-300">
                                  {blk.detectedSignatures.length
                                    ? blk.detectedSignatures.join(', ')
                                    : 'Raw Valkyrie payload'}
                                </td>
                                <td className="py-2 px-3 font-mono text-[11px] text-gray-500">
                                  {blk.headerHex}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {report.valkyrie.recoveredStrings.length > 0 && (
                      <div className="p-4 rounded-xl bg-[#16181D] border border-white/[0.08] space-y-2">
                        <div className="text-xs font-semibold text-gray-200">
                          Recovered Identifier Strings ({report.valkyrie.recoveredStrings.length})
                        </div>
                        <div className="max-h-48 overflow-y-auto font-mono text-[11px] text-gray-400 leading-relaxed">
                          {report.valkyrie.recoveredStrings.join('  ·  ')}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Tab 3: Identical & Mirrored Twin Part Matches */}
            {activeSubTab === 'matches' && (
              <div className="rounded-xl border border-white/[0.08] bg-[#16181D] overflow-x-auto">
                {!report.partMatches || report.partMatches.length === 0 ? (
                  <div className="p-8 text-center text-xs text-gray-500">
                    No identical byte, mirrored L/R twin, or canonical size-prior matches found yet.
                  </div>
                ) : (
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-white/[0.08] bg-[#1B1E24] text-gray-400">
                        <th className="py-2.5 px-3 font-medium">Source Part</th>
                        <th className="py-2.5 px-3 font-medium">Match Type</th>
                        <th className="py-2.5 px-3 font-medium">Matched Target / Canonical Twin</th>
                        <th className="py-2.5 px-3 font-medium">Confidence</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.06]">
                      {report.partMatches.map((m, idx) => (
                        <tr key={idx} className="hover:bg-white/[0.02]">
                          <td className="py-2.5 px-3 font-medium text-gray-200">
                            {m.sourceName}
                          </td>
                          <td className="py-2.5 px-3 font-mono text-violet-300">
                            {m.matchKind}
                          </td>
                          <td className="py-2.5 px-3 text-gray-300">
                            {m.matchedName}
                            {m.suggestedComponent ? ` (${m.suggestedComponent})` : ''}
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-emerald-300">
                            {Math.round(m.confidence * 100)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* Tab 4: Extracted Assets */}
            {activeSubTab === 'assets' && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                {report.assets.length === 0 ? (
                  <div className="col-span-full p-8 text-center text-sm text-gray-500 rounded-xl bg-[#16181D] border border-white/[0.08]">
                    No uncompressed PNG/JPEG blobs extracted. Pair a companion .procreate or PNG layer export above if needed.
                  </div>
                ) : (
                  report.assets.map((asset) => (
                    <div
                      key={asset.id}
                      className="rounded-lg bg-[#16181D] border border-white/[0.08] p-3 flex flex-col gap-2"
                    >
                      <div className="h-28 rounded bg-[#111215] flex items-center justify-center p-2 overflow-hidden">
                        <img
                          src={asset.src}
                          alt={asset.name}
                          className="max-h-full max-w-full object-contain"
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-gray-200 truncate">
                          {asset.name}
                        </div>
                        <div className="text-[11px] font-mono tabular-nums text-gray-500">
                          {asset.width}×{asset.height} · {asset.origin}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Tab 5: SQLite Tables */}
            {activeSubTab === 'tables' && (
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
                <div className="rounded-xl bg-[#16181D] border border-white/[0.08] p-2 space-y-1 h-fit">
                  {report.tables.length === 0 ? (
                    <div className="p-4 text-xs text-gray-500">
                      No SQLite tables carved from this container.
                    </div>
                  ) : (
                    report.tables.map((t, i) => (
                      <button
                        key={t.name}
                        type="button"
                        onClick={() => setSelectedTableIdx(i)}
                        className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-xs transition-colors cursor-pointer ${
                          selectedTableIdx === i
                            ? 'bg-violet-600/20 text-white border border-violet-500/40'
                            : 'text-gray-300 hover:bg-white/[0.04]'
                        }`}
                      >
                        <span className="font-mono truncate">{t.name}</span>
                        <span className="font-mono tabular-nums text-gray-500">
                          {t.rowCount}
                        </span>
                      </button>
                    ))
                  )}
                </div>

                <div className="lg:col-span-3 rounded-xl bg-[#16181D] border border-white/[0.08] overflow-x-auto">
                  {report.tables[selectedTableIdx] ? (
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-white/[0.08] bg-[#1B1E24] text-gray-400">
                          {report.tables[selectedTableIdx].columns.map((col) => (
                            <th key={col} className="py-2 px-3 font-mono font-medium">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.06]">
                        {report.tables[selectedTableIdx].sampleRows.map((row, rIdx) => (
                          <tr key={rIdx} className="hover:bg-white/[0.02]">
                            {report.tables[selectedTableIdx].columns.map((col) => (
                              <td
                                key={col}
                                className="py-2 px-3 font-mono text-gray-300 max-w-[220px] truncate"
                              >
                                {String(row[col] ?? 'NULL')}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="p-8 text-center text-xs text-gray-500">
                      No SQLite rows to inspect.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
