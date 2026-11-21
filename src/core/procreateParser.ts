import JSZip from 'jszip';
import {
  decompressLz4Block,
  parseBinaryPlist,
  resolveNSKeyedArchiver,
} from './binaryDecoders';
import { ExtractedAsset, TuningConfig } from './types';

export interface ProcreateLayerRecord {
  uuid: string;
  name: string;
  groupPath: string[];
  bounds?: { x: number; y: number; w: number; h: number };
  anchor?: [number, number];
  rotationDeg?: number;
  hidden?: boolean;
  zIndex: number;
  matchedAssetId?: string;
}

export interface ProcreateParseResult {
  documentName: string;
  width: number;
  height: number;
  layers: ProcreateLayerRecord[];
  assets: ExtractedAsset[];
  notes: string[];
}

function bytesToBase64Universal(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function parseCgSize(val: unknown): { w: number; h: number } | null {
  if (typeof val !== 'string') return null;
  const m = val.match(/\{\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\}/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return Number.isFinite(w) && Number.isFinite(h) ? { w, h } : null;
}

function parseCgPoint(val: unknown): [number, number] | null {
  if (typeof val !== 'string') return null;
  const m = val.match(/\{\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\}/);
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function parseCgRect(val: unknown): { x: number; y: number; w: number; h: number } | null {
  if (typeof val !== 'string') return null;
  const m = val.match(
    /\{\s*\{\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\}\s*,\s*\{\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\}\s*\}/
  );
  if (!m) return null;
  return {
    x: Number(m[1]),
    y: Number(m[2]),
    w: Number(m[3]),
    h: Number(m[4]),
  };
}

/**
 * Unpacks a `.procreate` ZIP archive (`Document.archive` bplist + QuickLook + PNG/LZ4 chunks).
 * Runs in both Node.js (`server.ts`) and Browser (`dreamsParser.ts`).
 */
export async function parseProcreateArchive(
  zipBytes: Uint8Array,
  tuning?: Partial<TuningConfig>
): Promise<ProcreateParseResult> {
  const zip = await JSZip.loadAsync(zipBytes);
  const scale = tuning?.scaleFactor ?? 1;
  const ox = tuning?.offsetX ?? 0;
  const oy = tuning?.offsetY ?? 0;

  let docName = 'Procreate_Rig';
  let width = 2048;
  let height = 2048;
  const layers: ProcreateLayerRecord[] = [];
  const assets: ExtractedAsset[] = [];
  const notes: string[] = [];

  // 1. Collect any direct PNG/JPG images inside the .procreate archive (e.g., QuickLook or pre-rendered chunks)
  const chunkEntriesByDir = new Map<string, Array<{ path: string; name: string }>>();
  for (const [entryPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (/\.(png|jpe?g|webp)$/i.test(entryPath)) {
      const buf = await entry.async('uint8array');
      const mime = /\.png$/i.test(entryPath)
        ? 'image/png'
        : /\.webp$/i.test(entryPath)
        ? 'image/webp'
        : 'image/jpeg';
      const src = `data:${mime};base64,${bytesToBase64Universal(buf)}`;
      const base = entryPath.split('/').pop()?.replace(/\.[^.]+$/, '') || entryPath;
      assets.push({
        id: `procreate_img_${entryPath}`,
        name: base,
        mime,
        width: 512,
        height: 512,
        src,
        byteSize: buf.byteLength,
        origin: 'procreate-chunk',
      });
    } else if (/\.chunk$/i.test(entryPath)) {
      const parts = entryPath.split('/');
      const folder = parts.length >= 2 ? parts[parts.length - 2] : 'root';
      const arr = chunkEntriesByDir.get(folder) ?? [];
      arr.push({ path: entryPath, name: parts[parts.length - 1] });
      chunkEntriesByDir.set(folder, arr);
    }
  }

  // 2. Parse Document.archive (bplist00 + NSKeyedArchiver)
  const archiveEntry =
    zip.file('Document.archive') ||
    Object.values(zip.files).find((f) => f.name.endsWith('Document.archive'));

  if (archiveEntry) {
    const raw = await archiveEntry.async('uint8array');
    const plist = parseBinaryPlist(raw);
    const doc = resolveNSKeyedArchiver(plist) as Record<string, unknown> | null;

    if (doc && typeof doc === 'object') {
      if (typeof doc.name === 'string' && doc.name.trim()) docName = doc.name.trim();
      const sizeObj = parseCgSize(doc.size);
      if (sizeObj && sizeObj.w > 0 && sizeObj.h > 0) {
        width = Math.round(sizeObj.w * scale);
        height = Math.round(sizeObj.h * scale);
      }

      let zCounter = 0;
      const walkLayerNode = (node: unknown, groupPath: string[]) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach((item) => walkLayerNode(item, groupPath));
          return;
        }
        const rec = node as Record<string, unknown>;
        const cls = typeof rec.$class === 'string' ? rec.$class : '';
        const name =
          (typeof rec.name === 'string' && rec.name.trim()) ||
          (typeof rec.title === 'string' && rec.title.trim()) ||
          '';

        if (/group/i.test(cls) || Array.isArray(rec.children) || Array.isArray(rec.layers)) {
          const nextPath = name ? [...groupPath, name] : groupPath;
          if (Array.isArray(rec.children)) walkLayerNode(rec.children, nextPath);
          if (Array.isArray(rec.layers)) walkLayerNode(rec.layers, nextPath);
          return;
        }

        const uuid = typeof rec.UUID === 'string' ? rec.UUID : `layer_${zCounter}`;
        const rect =
          parseCgRect(rec.bounds) ||
          parseCgRect(rec.frame) ||
          parseCgRect(rec.rect);
        const anchor =
          parseCgPoint(rec.anchorPoint) ||
          parseCgPoint(rec.anchor) ||
          parseCgPoint(rec.pivot);

        const pos = parseCgPoint(rec.position) || parseCgPoint(rec.translation);
        const layerBounds = rect
          ? {
              x: Math.round((rect.x * scale + ox) * 10) / 10,
              y: Math.round((rect.y * scale + oy) * 10) / 10,
              w: Math.max(16, Math.round(rect.w * scale)),
              h: Math.max(16, Math.round(rect.h * scale)),
            }
          : pos
          ? {
              x: Math.round(pos[0] * scale + ox - 128),
              y: Math.round(pos[1] * scale + oy - 128),
              w: 256,
              h: 256,
            }
          : undefined;

        const rot =
          typeof rec.rotation === 'number'
            ? (rec.rotation * 180) / Math.PI
            : typeof rec.angle === 'number'
            ? rec.angle
            : 0;

        if (name || uuid !== `layer_${zCounter}`) {
          layers.push({
            uuid,
            name: name || `Layer ${zCounter + 1}`,
            groupPath,
            bounds: layerBounds,
            anchor: anchor ?? [0.5, 0.5],
            rotationDeg: Math.round(rot * 10) / 10,
            hidden: Boolean(rec.hidden),
            zIndex: zCounter++,
          });
        }
      };

      if (Array.isArray(doc.layers)) walkLayerNode(doc.layers, []);
      if (Array.isArray(doc.unwrappedLayers)) walkLayerNode(doc.unwrappedLayers, []);

      notes.push(
        `Decoded Procreate Document.archive (${width}×${height}): ${layers.length} layer(s), ${chunkEntriesByDir.size} chunk folder(s).`
      );
    }
  } else {
    notes.push('Procreate archive did not contain Document.archive; parsed image entries only.');
  }

  // 3. Attempt LZ4 chunk inspection for chunk folders matched to layer UUIDs
  let lz4DecodedCount = 0;
  for (const layer of layers) {
    const chunks = chunkEntriesByDir.get(layer.uuid);
    if (!chunks || !chunks.length) continue;
    // Try decoding first chunk to confirm tile size/presence
    const firstFile = zip.file(chunks[0].path);
    if (firstFile) {
      const rawChunk = await firstFile.async('uint8array');
      const dec = decompressLz4Block(rawChunk, 512 * 1024);
      if (dec.length > 0) lz4DecodedCount++;
    }
  }
  if (lz4DecodedCount > 0) {
    notes.push(`Verified ${lz4DecodedCount} LZ4-compressed layer tile chunk folder(s).`);
  }

  return {
    documentName: docName,
    width,
    height,
    layers,
    assets,
    notes,
  };
}
