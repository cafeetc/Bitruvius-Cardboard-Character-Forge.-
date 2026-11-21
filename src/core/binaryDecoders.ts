/**
 * Pure TypeScript binary container decoders (Apple bplist00 + NSKeyedArchiver,
 * XML plist, LZ4 block/frame decompression, and exact PNG/JPEG/WebP signature carving).
 * Designed to run identically in Node.js (server.ts) and browser clients.
 */

export function bytesToHex(bytes: Uint8Array, maxLen = 48): string {
  const slice = bytes.subarray(0, maxLen);
  return Array.from(slice)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

export function findAllOccurrences(
  haystack: Uint8Array,
  needle: Uint8Array,
  maxHits = 4096
): number[] {
  const hits: number[] = [];
  const nLen = needle.length;
  if (nLen === 0 || haystack.length < nLen) return hits;
  const first = needle[0];
  const limit = haystack.length - nLen;

  for (let i = 0; i <= limit; i++) {
    if (haystack[i] !== first) continue;
    let matched = true;
    for (let j = 1; j < nLen; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      hits.push(i);
      if (hits.length >= maxHits) break;
      i += nLen - 1;
    }
  }
  return hits;
}

function readUintBE(bytes: Uint8Array, offset: number, size: number): number {
  let val = 0;
  for (let i = 0; i < size; i++) {
    val = val * 256 + bytes[offset + i];
  }
  return val;
}

function readIntBE(bytes: Uint8Array, offset: number, size: number): number {
  if (size === 1) {
    const v = bytes[offset];
    return v > 127 ? v - 256 : v;
  }
  if (size === 2) {
    const v = (bytes[offset] << 8) | bytes[offset + 1];
    return v > 32767 ? v - 65536 : v;
  }
  if (size === 4) {
    return (
      (bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]
    );
  }
  const unsigned = readUintBE(bytes, offset, size);
  const maxSigned = Math.pow(2, size * 8 - 1);
  return unsigned >= maxSigned ? unsigned - Math.pow(2, size * 8) : unsigned;
}

export interface PlistUid {
  CF$UID: number;
}

function isPlistUid(v: unknown): v is PlistUid {
  return typeof v === 'object' && v !== null && 'CF$UID' in v && typeof (v as PlistUid).CF$UID === 'number';
}

export function parseBinaryPlist(bytes: Uint8Array): unknown {
  if (bytes.length < 40) return null;
  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  if (magic !== 'bplist') return null;

  const trailerOffset = bytes.length - 32;
  const offsetIntSize = bytes[trailerOffset + 6];
  const objectRefSize = bytes[trailerOffset + 7];
  const numObjects = readUintBE(bytes, trailerOffset + 8, 8);
  const topObject = readUintBE(bytes, trailerOffset + 16, 8);
  const offsetTableOffset = readUintBE(bytes, trailerOffset + 24, 8);

  if (
    offsetIntSize < 1 ||
    offsetIntSize > 8 ||
    objectRefSize < 1 ||
    objectRefSize > 8 ||
    numObjects <= 0 ||
    numObjects > 500000 ||
    offsetTableOffset + numObjects * offsetIntSize > trailerOffset
  ) {
    return null;
  }

  const offsets: number[] = new Array(numObjects);
  for (let i = 0; i < numObjects; i++) {
    offsets[i] = readUintBE(bytes, offsetTableOffset + i * offsetIntSize, offsetIntSize);
  }

  const visited = new Map<number, unknown>();

  const readLength = (cursor: number, info: number): { length: number; next: number } => {
    if (info !== 0x0f) return { length: info, next: cursor };
    const marker = bytes[cursor];
    const intType = (marker & 0xf0) >> 4;
    if (intType !== 0x1) return { length: 0, next: cursor + 1 };
    const intByteSize = 1 << (marker & 0x0f);
    return {
      length: readUintBE(bytes, cursor + 1, intByteSize),
      next: cursor + 1 + intByteSize,
    };
  };

  const parseObject = (objIdx: number): unknown => {
    if (objIdx < 0 || objIdx >= numObjects) return null;
    if (visited.has(objIdx)) return visited.get(objIdx);

    const start = offsets[objIdx];
    if (start < 8 || start >= offsetTableOffset) return null;
    const marker = bytes[start];
    const objType = (marker & 0xf0) >> 4;
    const info = marker & 0x0f;

    if (objType === 0x0) {
      if (info === 0x0) return null;
      if (info === 0x8) return false;
      if (info === 0x9) return true;
      return null;
    }

    if (objType === 0x1) {
      const byteLen = 1 << info;
      if (start + 1 + byteLen > bytes.length) return 0;
      const val = byteLen <= 8 ? readIntBE(bytes, start + 1, byteLen) : readUintBE(bytes, start + 1, 8);
      visited.set(objIdx, val);
      return val;
    }

    if (objType === 0x2) {
      const byteLen = 1 << info;
      const view = new DataView(bytes.buffer, bytes.byteOffset + start + 1, byteLen);
      const val = byteLen === 4 ? view.getFloat32(0, false) : byteLen === 8 ? view.getFloat64(0, false) : 0;
      visited.set(objIdx, val);
      return val;
    }

    if (objType === 0x3) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + start + 1, 8);
      const cocoaSec = view.getFloat64(0, false);
      const val = new Date((cocoaSec + 978307200) * 1000).toISOString();
      visited.set(objIdx, val);
      return val;
    }

    if (objType === 0x4) {
      const { length, next } = readLength(start + 1, info);
      const slice = bytes.subarray(next, Math.min(bytes.length, next + length));
      const val = { __bplistDataBytes: slice.length, __previewHex: bytesToHex(slice, 16) };
      visited.set(objIdx, val);
      return val;
    }

    if (objType === 0x5) {
      const { length, next } = readLength(start + 1, info);
      const slice = bytes.subarray(next, Math.min(bytes.length, next + length));
      const val = new TextDecoder('latin1').decode(slice);
      visited.set(objIdx, val);
      return val;
    }

    if (objType === 0x6) {
      const { length, next } = readLength(start + 1, info);
      const byteLen = length * 2;
      const slice = bytes.subarray(next, Math.min(bytes.length, next + byteLen));
      let str = '';
      for (let i = 0; i + 1 < slice.length; i += 2) {
        str += String.fromCharCode((slice[i] << 8) | slice[i + 1]);
      }
      visited.set(objIdx, str);
      return str;
    }

    if (objType === 0x8) {
      const byteLen = info + 1;
      const val: PlistUid = { CF$UID: readUintBE(bytes, start + 1, byteLen) };
      visited.set(objIdx, val);
      return val;
    }

    if (objType === 0xa || objType === 0xc) {
      const { length, next } = readLength(start + 1, info);
      const arr: unknown[] = [];
      visited.set(objIdx, arr);
      for (let i = 0; i < length; i++) {
        const ref = readUintBE(bytes, next + i * objectRefSize, objectRefSize);
        arr.push(parseObject(ref));
      }
      return arr;
    }

    if (objType === 0xd) {
      const { length, next } = readLength(start + 1, info);
      const dict: Record<string, unknown> = {};
      visited.set(objIdx, dict);
      const valsStart = next + length * objectRefSize;
      for (let i = 0; i < length; i++) {
        const keyRef = readUintBE(bytes, next + i * objectRefSize, objectRefSize);
        const valRef = readUintBE(bytes, valsStart + i * objectRefSize, objectRefSize);
        const key = String(parseObject(keyRef) ?? `key_${i}`);
        dict[key] = parseObject(valRef);
      }
      return dict;
    }

    return null;
  };

  return parseObject(topObject);
}

/**
 * Resolves NSKeyedArchiver `$archiver` + `$objects` graphs into plain nested objects.
 */
export function resolveNSKeyedArchiver(root: unknown): unknown {
  if (typeof root !== 'object' || root === null) return root;
  const obj = root as Record<string, unknown>;
  if (!Array.isArray(obj.$objects)) return root;

  const objects = obj.$objects as unknown[];
  const top = (obj.$top as Record<string, unknown> | undefined) ?? { root: { CF$UID: 1 } };
  const resolved = new Map<number, unknown>();

  const resolveVal = (val: unknown, depth: number): unknown => {
    if (depth > 28) return null;
    if (isPlistUid(val)) {
      const idx = val.CF$UID;
      if (idx === 0) return null;
      if (resolved.has(idx)) return resolved.get(idx);
      const raw = objects[idx];
      if (raw === '$null') return null;
      if (typeof raw !== 'object' || raw === null) {
        resolved.set(idx, raw);
        return raw;
      }
      if (Array.isArray(raw)) {
        const arr: unknown[] = [];
        resolved.set(idx, arr);
        raw.forEach((item) => arr.push(resolveVal(item, depth + 1)));
        return arr;
      }
      const rec = raw as Record<string, unknown>;
      // Handle NSArray / NSDictionary archived wrappers
      if (Array.isArray(rec['NS.objects'])) {
        if (Array.isArray(rec['NS.keys'])) {
          const dict: Record<string, unknown> = {};
          resolved.set(idx, dict);
          const ks = rec['NS.keys'] as unknown[];
          const vs = rec['NS.objects'] as unknown[];
          for (let i = 0; i < ks.length; i++) {
            const k = String(resolveVal(ks[i], depth + 1) ?? i);
            dict[k] = resolveVal(vs[i], depth + 1);
          }
          return dict;
        }
        const arr: unknown[] = [];
        resolved.set(idx, arr);
        (rec['NS.objects'] as unknown[]).forEach((item) => arr.push(resolveVal(item, depth + 1)));
        return arr;
      }

      const out: Record<string, unknown> = {};
      resolved.set(idx, out);
      for (const [k, v] of Object.entries(rec)) {
        if (k === '$class') {
          const cls = resolveVal(v, depth + 1) as Record<string, unknown> | null;
          if (cls && typeof cls.$classname === 'string') {
            out.$class = cls.$classname;
          }
          continue;
        }
        out[k] = resolveVal(v, depth + 1);
      }
      return out;
    }
    if (Array.isArray(val)) return val.map((item) => resolveVal(item, depth + 1));
    if (typeof val === 'object' && val !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        out[k] = resolveVal(v, depth + 1);
      }
      return out;
    }
    return val;
  };

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(top)) {
    result[k] = resolveVal(v, 0);
  }
  return result.root ?? result;
}

/**
 * Pure TypeScript LZ4 block decompressor (useful for Procreate .chunk tiles & Valkyrie blocks).
 */
export function decompressLz4Block(
  src: Uint8Array,
  maxOutputBytes = 16 * 1024 * 1024
): Uint8Array {
  const out: number[] = [];
  let ip = 0;
  while (ip < src.length) {
    const token = src[ip++];
    let litLen = token >> 4;
    if (litLen === 15) {
      let add = 255;
      while (ip < src.length && add === 255) {
        add = src[ip++];
        litLen += add;
      }
    }
    for (let i = 0; i < litLen && ip < src.length; i++) {
      out.push(src[ip++]);
      if (out.length >= maxOutputBytes) return new Uint8Array(out);
    }
    if (ip >= src.length) break;

    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (offset === 0 || offset > out.length) break;

    let matchLen = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      let add = 255;
      while (ip < src.length && add === 255) {
        add = src[ip++];
        matchLen += add;
      }
    }
    let ref = out.length - offset;
    for (let i = 0; i < matchLen; i++) {
      out.push(out[ref++]);
      if (out.length >= maxOutputBytes) return new Uint8Array(out);
    }
  }
  return new Uint8Array(out);
}

/**
 * Parses an LZ4 Frame (magic 04 22 4D 18) into decompressed bytes.
 */
export function decompressLz4Frame(src: Uint8Array): Uint8Array | null {
  if (
    src.length < 11 ||
    src[0] !== 0x04 ||
    src[1] !== 0x22 ||
    src[2] !== 0x4d ||
    src[3] !== 0x18
  ) {
    return null;
  }
  const flg = src[4];
  const hasContentSize = (flg & 0x08) !== 0;
  const hasDictId = (flg & 0x01) !== 0;
  const hasHeaderChecksum = true;
  let pos = 6;
  if (hasContentSize) pos += 8;
  if (hasDictId) pos += 4;
  if (hasHeaderChecksum) pos += 1;

  const blocks: Uint8Array[] = [];
  let total = 0;
  while (pos + 4 <= src.length) {
    const rawSize =
      src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24);
    pos += 4;
    if (rawSize === 0) break;
    const uncompressed = (rawSize & 0x80000000) !== 0;
    const blockSize = rawSize & 0x7fffffff;
    if (blockSize <= 0 || pos + blockSize > src.length) break;
    const payload = src.subarray(pos, pos + blockSize);
    pos += blockSize;
    if ((flg & 0x10) !== 0) pos += 4; // block checksum
    const dec = uncompressed ? payload : decompressLz4Block(payload);
    blocks.push(dec);
    total += dec.length;
    if (total > 64 * 1024 * 1024) break;
  }

  if (blocks.length === 0) return null;
  const merged = new Uint8Array(total);
  let cursor = 0;
  for (const b of blocks) {
    merged.set(b, cursor);
    cursor += b.length;
  }
  return merged;
}

export interface CarvedImageStream {
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  offset: number;
  bytes: Uint8Array;
  width: number;
  height: number;
}

export function carveImagesFromBuffer(buf: Uint8Array, maxImages = 128): CarvedImageStream[] {
  const results: CarvedImageStream[] = [];
  const seenOffsets = new Set<number>();

  // 1. PNG carving with exact chunk walking (IHDR .. IEND + 4B CRC)
  const pngSig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const off of findAllOccurrences(buf, pngSig, maxImages)) {
    if (off + 33 > buf.length || seenOffsets.has(off)) continue;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const ihdrType = String.fromCharCode(buf[off + 12], buf[off + 13], buf[off + 14], buf[off + 15]);
    if (ihdrType !== 'IHDR') continue;
    const width = view.getUint32(off + 16, false);
    const height = view.getUint32(off + 20, false);
    if (width < 1 || height < 1 || width > 16384 || height > 16384) continue;

    let cursor = off + 8;
    let endOffset = -1;
    while (cursor + 12 <= buf.length) {
      const chunkLen = view.getUint32(cursor, false);
      const chunkType = String.fromCharCode(
        buf[cursor + 4],
        buf[cursor + 5],
        buf[cursor + 6],
        buf[cursor + 7]
      );
      const nextCursor = cursor + 12 + chunkLen;
      if (chunkLen > 32 * 1024 * 1024 || nextCursor > buf.length) break;
      cursor = nextCursor;
      if (chunkType === 'IEND') {
        endOffset = cursor;
        break;
      }
    }
    if (endOffset > off + 33) {
      seenOffsets.add(off);
      results.push({
        mime: 'image/png',
        offset: off,
        bytes: buf.subarray(off, endOffset),
        width,
        height,
      });
    }
  }

  // 2. JPEG carving (FF D8 FF .. FF D9)
  const jpgSig = new Uint8Array([0xff, 0xd8, 0xff]);
  for (const off of findAllOccurrences(buf, jpgSig, maxImages)) {
    if (seenOffsets.has(off) || results.length >= maxImages) continue;
    let end = -1;
    const limit = Math.min(buf.length - 1, off + 8 * 1024 * 1024);
    for (let i = off + 4; i < limit; i++) {
      if (buf[i] === 0xff && buf[i + 1] === 0xd9) {
        end = i + 2;
        break;
      }
    }
    if (end > off + 128) {
      seenOffsets.add(off);
      results.push({
        mime: 'image/jpeg',
        offset: off,
        bytes: buf.subarray(off, end),
        width: 512,
        height: 512,
      });
    }
  }

  // 3. WebP carving (RIFF....WEBP)
  const riffSig = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
  for (const off of findAllOccurrences(buf, riffSig, maxImages)) {
    if (off + 16 > buf.length || seenOffsets.has(off) || results.length >= maxImages) continue;
    if (
      buf[off + 8] !== 0x57 ||
      buf[off + 9] !== 0x45 ||
      buf[off + 10] !== 0x42 ||
      buf[off + 11] !== 0x50
    ) {
      continue;
    }
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const size = view.getUint32(off + 4, true) + 8;
    if (size > 16 && off + size <= buf.length) {
      seenOffsets.add(off);
      results.push({
        mime: 'image/webp',
        offset: off,
        bytes: buf.subarray(off, off + size),
        width: 512,
        height: 512,
      });
    }
  }

  return results;
}
