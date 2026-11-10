/* Rendering budgets depend on device capabilities and sustained frame cost,
 * independently of the responsive layout. No library books are removed. */
export const renderProfiles = Object.freeze({
  full: Object.freeze({ pixelRatio: 1.75, shadowSize: 2048, textureSize: 1024, environmentSize: 256, coverSize: 960, coverCache: 9, atlasSize: 2048, frameInterval: 30, dust: true }),
  balanced: Object.freeze({ pixelRatio: 1.25, shadowSize: 1024, textureSize: 512, environmentSize: 128, coverSize: 768, coverCache: 5, atlasSize: 2048, frameInterval: 1000 / 30, dust: true }),
  economy: Object.freeze({ pixelRatio: 1, shadowSize: 0, textureSize: 512, environmentSize: 64, coverSize: 512, coverCache: 5, atlasSize: 1024, frameInterval: 1000 / 24, dust: false }),
});

export function initialRenderQuality({ memory, cores, maxTextureSize = Infinity, coarsePointer = false, floatTargets = true } = {}) {
  if (!floatTargets || (memory > 0 && memory <= 2) || (cores > 0 && cores <= 2) || maxTextureSize <= 2048) return 'economy';
  if (coarsePointer || (memory > 0 && memory <= 4) || (cores > 0 && cores <= 4) || maxTextureSize <= 4096) return 'balanced';
  return 'full';
}

export class RenderBudget {
  constructor(quality) {
    this.quality = quality;
    this.reset();
  }
  get profile() { return renderProfiles[this.quality]; }
  reset() { this.samples = 0; this.slow = 0; this.windowStart = null; }
  // Ignore loading, tab resumes, intentional pauses and shader recompilation.
  // One delayed frame must never change the rendering quality.
  observe(now, frameTime, workTime) {
    if (!Number.isFinite(frameTime) || frameTime <= 0) { this.reset(); return false; }
    if (this.windowStart === null) this.windowStart = now;
    this.samples++;
    if (frameTime > Math.max(55, this.profile.frameInterval * 1.6) || workTime > 24) this.slow++;
    if (now - this.windowStart < 3000 || this.samples < 12) return false;
    const overloaded = this.slow / this.samples > .45;
    this.reset();
    return overloaded && this.lower();
  }
  lower() {
    const next = { full: 'balanced', balanced: 'economy' }[this.quality];
    if (!next) return false;
    this.quality = next;
    this.reset();
    return true;
  }
}

// A reusable broad phase for flock neighbors and collisions. Rebuilding it
// between solver passes catches books that moved across a cell boundary.
export class SpatialGrid {
  constructor(cellSize = 1.5) {
    this.cellSize = cellSize;
    this.cells = new Map();
    this.pool = [];
    this.result = [];
  }
  key(x, y, z) {
    // The room spans fewer than 100 cells on each axis. Packed signed cells
    // avoid thousands of temporary string keys in every animation frame.
    return (x & 1023) | ((y & 1023) << 10) | ((z & 1023) << 20);
  }
  rebuild(members) {
    for (const bucket of this.cells.values()) { bucket.length = 0; this.pool.push(bucket); }
    this.cells.clear();
    const size = this.cellSize;
    members.forEach((member, index) => {
      const p = member.position;
      const key = this.key(Math.floor(p.x / size), Math.floor(p.y / size), Math.floor(p.z / size));
      let bucket = this.cells.get(key);
      if (!bucket) { bucket = this.pool.pop() || []; this.cells.set(key, bucket); }
      bucket.push(index);
    });
  }
  query(position, radius) {
    const result = this.result; result.length = 0;
    const size = this.cellSize;
    const minX = Math.floor((position.x - radius) / size), maxX = Math.floor((position.x + radius) / size);
    const minY = Math.floor((position.y - radius) / size), maxY = Math.floor((position.y + radius) / size);
    const minZ = Math.floor((position.z - radius) / size), maxZ = Math.floor((position.z + radius) / size);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) {
      const bucket = this.cells.get(this.key(x, y, z));
      if (bucket) for (const index of bucket) result.push(index);
    }
    return result;
  }
}
