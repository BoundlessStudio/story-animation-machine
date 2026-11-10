// Just enough OpenEXR to measure a depth map: single-part scanline files, one HALF or FLOAT
// channel, ZIP / ZIPS / uncompressed. That is what Atlas returns for depth.
import { inflateSync } from 'node:zlib';

function halfToFloat(h) {
  const e = (h >> 10) & 0x1f, m = h & 0x3ff, sign = h & 0x8000 ? -1 : 1;
  if (e === 0) return sign * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? NaN : sign * Infinity;
  return sign * 2 ** (e - 15) * (1 + m / 1024);
}

/** @returns {{ width: number, height: number, near: number, middle: number, far: number } | null} */
export function depthStats(buffer) {
  try {
    if (buffer.readUInt32LE(0) !== 20000630) return null;
    let at = 8, compression = 0, pixelType = 1, width = 0, height = 0;
    while (buffer[at] !== 0) {
      const nameEnd = buffer.indexOf(0, at), name = buffer.toString('latin1', at, nameEnd);
      const typeEnd = buffer.indexOf(0, nameEnd + 1), size = buffer.readInt32LE(typeEnd + 1), value = typeEnd + 5;
      if (name === 'compression') compression = buffer[value];
      if (name === 'channels') {
        const first = buffer.indexOf(0, value);
        pixelType = buffer.readInt32LE(first + 1);
        if (buffer[first + 17] !== 0) return null;           // more than one channel
      }
      if (name === 'dataWindow') { width = buffer.readInt32LE(value + 8) - buffer.readInt32LE(value) + 1; height = buffer.readInt32LE(value + 12) - buffer.readInt32LE(value + 4) + 1; }
      at = value + size;
    }
    at += 1;
    const linesPerBlock = { 0: 1, 2: 1, 3: 16 }[compression];
    if (!linesPerBlock || (pixelType !== 1 && pixelType !== 2)) return null;
    const bytes = pixelType === 1 ? 2 : 4, blocks = Math.ceil(height / linesPerBlock), sample = [];
    for (let block = 0; block < blocks; block += 1) {
      const offset = Number(buffer.readBigUInt64LE(at + block * 8));
      const y = buffer.readInt32LE(offset), size = buffer.readInt32LE(offset + 4);
      const rows = Math.min(linesPerBlock, height - y), raw = rows * width * bytes;
      let data = buffer.subarray(offset + 8, offset + 8 + size);
      if (compression !== 0 && size < raw) {
        const packed = inflateSync(data);
        for (let i = 1; i < packed.length; i += 1) packed[i] = (packed[i - 1] + packed[i] - 128) & 0xff;   // undo the predictor
        data = Buffer.allocUnsafe(packed.length);
        const half = Math.ceil(packed.length / 2);
        for (let i = 0, a = 0, b = half; i < packed.length; i += 2) { data[i] = packed[a++]; if (i + 1 < packed.length) data[i + 1] = packed[b++]; }
      }
      for (let i = 0; i < rows * width; i += 53) {             // a sparse sample is plenty
        const z = bytes === 2 ? halfToFloat(data.readUInt16LE(i * 2)) : data.readFloatLE(i * 4);
        if (Number.isFinite(z) && z > 0) sample.push(z);
      }
    }
    if (sample.length < 50) return null;
    sample.sort((a, b) => a - b);
    const pick = q => sample[Math.min(sample.length - 1, Math.floor(sample.length * q))];
    return { width, height, near: pick(0.05), middle: pick(0.5), far: pick(0.95) };
  } catch {
    return null;
  }
}
