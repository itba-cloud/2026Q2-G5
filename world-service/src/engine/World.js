import { MapGenerator } from './MapGenerator.js';
import { CombatSystem } from './CombatSystem.js';
import { BuildingSystem, STRUCTURE_CATALOG } from './BuildingSystem.js';
import { CollisionSystem } from './CollisionSystem.js';
import { ResourceRegenWheel } from './ResourceRegenWheel.js';

export class World {
  /**
   * @param {object} options
   * @param {string} options.worldId
   * @param {string} options.name Display name, shown on /health and stamped on chat
   * @param {number} options.seed
   * @param {number} options.worldWidth
   * @param {number} options.worldHeight
   * @param {number} options.playerSpeed
   * @param {number} options.playerRadius
   * @param {Function} [options.onEvent] Event broadcast callback
   */
  constructor({
    worldId = 'world-01',
    name = 'Mundo',
    seed = 48291,
    worldWidth = 1000,
    worldHeight = 1000,
    playerSpeed = 150,
    playerRadius = 16,
    onEvent = null,
  }) {
    this.worldId = worldId;
    this.name = name;
    this.seed = seed;
    this.worldWidth = worldWidth;
    this.worldHeight = worldHeight;
    this.playerSpeed = playerSpeed;
    this.playerRadius = playerRadius;
    this.onEvent = onEvent;

    this.tickCount = 0;
    this.players = new Map(); // Active connected players: id -> player
    this.persistedPlayersData = new Map(); // Persisted state: name/id -> playerData
    this.harvestedResources = new Set();
    this.structures = new Map(); // id -> structure

    this.mapGenerator = new MapGenerator(this.seed, this.worldWidth, this.worldHeight);
    this.resources = this.mapGenerator.generateResources(Array.from(this.harvestedResources));

    this.collisionSystem = new CollisionSystem();
    this.combatSystem = new CombatSystem();
    this.buildingSystem = new BuildingSystem();
    this.regenWheel = new ResourceRegenWheel(64);

    // Initialize Spatial Partitioning Grid
    this.collisionSystem.syncWorld(this);
  }

  _emit(eventType, payload) {
    if (typeof this.onEvent === 'function') {
      this.onEvent(eventType, payload);
    }
  }

  /**
   * Finds a safe spawn position free of solid obstacles.
   * If preferred coordinates are given, searches near them; otherwise picks a random spot across the entire map.
   * @param {number|null} [preferredX]
   * @param {number|null} [preferredY]
   * @param {number} [radius=16]
   * @returns {{ x: number, y: number }}
   */
  getSafeSpawnPosition(preferredX = null, preferredY = null, radius = this.playerRadius) {
    const margin = radius + 60;
    const usableW = Math.max(100, this.worldWidth - margin * 2);
    const usableH = Math.max(100, this.worldHeight - margin * 2);

    if (preferredX !== null && preferredY !== null && !isNaN(preferredX) && !isNaN(preferredY)) {
      return this.collisionSystem.findSafePosition(preferredX, preferredY, radius, this);
    }

    // Try picking random locations across the map
    for (let attempt = 0; attempt < 30; attempt++) {
      const candidateX = Math.round(margin + Math.random() * usableW);
      const candidateY = Math.round(margin + Math.random() * usableH);
      if (!this.collisionSystem.isOverlapping(candidateX, candidateY, radius, this)) {
        return { x: candidateX, y: candidateY };
      }
    }

    // Fallback: pick random seed point and find nearest clear position
    const fallbackX = Math.round(margin + Math.random() * usableW);
    const fallbackY = Math.round(margin + Math.random() * usableH);
    return this.collisionSystem.findSafePosition(fallbackX, fallbackY, radius, this);
  }

  /**
   * Adds or reinstates a player in the world.
   * @param {string} id Unique player ID
   * @param {string} name Display name
   * @returns {object}
   */
  addPlayer(id, name) {
    const playerName = name || `Player_${id.slice(0, 4)}`;
    const savedData = this.persistedPlayersData.get(playerName) || this.persistedPlayersData.get(id);

    const safePos = this.getSafeSpawnPosition(
      savedData?.x ?? null,
      savedData?.y ?? null,
      this.playerRadius
    );

    const player = {
      id,
      name: playerName,
      x: safePos.x,
      y: safePos.y,
      dirX: 0,
      dirY: 0,
      speed: this.playerSpeed,
      hp: savedData?.hp ?? 100,
      maxHp: 100,
      radius: this.playerRadius,
      inventory: savedData?.inventory ?? { wood: 0, stone: 0, food: 0 },
      kills: savedData?.kills ?? 0,
      deaths: savedData?.deaths ?? 0,
      isDead: false,
      respawnAt: 0,
      joinedAt: Date.now(),
      lastActive: Date.now(),
    };

    this.players.set(id, player);
    return player;
  }

  /**
   * Removes an active player and archives their progress.
   * @param {string} id
   * @returns {object|null}
   */
  removePlayer(id) {
    const player = this.players.get(id);
    if (player) {
      this.persistedPlayersData.set(player.name, {
        id: player.id,
        name: player.name,
        x: Math.round(player.x * 100) / 100,
        y: Math.round(player.y * 100) / 100,
        hp: player.hp,
        inventory: { ...player.inventory },
        kills: player.kills || 0,
        deaths: player.deaths || 0,
        lastSeen: new Date().toISOString(),
      });

      this.players.delete(id);
      return player;
    }
    return null;
  }

  /**
   * Updates player movement vector.
   * @param {string} id
   * @param {number} x
   * @param {number} y
   */
  setPlayerMovement(id, x = 0, y = 0) {
    const player = this.players.get(id);
    if (!player || player.isDead) return;

    let dirX = Number(x) || 0;
    let dirY = Number(y) || 0;

    dirX = Math.max(-1, Math.min(1, dirX));
    dirY = Math.max(-1, Math.min(1, dirY));

    const length = Math.hypot(dirX, dirY);
    if (length > 0) {
      dirX = dirX / length;
      dirY = dirY / length;
    } else {
      dirX = 0;
      dirY = 0;
    }

    player.dirX = dirX;
    player.dirY = dirY;
    player.lastActive = Date.now();
  }

  /**
   * Player shoots a projectile towards given angle.
   * @param {string} playerId
   * @param {number} angle In radians
   * @returns {object|null}
   */
  shoot(playerId, angle) {
    const player = this.players.get(playerId);
    if (!player || player.isDead) return null;

    return this.combatSystem.createProjectile(playerId, player.x, player.y, angle);
  }

  /**
   * Player harvests a nearby resource.
   * @param {string} playerId
   * @param {string} [targetResourceId] Optional specific target ID
   * @param {number} [nowOverride=null] Optional timestamp in ms for deterministic testing
   * @returns {{ success: boolean, reason?: string, harvested?: boolean, resource?: object }}
   */
  harvest(playerId, targetResourceId = null, nowOverride = null) {
    const player = this.players.get(playerId);
    if (!player || player.isDead) return { success: false, reason: 'Jugador no disponible' };

    const maxHarvestRange = 60;
    let resource = null;

    if (targetResourceId && this.resources.has(targetResourceId)) {
      const candidate = this.resources.get(targetResourceId);
      if (candidate.hp > 0 && (!candidate.stage || candidate.stage === 'full')) {
        const dist = Math.hypot(player.x - candidate.x, player.y - candidate.y);
        if (dist <= maxHarvestRange + candidate.radius) {
          resource = candidate;
        }
      }
    }

    // Auto-detect closest harvestable resource if none specified or target is invalid
    if (!resource) {
      let minDist = maxHarvestRange;
      for (const res of this.resources.values()) {
        if (res.hp <= 0 || (res.stage && res.stage !== 'full')) continue;
        const dist = Math.hypot(player.x - res.x, player.y - res.y) - res.radius;
        if (dist <= minDist) {
          minDist = dist;
          resource = res;
        }
      }
    }

    if (!resource) {
      if (targetResourceId && this.resources.has(targetResourceId)) {
        const candidate = this.resources.get(targetResourceId);
        if (candidate.stage && candidate.stage !== 'full') {
          return { success: false, reason: 'El recurso aún está creciendo' };
        }
      }
      return { success: false, reason: 'No hay recursos al alcance' };
    }

    // Damage resource
    resource.hp -= 1;

    if (resource.hp <= 0) {
      // Resource depleted
      resource.hp = 0;
      const now = nowOverride !== null ? nowOverride : Date.now();
      const resType = resource.resourceType || 'wood';
      const yieldAmt = resource.yieldAmount || 1;

      player.inventory[resType] = (player.inventory[resType] || 0) + yieldAmt;

      if (resource.type === 'tree') {
        resource.stage = 'stump';
        // Tree retains collision hitbox as a stump! Do not remove from collisionSystem.
        this.regenWheel.schedule(resource.id, 'branches', 30, now);
        this.regenWheel.schedule(resource.id, 'full', 60, now);
      } else if (resource.type === 'bush') {
        resource.stage = 'empty';
        this.regenWheel.schedule(resource.id, 'full', 30, now);
      } else {
        this.resources.delete(resource.id);
        this.harvestedResources.add(resource.id);
        this.collisionSystem.remove(resource.id);
      }

      this._emit('RESOURCE_HARVESTED', {
        resourceId: resource.id,
        harvestedBy: player.id,
        resourceType: resType,
        yieldAmount: yieldAmt,
        stage: resource.stage,
        playerInventory: { ...player.inventory },
      });

      return { success: true, harvested: true, resource };
    } else {
      this._emit('RESOURCE_DAMAGED', {
        resourceId: resource.id,
        hp: resource.hp,
        maxHp: resource.maxHp,
        harvestedBy: player.id,
      });

      return { success: true, harvested: false, hp: resource.hp };
    }
  }

  /**
   * Consumes food item to recover health (+20 HP).
   * @param {string} playerId
   * @returns {{ success: boolean, reason?: string }}
   */
  consumeFood(playerId) {
    const player = this.players.get(playerId);
    if (!player || player.isDead) return { success: false, reason: 'Jugador no disponible' };

    if (!player.inventory.food || player.inventory.food <= 0) {
      return { success: false, reason: 'No tienes comida en el inventario' };
    }

    if (player.hp >= player.maxHp) {
      return { success: false, reason: 'Tu salud ya está al máximo' };
    }

    player.inventory.food -= 1;
    player.hp = Math.min(player.maxHp, player.hp + 20);

    return {
      success: true,
      hp: player.hp,
      foodRemaining: player.inventory.food,
    };
  }

  /**
   * Builds a structure at the specified coordinates.
   * @param {string} playerId
   * @param {string} type 'wall' | 'campfire' | 'turret'
   * @param {number} x
   * @param {number} y
   * @returns {{ success: boolean, reason?: string, structure?: object }}
   */
  buildStructure(playerId, type, x, y) {
    const player = this.players.get(playerId);
    if (!player || player.isDead) return { success: false, reason: 'Jugador no disponible' };

    const validation = this.buildingSystem.canBuild(player, type, x, y, this);
    if (!validation.valid) {
      return { success: false, reason: validation.reason };
    }

    const structure = this.buildingSystem.build(player, type, x, y);
    if (!structure) {
      return { success: false, reason: 'Error al construir estructura' };
    }

    this.structures.set(structure.id, structure);

    // Register into Spatial Hash Grid if it blocks movement or projectiles
    if (structure.blocksMovement || structure.blocksProjectiles) {
      this.collisionSystem.insert({
        id: structure.id,
        type: structure.type,
        x: structure.x,
        y: structure.y,
        radius: structure.radius,
        blocksMovement: structure.blocksMovement ?? true,
        blocksProjectiles: structure.blocksProjectiles ?? true,
      });

      // Automatically push out any player overlapping with the newly built structure
      if (structure.blocksMovement) {
        for (const p of this.players.values()) {
          if (p.isDead) continue;
          const dep = this.collisionSystem.resolvePenetration(p.x, p.y, p.radius, this, 4, p.id);
          p.x = dep.x;
          p.y = dep.y;
        }
      }
    }

    this._emit('STRUCTURE_BUILT', {
      structure,
      playerInventory: { ...player.inventory },
    });

    return { success: true, structure };
  }

  /**
   * Removes a structure from the world.
   * @param {string} structureId
   */
  removeStructure(structureId) {
    if (this.structures.has(structureId)) {
      this.structures.delete(structureId);
      this.collisionSystem.remove(structureId);
      this._emit('STRUCTURE_DESTROYED', { structureId });
    }
  }

  /**
   * Handles player death, updates kills/deaths stats, and sets respawn countdown.
   * @param {string} playerId
   * @param {string} killerId
   */
  killPlayer(playerId, killerId) {
    const player = this.players.get(playerId);
    if (!player) return;

    player.isDead = true;
    player.hp = 0;
    player.dirX = 0;
    player.dirY = 0;
    player.deaths = (player.deaths || 0) + 1;
    player.respawnAt = Date.now() + 3000; // 3 seconds respawn timer

    let killer = this.players.get(killerId);
    let killerName = 'un proyectil';

    if (killer) {
      killerName = killer.name;
      if (killer.id !== playerId) {
        killer.kills = (killer.kills || 0) + 1;
      }
    } else if (typeof killerId === 'string' && killerId.startsWith('struct_')) {
      const killerStruct = this.structures.get(killerId);
      if (killerStruct) {
        killerName = killerStruct.name || 'Torreta Defensiva';
        if (killerStruct.ownerId) {
          const ownerPlayer = this.players.get(killerStruct.ownerId);
          if (ownerPlayer && ownerPlayer.id !== playerId) {
            ownerPlayer.kills = (ownerPlayer.kills || 0) + 1;
            killer = ownerPlayer;
            killerName = `${ownerPlayer.name} (${killerStruct.name || 'Torreta'})`;
          }
        }
      } else {
        killerName = 'Torreta Defensiva';
      }
    }

    this._emit('PLAYER_DIED', {
      playerId,
      playerName: player.name,
      killerId,
      killerName,
      playerDeaths: player.deaths,
      killerKills: killer ? killer.kills : 0,
      respawnDelay: 3,
    });
  }

  /**
   * Respawns a player back into the game at a safe random map position.
   * @param {object} player
   */
  respawnPlayer(player) {
    player.isDead = false;
    player.hp = player.maxHp;

    const safePos = this.getSafeSpawnPosition(null, null, player.radius);
    player.x = safePos.x;
    player.y = safePos.y;
    player.dirX = 0;
    player.dirY = 0;
    player.respawnAt = 0;

    this._emit('PLAYER_RESPAWNED', {
      playerId: player.id,
      x: player.x,
      y: player.y,
      hp: player.hp,
      kills: player.kills || 0,
      deaths: player.deaths || 0,
    });
  }

  /**
   * Evaluates defensive turrets: searches for closest enemy, tracks target angle, and shoots projectiles.
   * @param {number} deltaTime
   */
  processTurrets(deltaTime) {
    const now = Date.now();

    for (const struct of this.structures.values()) {
      if (struct.type !== 'turret' || struct.hp <= 0) continue;

      const range = struct.range || 220;
      let closestTarget = null;
      let minDistance = range;

      // Find closest enemy player within detection range
      for (const player of this.players.values()) {
        if (player.isDead || player.hp <= 0) continue;
        if (struct.ownerId && player.id === struct.ownerId) continue; // Do not target owner

        const dist = Math.hypot(player.x - struct.x, player.y - struct.y);
        if (dist <= minDistance) {
          minDistance = dist;
          closestTarget = player;
        }
      }

      if (closestTarget) {
        const targetAngle = Math.atan2(closestTarget.y - struct.y, closestTarget.x - struct.x);
        struct.angle = targetAngle;
        struct.targetId = closestTarget.id;

        const shootInterval = (struct.fireRate || 1.0) * 1000;
        if (now - (struct.lastShootTime || 0) >= shootInterval) {
          struct.lastShootTime = now;

          const proj = this.combatSystem.createProjectile(
            struct.id,
            struct.x,
            struct.y,
            targetAngle,
            {
              speed: struct.bulletSpeed || 380,
              damage: struct.damage || 20,
              shooterOwnerId: struct.ownerId,
              spawnOffset: (struct.radius || 18) + 6,
              cooldown: 0, // Cooldown handled by struct.lastShootTime
            }
          );

          if (proj) {
            this._emit('TURRET_SHOT', {
              turretId: struct.id,
              targetId: closestTarget.id,
              angle: targetAngle,
              x: struct.x,
              y: struct.y,
            });
          }
        }
      } else {
        struct.targetId = null;
      }
    }
  }

  /**
   * Advances simulation by deltaTime (in seconds).
   * @param {number} deltaTime
   * @param {number} [nowOverride=null] Optional timestamp in ms for deterministic testing
   */
  tick(deltaTime, nowOverride = null) {
    this.tickCount++;
    const now = nowOverride !== null ? nowOverride : Date.now();

    // 1. Process Players (Movement & Respawns)
    for (const player of this.players.values()) {
      if (player.isDead) {
        if (now >= player.respawnAt) {
          this.respawnPlayer(player);
        }
        continue;
      }

      if (player.dirX !== 0 || player.dirY !== 0) {
        const resolved = this.collisionSystem.resolveMovement(
          player.x,
          player.y,
          player.dirX,
          player.dirY,
          player.speed,
          deltaTime,
          player.radius,
          this,
          player.id
        );
        player.x = resolved.x;
        player.y = resolved.y;
      } else {
        // Idle player: push out if overlapping any collider or obstacle
        const depenetrated = this.collisionSystem.resolvePenetration(
          player.x,
          player.y,
          player.radius,
          this,
          4,
          player.id
        );
        player.x = depenetrated.x;
        player.y = depenetrated.y;
      }
    }

    // 2. Process Campfire Passive Healing
    for (const struct of this.structures.values()) {
      if (struct.type === 'campfire' && struct.healRadius > 0) {
        for (const player of this.players.values()) {
          if (player.isDead || player.hp >= player.maxHp) continue;

          const dist = Math.hypot(player.x - struct.x, player.y - struct.y);
          if (dist <= struct.healRadius) {
            player.hp = Math.min(
              player.maxHp,
              player.hp + (struct.healAmountPerSec || 5) * deltaTime
            );
          }
        }
      }
    }

    // 3. Process Turret Defenses (Shooting & Aiming)
    this.processTurrets(deltaTime);

    // 4. Process Combat & Projectiles
    this.combatSystem.tick(deltaTime, this, (hitEvent) => {
      this._emit('PLAYER_HIT', hitEvent);
    });

    // 5. Process Resource Regeneration (Timing Wheel)
    const regens = this.regenWheel.tick(now);
    for (let i = 0; i < regens.length; i++) {
      const item = regens[i];
      const res = this.resources.get(item.resourceId);
      if (res) {
        res.stage = item.targetStage;
        if (item.targetStage === 'full') {
          res.hp = res.maxHp;
        }
        this._emit('RESOURCE_REGENERATED', {
          resourceId: res.id,
          stage: res.stage,
          hp: res.hp,
          maxHp: res.maxHp,
        });
      }
    }
  }

  /**
   * Returns snapshot for STATE_SYNC broadcast.
   * @returns {object}
   */
  getSyncState() {
    const playersList = [];
    for (const p of this.players.values()) {
      playersList.push({
        id: p.id,
        name: p.name,
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        dirX: Math.round(p.dirX * 100) / 100,
        dirY: Math.round(p.dirY * 100) / 100,
        hp: Math.round(p.hp * 10) / 10,
        maxHp: p.maxHp,
        kills: p.kills || 0,
        deaths: p.deaths || 0,
        isDead: p.isDead,
        inventory: p.inventory,
      });
    }

    const structuresList = [];
    for (const s of this.structures.values()) {
      structuresList.push({
        id: s.id,
        type: s.type,
        x: s.x,
        y: s.y,
        radius: s.radius,
        blocksMovement: s.blocksMovement,
        blocksProjectiles: s.blocksProjectiles,
        hp: Math.round(s.hp),
        maxHp: s.maxHp,
        angle: s.angle !== undefined ? Math.round(s.angle * 100) / 100 : undefined,
        targetId: s.targetId || null,
        ownerId: s.ownerId,
      });
    }

    return {
      tick: this.tickCount,
      timestamp: Date.now(),
      players: playersList,
      projectiles: this.combatSystem.getProjectilesList(),
      structures: structuresList,
    };
  }

  /**
   * Returns full state representation for INIT packet.
   * @param {string} playerId
   * @returns {object}
   */
  getInitData(playerId) {
    const player = this.players.get(playerId);
    const resourcesList = Array.from(this.resources.values());
    const structuresList = Array.from(this.structures.values());
    const playersList = Array.from(this.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      hp: p.hp,
      maxHp: p.maxHp,
      kills: p.kills || 0,
      deaths: p.deaths || 0,
      isDead: p.isDead,
    }));

    return {
      worldId: this.worldId,
      seed: this.seed,
      worldWidth: this.worldWidth,
      worldHeight: this.worldHeight,
      playerId,
      player: player ? {
        id: player.id,
        name: player.name,
        x: player.x,
        y: player.y,
        hp: player.hp,
        maxHp: player.maxHp,
        kills: player.kills || 0,
        deaths: player.deaths || 0,
        inventory: player.inventory,
      } : null,
      players: playersList,
      resources: resourcesList,
      structures: structuresList,
      buildingCatalog: STRUCTURE_CATALOG,
    };
  }

  /**
   * Creates a serializable snapshot for persistence.
   * @returns {object}
   */
  getSnapshot() {
    const playersData = {};
    for (const [key, data] of this.persistedPlayersData.entries()) {
      playersData[key] = {
        name: data.name,
        x: data.x,
        y: data.y,
        hp: data.hp,
        kills: data.kills || 0,
        deaths: data.deaths || 0,
        inventory: data.inventory,
      };
    }
    for (const p of this.players.values()) {
      playersData[p.name] = {
        name: p.name,
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        hp: p.hp,
        kills: p.kills || 0,
        deaths: p.deaths || 0,
        inventory: p.inventory,
      };
    }

    return {
      world_id: this.worldId,
      seed: this.seed,
      harvested_resources: Array.from(this.harvestedResources),
      structures: Array.from(this.structures.values()),
      players_data: playersData,
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Hydrates world state from a persisted snapshot.
   * @param {object} snapshot
   */
  hydrateFromSnapshot(snapshot) {
    if (!snapshot) return;

    this.regenWheel.clear();

    if (snapshot.players_data && typeof snapshot.players_data === 'object') {
      for (const [key, p] of Object.entries(snapshot.players_data)) {
        this.persistedPlayersData.set(key, { ...p });
      }
    }

    if (Array.isArray(snapshot.harvested_resources)) {
      this.harvestedResources = new Set(snapshot.harvested_resources);
      this.resources = this.mapGenerator.generateResources(Array.from(this.harvestedResources));
    }

    if (Array.isArray(snapshot.structures)) {
      this.structures = new Map(
        snapshot.structures.map((s) => {
          const spec = STRUCTURE_CATALOG[s.type];
          return [
            s.id,
            {
              ...s,
              blocksMovement: s.blocksMovement ?? spec?.blocksMovement ?? true,
              blocksProjectiles: s.blocksProjectiles ?? spec?.blocksProjectiles ?? true,
            },
          ];
        })
      );
    }

    // Resynchronize spatial partitioning grid with loaded snapshot
    this.collisionSystem.syncWorld(this);
  }

  getPlayerCount() {
    return this.players.size;
  }
}
