import { ComponentModelKey, DeducedTrackRule, ExtractedAsset, IdenticalPartMatch } from './types';

export type { IdenticalPartMatch };

export interface AssetFingerprint {
  assetId: string;
  exactHash: string;
  mirrorSignature: string;
  width: number;
  height: number;
  aspect: number;
}

/**
 * Fast FNV-1a 64-bit-style hex digest (pure TS, works in Node & Browser).
 */
export function fnv1aHex(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    h1 ^= b;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= b ^ (i & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

export function dataUrlToBytes(src: string): Uint8Array | null {
  const idx = src.indexOf('base64,');
  if (idx === -1) return null;
  const b64 = src.slice(idx + 7);
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Known canonical sprite dimensions from Projyct.Bytruvyus, Gotz, Yorick, and Piggy.
 * Allows identifying layers named "Inserted Image" or "Layer 12" purely by geometry.
 */
const CANONICAL_SIZE_PRIORS: Array<{
  w: number;
  h: number;
  component: ComponentModelKey;
  role: string;
  label: string;
}> = [
  // Bytruvyus body
  { w: 601, h: 896, component: 'bytruvyus', role: 'head', label: 'Head (Front)' },
  { w: 303, h: 423, component: 'bytruvyus', role: 'neck', label: 'Neck' },
  { w: 181, h: 1319, component: 'bytruvyus', role: 'thorax', label: 'Upperspine' },
  { w: 719, h: 1505, component: 'bytruvyus', role: 'rib', label: 'Ribcage' },
  { w: 531, h: 531, component: 'bytruvyus', role: 'thorax', label: 'Neckring' },
  { w: 714, h: 393, component: 'bytruvyus', role: 'brace', label: 'Shouldertendon' },
  { w: 724, h: 953, component: 'bytruvyus', role: 'brace', label: 'Backshoulder' },
  { w: 499, h: 407, component: 'bytruvyus', role: 'acromion', label: 'Shoulderbone' },
  { w: 258, h: 1353, component: 'bytruvyus', role: 'humerus', label: 'Humerus' },
  { w: 680, h: 964, component: 'bytruvyus', role: 'swivel', label: 'Shoulderswivel' },
  { w: 94, h: 1300, component: 'bytruvyus', role: 'forearm', label: 'Ulna' },
  { w: 116, h: 1354, component: 'bytruvyus', role: 'forearm', label: 'Radius' },
  { w: 647, h: 828, component: 'bytruvyus', role: 'pelvis', label: 'Pelvis Hip' },
  { w: 385, h: 2125, component: 'bytruvyus', role: 'femur', label: 'Femur' },
  { w: 247, h: 878, component: 'bytruvyus', role: 'hand', label: 'Handkit' },
  { w: 235, h: 1579, component: 'bytruvyus', role: 'shin', label: 'Tibia' },
  { w: 101, h: 1516, component: 'bytruvyus', role: 'shin', label: 'Fibula' },
  { w: 806, h: 681, component: 'bytruvyus', role: 'foot', label: 'Foot' },
  // Yorick head
  { w: 2000, h: 2805, component: 'yorick', role: 'skull', label: 'Skullbone' },
  { w: 1451, h: 1390, component: 'yorick', role: 'forehead', label: 'Forehead' },
  { w: 401, h: 526, component: 'yorick', role: 'furlbone', label: 'Furlbone' },
  { w: 791, h: 743, component: 'yorick', role: 'eyeframe', label: 'Eyeframe' },
  { w: 536, h: 549, component: 'yorick', role: 'socket', label: 'Socketbone' },
  { w: 459, h: 458, component: 'yorick', role: 'eyeball', label: 'Eyeball' },
  { w: 1069, h: 749, component: 'yorick', role: 'cheek', label: 'Cheek' },
  { w: 851, h: 356, component: 'yorick', role: 'upperlip', label: 'Upper Lip' },
  { w: 1105, h: 395, component: 'yorick', role: 'chin', label: 'Chin' },
  // Gotz hand
  { w: 283, h: 453, component: 'gotz', role: 'thumb.carpal', label: 'Carpal' },
  { w: 207, h: 1062, component: 'gotz', role: 'bird.meta', label: 'Bird Metacarpal' },
  { w: 275, h: 978, component: 'gotz', role: 'index.meta', label: 'Index Metacarpal' },
  { w: 280, h: 1032, component: 'gotz', role: 'ring.meta', label: 'Ring Metacarpal' },
  { w: 209, h: 939, component: 'gotz', role: 'pinky.meta', label: 'Pinky Metacarpal' },
  // Piggy foot
  { w: 913, h: 778, component: 'piggy', role: 'heel', label: 'Heelbone' },
  { w: 869, h: 781, component: 'piggy', role: 'ankle', label: 'Ankle' },
  { w: 888, h: 780, component: 'piggy', role: 'footbone', label: 'Footbone' },
  { w: 473, h: 508, component: 'piggy', role: 'cuboid', label: 'Cuboid' },
  { w: 596, h: 1148, component: 'piggy', role: 'market.meta', label: 'Market Metatarsal' },
];

export function computeAssetFingerprint(asset: ExtractedAsset): AssetFingerprint {
  const bytes = dataUrlToBytes(asset.src);
  const exactHash = bytes ? fnv1aHex(bytes) : `${asset.width}x${asset.height}:${asset.byteSize}`;
  return {
    assetId: asset.id,
    exactHash,
    mirrorSignature: `${asset.width}x${asset.height}`,
    width: asset.width,
    height: asset.height,
    aspect: asset.height > 0 ? Math.round((asset.width / asset.height) * 1000) / 1000 : 1,
  };
}

/**
 * Browser-safe visual perceptual + horizontal-mirror pixel hash via Canvas 8x8 downsampling.
 * Detects identical or horizontally flipped twin sprites even when re-encoded with different PNG compression.
 */
export async function computeVisualMirrorHash(
  src: string
): Promise<{ dHash: string; mirrorDHash: string } | null> {
  if (typeof document === 'undefined') return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = 9;
        const h = 8;
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        let bits = '';
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w - 1; x++) {
            const i1 = (y * w + x) * 4;
            const i2 = (y * w + x + 1) * 4;
            const l1 = data[i1] * 0.3 + data[i1 + 1] * 0.59 + data[i1 + 2] * 0.11 + data[i1 + 3] * 0.5;
            const l2 = data[i2] * 0.3 + data[i2 + 1] * 0.59 + data[i2 + 2] * 0.11 + data[i2 + 3] * 0.5;
            bits += l1 > l2 ? '1' : '0';
          }
        }

        // Mirrored draw
        ctx.clearRect(0, 0, w, h);
        ctx.save();
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(img, 0, 0, w, h);
        ctx.restore();
        const mData = ctx.getImageData(0, 0, w, h).data;
        let mBits = '';
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w - 1; x++) {
            const i1 = (y * w + x) * 4;
            const i2 = (y * w + x + 1) * 4;
            const l1 = mData[i1] * 0.3 + mData[i1 + 1] * 0.59 + mData[i1 + 2] * 0.11 + mData[i1 + 3] * 0.5;
            const l2 = mData[i2] * 0.3 + mData[i2 + 1] * 0.59 + mData[i2 + 2] * 0.11 + mData[i2 + 3] * 0.5;
            mBits += l1 > l2 ? '1' : '0';
          }
        }
        resolve({ dHash: bits, mirrorDHash: mBits });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export function hammingDistance(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let dist = 0;
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) dist++;
  }
  return dist;
}

/**
 * Detects identical parts, mirrored left/right twins, and canonical Bitruvian/Gotz/Yorick/Piggy
 * roles across assets & tracks even when layer names or hierarchies are inconsistent.
 */
export function detectIdenticalAndCanonicalParts(
  assets: ExtractedAsset[],
  tracks: DeducedTrackRule[]
): {
  matches: IdenticalPartMatch[];
  enrichedTracks: DeducedTrackRule[];
} {
  const fps = assets.map((a) => ({ asset: a, fp: computeAssetFingerprint(a) }));
  const matches: IdenticalPartMatch[] = [];
  const assetPrior = new Map<
    string,
    { component: ComponentModelKey; role: string; label: string }
  >();

  // 1. Canonical size matching (catches "Inserted Image" / "Layer 12" etc.)
  for (const { asset, fp } of fps) {
    const prior = CANONICAL_SIZE_PRIORS.find(
      (p) => Math.abs(p.w - fp.width) <= 2 && Math.abs(p.h - fp.height) <= 2
    );
    if (prior) {
      assetPrior.set(asset.id, prior);
      matches.push({
        sourceAssetId: asset.id,
        sourceName: asset.name,
        matchedAssetId: `canonical:${prior.component}:${prior.role}`,
        matchedName: prior.label,
        matchKind: 'canonical-prior',
        confidence: 0.96,
        suggestedComponent: prior.component,
        suggestedRole: prior.role,
      });
    }
  }

  // 2. Pairwise exact byte & dimension twin matching across all extracted assets
  for (let i = 0; i < fps.length; i++) {
    for (let j = i + 1; j < fps.length; j++) {
      const a = fps[i];
      const b = fps[j];
      if (a.fp.exactHash === b.fp.exactHash) {
        matches.push({
          sourceAssetId: a.asset.id,
          sourceName: a.asset.name,
          matchedAssetId: b.asset.id,
          matchedName: b.asset.name,
          matchKind: 'exact-bytes',
          confidence: 1,
        });
      } else if (
        a.fp.width > 16 &&
        Math.abs(a.fp.width - b.fp.width) <= 2 &&
        Math.abs(a.fp.height - b.fp.height) <= 2
      ) {
        matches.push({
          sourceAssetId: a.asset.id,
          sourceName: a.asset.name,
          matchedAssetId: b.asset.id,
          matchedName: b.asset.name,
          matchKind: 'dimension-twin',
          confidence: 0.85,
        });
      }
    }
  }

  // 3. Enrich tracks whose names are generic ("Inserted Image", "Layer N") using asset priors or twin partners
  const enrichedTracks = tracks.map((tr) => {
    const prior = tr.matchedAssetId ? assetPrior.get(tr.matchedAssetId) : undefined;
    const isGeneric = /^(inserted image|layer\s*\d*|group\s*\d*|untitled|track\s*\d*)$/i.test(
      tr.rawName.trim()
    );
    if (prior && (isGeneric || tr.component === 'bytruvyus')) {
      const side =
        tr.layerBox.x + tr.layerBox.w * 0.5 >= 1250 ? 'L' : 'R';
      const roleWithSide =
        prior.component === 'bytruvyus' &&
        ['rib', 'brace', 'swivel', 'acromion', 'humerus', 'forearm', 'hand', 'femur', 'shin', 'foot'].includes(
          prior.role
        )
          ? `${prior.role}${side}`
          : prior.role;
      return {
        ...tr,
        component: prior.component,
        suggestedNodeId: isGeneric ? roleWithSide : tr.suggestedNodeId,
        inferenceReason: `${tr.inferenceReason} · Dimension-matched to ${prior.label}`,
      };
    }

    // If track has no matched asset yet, try matching by layerBox dimensions against assets
    if (!tr.matchedAssetId && tr.layerBox.w > 0 && tr.layerBox.h > 0) {
      const byDim = fps.find(
        (f) =>
          Math.abs(f.fp.width - tr.layerBox.w) <= 3 &&
          Math.abs(f.fp.height - tr.layerBox.h) <= 3
      );
      if (byDim) {
        return {
          ...tr,
          matchedAssetId: byDim.asset.id,
          inferenceReason: `${tr.inferenceReason} · Paired asset "${byDim.asset.name}" by bounding dimensions`,
        };
      }
    }
    return tr;
  });

  return { matches, enrichedTracks };
}

/**
 * Browser perceptual dHash + horizontal-mirror twin scan across extracted assets.
 * Detects Left/Right mirrored limb sprites or re-compressed identical layers.
 */
export async function detectVisualMirrorMatches(
  assets: ExtractedAsset[]
): Promise<IdenticalPartMatch[]> {
  if (typeof document === 'undefined' || assets.length < 2) return [];
  const hashes = await Promise.all(
    assets.slice(0, 80).map(async (asset) => ({
      asset,
      hash: await computeVisualMirrorHash(asset.src),
    }))
  );

  const matches: IdenticalPartMatch[] = [];
  for (let i = 0; i < hashes.length; i++) {
    const a = hashes[i];
    if (!a.hash) continue;
    for (let j = i + 1; j < hashes.length; j++) {
      const b = hashes[j];
      if (!b.hash) continue;
      const directDist = hammingDistance(a.hash.dHash, b.hash.dHash);
      const mirrorDist = hammingDistance(a.hash.dHash, b.hash.mirrorDHash);
      if (mirrorDist <= 6 && mirrorDist < directDist) {
        matches.push({
          sourceAssetId: a.asset.id,
          sourceName: a.asset.name,
          matchedAssetId: b.asset.id,
          matchedName: b.asset.name,
          matchKind: 'mirrored-twin',
          confidence: Math.round((1 - mirrorDist / 64) * 100) / 100,
        });
      } else if (directDist <= 4) {
        matches.push({
          sourceAssetId: a.asset.id,
          sourceName: a.asset.name,
          matchedAssetId: b.asset.id,
          matchedName: b.asset.name,
          matchKind: 'exact-bytes',
          confidence: Math.round((1 - directDist / 64) * 100) / 100,
        });
      }
    }
  }
  return matches;
}
