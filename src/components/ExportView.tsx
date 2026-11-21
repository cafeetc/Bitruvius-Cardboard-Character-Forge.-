import React, { useMemo, useState } from 'react';
import { Check, Copy, Download, FileCode2, FileJson, Network } from 'lucide-react';
import {
  bakeRigForMainApp,
  exportBonesSchema,
  exportPoseableHtml,
} from '../core/bitruvianEngine';
import { AssembledModelsMap, ComponentModelKey, RigSpec } from '../core/types';

interface ExportViewProps {
  rigSpec: RigSpec;
  assembledModels?: AssembledModelsMap;
}

function downloadTextFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

export const ExportView: React.FC<ExportViewProps> = ({ rigSpec, assembledModels }) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const rigidSpec = useMemo(() => bakeRigForMainApp(rigSpec), [rigSpec]);

  const stats = useMemo(() => {
    const pieces = rigidSpec.nodes.reduce((sum, n) => sum + n.pieces.length, 0);
    const aims = rigidSpec.nodes.filter((n) => n.aim !== null).length;
    const locked = rigidSpec.nodes.filter((n) => n.lock).length;
    return { bones: rigidSpec.nodes.length, pieces, aims, locked };
  }, [rigidSpec]);

  const slug = (rigidSpec.name || 'bytruvyus-rig')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const handleCopy = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const handleDownloadAllFourBundle = () => {
    if (!assembledModels) return;
    const bundle: Partial<Record<ComponentModelKey, RigSpec>> = {};
    (['bytruvyus', 'gotz', 'yorick', 'piggy'] as ComponentModelKey[]).forEach((k) => {
      if (assembledModels[k]) {
        bundle[k] = bakeRigForMainApp(assembledModels[k]!);
      }
    });
    downloadTextFile(
      'bytruvyus-4-component-bundle.json',
      JSON.stringify(bundle, null, 2),
      'application/json'
    );
  };

  return (
    <div className="flex-1 overflow-y-auto bg-[#111215] p-6">
      <div className="max-w-[1100px] mx-auto space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-white">
              Export Ready-to-Pose Rigs &amp; Core Schemas
            </h1>
            <p className="text-sm text-gray-400 mt-1">
              Bakes Forge stretches into rigid sprite bounds for Projyct.Bytruvyus, exports a standalone poseable HTML puppet, or extracts the skeleton hierarchy.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-xs font-mono tabular-nums text-gray-400 flex items-center gap-2">
              <span>{stats.bones} bones</span>
              <span aria-hidden="true">·</span>
              <span>{stats.pieces} pieces</span>
              <span aria-hidden="true">·</span>
              <span>{stats.aims} aim bonds</span>
              <span aria-hidden="true">·</span>
              <span>
                {rigidSpec.W}×{rigidSpec.H}
              </span>
            </div>
            {assembledModels && Object.keys(assembledModels).length > 1 && (
              <button
                type="button"
                onClick={handleDownloadAllFourBundle}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-violet-200 bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/30 rounded-lg transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Export All 4 Models Bundle
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* Option 1: Standalone Poseable HTML */}
          <div className="rounded-xl bg-[#16181D] border border-white/[0.08] p-5 flex flex-col justify-between gap-5">
            <div className="space-y-2.5">
              <div className="w-9 h-9 rounded-lg bg-violet-600/20 border border-violet-500/30 flex items-center justify-center text-violet-300">
                <FileCode2 className="w-4 h-4" />
              </div>
              <h2 className="text-base font-semibold text-white">
                Poseable HTML Puppet
              </h2>
              <p className="text-xs text-gray-400 leading-relaxed">
                Self-contained single-file interactive poser with all sprite assets embedded and the Bitruvian FK + Closed-Chain Aim Bond solver built in.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  downloadTextFile(
                    `${slug}-pose-player.html`,
                    exportPoseableHtml(rigidSpec),
                    'text/html'
                  )
                }
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-violet-600 hover:bg-violet-500 rounded-lg transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Download .html
              </button>
            </div>
          </div>

          {/* Option 2: Bitruvian rig-data.json */}
          <div className="rounded-xl bg-[#16181D] border border-white/[0.08] p-5 flex flex-col justify-between gap-5">
            <div className="space-y-2.5">
              <div className="w-9 h-9 rounded-lg bg-[#21242B] border border-white/[0.08] flex items-center justify-center text-emerald-400">
                <FileJson className="w-4 h-4" />
              </div>
              <h2 className="text-base font-semibold text-white">
                Bitruvian rig-data.json
              </h2>
              <p className="text-xs text-gray-400 leading-relaxed">
                Native Projyct.Bytruvyus rig payload including rigid stage dimensions, node pivots, limits, aim bonds, and embedded PNG asset pieces.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  downloadTextFile(
                    `${slug}-rig-data.json`,
                    JSON.stringify({ rig: rigidSpec }, null, 2),
                    'application/json'
                  )
                }
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-medium text-gray-100 bg-[#21242B] hover:bg-[#2A2E37] border border-white/[0.08] rounded-lg transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Download JSON
              </button>
              <button
                type="button"
                onClick={() =>
                  handleCopy('rig-data', JSON.stringify({ rig: rigidSpec }, null, 2))
                }
                className="px-3 py-2 text-xs font-medium text-gray-300 bg-[#21242B] hover:bg-[#2A2E37] border border-white/[0.08] rounded-lg cursor-pointer"
                title="Copy JSON"
              >
                {copiedId === 'rig-data' ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>

          {/* Option 3: Bones Skeleton Schema */}
          <div className="rounded-xl bg-[#16181D] border border-white/[0.08] p-5 flex flex-col justify-between gap-5">
            <div className="space-y-2.5">
              <div className="w-9 h-9 rounded-lg bg-[#21242B] border border-white/[0.08] flex items-center justify-center text-gray-200">
                <Network className="w-4 h-4" />
              </div>
              <h2 className="text-base font-semibold text-white">
                Bones Skeleton JSON
              </h2>
              <p className="text-xs text-gray-400 leading-relaxed">
                Lightweight relative-offset bone hierarchy with slots and IK/aim targets, compatible with Bitruvian skeleton import/export.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  downloadTextFile(
                    `${slug}-bones.json`,
                    JSON.stringify(exportBonesSchema(rigidSpec), null, 2),
                    'application/json'
                  )
                }
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-medium text-gray-100 bg-[#21242B] hover:bg-[#2A2E37] border border-white/[0.08] rounded-lg transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Download Bones
              </button>
              <button
                type="button"
                onClick={() =>
                  handleCopy(
                    'bones',
                    JSON.stringify(exportBonesSchema(rigidSpec), null, 2)
                  )
                }
                className="px-3 py-2 text-xs font-medium text-gray-300 bg-[#21242B] hover:bg-[#2A2E37] border border-white/[0.08] rounded-lg cursor-pointer"
                title="Copy Bones JSON"
              >
                {copiedId === 'bones' ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
