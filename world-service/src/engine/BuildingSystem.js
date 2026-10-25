import crypto from 'crypto';

export const STRUCTURE_CATALOG = Object.freeze({
  wall: {
    type: 'wall',
    name: 'Muro de Madera',
    cost: { wood: 5 },
    hp: 100,
    maxHp: 100,
    radius: 18,
    blocksMovement: true,
    blocksProjectiles: true,
  },
  campfire: {
    type: 'campfire',
    name: 'Fogata',
    cost: { wood: 3, stone: 2 },
    hp: 50,
    maxHp: 50,
    radius: 16,
    healRadius: 90,
    healAmountPerSec: 5,
    blocksMovement: false,
    blocksProjectiles: false,
  },
  turret: {
    type: 'turret',
    name: 'Torreta Defensiva',
    cost: { wood: 10, stone: 5 },
    hp: 80,
    maxHp: 80,
    radius: 18,
    blocksMovement: true,
    blocksProjectiles: true,
    range: 220,
    fireRate: 1.0, // seconds between shots
    damage: 20,
    bulletSpeed: 380,
  },
});

export class BuildingSystem {
  constructor(catalog = STRUCTURE_CATALOG) {
    this.catalog = catalog;
    this.maxPlacementRange = 160; // Max reach distance from player
  }

  /**
   * Validates if player can build structure at desired coordinates.
   * @param {object} player
   * @param {string} type
   * @param {number} x
   * @param {number} y
   * @param {object} world
   * @returns {{ valid: boolean, reason?: string }}
   */
  canBuild(player, type, x, y, world) {
    const spec = this.catalog[type];
    if (!spec) {
      return { valid: false, reason: 'Tipo de estructura inválido' };
    }

    // 1. Check Player Inventory
    for (const [material, requiredAmount] of Object.entries(spec.cost)) {
      const playerAmount = player.inventory?.[material] || 0;
      if (playerAmount < requiredAmount) {
        return {
          valid: false,
          reason: `Recursos insuficientes. Requiere ${requiredAmount} de ${material}`,
        };
      }
    }

    // 2. Check Placement Range
    const distToPlayer = Math.hypot(x - player.x, y - player.y);
    if (distToPlayer > this.maxPlacementRange) {
      return { valid: false, reason: 'Demasiado lejos del jugador' };
    }

    // 3. Check World Boundaries
    const radius = spec.radius;
    if (
      x < radius ||
      x > world.worldWidth - radius ||
      y < radius ||
      y > world.worldHeight - radius
    ) {
      return { valid: false, reason: 'Fuera de los límites del mapa' };
    }

    // 4. Check Collision with Existing Structures
    for (const struct of world.structures.values()) {
      const dist = Math.hypot(x - struct.x, y - struct.y);
      if (dist < radius + (struct.radius || 18)) {
        return { valid: false, reason: 'Superposición con otra estructura' };
      }
    }

    // 5. Check Collision with Resources (trees, rocks)
    for (const res of world.resources.values()) {
      const dist = Math.hypot(x - res.x, y - res.y);
      if (dist < radius + (res.radius || 16)) {
        return { valid: false, reason: 'Superposición con un recurso' };
      }
    }

    return { valid: true };
  }

  /**
   * Deducts inventory cost and returns created structure object.
   * @param {object} player
   * @param {string} type
   * @param {number} x
   * @param {number} y
   * @returns {object|null}
   */
  build(player, type, x, y) {
    const spec = this.catalog[type];
    if (!spec) return null;

    // Deduct cost
    for (const [material, amount] of Object.entries(spec.cost)) {
      player.inventory[material] = (player.inventory[material] || 0) - amount;
    }

    const id = `struct_${crypto.randomUUID().slice(0, 8)}`;
    return {
      id,
      type,
      name: spec.name,
      x: Math.round(x),
      y: Math.round(y),
      hp: spec.hp,
      maxHp: spec.maxHp,
      radius: spec.radius,
      blocksMovement: spec.blocksMovement ?? true,
      blocksProjectiles: spec.blocksProjectiles ?? true,
      healRadius: spec.healRadius || 0,
      healAmountPerSec: spec.healAmountPerSec || 0,
      range: spec.range || 0,
      fireRate: spec.fireRate || 0,
      damage: spec.damage || 0,
      bulletSpeed: spec.bulletSpeed || 0,
      lastShootTime: 0,
      angle: 0,
      targetId: null,
      ownerId: player.id,
      createdAt: Date.now(),
    };
  }

  getCatalog() {
    return this.catalog;
  }
}
