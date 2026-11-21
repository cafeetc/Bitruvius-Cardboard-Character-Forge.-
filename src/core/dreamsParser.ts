import JSZip from 'jszip';
import initSqlJs, { SqlJsStatic } from 'sql.js';
import { BITRUVIAN_ANATOMICAL_LIMITS, importBonesSchema } from './bitruvianEngine';
import {
  applyTuningToTracks,
  assembleFourComponentModels,
  classifyComponent,
  computePivotFromAnchor,
  DEFAULT_TUNING,
  inferAnatomicalMapping,
} from './componentAssembler';
import { detectIdenticalAndCanonicalParts, detectVisualMirrorMatches } from './partMatcher';
import { parseProcreateArchive } from './procreateParser';
import {
  AnchorConvention,
  ComponentModelKey,
  DeducedTrackRule,
  DreamsInspectionReport,
  ExtractedAsset,
  IdenticalPartMatch,
  RigNodeSpec,
  RigSpec,
  TuningConfig,
} from './types';

let sqlPromise: Promise<SqlJsStatic> | null = null;

async function getSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: () => '/sql-wasm.wasm',
      useOldExtensionFunctions: false,
    });
  }
  return sqlPromise;
}

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width > 0 && height > 0 && width < 32768 && height < 32768) {
      return { width, height };
    }
  }
  return null;
}

async function decodeImageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth || 256, height: img.naturalHeight || 256 });
    img.onerror = () => resolve({ width: 256, height: 256 });
    img.src = src;
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function sanitizeNodeId(raw: string, used: Set<string>): string {
  const base =
    raw
      .trim()
      .replace(/[^a-zA-Z0-9_.]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'node';
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${n++}`;
  }
  used.add(candidate);
  return candidate;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Trims transparent alpha borders from an uploaded PNG/image so placement [x,y,w,h]
 * matches the actual limb artwork bounds (like Procreate Dreams layer trimming).
 */
async function analyzeUploadedImage(
  file: File
): Promise<{ asset: ExtractedAsset; trimmedBox: { x: number; y: number; w: number; h: number } }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Failed to decode ${file.name}`));
      el.src = url;
    });
    const w = img.naturalWidth || 256;
    const h = img.naturalHeight || 256;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      const dataUrl = await fileToDataUrl(file);
      return {
        asset: {
          id: `file_${file.name}`,
          name: file.name.replace(/\.[^.]+$/, ''),
          mime: file.type || 'image/png',
          width: w,
          height: h,
          src: dataUrl,
          byteSize: file.size,
          origin: 'uploaded-file',
        },
        trimmedBox: { x: 0, y: 0, w, h },
      };
    }

    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < minX || maxY < minY) {
      minX = 0;
      minY = 0;
      maxX = w - 1;
      maxY = h - 1;
    }

    const tw = maxX - minX + 1;
    const th = maxY - minY + 1;
    const trimCv = document.createElement('canvas');
    trimCv.width = tw;
    trimCv.height = th;
    const trimCtx = trimCv.getContext('2d');
    trimCtx?.drawImage(cv, minX, minY, tw, th, 0, 0, tw, th);
    const src = trimCv.toDataURL('image/png');

    return {
      asset: {
        id: `file_${file.name}`,
        name: file.name.replace(/\.[^.]+$/, ''),
        mime: 'image/png',
        width: tw,
        height: th,
        src,
        byteSize: file.size,
        origin: 'uploaded-file',
        stageBox: { x: minX, y: minY, w: tw, h: th },
      },
      trimmedBox: { x: minX, y: minY, w: tw, h: th },
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface StreamProgressCallback {
  (progressPct: number, statusText: string): void;
}

/**
 * Streams a `.drm`, `.procreate`, `.sqlite`, or `.db` binary file to the local Express
 * Valkyrie Deconstructor endpoint (`POST /api/drm/deconstruct`) with live upload progress.
 */
function streamToValkyrieServer(
  file: File,
  tuning: TuningConfig,
  onProgress?: StreamProgressCallback
): Promise<DreamsInspectionReport> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      anchorConvention: tuning.anchorConvention,
      scaleFactor: String(tuning.scaleFactor),
      offsetX: String(tuning.offsetX),
      offsetY: String(tuning.offsetY),
      reverseZ: String(tuning.reverseZ),
    });

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/drm/deconstruct?${params.toString()}`, true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', file.name);

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) {
        const pct = Math.min(85, Math.round((ev.loaded / Math.max(1, ev.total)) * 85));
        onProgress(pct, `Streaming ${file.name} blocks (${pct}%)...`);
      }
    };

    xhr.upload.onload = () => {
      onProgress?.(90, `Carving Valkyrie 64KB blocks & matching parts...`);
    };

    xhr.onload = () => {
      try {
        const parsed = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress?.(100, 'Deconstruction complete.');
          resolve(parsed as DreamsInspectionReport);
        } else {
          reject(new Error(parsed?.error || `Server error (${xhr.status})`));
        }
      } catch {
        reject(new Error(`Invalid server response (${xhr.status})`));
      }
    };

    xhr.onerror = () => {
      reject(new Error('Network error streaming save file to local deconstructor server.'));
    };

    xhr.send(file);
  });
}

async function runPartMatchingAndAssemble(
  report: DreamsInspectionReport
): Promise<DreamsInspectionReport> {
  const { matches, enrichedTracks } = detectIdenticalAndCanonicalParts(
    report.assets,
    report.tracks
  );
  const visualMatches = await detectVisualMirrorMatches(report.assets);

  const seenPair = new Set<string>();
  const combinedMatches: IdenticalPartMatch[] = [];
  for (const m of [...matches, ...visualMatches]) {
    const k = `${m.sourceAssetId}|${m.matchedAssetId}|${m.matchKind}`;
    if (!seenPair.has(k)) {
      seenPair.add(k);
      combinedMatches.push(m);
    }
  }

  // Propagate parent relationships using updated node IDs/components where needed
  const assembledModels = assembleFourComponentModels(
    report.fileName.replace(/\.[^.]+$/, ''),
    report.stageWidth,
    report.stageHeight,
    enrichedTracks,
    report.assets
  );

  return {
    ...report,
    tracks: enrichedTracks,
    assembledModels,
    partMatches: combinedMatches,
  };
}

/**
 * Merges an optional companion `.procreate` or PNG layer stack onto a primary report
 * (typically a Valkyrie `.drm`), automatically matching sprites and twins across both.
 */
export async function pairCompanionFilesToReport(
  baseReport: DreamsInspectionReport,
  companionFiles: File[],
  onProgress?: StreamProgressCallback
): Promise<DreamsInspectionReport> {
  if (!companionFiles.length) return baseReport;

  const extraAssets: ExtractedAsset[] = [...baseReport.assets];
  const extraNotes: string[] = [...baseReport.notes];
  let extraTracks: DeducedTrackRule[] = [...baseReport.tracks];

  for (const file of companionFiles) {
    if (/\.(png|jpe?g|webp)$/i.test(file.name)) {
      const { asset } = await analyzeUploadedImage(file);
      extraAssets.push(asset);
    } else if (/\.procreate$/i.test(file.name)) {
      onProgress?.(50, `Pairing companion .procreate (${file.name})...`);
      const buf = new Uint8Array(await file.arrayBuffer());
      const pro = await parseProcreateArchive(buf, baseReport.tuning);
      extraAssets.push(...pro.assets);
      extraNotes.push(`Paired companion .procreate: ${pro.layers.length} layer(s), ${pro.assets.length} asset(s).`);
      if (extraTracks.length === 0 && pro.layers.length > 0) {
        const usedIds = new Set<string>();
        extraTracks = pro.layers.map((layer) => {
          const component = classifyComponent(layer.name, layer.groupPath);
          const inferred = inferAnatomicalMapping(layer.name, component);
          const nodeId = sanitizeNodeId(inferred.role || layer.name, usedIds);
          const box = layer.bounds ?? { x: 900, y: 900, w: 240, h: 240 };
          const { pivot, spaceLabel } = computePivotFromAnchor(
            box,
            layer.anchor ?? [0.5, 0.5],
            baseReport.tuning.anchorConvention,
            pro.width,
            pro.height
          );
          return {
            trackId: layer.uuid,
            rawName: layer.name,
            component,
            suggestedNodeId: nodeId,
            parentTrackId: null,
            suggestedParentId: null,
            rawAnchor: layer.anchor ?? [0.5, 0.5],
            anchorSpace: spaceLabel,
            layerBox: box,
            computedPivot: pivot,
            restAngle: layer.rotationDeg ?? 0,
            limits: inferred.limits,
            locked: false,
            aimTargetId: null,
            aimMin: 0.7,
            aimMax: 1.15,
            zIndex: layer.zIndex,
            matchedAssetId: layer.matchedAssetId ?? null,
            inferenceReason: `Paired from ${file.name} (${layer.groupPath.join(' / ') || 'Root'})`,
          };
        });
      }
    }
  }

  // Pair newly added assets to existing tracks by normalized name, role, or dimensions
  const pairedTracks = extraTracks.map((tr) => {
    if (tr.matchedAssetId) return tr;
    const cleanNode = tr.suggestedNodeId.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanRaw = tr.rawName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const hit =
      extraAssets.find((a) => a.name.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanRaw) ||
      extraAssets.find((a) => a.name.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanNode) ||
      extraAssets.find((a) => {
        const an = a.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        return an.length > 2 && (an.includes(cleanNode) || cleanRaw.includes(an));
      });
    return hit
      ? {
          ...tr,
          matchedAssetId: hit.id,
          layerBox: hit.stageBox ?? {
            ...tr.layerBox,
            w: tr.layerBox.w || hit.width,
            h: tr.layerBox.h || hit.height,
          },
          inferenceReason: `${tr.inferenceReason} · Paired companion asset "${hit.name}"`,
        }
      : tr;
  });

  extraNotes.push(`Paired ${companionFiles.length} companion file(s) into report.`);
  return runPartMatchingAndAssemble({
    ...baseReport,
    assets: extraAssets,
    tracks: pairedTracks,
    notes: extraNotes,
  });
}

export async function parseDreamsFiles(
  files: File[],
  tuningInput: AnchorConvention | Partial<TuningConfig> = 'auto',
  onProgress?: StreamProgressCallback
): Promise<DreamsInspectionReport> {
  if (!files.length) {
    throw new Error('No files selected.');
  }

  const tuning: TuningConfig =
    typeof tuningInput === 'string'
      ? { ...DEFAULT_TUNING, anchorConvention: tuningInput }
      : { ...DEFAULT_TUNING, ...tuningInput };

  const imageFiles = files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
  const dataFiles = files.filter((f) => !/\.(png|jpe?g|webp)$/i.test(f.name));

  const looseAssets: ExtractedAsset[] = [];
  for (const imgFile of imageFiles) {
    const { asset } = await analyzeUploadedImage(imgFile);
    looseAssets.push(asset);
  }

  // Case 1: Only PNG/image files dropped
  if (dataFiles.length === 0) {
    onProgress?.(40, `Trimming ${looseAssets.length} PNG layer(s)...`);
    const maxW = Math.max(2048, ...looseAssets.map((a) => (a.stageBox?.x ?? 0) + a.width));
    const maxH = Math.max(2048, ...looseAssets.map((a) => (a.stageBox?.y ?? 0) + a.height));
    const usedIds = new Set<string>();

    const temp = looseAssets.map((a, idx) => {
      const component = classifyComponent(a.name);
      const inferred = inferAnatomicalMapping(a.name, component);
      const nodeId = sanitizeNodeId(inferred.role !== a.name ? inferred.role : a.name, usedIds);
      return { a, idx, component, inferred, nodeId };
    });

    const tracks: DeducedTrackRule[] = temp.map(({ a, idx, component, inferred, nodeId }) => {
      const box = a.stageBox ?? {
        x: Math.round((maxW - a.width) * 0.5),
        y: Math.round((maxH - a.height) * 0.5),
        w: a.width,
        h: a.height,
      };
      const { pivot, spaceLabel } = computePivotFromAnchor(
        box,
        [0.5, 0.14],
        tuning.anchorConvention === 'auto' ? 'normalized-tl' : tuning.anchorConvention,
        maxW,
        maxH
      );
      let parentId: string | null = null;
      for (const hint of inferred.parentHints) {
        const found = temp.find(
          (c) =>
            c.component === component &&
            c.nodeId !== nodeId &&
            c.nodeId.toLowerCase().includes(hint.toLowerCase())
        );
        if (found) {
          parentId = found.nodeId;
          break;
        }
      }
      return {
        trackId: a.id,
        rawName: a.name,
        component,
        suggestedNodeId: nodeId,
        parentTrackId: null,
        suggestedParentId: parentId,
        rawAnchor: [0.5, 0.14],
        anchorSpace: spaceLabel,
        layerBox: box,
        computedPivot: pivot,
        restAngle: 0,
        limits: inferred.limits,
        locked: false,
        aimTargetId: null,
        aimMin: 0.7,
        aimMax: 1.15,
        zIndex: idx,
        matchedAssetId: a.id,
        inferenceReason: 'Auto-trimmed alpha bounds + anatomical parent deduction',
      };
    });

    const tunedTracks = applyTuningToTracks(tracks, tuning, maxW, maxH);
    const report: DreamsInspectionReport = {
      fileName: `${imageFiles.length} Layer PNGs`,
      fileSize: files.reduce((acc, f) => acc + f.size, 0),
      containerType: 'asset-stack',
      stageWidth: maxW,
      stageHeight: maxH,
      tables: [],
      assets: looseAssets,
      tracks: tunedTracks,
      assembledModels: {},
      conventionUsed: tuning.anchorConvention,
      tuning,
      notes: [
        `Auto-trimmed ${looseAssets.length} PNG layer(s) and classified components automatically.`,
      ],
    };
    onProgress?.(100, 'Complete.');
    return runPartMatchingAndAssemble(report);
  }

  // Pick primary container (.drm prioritized over .procreate/.zip/.json)
  const primary =
    dataFiles.find((f) => /\.drm$/i.test(f.name)) ??
    dataFiles.find((f) => /\.procreate$/i.test(f.name)) ??
    dataFiles[0];
  const secondaryDataFiles = dataFiles.filter((f) => f !== primary);

  // Case 2: Bitruvian / Bones JSON
  if (/\.json$/i.test(primary.name)) {
    const text = await primary.text();
    const parsed = JSON.parse(text);
    const rigSpec: RigSpec = parsed.rig
      ? parsed.rig
      : parsed.bones
      ? importBonesSchema(parsed)
      : parsed;

    const assets: ExtractedAsset[] = [...looseAssets];
    const tracks: DeducedTrackRule[] = (rigSpec.nodes || []).map((n: RigNodeSpec, idx: number) => {
      const piece = n.pieces?.[0];
      let assetId: string | null = null;
      if (piece?.src) {
        assetId = `json_asset_${n.id}_${idx}`;
        assets.push({
          id: assetId,
          name: piece.name || n.name,
          mime: 'image/png',
          width: piece.w,
          height: piece.h,
          src: piece.src,
          byteSize: piece.src.length,
          origin: 'zip-entry',
          stageBox: { x: piece.x, y: piece.y, w: piece.w, h: piece.h },
        });
      }
      const box = piece
        ? { x: piece.x, y: piece.y, w: piece.w, h: piece.h }
        : { x: n.pivot[0] - 50, y: n.pivot[1] - 50, w: 100, h: 100 };

      const component: ComponentModelKey =
        rigSpec.component && rigSpec.component !== 'master'
          ? rigSpec.component
          : classifyComponent(n.name || n.id);

      return {
        trackId: n.id,
        rawName: n.name || n.id,
        component,
        suggestedNodeId: n.id,
        parentTrackId: n.parent,
        suggestedParentId: n.parent,
        rawAnchor: [n.pivot[0], n.pivot[1]],
        anchorSpace: 'Stage World Coordinates',
        layerBox: box,
        computedPivot: [n.pivot[0], n.pivot[1]],
        restAngle: n.ang || 0,
        limits: n.limits || BITRUVIAN_ANATOMICAL_LIMITS[n.id] || [-180, 180],
        locked: !!n.lock,
        aimTargetId: n.aim?.to ?? null,
        aimMin: n.aim?.min ?? 0.7,
        aimMax: n.aim?.max ?? 1.15,
        zIndex: piece?.i ?? idx,
        matchedAssetId: assetId,
        inferenceReason: 'Direct Bitruvian JSON rig import',
      };
    });

    const report: DreamsInspectionReport = {
      fileName: primary.name,
      fileSize: primary.size,
      containerType: 'json-rig',
      stageWidth: rigSpec.W || 2500,
      stageHeight: rigSpec.H || 2500,
      tables: [],
      assets,
      tracks,
      assembledModels: {},
      conventionUsed: 'stage-world',
      tuning: { ...tuning, anchorConvention: 'stage-world' },
      notes: [`Loaded ${tracks.length} rig node(s) from JSON specification.`],
    };
    onProgress?.(100, 'Complete.');
    return runPartMatchingAndAssemble(report);
  }

  // Case 3: Stream `.drm`, `.procreate`, `.sqlite`, `.db`, or `.zip` through the Express Valkyrie server
  let serverReport: DreamsInspectionReport;
  if (/\.(drm|procreate|sqlite|db)$/i.test(primary.name)) {
    serverReport = await streamToValkyrieServer(primary, tuning, onProgress);
  } else {
    // Generic .zip archive fallback in browser
    onProgress?.(30, `Inspecting archive ${primary.name}...`);
    const buf = new Uint8Array(await primary.arrayBuffer());
    if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
      const zip = await JSZip.loadAsync(buf);
      if (zip.file('Document.archive')) {
        const pro = await parseProcreateArchive(buf, tuning);
        const usedIds = new Set<string>();
        const tracks: DeducedTrackRule[] = pro.layers.map((layer) => {
          const component = classifyComponent(layer.name, layer.groupPath);
          const inferred = inferAnatomicalMapping(layer.name, component);
          const nodeId = sanitizeNodeId(inferred.role || layer.name, usedIds);
          const box = layer.bounds ?? { x: 900, y: 900, w: 240, h: 240 };
          const { pivot, spaceLabel } = computePivotFromAnchor(
            box,
            layer.anchor ?? [0.5, 0.5],
            tuning.anchorConvention,
            pro.width,
            pro.height
          );
          return {
            trackId: layer.uuid,
            rawName: layer.name,
            component,
            suggestedNodeId: nodeId,
            parentTrackId: null,
            suggestedParentId: null,
            rawAnchor: layer.anchor ?? [0.5, 0.5],
            anchorSpace: spaceLabel,
            layerBox: box,
            computedPivot: pivot,
            restAngle: layer.rotationDeg ?? 0,
            limits: inferred.limits,
            locked: false,
            aimTargetId: null,
            aimMin: 0.7,
            aimMax: 1.15,
            zIndex: layer.zIndex,
            matchedAssetId: layer.matchedAssetId ?? null,
            inferenceReason: `Procreate archive (${layer.groupPath.join(' / ') || 'Root'})`,
          };
        });
        serverReport = {
          fileName: primary.name,
          fileSize: primary.size,
          containerType: 'procreate',
          stageWidth: pro.width,
          stageHeight: pro.height,
          tables: [],
          assets: pro.assets,
          tracks,
          assembledModels: {},
          conventionUsed: tuning.anchorConvention,
          tuning,
          notes: pro.notes,
        };
      } else {
        // Check if zip contains .drm or PNGs
        const zipAssets: ExtractedAsset[] = [];
        for (const [entryPath, entry] of Object.entries(zip.files)) {
          if (entry.dir) continue;
          if (/\.(png|jpe?g|webp)$/i.test(entryPath)) {
            const entryBuf = await entry.async('uint8array');
            const mime = /\.png$/i.test(entryPath)
              ? 'image/png'
              : /\.webp$/i.test(entryPath)
              ? 'image/webp'
              : 'image/jpeg';
            const src = `data:${mime};base64,${bytesToBase64(entryBuf)}`;
            const dims =
              mime === 'image/png'
                ? readPngDimensions(entryBuf) ?? (await decodeImageDimensions(src))
                : await decodeImageDimensions(src);
            const baseName = entryPath.split('/').pop()?.replace(/\.[^.]+$/, '') || entryPath;
            zipAssets.push({
              id: entryPath,
              name: baseName,
              mime,
              width: dims.width,
              height: dims.height,
              src,
              byteSize: entryBuf.byteLength,
              origin: 'zip-entry',
            });
          }
        }
        const usedIds = new Set<string>();
        const tracks: DeducedTrackRule[] = zipAssets.map((a, idx) => {
          const component = classifyComponent(a.name);
          const inferred = inferAnatomicalMapping(a.name, component);
          const nodeId = sanitizeNodeId(inferred.role || a.name, usedIds);
          const box = {
            x: Math.round((2048 - a.width) * 0.5),
            y: Math.round((2048 - a.height) * 0.5),
            w: a.width,
            h: a.height,
          };
          const { pivot, spaceLabel } = computePivotFromAnchor(
            box,
            [0.5, 0.15],
            tuning.anchorConvention,
            2048,
            2048
          );
          return {
            trackId: a.id,
            rawName: a.name,
            component,
            suggestedNodeId: nodeId,
            parentTrackId: null,
            suggestedParentId: null,
            rawAnchor: [0.5, 0.15],
            anchorSpace: spaceLabel,
            layerBox: box,
            computedPivot: pivot,
            restAngle: 0,
            limits: inferred.limits,
            locked: false,
            aimTargetId: null,
            aimMin: 0.7,
            aimMax: 1.15,
            zIndex: idx,
            matchedAssetId: a.id,
            inferenceReason: 'ZIP image entry',
          };
        });
        serverReport = {
          fileName: primary.name,
          fileSize: primary.size,
          containerType: 'zip-package',
          stageWidth: 2048,
          stageHeight: 2048,
          tables: [],
          assets: zipAssets,
          tracks,
          assembledModels: {},
          conventionUsed: tuning.anchorConvention,
          tuning,
          notes: [`Extracted ${zipAssets.length} image asset(s) from ZIP archive.`],
        };
      }
    } else {
      serverReport = await streamToValkyrieServer(primary, tuning, onProgress);
    }
  }

  // Enrich with browser perceptual & mirror twin detection
  let report = await runPartMatchingAndAssemble(serverReport);

  // If companion PNGs or secondary .procreate were selected alongside .drm, merge them in
  const companions = [...imageFiles, ...secondaryDataFiles];
  if (companions.length > 0) {
    report = await pairCompanionFilesToReport(report, companions, onProgress);
  }

  return report;
}

export function recomputeReportWithTuning(
  report: DreamsInspectionReport,
  tuning: TuningConfig
): DreamsInspectionReport {
  const tunedTracks = applyTuningToTracks(
    report.tracks,
    tuning,
    report.stageWidth,
    report.stageHeight
  );
  const assembledModels = assembleFourComponentModels(
    report.fileName.replace(/\.[^.]+$/, ''),
    report.stageWidth,
    report.stageHeight,
    tunedTracks,
    report.assets
  );
  return {
    ...report,
    conventionUsed: tuning.anchorConvention,
    tuning,
    tracks: tunedTracks,
    assembledModels,
  };
}

export function recomputeReportWithConvention(
  report: DreamsInspectionReport,
  convention: AnchorConvention
): DreamsInspectionReport {
  return recomputeReportWithTuning(report, {
    ...report.tuning,
    anchorConvention: convention,
  });
}

export function buildRigSpecFromReport(
  report: DreamsInspectionReport,
  component?: ComponentModelKey
): RigSpec {
  if (component && report.assembledModels[component]) {
    return report.assembledModels[component]!;
  }

  const assetById = new Map<string, ExtractedAsset>();
  report.assets.forEach((a) => assetById.set(a.id, a));

  const trackByNodeId = new Map<string, DeducedTrackRule>();
  report.tracks.forEach((tr) => trackByNodeId.set(tr.suggestedNodeId, tr));

  const nodes: RigNodeSpec[] = report.tracks.map((tr) => {
    const asset = tr.matchedAssetId ? assetById.get(tr.matchedAssetId) : undefined;
    const aimTarget = tr.aimTargetId ? trackByNodeId.get(tr.aimTargetId) : undefined;

    return {
      id: tr.suggestedNodeId,
      name: tr.rawName,
      parent: tr.suggestedParentId,
      pivot: [tr.computedPivot[0], tr.computedPivot[1]],
      ang: tr.restAngle,
      limits: [tr.limits[0], tr.limits[1]],
      lock: tr.locked,
      aim:
        tr.aimTargetId && aimTarget
          ? {
              to: tr.aimTargetId,
              from: [aimTarget.computedPivot[0], aimTarget.computedPivot[1]],
              min: tr.aimMin,
              max: tr.aimMax,
            }
          : null,
      top: tr.layerBox.y,
      left: tr.layerBox.x,
      pieces: asset
        ? [
            {
              i: tr.zIndex,
              name: asset.name,
              x: tr.layerBox.x,
              y: tr.layerBox.y,
              w: tr.layerBox.w,
              h: tr.layerBox.h,
              src: asset.src,
            },
          ]
        : [],
    };
  });

  return {
    name: report.fileName.replace(/\.[^.]+$/, ''),
    source: `Deduced from ${report.fileName}`,
    component: 'master',
    W: report.stageWidth,
    H: report.stageHeight,
    nodes,
  };
}

function renderProceduralLimbPng(
  w: number,
  h: number,
  shape: 'pelvis' | 'thorax' | 'head' | 'limb' | 'hand' | 'tendon',
  fill: string,
  stroke: string
): Uint8Array {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 6;
  ctx.lineJoin = 'round';

  if (shape === 'head') {
    ctx.beginPath();
    ctx.ellipse(w / 2, h * 0.48, w * 0.36, h * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#111215';
    ctx.fillRect(w * 0.3, h * 0.44, w * 0.4, 14);
  } else if (shape === 'thorax') {
    ctx.beginPath();
    ctx.moveTo(w * 0.12, h * 0.14);
    ctx.lineTo(w * 0.88, h * 0.14);
    ctx.lineTo(w * 0.72, h * 0.92);
    ctx.lineTo(w * 0.28, h * 0.92);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (shape === 'pelvis') {
    ctx.beginPath();
    ctx.moveTo(w * 0.15, h * 0.15);
    ctx.lineTo(w * 0.85, h * 0.15);
    ctx.lineTo(w * 0.72, h * 0.85);
    ctx.lineTo(w * 0.5, h * 0.65);
    ctx.lineTo(w * 0.28, h * 0.85);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (shape === 'tendon') {
    ctx.beginPath();
    ctx.roundRect(8, h * 0.25, w - 16, h * 0.5, 16);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.roundRect(w * 0.18, 10, w * 0.64, h - 20, Math.min(w, h) * 0.28);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(w / 2, Math.min(w * 0.5, 36), 10, 0, Math.PI * 2);
    ctx.fillStyle = '#c4b5fd';
    ctx.fill();
  }

  const dataUrl = cv.toDataURL('image/png');
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Builds a 4-component SQLite3 `.drm` sample save in memory covering Bytruvyus (Body),
 * Gotz (Hand), Yorick (Head/Skull), and Piggy (Foot) so users can test the full
 * streaming deconstructor and multi-model assembly pipeline immediately.
 */
export async function generateSampleDreamsDrm(): Promise<File> {
  const SQL = await getSql();
  const db = new SQL.Database();

  db.run(`
    CREATE TABLE ZDOCUMENT (id INTEGER PRIMARY KEY, name TEXT, width INTEGER, height INTEGER);
    CREATE TABLE ZASSET (id TEXT PRIMARY KEY, name TEXT, mime TEXT, data BLOB);
    CREATE TABLE ZTRACK (
      id TEXT PRIMARY KEY,
      name TEXT,
      parent_id TEXT,
      x REAL, y REAL, w REAL, h REAL,
      anchor_x REAL, anchor_y REAL,
      rotation REAL,
      min_angle REAL, max_angle REAL,
      locked INTEGER,
      aim_target TEXT,
      aim_min REAL, aim_max REAL,
      z_order INTEGER,
      asset_id TEXT
    );
    CREATE TABLE ZKEYFRAME (id INTEGER PRIMARY KEY AUTOINCREMENT, track_id TEXT, frame INTEGER, rotation REAL);
  `);

  db.run("INSERT INTO ZDOCUMENT VALUES (1, 'Projyct_Bytruvyus_Sample.drm', 2048, 2200)");

  const parts: Array<{
    id: string;
    name: string;
    parent: string | null;
    x: number;
    y: number;
    w: number;
    h: number;
    ax: number;
    ay: number;
    minA: number;
    maxA: number;
    locked: number;
    aimTarget: string | null;
    z: number;
    shape: 'pelvis' | 'thorax' | 'head' | 'limb' | 'hand' | 'tendon';
    fill: string;
  }> = [
    // Bytruvyus main body
    { id: 't_pelvis', name: 'Pelvis_Root', parent: null, x: 864, y: 980, w: 320, h: 190, ax: 0.5, ay: 0.45, minA: -180, maxA: 180, locked: 0, aimTarget: null, z: 10, shape: 'pelvis', fill: '#4c1d95' },
    { id: 't_thorax', name: 'Thorax_Chest', parent: 't_pelvis', x: 824, y: 580, w: 400, h: 420, ax: 0.5, ay: 0.92, minA: -38, maxA: 38, locked: 0, aimTarget: null, z: 11, shape: 'thorax', fill: '#5b21b6' },
    { id: 't_head', name: 'Head', parent: 't_thorax', x: 904, y: 270, w: 240, h: 300, ax: 0.5, ay: 0.88, minA: -55, maxA: 55, locked: 0, aimTarget: null, z: 9, shape: 'head', fill: '#6d28d9' },
    { id: 't_brace_l', name: 'TendonBrace_L', parent: 't_thorax', x: 1024, y: 575, w: 290, h: 90, ax: 0.08, ay: 0.5, minA: -18, maxA: 18, locked: 1, aimTarget: 't_arm_l', z: 14, shape: 'tendon', fill: '#3b0764' },
    { id: 't_arm_l', name: 'Humerus_L', parent: 't_thorax', x: 1230, y: 600, w: 120, h: 360, ax: 0.5, ay: 0.12, minA: -165, maxA: 160, locked: 0, aimTarget: null, z: 7, shape: 'limb', fill: '#7c3aed' },
    { id: 't_fore_l', name: 'Forearm_L', parent: 't_arm_l', x: 1235, y: 900, w: 110, h: 340, ax: 0.5, ay: 0.12, minA: -150, maxA: 15, locked: 0, aimTarget: null, z: 6, shape: 'limb', fill: '#8b5cf6' },
    { id: 't_hand_l', name: 'Hand_L', parent: 't_fore_l', x: 1245, y: 1200, w: 96, h: 150, ax: 0.5, ay: 0.15, minA: -85, maxA: 85, locked: 0, aimTarget: null, z: 5, shape: 'limb', fill: '#a78bfa' },
    { id: 't_arm_r', name: 'Humerus_R', parent: 't_thorax', x: 698, y: 600, w: 120, h: 360, ax: 0.5, ay: 0.12, minA: -160, maxA: 165, locked: 0, aimTarget: null, z: 15, shape: 'limb', fill: '#7c3aed' },
    { id: 't_fore_r', name: 'Forearm_R', parent: 't_arm_r', x: 703, y: 900, w: 110, h: 340, ax: 0.5, ay: 0.12, minA: -15, maxA: 150, locked: 0, aimTarget: null, z: 16, shape: 'limb', fill: '#8b5cf6' },
    { id: 't_hand_r', name: 'Hand_R', parent: 't_fore_r', x: 707, y: 1200, w: 96, h: 150, ax: 0.5, ay: 0.15, minA: -85, maxA: 85, locked: 0, aimTarget: null, z: 17, shape: 'limb', fill: '#a78bfa' },
    { id: 't_femur_l', name: 'Femur_L', parent: 't_pelvis', x: 1054, y: 1110, w: 140, h: 430, ax: 0.5, ay: 0.1, minA: -130, maxA: 115, locked: 0, aimTarget: null, z: 12, shape: 'limb', fill: '#6d28d9' },
    { id: 't_shin_l', name: 'Shin_L', parent: 't_femur_l', x: 1064, y: 1490, w: 120, h: 420, ax: 0.5, ay: 0.1, minA: -15, maxA: 145, locked: 0, aimTarget: null, z: 13, shape: 'limb', fill: '#7c3aed' },
    { id: 't_foot_l', name: 'Foot_L', parent: 't_shin_l', x: 1060, y: 1870, w: 170, h: 110, ax: 0.25, ay: 0.3, minA: -65, maxA: 75, locked: 0, aimTarget: null, z: 14, shape: 'tendon', fill: '#8b5cf6' },
    { id: 't_femur_r', name: 'Femur_R', parent: 't_pelvis', x: 854, y: 1110, w: 140, h: 430, ax: 0.5, ay: 0.1, minA: -115, maxA: 130, locked: 0, aimTarget: null, z: 18, shape: 'limb', fill: '#6d28d9' },
    { id: 't_shin_r', name: 'Shin_R', parent: 't_femur_r', x: 864, y: 1490, w: 120, h: 420, ax: 0.5, ay: 0.1, minA: -145, maxA: 15, locked: 0, aimTarget: null, z: 19, shape: 'limb', fill: '#7c3aed' },
    { id: 't_foot_r', name: 'Foot_R', parent: 't_shin_r', x: 818, y: 1870, w: 170, h: 110, ax: 0.75, ay: 0.3, minA: -75, maxA: 65, locked: 0, aimTarget: null, z: 20, shape: 'tendon', fill: '#8b5cf6' },

    // Yorick (Head / Skull sub-rig)
    { id: 'y_skull', name: 'Yorick_Skullbone', parent: null, x: 760, y: 520, w: 520, h: 660, ax: 0.5, ay: 0.65, minA: -45, maxA: 45, locked: 0, aimTarget: null, z: 5, shape: 'head', fill: '#4c1d95' },
    { id: 'y_chin', name: 'Yorick_Chin', parent: 'y_skull', x: 860, y: 1020, w: 320, h: 180, ax: 0.5, ay: 0.2, minA: -35, maxA: 20, locked: 0, aimTarget: null, z: 6, shape: 'pelvis', fill: '#6d28d9' },

    // Gotz (Hand sub-rig)
    { id: 'g_bird_meta', name: 'Gotz_BirdMetacarpal', parent: null, x: 960, y: 840, w: 110, h: 420, ax: 0.5, ay: 0.85, minA: -45, maxA: 45, locked: 0, aimTarget: null, z: 4, shape: 'limb', fill: '#5b21b6' },
    { id: 'g_index_prox', name: 'Gotz_IndexProximal', parent: 'g_bird_meta', x: 820, y: 580, w: 96, h: 280, ax: 0.5, ay: 0.85, minA: -35, maxA: 90, locked: 0, aimTarget: null, z: 5, shape: 'limb', fill: '#7c3aed' },

    // Piggy (Foot sub-rig)
    { id: 'p_ankle', name: 'Piggy_Ankle', parent: null, x: 880, y: 720, w: 280, h: 240, ax: 0.5, ay: 0.2, minA: -45, maxA: 45, locked: 0, aimTarget: null, z: 4, shape: 'pelvis', fill: '#5b21b6' },
    { id: 'p_footbone', name: 'Piggy_Footbone', parent: 'p_ankle', x: 840, y: 920, w: 360, h: 220, ax: 0.35, ay: 0.4, minA: -35, maxA: 35, locked: 0, aimTarget: null, z: 5, shape: 'tendon', fill: '#7c3aed' },
  ];

  for (const p of parts) {
    const pngBytes = renderProceduralLimbPng(p.w, p.h, p.shape, p.fill, '#ddd6fe');
    db.run('INSERT INTO ZASSET (id, name, mime, data) VALUES (?, ?, ?, ?)', [
      `asset_${p.id}`,
      p.name,
      'image/png',
      pngBytes,
    ]);
    db.run(
      `INSERT INTO ZTRACK (
        id, name, parent_id, x, y, w, h, anchor_x, anchor_y, rotation,
        min_angle, max_angle, locked, aim_target, aim_min, aim_max, z_order, asset_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0.7, 1.15, ?, ?)`,
      [
        p.id,
        p.name,
        p.parent,
        p.x,
        p.y,
        p.w,
        p.h,
        p.ax,
        p.ay,
        p.minA,
        p.maxA,
        p.locked,
        p.aimTarget,
        p.z,
        `asset_${p.id}`,
      ]
    );
    db.run('INSERT INTO ZKEYFRAME (track_id, frame, rotation) VALUES (?, 0, ?)', [p.id, p.minA * 0.5]);
    db.run('INSERT INTO ZKEYFRAME (track_id, frame, rotation) VALUES (?, 24, ?)', [p.id, p.maxA * 0.5]);
  }

  const exported = db.export();
  db.close();
  return new File([new Uint8Array(exported)], 'Projyct_Bytruvyus_Sample.drm', {
    type: 'application/x-sqlite3',
  });
}
