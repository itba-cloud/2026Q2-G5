import crypto from 'crypto';

export class CombatSystem {
  constructor(options = {}) {
    this.projectileSpeed = options.projectileSpeed || 400; // units/sec
    this.projectileRadius = options.projectileRadius || 5;
    this.projectileDamage = options.projectileDamage || 25;
    this.projectileMaxTtl = options.projectileMaxTtl || 2.5; // seconds
    this.shootCooldownMs = options.shootCooldownMs || 250;

    this.projectiles = new Map(); // id -> projectile
    this.lastShootTimes = new Map(); // playerId -> timestamp
  }

  /**
   * Checks if player can shoot based on cooldown.
   * @param {string} playerId
   * @returns {boolean}
   */
  canShoot(playerId) {
    const now = Date.now();
    const last = this.lastShootTimes.get(playerId) || 0;
    return now - last >= this.shootCooldownMs;
  }

  /**
   * Spawns a projectile from shooter in the given angle.
   * @param {string} shooterId
   * @param {number} x
   * @param {number} y
   * @param {number} angle In radians
   * @param {object} [options={}]
   * @returns {object|null}
   */
  createProjectile(shooterId, x, y, angle, options = {}) {
    const cooldown = options.cooldown ?? this.shootCooldownMs;
    const now = Date.now();
    const last = this.lastShootTimes.get(shooterId) || 0;
    if (cooldown > 0 && now - last < cooldown) return null;

    this.lastShootTimes.set(shooterId, now);

    const speed = options.speed || this.projectileSpeed;
    const damage = options.damage ?? this.projectileDamage;
    const radius = options.radius || this.projectileRadius;
    const ttl = options.ttl || this.projectileMaxTtl;
    const spawnOffset = options.spawnOffset ?? 18;
    const shooterOwnerId = options.shooterOwnerId || null;

    const id = `proj_${crypto.randomUUID().slice(0, 8)}`;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;

    // Offset spawn position slightly in front of shooter
    const projX = x + Math.cos(angle) * spawnOffset;
    const projY = y + Math.sin(angle) * spawnOffset;

    const projectile = {
      id,
      shooterId,
      shooterOwnerId,
      x: projX,
      y: projY,
      vx,
      vy,
      angle,
      radius,
      damage,
      ttl,
    };

    this.projectiles.set(id, projectile);
    return projectile;
  }

  /**
   * Advances all projectiles and evaluates radial collisions using Spatial Hash Grid.
   * @param {number} deltaTime
   * @param {object} world Reference to World instance
   * @param {Function} [onHitCallback] Callback for hit events
   */
  tick(deltaTime, world, onHitCallback = null) {
    const toRemove = [];

    for (const [id, proj] of this.projectiles.entries()) {
      // 1. Move projectile
      proj.x += proj.vx * deltaTime;
      proj.y += proj.vy * deltaTime;
      proj.ttl -= deltaTime;

      // 2. Check TTL or World Bounds
      if (
        proj.ttl <= 0 ||
        proj.x < 0 ||
        proj.x > world.worldWidth ||
        proj.y < 0 ||
        proj.y > world.worldHeight
      ) {
        toRemove.push(id);
        continue;
      }

      let collided = false;

      // 3. Collision with Obstacles: Structures & Resources (Spatial Hash Grid O(1) local query)
      const queryRadius = proj.radius + 25;
      const colliders = world.collisionSystem
        ? world.collisionSystem.getNearbyColliders(proj.x, proj.y, queryRadius, world, proj.shooterId)
        : null;

      const candidates = colliders
        ? colliders.filter((c) => c.blocksProjectiles && c.id !== proj.shooterId)
        : [
            ...Array.from(world.structures?.values() || []),
            ...Array.from(world.resources?.values() || []),
          ];

      for (const c of candidates) {
        if (c.id === proj.shooterId) continue;

        // 3a. Collision with Structure (Deals damage)
        const struct = world.structures?.get(c.id);
        if (struct && struct.blocksProjectiles) {
          const dist = Math.hypot(proj.x - struct.x, proj.y - struct.y);
          if (dist < proj.radius + (struct.radius || 18)) {
            collided = true;
            struct.hp -= proj.damage;

            if (typeof onHitCallback === 'function') {
              onHitCallback({
                type: 'STRUCTURE',
                targetId: struct.id,
                shooterId: proj.shooterId,
                shooterOwnerId: proj.shooterOwnerId,
                damage: proj.damage,
                remainingHp: Math.max(0, struct.hp),
                x: proj.x,
                y: proj.y,
              });
            }

            if (struct.hp <= 0) {
              world.removeStructure(struct.id);
            }
            break;
          }
        }

        // 3b. Collision with Solid Resource (Blocks projectile, 0 damage)
        const res = world.resources?.get(c.id);
        if (res && res.blocksProjectiles) {
          const resRadius = res.colliderRadius || (res.radius ? res.radius * 0.75 : 14);
          const dist = Math.hypot(proj.x - res.x, proj.y - res.y);
          if (dist < proj.radius + resRadius) {
            collided = true;

            if (typeof onHitCallback === 'function') {
              onHitCallback({
                type: 'RESOURCE',
                targetId: res.id,
                resourceType: res.type,
                shooterId: proj.shooterId,
                shooterOwnerId: proj.shooterOwnerId,
                damage: 0,
                x: proj.x,
                y: proj.y,
              });
            }
            break;
          }
        }
      }

      if (collided) {
        toRemove.push(id);
        continue;
      }

      // 4. Collision with Players (excluding the shooter and shooter owner if friendly)
      for (const player of world.players.values()) {
        if (player.id === proj.shooterId) continue;
        if (proj.shooterOwnerId && player.id === proj.shooterOwnerId) continue;
        if (player.hp <= 0 || player.isDead) continue; // Skip dead players

        const dist = Math.hypot(proj.x - player.x, proj.y - player.y);
        if (dist < proj.radius + player.radius) {
          collided = true;
          player.hp = Math.max(0, player.hp - proj.damage);

          const killerId = proj.shooterOwnerId || proj.shooterId;

          if (typeof onHitCallback === 'function') {
            onHitCallback({
              type: 'PLAYER',
              targetId: player.id,
              shooterId: proj.shooterId,
              shooterOwnerId: proj.shooterOwnerId,
              damage: proj.damage,
              remainingHp: player.hp,
              x: player.x,
              y: player.y,
            });
          }

          if (player.hp <= 0) {
            world.killPlayer(player.id, killerId);
          }
          break;
        }
      }

      if (collided) {
        toRemove.push(id);
      }
    }

    // Clean up expired or collided projectiles
    for (const id of toRemove) {
      this.projectiles.delete(id);
    }
  }

  /**
   * Returns list of active projectiles for network sync.
   * @returns {Array<object>}
   */
  getProjectilesList() {
    const list = [];
    for (const p of this.projectiles.values()) {
      list.push({
        id: p.id,
        shooterId: p.shooterId,
        shooterOwnerId: p.shooterOwnerId,
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        vx: Math.round(p.vx),
        vy: Math.round(p.vy),
      });
    }
    return list;
  }

  clear() {
    this.projectiles.clear();
    this.lastShootTimes.clear();
  }
}
