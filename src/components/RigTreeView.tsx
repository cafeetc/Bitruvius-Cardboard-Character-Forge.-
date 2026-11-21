import React, { useMemo, useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { hydrateRig } from '../core/bitruvianEngine';
import { RigSpec } from '../core/types';

interface RigTreeViewProps {
  rigSpec: RigSpec;
  onApplyRigJson: (spec: RigSpec) => void;
  onSelectNodeInStudio: (nodeId: string) => void;
}

export const RigTreeView: React.FC<RigTreeViewProps> = ({
  rigSpec,
  onApplyRigJson,
  onSelectNodeInStudio,
}) => {
  const hydrated = useMemo(() => hydrateRig(rigSpec), [rigSpec]);

  // Strip massive base64 image data for the readable blueprint JSON view, keeping structural schema intact
  const readableJson = useMemo(() => {
    const compact = {
      rig: {
        name: rigSpec.name,
        source: rigSpec.source,
        W: rigSpec.W,
        H: rigSpec.H,
        nodes: rigSpec.nodes.map((n) => ({
          ...n,
          pieces: n.pieces.map((p) => ({
            i: p.i,
            name: p.name,
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
            src: p.src.startsWith('data:')
              ? `${p.src.slice(0, 42)}...(${p.src.length} chars)`
              : p.src,
          })),
        })),
      },
    };
    return JSON.stringify(compact, null, 2);
  }, [rigSpec]);

  const [rawDraft, setRawDraft] = useState('');
  const [editingRaw, setEditingRaw] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCopyFull = async () => {
    const full = JSON.stringify({ rig: rigSpec }, null, 2);
    await navigator.clipboard.writeText(full);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleStartEdit = () => {
    setRawDraft(JSON.stringify({ rig: rigSpec }, null, 2));
    setJsonError(null);
    setEditingRaw(true);
  };

  const handleApplyEdit = () => {
    try {
      const parsed = JSON.parse(rawDraft);
      const nextRig: RigSpec = parsed.rig ? parsed.rig : parsed;
      if (!nextRig || !Array.isArray(nextRig.nodes)) {
        throw new Error('JSON must contain a valid "nodes" array.');
      }
      onApplyRigJson(nextRig);
      setEditingRaw(false);
      setJsonError(null);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-[#111215] p-6">
      <div className="max-w-[1280px] mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Topological Execution Order & Rules Table */}
        <div className="lg:col-span-7 space-y-4">
          <div>
            <h1 className="text-xl font-semibold text-white">
              Kinematic Solver Order &amp; Anchor Rules
            </h1>
            <p className="text-sm text-gray-400 mt-1">
              Topological evaluation sequence used by the Bitruvian FK &amp; closed-chain Aim Bond solver.
            </p>
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-[#16181D] overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-white/[0.08] bg-[#1B1E24] text-gray-400">
                  <th className="py-2.5 px-3 font-medium">#</th>
                  <th className="py-2.5 px-3 font-medium">Node ID</th>
                  <th className="py-2.5 px-3 font-medium">Parent</th>
                  <th className="py-2.5 px-3 font-medium">Rest Pivot</th>
                  <th className="py-2.5 px-3 font-medium">Limits</th>
                  <th className="py-2.5 px-3 font-medium">Constraint / Bond</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {hydrated.nodes.map((node, idx) => (
                  <tr
                    key={node.id}
                    onClick={() => onSelectNodeInStudio(node.id)}
                    className="hover:bg-white/[0.03] cursor-pointer transition-colors"
                  >
                    <td className="py-2 px-3 font-mono text-gray-500">{idx + 1}</td>
                    <td className="py-2 px-3">
                      <div className="font-mono font-medium text-gray-100">{node.id}</div>
                      <div className="text-[11px] text-gray-500 truncate max-w-[170px]">
                        {node.name}
                      </div>
                    </td>
                    <td className="py-2 px-3 font-mono text-gray-400">
                      {node.parent ?? '—'}
                    </td>
                    <td className="py-2 px-3 font-mono text-emerald-300 whitespace-nowrap">
                      [{node.rest[0]}, {node.rest[1]}]
                    </td>
                    <td className="py-2 px-3 font-mono text-gray-300 whitespace-nowrap">
                      [{node.limits[0]}°, {node.limits[1]}°]
                    </td>
                    <td className="py-2 px-3 text-xs">
                      {node.aim ? (
                        <span className="font-mono text-violet-300">
                          aim → {node.aim.to} ({node.aim.min}–{node.aim.max}×)
                        </span>
                      ) : node.bond ? (
                        <span className="font-mono text-amber-300">
                          bond ← {node.bond.id}
                        </span>
                      ) : node.lock ? (
                        <span className="text-gray-400">Locked</span>
                      ) : (
                        <span className="text-gray-500">Free FK</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Live Rig Schema Preview / Editor */}
        <div className="lg:col-span-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-white">Bitruvian Rig Schema</h2>
              <p className="text-xs text-gray-400">Live structure ready for Projyct.Bytruvyus</p>
            </div>
            <div className="flex items-center gap-2">
              {!editingRaw ? (
                <>
                  <button
                    type="button"
                    onClick={handleStartEdit}
                    className="px-3 py-1.5 text-xs font-medium text-gray-200 bg-[#21242B] hover:bg-[#2A2E37] border border-white/[0.08] rounded-md cursor-pointer"
                  >
                    Edit Raw JSON
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyFull}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-violet-600 hover:bg-violet-500 rounded-md cursor-pointer"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copied' : 'Copy Full JSON'}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setEditingRaw(false)}
                    className="px-3 py-1.5 text-xs font-medium text-gray-300 bg-[#21242B] rounded-md cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleApplyEdit}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-violet-600 hover:bg-violet-500 rounded-md cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Apply Changes
                  </button>
                </>
              )}
            </div>
          </div>

          {jsonError && (
            <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-500/30 text-xs text-rose-200">
              {jsonError}
            </div>
          )}

          {editingRaw ? (
            <textarea
              value={rawDraft}
              onChange={(e) => setRawDraft(e.target.value)}
              spellCheck={false}
              className="w-full h-[560px] p-4 rounded-xl bg-[#16181D] border border-violet-500/40 font-mono text-xs text-gray-200 focus:outline-none resize-none"
            />
          ) : (
            <pre className="w-full h-[560px] p-4 rounded-xl bg-[#16181D] border border-white/[0.08] font-mono text-xs text-gray-300 overflow-auto">
              {readableJson}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
};
