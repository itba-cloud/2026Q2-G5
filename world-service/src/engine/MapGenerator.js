/**
 * MapGenerator: Generates deterministic resources based on mathematical seed.
 * Uses Mulberry32 pseudo-random number generator algorithm.
 */

/**
 * Creates a deterministic 32-bit PRNG from an integer seed.
 * @param {number} seed
 * @returns {() => number} Returns float in range [0, 1)
 */
function createMulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MapGenerator {
  /**
   * @param {number} seed
   * @param {number} width
   * @param {number} height
   */
  constructor(seed = 48291, width = 1000, height = 1000) {
    this.seed = seed;
    this.width = width;
    this.height = height;
  }

  /**
   * Generates deterministic base map resources.
   * @param {string[]} [harvestedIds=[]] Optional list of resource IDs that have been harvested
   * @returns {Map<string, object>}
   */
  generateResources(harvestedIds = []) {
    const prng = createMulberry32(this.seed);
    const resources = new Map();
    const harvestedSet = new Set(harvestedIds);

    const margin = 40;
    const usableWidth = this.width - margin * 2;
    const usableHeight = this.height - margin * 2;

    // Number of resources proportional to world area
    const treeCount = Math.floor((this.width * this.height) / 25000); // ~40 trees in 1000x1000
    const rockCount = Math.floor((this.width * this.height) / 50000); // ~20 rocks in 1000x1000
    const bushCount = Math.floor((this.width * this.height) / 60000); // ~16 bushes in 1000x1000

    // 1. Generate Trees (Solid trunk)
    for (let i = 0; i < treeCount; i++) {
      const id = `tree_${i + 1}`;
      if (harvestedSet.has(id)) continue;
      const x = Math.round(margin + prng() * usableWidth);
      const y = Math.round(margin + prng() * usableHeight);
      resources.set(id, {
        id,
        type: 'tree',
        stage: 'full',
        x,
        y,
        hp: 3,
        maxHp: 3,
        resourceType: 'wood',
        yieldAmount: 3,
        radius: 18,
        colliderRadius: 12,
        blocksMovement: true,
        blocksProjectiles: true,
      });
    }

    // 2. Generate Rocks (Solid boulder)
    for (let i = 0; i < rockCount; i++) {
      const id = `rock_${i + 1}`;
      if (harvestedSet.has(id)) continue;
      const x = Math.round(margin + prng() * usableWidth);
      const y = Math.round(margin + prng() * usableHeight);
      resources.set(id, {
        id,
        type: 'rock',
        stage: 'full',
        x,
        y,
        hp: 4,
        maxHp: 4,
        resourceType: 'stone',
        yieldAmount: 2,
        radius: 15,
        colliderRadius: 15,
        blocksMovement: true,
        blocksProjectiles: true,
      });
    }

    // 3. Generate Bushes (Soft foliage, walkable)
    for (let i = 0; i < bushCount; i++) {
      const id = `bush_${i + 1}`;
      if (harvestedSet.has(id)) continue;
      const x = Math.round(margin + prng() * usableWidth);
      const y = Math.round(margin + prng() * usableHeight);
      resources.set(id, {
        id,
        type: 'bush',
        stage: 'full',
        x,
        y,
        hp: 1,
        maxHp: 1,
        resourceType: 'food',
        yieldAmount: 1,
        radius: 12,
        colliderRadius: 0,
        blocksMovement: false,
        blocksProjectiles: false,
      });
    }

    return resources;
  }
}
