import path from 'node:path';
import zlib from 'node:zlib';
import initSqlJs, { SqlJsStatic } from 'sql.js';
import {
  bytesToHex,
  carveImagesFromBuffer,
  decompressLz4Frame,
  findAllOccurrences,
  parseBinaryPlist,
  resolveNSKeyedArchiver,
} from './binaryDecoders.ts';
import {
  assembleFourComponentModels,
  classifyComponent,
  computePivotFromAnchor,
  DEFAULT_TUNING,
  inferAnatomicalMapping,
} from './componentAssembler.ts';
import { detectIdenticalAndCanonicalParts } from './partMatcher.ts';
import { parseProcreateArchive } from './procreateParser.ts';
import type {
  AnchorConvention,
  DeducedTrackRule,
  DreamsInspectionReport,
  DreamsTableInfo,
  ExtractedAsset,
  TuningConfig,
  ValkyrieBlockSummary,
  ValkyrieDiagnostics,
} from './types.ts';

let nodeSqlPromise: Promise<SqlJsStatic> | null = null;

async function getNodeSql(): Promise<SqlJsStatic> {
  if (!nodeSqlPromise) {
    const wasmPath = path.resolve(process.cwd(), 'public', 'sql-wasm.wasm');
    nodeSqlPromise = initSqlJs({
      locateFile: () => wasmPath,
      useOldExtensionFunctions: false,
    });
  }
  return nodeSqlPromise;
}

function asciiBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function extractReadableStrings(buf: Uint8Array, minLen = 4, maxStrings = 350): string[] {
  const found = new Set<string>();
  let cur = '';
  const limit = Math.min(buf.length, 24 * 1024 * 1024);
  for (let i = 0; i < limit; i++) {
    const c = buf[i];
    if (c >= 32 && c <= 126) {
      cur += String.fromCharCode(c);
    } else {
      if (cur.length >= minLen && /[a-zA-Z]{2,}/.test(cur)) {
        const trimmed = cur.trim();
        if (
          trimmed.length <= 96 &&
          /(bytruv|bitruv|gotz|yorick|yorrick|piggy|piggies|skull|humerus|femur|thorax|pelvis|lumbar|acromion|swivel|brace|forearm|shin|hand|foot|wrist|ankle|finger|thumb|toe|track|anchor|pivot|stage|layer|bone|joint|ztrack|zactor|zkeyframe|sqlite|nskeyed|valkyrie)/i.test(
            trimmed
          )
        ) {
          found.add(trimmed);
          if (found.size >= maxStrings) break;
        }
      }
      cur = '';
    }
  }
  return Array.from(found);
}

interface RawDiscoveredNode {
  id: string;
  name: string;
  parentId: string | null;
  groupPath: string[];
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  anchorX: number | null;
  anchorY: number | null;
  rotation: number;
  minAngle: number | null;
  maxAngle: number | null;
  locked: boolean;
  aimTarget: string | null;
  zIndex: number;
  assetId: string | null;
  reason: string;
}

function minePlistTreeForNodes(
  obj: unknown,
  out: RawDiscoveredNode[],
  groupPath: string[],
  depth = 0
): void {
  if (depth > 18 || !obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach((item) => minePlistTreeForNodes(item, out, groupPath, depth + 1));
    return;
  }
  const rec = obj as Record<string, unknown>;
  const name =
    typeof rec.name === 'string' && rec.name.trim()
      ? rec.name.trim()
      : typeof rec.title === 'string' && rec.title.trim()
      ? rec.title.trim()
      : null;

  const hasSpatial =
    'anchorPoint' in rec ||
    'anchor' in rec ||
    'pivot' in rec ||
    'bounds' in rec ||
    'frame' in rec ||
    'position' in rec ||
    'transform' in rec ||
    'rotation' in rec;

  if (name && hasSpatial) {
    const parseVec = (v: unknown): [number, number] | null => {
      if (Array.isArray(v) && v.length >= 2) {
        const a = Number(v[0]);
        const b = Number(v[1]);
        if (Number.isFinite(a) && Number.isFinite(b)) return [a, b];
      }
      if (typeof v === 'string') {
        const m = v.match(/\{\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\}/);
        if (m) return [Number(m[1]), Number(m[2])];
      }
      return null;
    };

    const parseRect = (v: unknown): { x: number; y: number; w: number; h: number } | null => {
      if (typeof v === 'string') {
        const m = v.match(
          /\{\s*\{\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\}\s*,\s*\{\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\}\s*\}/
        );
        if (m) return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
      }
      return null;
    };

    const rect = parseRect(rec.frame) || parseRect(rec.bounds);
    const anc = parseVec(rec.anchorPoint) || parseVec(rec.anchor) || parseVec(rec.pivot);
    const pos = parseVec(rec.position);
    const rot = typeof rec.rotation === 'number' ? rec.rotation : 0;

    out.push({
      id: typeof rec.UUID === 'string' ? rec.UUID : `plist_${out.length}_${name}`,
      name,
      parentId: null,
      groupPath,
      x: rect ? rect.x : pos ? pos[0] - 128 : null,
      y: rect ? rect.y : pos ? pos[1] - 128 : null,
      w: rect ? rect.w : null,
      h: rect ? rect.h : null,
      anchorX: anc ? anc[0] : null,
      anchorY: anc ? anc[1] : null,
      rotation: Math.abs(rot) <= 6.3 ? (rot * 180) / Math.PI : rot,
      minAngle: null,
      maxAngle: null,
      locked: Boolean(rec.locked),
      aimTarget: null,
      zIndex: out.length,
      assetId: null,
      reason: 'Carved from embedded bplist00 / NSKeyedArchiver object',
    });
  }

  const nextGroup = name ? [...groupPath, name] : groupPath;
  for (const val of Object.values(rec)) {
    if (val && typeof val === 'object') {
      minePlistTreeForNodes(val, out, nextGroup, depth + 1);
    }
  }
}

async function scanSqliteBytes(
  sqliteBytes: Uint8Array,
  tablesOut: DreamsTableInfo[],
  assetsOut: ExtractedAsset[],
  nodesOut: RawDiscoveredNode[],
  stageDims: { w: number; h: number }
): Promise<void> {
  const SQL = await getNodeSql();
  const db = new SQL.Database(sqliteBytes);
  try {
    const master = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const tableNames: string[] = master[0]?.values.map((r) => String(r[0])) ?? [];

    for (const tName of tableNames) {
      const pragma = db.exec(`PRAGMA table_info("${tName.replace(/"/g, '""')}")`);
      const cols = pragma[0]?.values.map((r) => String(r[1])) ?? [];
      const cntRes = db.exec(`SELECT COUNT(*) FROM "${tName.replace(/"/g, '""')}"`);
      const rowCount = Number(cntRes[0]?.values[0]?.[0] ?? 0);
      const rowsRes = db.exec(`SELECT * FROM "${tName.replace(/"/g, '""')}" LIMIT 400`);
      const actualCols = rowsRes[0]?.columns ?? cols;
      const rows = rowsRes[0]?.values ?? [];
      const sampleRows: Record<string, unknown>[] = [];

      for (let rIdx = 0; rIdx < rows.length; rIdx++) {
        const row = rows[rIdx];
        const obj: Record<string, unknown> = {};
        for (let cIdx = 0; cIdx < actualCols.length; cIdx++) {
          const col = actualCols[cIdx];
          const v = row[cIdx];
          if (v instanceof Uint8Array) {
            const carved = carveImagesFromBuffer(v, 4);
            if (carved.length > 0) {
              const img = carved[0];
              assetsOut.push({
                id: `sql_${tName}_${rIdx}_${cIdx}`,
                name: String(obj.name ?? obj.title ?? obj.ZNAME ?? `${tName}_${rIdx}`),
                mime: img.mime,
                width: img.width,
                height: img.height,
                src: `data:${img.mime};base64,${Buffer.from(img.bytes).toString('base64')}`,
                byteSize: img.bytes.byteLength,
                origin: 'sqlite-blob',
              });
              obj[col] = `[${img.mime} ${img.width}×${img.height}]`;
            } else {
              obj[col] = `<Uint8Array ${v.byteLength}B>`;
            }
          } else {
            obj[col] = v;
          }
        }
        if (rIdx < 8) sampleRows.push(obj);

        const getNum = (keys: string[]): number | null => {
          for (const k of keys) {
            const match = Object.keys(obj).find((ok) => ok.toLowerCase() === k.toLowerCase());
            if (match && obj[match] !== null && obj[match] !== undefined) {
              const n = Number(obj[match]);
              if (Number.isFinite(n)) return n;
            }
          }
          return null;
        };
        const getStr = (keys: string[]): string | null => {
          for (const k of keys) {
            const match = Object.keys(obj).find((ok) => ok.toLowerCase() === k.toLowerCase());
            if (match && typeof obj[match] === 'string' && String(obj[match]).trim()) {
              return String(obj[match]).trim();
            }
          }
          return null;
        };

        if (/doc|stage|project|canvas/i.test(tName)) {
          const sw = getNum(['width', 'stageWidth', 'zwidth']);
          const sh = getNum(['height', 'stageHeight', 'zheight']);
          if (sw && sw >= 64 && sw <= 16384) stageDims.w = sw;
          if (sh && sh >= 64 && sh <= 16384) stageDims.h = sh;
        }

        const ax = getNum(['anchorX', 'anchor_x', 'zanchorx', 'pivotX', 'pivot_x']);
        const ay = getNum(['anchorY', 'anchor_y', 'zanchory', 'pivotY', 'pivot_y']);
        const x = getNum(['x', 'posX', 'zx', 'zpositionx']);
        const y = getNum(['y', 'posY', 'zy', 'zpositiony']);

        if (ax !== null || ay !== null || x !== null || y !== null || /track|actor|layer|node/i.test(tName)) {
          const id =
            getStr(['id', 'track_id', 'uuid', 'zuuid']) ||
            (getNum(['id', 'z_pk']) !== null ? String(getNum(['id', 'z_pk'])) : `${tName}_${rIdx}`);
          const name = getStr(['name', 'title', 'label', 'zname', 'ztitle']) || `Track ${id}`;
          nodesOut.push({
            id,
            name,
            parentId:
              getStr(['parent', 'parentId', 'parent_id', 'zparent']) ||
              (getNum(['parent_id', 'zparent']) !== null ? String(getNum(['parent_id', 'zparent'])) : null),
            groupPath: [],
            x,
            y,
            w: getNum(['w', 'width', 'zwidth']),
            h: getNum(['h', 'height', 'zheight']),
            anchorX: ax,
            anchorY: ay,
            rotation: getNum(['rotation', 'ang', 'angle', 'zrotation']) ?? 0,
            minAngle: getNum(['minAngle', 'min_angle']),
            maxAngle: getNum(['maxAngle', 'max_angle']),
            locked: Boolean(getNum(['locked', 'lock', 'zlocked'])),
            aimTarget: getStr(['aimTarget', 'aim_to', 'zaimtarget']),
            zIndex: getNum(['zIndex', 'z_index', 'z_order', 'zorder']) ?? rIdx,
            assetId:
              getStr(['assetId', 'asset_id', 'zasset']) ||
              (getNum(['asset_id', 'zasset']) !== null ? String(getNum(['asset_id', 'zasset'])) : null),
            reason: `SQLite table "${tName}"`,
          });
        }
      }

      tablesOut.push({ name: tName, columns: actualCols, rowCount, sampleRows });
    }
  } finally {
    db.close();
  }
}

export async function deconstructBinarySaveOnServer(
  fileBuffer: Uint8Array,
  fileName: string,
  tuningInput?: Partial<TuningConfig>
): Promise<DreamsInspectionReport> {
  const tuning: TuningConfig = { ...DEFAULT_TUNING, ...tuningInput };
  const notes: string[] = [];
  const tables: DreamsTableInfo[] = [];
  const assets: ExtractedAsset[] = [];
  const discoveredNodes: RawDiscoveredNode[] = [];
  const stageDims = { w: 2048, h: 2048 };

  // Handle .procreate / ZIP directly if PK header
  if (fileBuffer.length >= 4 && fileBuffer[0] === 0x50 && fileBuffer[1] === 0x4b) {
    const pro = await parseProcreateArchive(fileBuffer, tuning);
    assets.push(...pro.assets);
    notes.push(...pro.notes);
    stageDims.w = pro.width;
    stageDims.h = pro.height;

    pro.layers.forEach((layer) => {
      discoveredNodes.push({
        id: layer.uuid,
        name: layer.name,
        parentId: null,
        groupPath: layer.groupPath,
        x: layer.bounds?.x ?? null,
        y: layer.bounds?.y ?? null,
        w: layer.bounds?.w ?? null,
        h: layer.bounds?.h ?? null,
        anchorX: layer.anchor?.[0] ?? 0.5,
        anchorY: layer.anchor?.[1] ?? 0.5,
        rotation: layer.rotationDeg ?? 0,
        minAngle: null,
        maxAngle: null,
        locked: false,
        aimTarget: null,
        zIndex: layer.zIndex,
        assetId: layer.matchedAssetId ?? null,
        reason: `Procreate layer (${layer.groupPath.join(' / ') || 'Root'})`,
      });
    });

    return finalizeServerReport(
      fileName,
      fileBuffer.byteLength,
      'procreate',
      stageDims,
      tables,
      assets,
      discoveredNodes,
      tuning,
      undefined,
      notes
    );
  }

  // Handle direct SQLite3 file
  const sqliteHeader = asciiBytes('SQLite format 3');
  const isDirectSqlite =
    fileBuffer.length >= 16 &&
    sqliteHeader.every((b, idx) => fileBuffer[idx] === b);

  if (isDirectSqlite) {
    await scanSqliteBytes(fileBuffer, tables, assets, discoveredNodes, stageDims);
    notes.push(`Opened direct SQLite3 container (${tables.length} tables).`);
    return finalizeServerReport(
      fileName,
      fileBuffer.byteLength,
      'sqlite',
      stageDims,
      tables,
      assets,
      discoveredNodes,
      tuning,
      undefined,
      notes
    );
  }

  // Pass 1: Valkyrie 64KB Block Framing & Multi-Pass Carving
  const valkNeedle = asciiBytes('Valkyrie');
  const valkHits = findAllOccurrences(fileBuffer, valkNeedle, 4096);
  const isValkyrie = valkHits.length > 0;
  const blockStride =
    valkHits.length >= 2 ? valkHits[1] - valkHits[0] : 65536;

  const sqliteNeedle = asciiBytes('SQLite format 3');
  const bplistNeedle = asciiBytes('bplist00');
  const pngNeedle = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpgNeedle = new Uint8Array([0xff, 0xd8, 0xff]);
  const lz4Needle = new Uint8Array([0x04, 0x22, 0x4d, 0x18]);

  const blocks: ValkyrieBlockSummary[] = [];
  const payloadChunks: Uint8Array[] = [];

  if (isValkyrie) {
    for (let i = 0; i < valkHits.length; i++) {
      const start = valkHits[i];
      const end = i + 1 < valkHits.length ? valkHits[i + 1] : fileBuffer.length;
      const block = fileBuffer.subarray(start, end);
      const sigs: string[] = [];

      if (findAllOccurrences(block, sqliteNeedle, 1).length) sigs.push('SQLite3');
      if (findAllOccurrences(block, bplistNeedle, 1).length) sigs.push('bplist00');
      if (findAllOccurrences(block, pngNeedle, 1).length) sigs.push('PNG');
      if (findAllOccurrences(block, jpgNeedle, 1).length) sigs.push('JPEG');
      if (findAllOccurrences(block, lz4Needle, 1).length) sigs.push('LZ4');
      for (let k = 0; k + 1 < Math.min(block.length, 4096); k++) {
        if (block[k] === 0x78 && (block[k + 1] === 0x9c || block[k + 1] === 0xda)) {
          sigs.push('Zlib');
          break;
        }
      }

      if (blocks.length < 32) {
        blocks.push({
          index: i,
          offset: start,
          size: end - start,
          headerHex: bytesToHex(block, 40),
          detectedSignatures: sigs,
        });
      }

      // Strip probable 32-byte Valkyrie block header when stitching payload stream
      const stripLen = Math.min(32, block.length);
      payloadChunks.push(block.subarray(stripLen));
    }
    notes.push(
      `Detected Valkyrie container (${valkHits.length} block(s), stride ~${blockStride} bytes).`
    );
  }

  // Assemble candidate scan buffers: raw file + header-stripped stitched stream
  const scanBuffers: Array<{ label: string; buf: Uint8Array }> = [
    { label: 'raw', buf: fileBuffer },
  ];
  if (payloadChunks.length > 0) {
    const totalLen = payloadChunks.reduce((acc, c) => acc + c.length, 0);
    const stitched = new Uint8Array(totalLen);
    let cursor = 0;
    for (const c of payloadChunks) {
      stitched.set(c, cursor);
      cursor += c.length;
    }
    scanBuffers.push({ label: 'valkyrie-stitched', buf: stitched });
  }

  // Pass 2: Zlib / Gzip / LZ4 stream decompression
  let carvedZlibCount = 0;
  let carvedLz4Count = 0;
  const decompressedBuffers: Uint8Array[] = [];

  for (const { buf } of scanBuffers) {
    for (const off of findAllOccurrences(buf, lz4Needle, 64)) {
      const dec = decompressLz4Frame(buf.subarray(off, Math.min(buf.length, off + 8 * 1024 * 1024)));
      if (dec && dec.length > 16) {
        carvedLz4Count++;
        decompressedBuffers.push(dec);
      }
    }

    // Scan for zlib (78 9C / 78 DA) & gzip (1F 8B 08) headers
    for (let i = 0; i + 16 < Math.min(buf.length, 32 * 1024 * 1024); i++) {
      if (buf[i] === 0x78 && (buf[i + 1] === 0x9c || buf[i + 1] === 0xda)) {
        try {
          const dec = zlib.inflateSync(buf.subarray(i, Math.min(buf.length, i + 4 * 1024 * 1024)));
          if (dec.length > 16) {
            carvedZlibCount++;
            decompressedBuffers.push(new Uint8Array(dec));
            i += 16;
          }
        } catch {
          // false positive zlib magic byte
        }
      } else if (buf[i] === 0x1f && buf[i + 1] === 0x8b && buf[i + 2] === 0x08) {
        try {
          const dec = zlib.gunzipSync(buf.subarray(i, Math.min(buf.length, i + 4 * 1024 * 1024)));
          if (dec.length > 16) {
            carvedZlibCount++;
            decompressedBuffers.push(new Uint8Array(dec));
            i += 16;
          }
        } catch {
          // false positive gzip magic byte
        }
      }
      if (decompressedBuffers.length >= 64) break;
    }
  }

  decompressedBuffers.forEach((b, idx) =>
    scanBuffers.push({ label: `decompressed_${idx}`, buf: b })
  );

  // Pass 3: Carve SQLite, bplist00, JSON, and PNG/JPEG/WebP images
  let carvedSqliteCount = 0;
  let carvedPlistCount = 0;
  let carvedJsonCount = 0;
  const decodedPlists: Array<{ offset: number; summary: unknown }> = [];
  const seenImageHashes = new Set<string>();

  for (const { label, buf } of scanBuffers) {
    // 3A. Embedded SQLite3
    for (const off of findAllOccurrences(buf, sqliteNeedle, 4)) {
      try {
        await scanSqliteBytes(
          buf.subarray(off),
          tables,
          assets,
          discoveredNodes,
          stageDims
        );
        carvedSqliteCount++;
        notes.push(`Carved embedded SQLite3 database from ${label} stream @ offset ${off}.`);
      } catch {
        // Partial or encrypted SQLite header
      }
    }

    // 3B. Apple bplist00
    for (const off of findAllOccurrences(buf, bplistNeedle, 32)) {
      const slice = buf.subarray(off, Math.min(buf.length, off + 2 * 1024 * 1024));
      const parsed = parseBinaryPlist(slice);
      if (parsed) {
        carvedPlistCount++;
        const resolved = resolveNSKeyedArchiver(parsed);
        if (decodedPlists.length < 8) {
          decodedPlists.push({ offset: off, summary: resolved });
        }
        minePlistTreeForNodes(resolved, discoveredNodes, []);
      }
    }

    // 3C. Embedded PNG / JPEG / WebP images
    for (const img of carveImagesFromBuffer(buf, 96)) {
      const sig = `${img.mime}:${img.width}x${img.height}:${img.bytes.byteLength}`;
      if (seenImageHashes.has(sig)) continue;
      seenImageHashes.add(sig);
      assets.push({
        id: `carved_${label}_${img.offset}`,
        name: `Carved_${img.width}x${img.height}_${assets.length + 1}`,
        mime: img.mime,
        width: img.width,
        height: img.height,
        src: `data:${img.mime};base64,${Buffer.from(img.bytes).toString('base64')}`,
        byteSize: img.bytes.byteLength,
        origin: 'valkyrie-carve',
      });
    }
  }

  // Pass 4: Recover readable identifier strings across raw + stitched + decompressed buffers
  const recoveredStringSet = new Set<string>();
  for (const { buf } of scanBuffers) {
    for (const s of extractReadableStrings(buf, 4, 200)) {
      recoveredStringSet.add(s);
      if (recoveredStringSet.size >= 300) break;
    }
    if (recoveredStringSet.size >= 300) break;
  }
  const recoveredStrings = Array.from(recoveredStringSet);

  if (discoveredNodes.length === 0 && recoveredStrings.length > 0) {
    const partNames = recoveredStrings.filter((s) =>
      /(bytruv|gotz|yorick|yorrick|piggy|head|neck|thorax|lumbar|pelvis|humerus|forearm|hand|femur|shin|foot|skull|eyeball|eyeframe|chin|cheek|upperlip|thumb|index|bird|ring|pinky|ankle|heel|cuboid|footbone|carpal|metacarpal|metatarsal)/i.test(
        s
      )
    );
    const uniqueParts = Array.from(new Set(partNames)).slice(0, 64);
    uniqueParts.forEach((pName, idx) => {
      discoveredNodes.push({
        id: `str_${idx}_${pName}`,
        name: pName,
        parentId: null,
        groupPath: [],
        x: Math.round(stageDims.w * 0.5 - 120),
        y: Math.round(stageDims.h * 0.5 - 120),
        w: 240,
        h: 240,
        anchorX: 0.5,
        anchorY: 0.2,
        rotation: 0,
        minAngle: null,
        maxAngle: null,
        locked: false,
        aimTarget: null,
        zIndex: idx,
        assetId: null,
        reason: 'Synthesized from carved Valkyrie string table',
      });
    });
    if (uniqueParts.length > 0) {
      notes.push(
        `Recovered ${uniqueParts.length} anatomical identifier(s) from Valkyrie / decompressed string tables.`
      );
    }
  }

  if (isValkyrie && assets.length === 0 && discoveredNodes.length === 0) {
    notes.push(
      'Valkyrie 64KB block container detected, but internal track/pixel blocks appear compressed with an undocumented Procreate Dreams codec (e.g., LZFSE/custom chunk compression). Pair an exported .procreate or PNG layer folder below to supply layer assets while keeping this .drm telemetry.'
    );
  }

  const diagnostics: ValkyrieDiagnostics = {
    isValkyrie,
    totalBytes: fileBuffer.byteLength,
    blockCount: valkHits.length,
    blockStride,
    carvedSqliteCount,
    carvedPlistCount,
    carvedJsonCount,
    carvedZlibCount,
    carvedLz4Count,
    carvedImageCount: assets.length,
    blocks,
    recoveredStrings,
    decodedPlists,
  };

  return finalizeServerReport(
    fileName,
    fileBuffer.byteLength,
    isValkyrie ? 'valkyrie-drm' : 'sqlite',
    stageDims,
    tables,
    assets,
    discoveredNodes,
    tuning,
    diagnostics,
    notes
  );
}

function finalizeServerReport(
  fileName: string,
  fileSize: number,
  containerType: DreamsInspectionReport['containerType'],
  stageDims: { w: number; h: number },
  tables: DreamsTableInfo[],
  assets: ExtractedAsset[],
  discoveredNodes: RawDiscoveredNode[],
  tuning: TuningConfig,
  valkyrie: ValkyrieDiagnostics | undefined,
  notes: string[]
): DreamsInspectionReport {
  const usedIds = new Set<string>();
  const rawTrackToNodeId = new Map<string, string>();

  // Also synthesize tracks from carved assets if no nodes were discovered
  if (discoveredNodes.length === 0 && assets.length > 0) {
    assets.forEach((a, idx) => {
      discoveredNodes.push({
        id: a.id,
        name: a.name,
        parentId: null,
        groupPath: [],
        x: Math.round((stageDims.w - a.width) * 0.5),
        y: Math.round((stageDims.h - a.height) * 0.5),
        w: a.width,
        h: a.height,
        anchorX: 0.5,
        anchorY: 0.18,
        rotation: 0,
        minAngle: null,
        maxAngle: null,
        locked: false,
        aimTarget: null,
        zIndex: idx,
        assetId: a.id,
        reason: 'Synthesized from carved image asset',
      });
    });
  }

  const intermediate = discoveredNodes.map((n) => {
    const component = classifyComponent(n.name, n.groupPath);
    const inferred = inferAnatomicalMapping(n.name, component);
    let base = (inferred.role || n.name)
      .trim()
      .replace(/[^a-zA-Z0-9_.]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'node';
    let candidate = base;
    let suffix = 2;
    while (usedIds.has(candidate)) {
      candidate = `${base}_${suffix++}`;
    }
    usedIds.add(candidate);
    rawTrackToNodeId.set(n.id, candidate);
    rawTrackToNodeId.set(n.name, candidate);
    return { n, component, inferred, nodeId: candidate };
  });

  const initialTracks: DeducedTrackRule[] = intermediate.map(
    ({ n, component, inferred, nodeId }) => {
      const matchedAsset =
        assets.find((a) => a.id === n.assetId) ||
        assets.find((a) => a.name.toLowerCase() === n.name.toLowerCase()) ||
        null;

      const w = n.w ?? matchedAsset?.width ?? 220;
      const h = n.h ?? matchedAsset?.height ?? 220;
      const x = n.x ?? Math.round((stageDims.w - w) * 0.5);
      const y = n.y ?? Math.round((stageDims.h - h) * 0.5);
      const box = { x, y, w, h };

      const rawAnchor: [number, number] | null =
        n.anchorX !== null && n.anchorY !== null ? [n.anchorX, n.anchorY] : null;
      const { pivot, spaceLabel } = computePivotFromAnchor(
        box,
        rawAnchor,
        tuning.anchorConvention as AnchorConvention,
        stageDims.w,
        stageDims.h
      );

      let parentId: string | null = null;
      if (n.parentId && rawTrackToNodeId.has(n.parentId)) {
        parentId = rawTrackToNodeId.get(n.parentId)!;
      } else {
        for (const hint of inferred.parentHints) {
          const found = intermediate.find(
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
      }

      return {
        trackId: n.id,
        rawName: n.name,
        component,
        suggestedNodeId: nodeId,
        parentTrackId: n.parentId,
        suggestedParentId: parentId,
        rawAnchor,
        anchorSpace: spaceLabel,
        layerBox: box,
        computedPivot: pivot,
        restAngle: Math.round(n.rotation * 10) / 10,
        limits:
          n.minAngle !== null && n.maxAngle !== null
            ? [Math.round(n.minAngle), Math.round(n.maxAngle)]
            : inferred.limits,
        locked: n.locked,
        aimTargetId: n.aimTarget ? rawTrackToNodeId.get(n.aimTarget) ?? n.aimTarget : null,
        aimMin: 0.7,
        aimMax: 1.15,
        zIndex: n.zIndex,
        matchedAssetId: matchedAsset?.id ?? null,
        inferenceReason: n.reason,
      };
    }
  );

  // Detect identical parts, mirrored twins, and canonical size priors
  const { matches, enrichedTracks } = detectIdenticalAndCanonicalParts(assets, initialTracks);
  if (matches.length > 0) {
    notes.push(
      `Identical/twin part matcher resolved ${matches.length} part match(es) across naming or hierarchy variations.`
    );
  }

  const assembledModels = assembleFourComponentModels(
    fileName.replace(/\.[^.]+$/, ''),
    stageDims.w,
    stageDims.h,
    enrichedTracks,
    assets
  );

  return {
    fileName,
    fileSize,
    containerType,
    stageWidth: stageDims.w,
    stageHeight: stageDims.h,
    tables,
    assets,
    tracks: enrichedTracks,
    assembledModels,
    partMatches: matches,
    conventionUsed: tuning.anchorConvention,
    tuning,
    valkyrie,
    notes,
  };
}
