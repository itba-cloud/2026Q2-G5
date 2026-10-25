/**
 * PredictionEngine: High-performance Client-Side Prediction system.
 *
 * Responsibilities:
 *  - Instantaneous 0ms input simulation (the local player never waits for the server).
 *  - Local sliding collision + depenetration against world bounds, structures and resources,
 *    mirroring the authoritative CollisionSystem so both simulations settle on the same spot.
 *  - Immediate cosmetic projectile spawning (rate limited exactly like the server).
 *  - Server reconciliation that compares the authoritative snapshot against the position the
 *    client actually held at the moment that snapshot describes (not the current one), and
 *    absorbs the residual into a decaying visual offset so corrections are never seen as jumps.
 */

/** Largest integration slice; longer frames are subdivided to avoid tunnelling. */
const MAX_SUB_STEP = 1 / 60;
/** Hard cap for a single update() call, protects against tab-throttle / breakpoint stalls. */
const MAX_FRAME_DT = 0.25;

export class PredictionEngine {
  /**
   * @param {object} [options]
   * @param {number} [options.playerSpeed=150]
   * @param {number} [options.playerRadius=16]
   * @param {number} [options.projectileSpeed=400]
   * @param {number} [options.projectileRadius=5]
   * @param {number} [options.projectileMaxTtl=2.5]
   * @param {number} [options.shootCooldownMs=250] Must match CombatSystem.shootCooldownMs
   * @param {number} [options.teleportThreshold=80] Above this error we snap instead of blending
   * @param {number} [options.correctionDeadzone=0.25] Errors below this are ignored (rounding noise)
   * @param {number} [options.errorSmoothingTau=0.08] Exponential time constant of the visual offset
   * @param {number} [options.maxCorrectionSpeedFactor=0.3] Catch-up speed cap, as a fraction of playerSpeed
   * @param {number} [options.historyDurationMs=1500] Retention of the predicted position trace
   * @param {number} [options.fallbackRttMs=60] Assumed real RTT until one is measured
   * @param {Function} [options.onLocalImpact]
   */
  constructor(options = {}) {
    this.worldWidth = options.worldWidth || 1000;
    this.worldHeight = options.worldHeight || 1000;
    this.playerSpeed = options.playerSpeed || 150;
    this.playerRadius = options.playerRadius || 16;
    this.projectileSpeed = options.projectileSpeed || 400;
    this.projectileRadius = options.projectileRadius || 5;
    this.projectileMaxTtl = options.projectileMaxTtl || 2.5;
    this.shootCooldownMs = options.shootCooldownMs ?? 250;
    this.teleportThreshold = options.teleportThreshold || 80;
    this.correctionDeadzone = options.correctionDeadzone ?? 0.25;
    this.errorSmoothingTau = options.errorSmoothingTau || 0.08;
    this.maxCorrectionSpeedFactor = options.maxCorrectionSpeedFactor ?? 0.3;
    this.historyDurationMs = options.historyDurationMs || 1500;
    this.fallbackRttMs = options.fallbackRttMs ?? 60;
    this.onLocalImpact = options.onLocalImpact || null;

    // Building catalog fallback
    this.buildingCatalog = {
      wall: { radius: 18, blocksMovement: true, blocksProjectiles: true },
      campfire: { radius: 16, blocksMovement: false, blocksProjectiles: false },
      turret: { radius: 18, blocksMovement: true, blocksProjectiles: true },
    };

    // Local player predicted state (authoritative for gameplay/simulation purposes)
    this.localPlayerId = null;
    this.predictedX = 0;
    this.predictedY = 0;
    this.dirX = 0;
    this.dirY = 0;
    this.lastInputTime = 0;

    // Visual reconciliation offset: the rendered position is (predicted + error).
    // Corrections are injected here so the camera never teleports; it decays to zero in ~200ms.
    this.errorX = 0;
    this.errorY = 0;

    // Trace of predicted positions, used to compare against delayed server snapshots.
    this.positionHistory = []; // [{ t, x, y }] ordered by ascending t
    // Trace of movement inputs, used to measure the real round trip time.
    this.inputHistory = []; // [{ dirX, dirY, sentAt }]
    this.rttEstimateMs = null;
    this._lastServerDirX = null;
    this._lastServerDirY = null;

    // Projectiles
    this.predictedProjectiles = []; // Local predicted projectiles
    this.serverProjectiles = []; // Authoritative projectiles from server
    this.lastShotAt = -Infinity;

    this.isInitialized = false;
  }

  /**
   * Monotonic-ish clock in milliseconds.
   * @returns {number}
   */
  _now() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  /**
   * Initializes world parameters and starting position.
   * @param {object} initData
   */
  init(initData) {
    if (!initData) return;
    this.worldWidth = initData.worldWidth || this.worldWidth;
    this.worldHeight = initData.worldHeight || this.worldHeight;
    this.localPlayerId = initData.playerId || null;

    if (initData.buildingCatalog) {
      this.buildingCatalog = { ...this.buildingCatalog, ...initData.buildingCatalog };
    }

    if (initData.player) {
      this.predictedX = initData.player.x;
      this.predictedY = initData.player.y;
      this.playerSpeed = initData.player.speed || this.playerSpeed;
      this.playerRadius = initData.player.radius || this.playerRadius;
    }

    this.dirX = 0;
    this.dirY = 0;
    this.lastInputTime = 0;
    this.errorX = 0;
    this.errorY = 0;
    this.positionHistory = [];
    this.inputHistory = [];
    this.rttEstimateMs = null;
    this._lastServerDirX = null;
    this._lastServerDirY = null;
    this.predictedProjectiles = [];
    this.serverProjectiles = [];
    this.lastShotAt = -Infinity;
    this.isInitialized = true;
  }

  /**
   * Sets input direction vector.
   * @param {{ x: number, y: number }|number} xOrDir
   * @param {number} [y]
   */
  setMovement(xOrDir, y) {
    let dx = 0;
    let dy = 0;

    if (typeof xOrDir === 'object' && xOrDir !== null) {
      dx = Number(xOrDir.x) || 0;
      dy = Number(xOrDir.y) || 0;
    } else {
      dx = Number(xOrDir) || 0;
      dy = Number(y) || 0;
    }

    dx = Math.max(-1, Math.min(1, dx));
    dy = Math.max(-1, Math.min(1, dy));

    const length = Math.hypot(dx, dy);
    const newDirX = length > 0 ? dx / length : 0;
    const newDirY = length > 0 ? dy / length : 0;

    if (newDirX !== this.dirX || newDirY !== this.dirY) {
      const now = this._now();
      this.lastInputTime = now;
      // Remember when this input left the client, so the RTT can be measured once the
      // server echoes the direction back inside a STATE_SYNC snapshot.
      this.inputHistory.push({ dirX: newDirX, dirY: newDirY, sentAt: now });
      if (this.inputHistory.length > 32) {
        this.inputHistory.shift();
      }
    }

    this.dirX = newDirX;
    this.dirY = newDirY;
  }

  /**
   * True when the local shoot cooldown (mirrored from the server) has elapsed.
   * @returns {boolean}
   */
  canShoot() {
    return this._now() - this.lastShotAt >= this.shootCooldownMs;
  }

  /**
   * Spawns an immediate local predicted projectile upon shooting.
   * Returns null when the server would have rejected the shot, so the client never
   * displays a bullet that does not exist in the authoritative simulation.
   * @param {string} shooterId
   * @param {number} startX
   * @param {number} startY
   * @param {number} angle In radians
   * @param {object} [options={}]
   * @returns {object|null}
   */
  spawnPredictedProjectile(shooterId, startX, startY, angle, options = {}) {
    if (!options.ignoreCooldown && !this.canShoot()) {
      return null;
    }

    const speed = options.speed || this.projectileSpeed;
    const radius = options.radius || this.projectileRadius;
    const ttl = options.ttl || this.projectileMaxTtl;
    const spawnOffset = options.spawnOffset ?? 18;

    const projX = startX + Math.cos(angle) * spawnOffset;
    const projY = startY + Math.sin(angle) * spawnOffset;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;

    const id = `local_proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const projectile = {
      id,
      shooterId: shooterId || this.localPlayerId,
      x: projX,
      y: projY,
      vx,
      vy,
      angle,
      radius,
      ttl,
      maxTtl: ttl,
      createdAt: Date.now(),
      isPredicted: true,
    };

    this.lastShotAt = this._now();
    this.predictedProjectiles.push(projectile);
    return projectile;
  }

  /**
   * Gathers all solid colliders near the queried position.
   * @param {number} x
   * @param {number} y
   * @param {number} queryRadius
   * @param {Map<string, object>|Array<object>} structures
   * @param {Map<string, object>|Array<object>} resources
   * @returns {Array<object>}
   */
  getNearbyColliders(x, y, queryRadius, structures, resources) {
    const colliders = [];

    // Structures: check blocksMovement (default true unless explicitly false)
    if (structures) {
      const structIterable = structures instanceof Map ? structures.values() : structures;
      for (const s of structIterable) {
        const spec = this.buildingCatalog[s.type] || {};
        const blocksMovement = s.blocksMovement !== undefined ? s.blocksMovement : (spec.blocksMovement ?? true);
        if (blocksMovement === false) continue; // Passable (e.g. campfire)
        const radius = s.radius || spec.radius || 18;
        const dist = Math.hypot(x - s.x, y - s.y);
        if (dist <= queryRadius + radius) {
          colliders.push({
            id: s.id,
            type: s.type,
            x: s.x,
            y: s.y,
            radius,
            blocksMovement: true,
            isStructure: true,
          });
        }
      }
    }

    // Resources: trees, rocks (bushes/berries are walkable and do not block movement)
    if (resources) {
      const resIterable = resources instanceof Map ? resources.values() : resources;
      for (const r of resIterable) {
        if (r.hp <= 0 && r.type !== 'tree') continue;
        if (r.blocksMovement === false || r.type === 'bush') continue; // Bushes are walkable
        const radius = r.colliderRadius || (r.radius ? r.radius * 0.75 : 14);
        const dist = Math.hypot(x - r.x, y - r.y);
        if (dist <= queryRadius + radius) {
          colliders.push({
            id: r.id,
            type: r.type,
            x: r.x,
            y: r.y,
            radius,
            blocksMovement: true,
            isResource: true,
          });
        }
      }
    }

    return colliders;
  }

  /**
   * Pushes the entity out of any obstacle it overlaps, along the collision normals.
   * Mirrors CollisionSystem.resolvePenetration so client and server come to rest identically.
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @param {Map|Array} structures
   * @param {Map|Array} resources
   * @param {number} [maxIterations=4]
   * @returns {{ x: number, y: number, pushed: boolean }}
   */
  resolvePenetration(x, y, radius, structures, resources, maxIterations = 4) {
    let posX = x;
    let posY = y;
    let anyPushed = false;

    for (let iter = 0; iter < maxIterations; iter++) {
      let iterPushed = false;
      const colliders = this.getNearbyColliders(posX, posY, radius + 20, structures, resources);

      for (const c of colliders) {
        const minDist = radius + c.radius;
        const dx = posX - c.x;
        const dy = posY - c.y;
        const distSq = dx * dx + dy * dy;

        if (distSq < minDist * minDist) {
          const dist = Math.sqrt(distSq);
          let nx;
          let ny;
          let overlap;

          if (dist > 0.0001) {
            nx = dx / dist;
            ny = dy / dist;
            overlap = minDist - dist;
          } else {
            // Centers coincide exactly: push away from the world center, as the server does
            const toCenterX = posX - this.worldWidth / 2;
            const toCenterY = posY - this.worldHeight / 2;
            const toCenterDist = Math.hypot(toCenterX, toCenterY);
            if (toCenterDist > 0.001) {
              nx = toCenterX / toCenterDist;
              ny = toCenterY / toCenterDist;
            } else {
              nx = 1;
              ny = 0;
            }
            overlap = minDist;
          }

          posX += nx * overlap;
          posY += ny * overlap;
          iterPushed = true;
          anyPushed = true;
        }
      }

      // Constrain to world bounds after each pass
      if (posX < radius) {
        posX = radius;
        iterPushed = true;
      } else if (posX > this.worldWidth - radius) {
        posX = this.worldWidth - radius;
        iterPushed = true;
      }

      if (posY < radius) {
        posY = radius;
        iterPushed = true;
      } else if (posY > this.worldHeight - radius) {
        posY = this.worldHeight - radius;
        iterPushed = true;
      }

      if (!iterPushed) break;
    }

    return { x: posX, y: posY, pushed: anyPushed };
  }

  /**
   * Resolves axis-separated continuous movement with smooth sliding and obstacle deflection.
   * Mirrors CollisionSystem.resolveMovement (X pass, Y pass, then depenetration).
   * @param {number} currentX
   * @param {number} currentY
   * @param {number} dirX
   * @param {number} dirY
   * @param {number} speed
   * @param {number} dt
   * @param {number} radius
   * @param {Map|Array} structures
   * @param {Map|Array} resources
   * @returns {{ x: number, y: number }}
   */
  resolveMovement(currentX, currentY, dirX, dirY, speed, dt, radius, structures, resources) {
    if (dirX === 0 && dirY === 0) {
      const pen = this.resolvePenetration(currentX, currentY, radius, structures, resources);
      return { x: pen.x, y: pen.y };
    }

    const moveX = dirX * speed * dt;
    const moveY = dirY * speed * dt;
    const queryMargin = Math.max(Math.abs(moveX), Math.abs(moveY)) + radius + 25;
    const colliders = this.getNearbyColliders(currentX, currentY, queryMargin, structures, resources);

    let posX = currentX;
    let posY = currentY;

    // --- STEP 1: RESOLVE X-AXIS MOVEMENT ---
    if (moveX !== 0) {
      const targetX = posX + moveX;
      let closestAllowedX = targetX;

      // World boundary check
      if (targetX < radius) {
        closestAllowedX = radius;
      } else if (targetX > this.worldWidth - radius) {
        closestAllowedX = this.worldWidth - radius;
      } else {
        for (const c of colliders) {
          const minDist = radius + c.radius;
          const currentDist = Math.hypot(posX - c.x, posY - c.y);
          const targetDist = Math.hypot(targetX - c.x, posY - c.y);

          if (targetDist < minDist) {
            if (targetDist < currentDist || currentDist >= minDist) {
              const deltaY = posY - c.y;
              if (Math.abs(deltaY) < minDist) {
                const safeDistX = Math.sqrt(Math.max(0, minDist * minDist - deltaY * deltaY));
                if (moveX > 0 && c.x >= posX) {
                  const safeX = c.x - safeDistX;
                  if (safeX < closestAllowedX) {
                    closestAllowedX = Math.max(posX, safeX);
                  }
                } else if (moveX < 0 && c.x <= posX) {
                  const safeX = c.x + safeDistX;
                  if (safeX > closestAllowedX) {
                    closestAllowedX = Math.min(posX, safeX);
                  }
                }
              }
            }
          }
        }
      }
      posX = closestAllowedX;
    }

    // --- STEP 2: RESOLVE Y-AXIS MOVEMENT (with updated X) ---
    if (moveY !== 0) {
      const targetY = posY + moveY;
      let closestAllowedY = targetY;

      // World boundary check
      if (targetY < radius) {
        closestAllowedY = radius;
      } else if (targetY > this.worldHeight - radius) {
        closestAllowedY = this.worldHeight - radius;
      } else {
        for (const c of colliders) {
          const minDist = radius + c.radius;
          const currentDist = Math.hypot(posX - c.x, posY - c.y);
          const targetDist = Math.hypot(posX - c.x, targetY - c.y);

          if (targetDist < minDist) {
            if (targetDist < currentDist || currentDist >= minDist) {
              const deltaX = posX - c.x;
              if (Math.abs(deltaX) < minDist) {
                const safeDistY = Math.sqrt(Math.max(0, minDist * minDist - deltaX * deltaX));
                if (moveY > 0 && c.y >= posY) {
                  const safeY = c.y - safeDistY;
                  if (safeY < closestAllowedY) {
                    closestAllowedY = Math.max(posY, safeY);
                  }
                } else if (moveY < 0 && c.y <= posY) {
                  const safeY = c.y + safeDistY;
                  if (safeY > closestAllowedY) {
                    closestAllowedY = Math.min(posY, safeY);
                  }
                }
              }
            }
          }
        }
      }
      posY = closestAllowedY;
    }

    // --- STEP 3: FINAL DEPENETRATION / PUSH OUT ---
    const depenetrated = this.resolvePenetration(posX, posY, radius, structures, resources);
    return { x: depenetrated.x, y: depenetrated.y };
  }

  /**
   * Appends the current predicted position to the trace and prunes stale samples.
   * @param {number} now
   */
  _recordHistory(now) {
    this.positionHistory.push({ t: now, x: this.predictedX, y: this.predictedY });

    const cutoff = now - this.historyDurationMs;
    let drop = 0;
    while (drop < this.positionHistory.length - 2 && this.positionHistory[drop].t < cutoff) {
      drop++;
    }
    if (drop > 0) {
      this.positionHistory.splice(0, drop);
    }
  }

  /**
   * Reads the predicted position this client held at a given wall clock instant.
   * @param {number} t
   * @returns {{ x: number, y: number }}
   */
  _sampleHistory(t) {
    const history = this.positionHistory;
    if (history.length === 0) {
      return { x: this.predictedX, y: this.predictedY };
    }

    const newest = history[history.length - 1];
    if (t >= newest.t) return { x: newest.x, y: newest.y };

    const oldest = history[0];
    if (t <= oldest.t) return { x: oldest.x, y: oldest.y };

    for (let i = history.length - 1; i > 0; i--) {
      const b = history[i];
      const a = history[i - 1];
      if (t >= a.t && t <= b.t) {
        const span = b.t - a.t;
        const alpha = span > 0 ? (t - a.t) / span : 0;
        return {
          x: a.x + (b.x - a.x) * alpha,
          y: a.y + (b.y - a.y) * alpha,
        };
      }
    }

    return { x: newest.x, y: newest.y };
  }

  /**
   * Rebases the whole predicted trace after a correction, so the next snapshot is
   * compared against the corrected trajectory instead of re-applying the same error.
   * @param {number} dx
   * @param {number} dy
   */
  _shiftHistory(dx, dy) {
    for (const entry of this.positionHistory) {
      entry.x += dx;
      entry.y += dy;
    }
  }

  /**
   * Advances local simulation by dt (called on every animation frame).
   * @param {number} dt Time elapsed in seconds
   * @param {Map|Array} structures
   * @param {Map|Array} resources
   * @param {Map|Array} [players] Live players, so bullets can stop on bodies at 0ms
   */
  update(dt, structures, resources, players) {
    if (!this.isInitialized) return;

    const frameDt = Math.max(0, Math.min(MAX_FRAME_DT, Number(dt) || 0));
    if (frameDt <= 0) return;

    // Subdivide long frames so a stutter can never tunnel the player or a bullet
    // through an obstacle. The sub-steps always sum back to exactly frameDt.
    const steps = Math.max(1, Math.ceil(frameDt / MAX_SUB_STEP));
    const stepDt = frameDt / steps;

    for (let i = 0; i < steps; i++) {
      // 1. Advance the local player (movement + sliding, or idle depenetration)
      const resolved = this.resolveMovement(
        this.predictedX,
        this.predictedY,
        this.dirX,
        this.dirY,
        this.playerSpeed,
        stepDt,
        this.playerRadius,
        structures,
        resources
      );
      this.predictedX = resolved.x;
      this.predictedY = resolved.y;

      // 2. Advance local predicted projectiles
      this._stepProjectiles(stepDt, structures, resources, players);
    }

    // 3. Record the resulting position so delayed snapshots can be compared fairly
    this._recordHistory(this._now());

    // 4. Bleed the visual correction offset away (frame rate independent decay)
    if (this.errorX !== 0 || this.errorY !== 0) {
      const retain = Math.exp(-frameDt / this.errorSmoothingTau);
      let nextX = this.errorX * retain;
      let nextY = this.errorY * retain;

      // Repaying the offset moves the avatar on top of its normal walking motion.
      // Cap that extra motion to a fraction of the walking speed so catching up reads
      // as a slight lean rather than a dash, no matter how big the correction was.
      const budget = this.maxCorrectionSpeedFactor * this.playerSpeed * frameDt;
      const deltaX = nextX - this.errorX;
      const deltaY = nextY - this.errorY;
      const delta = Math.hypot(deltaX, deltaY);
      if (delta > budget) {
        const scale = budget / delta;
        nextX = this.errorX + deltaX * scale;
        nextY = this.errorY + deltaY * scale;
      }

      this.errorX = nextX;
      this.errorY = nextY;
      if (Math.abs(this.errorX) < 0.05) this.errorX = 0;
      if (Math.abs(this.errorY) < 0.05) this.errorY = 0;
    }
  }

  /**
   * Integrates the locally predicted projectiles for a single sub-step.
   * @param {number} dt
   * @param {Map|Array} structures
   * @param {Map|Array} resources
   * @param {Map|Array} [players]
   */
  _stepProjectiles(dt, structures, resources, players) {
    for (let i = this.predictedProjectiles.length - 1; i >= 0; i--) {
      const proj = this.predictedProjectiles[i];
      proj.x += proj.vx * dt;
      proj.y += proj.vy * dt;
      proj.ttl -= dt;

      // Check bounds / TTL
      if (
        proj.ttl <= 0 ||
        proj.x < 0 ||
        proj.x > this.worldWidth ||
        proj.y < 0 ||
        proj.y > this.worldHeight
      ) {
        this.predictedProjectiles.splice(i, 1);
        continue;
      }

      // Check local collision with solid structures / resources
      const colliders = this.getNearbyColliders(proj.x, proj.y, proj.radius + 10, structures, resources);
      let hit = false;

      for (const c of colliders) {
        const dist = Math.hypot(proj.x - c.x, proj.y - c.y);
        if (dist < proj.radius + c.radius) {
          hit = true;
          if (typeof this.onLocalImpact === 'function') {
            this.onLocalImpact(proj.x, proj.y, c);
          }
          break;
        }
      }

      // Obstacles win over bodies, exactly like CombatSystem.tick: a bullet that
      // buries itself in a wall never reaches the player standing behind it.
      if (!hit && players) {
        const playerIterable = players instanceof Map ? players.values() : players;
        for (const target of playerIterable) {
          if (!target || target.id === proj.shooterId) continue;
          if (proj.shooterOwnerId && target.id === proj.shooterOwnerId) continue;
          if (target.isDead || target.hp <= 0) continue;

          const targetRadius = target.radius || this.playerRadius;
          const dist = Math.hypot(proj.x - target.x, proj.y - target.y);
          if (dist < proj.radius + targetRadius) {
            hit = true;
            if (typeof this.onLocalImpact === 'function') {
              // The server reports PLAYER hits at the body centre; match it so the
              // predicted sparks land where the confirming event would have put them.
              this.onLocalImpact(target.x, target.y, {
                id: target.id,
                type: 'player',
                x: target.x,
                y: target.y,
                radius: targetRadius,
                isPlayer: true,
              });
            }
            break;
          }
        }
      }

      if (hit) {
        this.predictedProjectiles.splice(i, 1);
      }
    }
  }

  /**
   * Measures the real round trip time by watching when the server starts echoing an
   * input back. Requires no extra packets and automatically accounts for the
   * artificial latency injected by NetworkClient.
   * @param {number} serverDirX
   * @param {number} serverDirY
   * @param {number} now
   */
  _observeServerDirection(serverDirX, serverDirY, now) {
    const dx = Number(serverDirX) || 0;
    const dy = Number(serverDirY) || 0;

    const changed =
      this._lastServerDirX === null ||
      Math.abs(dx - this._lastServerDirX) > 0.02 ||
      Math.abs(dy - this._lastServerDirY) > 0.02;

    if (changed) {
      // The server dir is quantised to 2 decimals and our inputs to 3: compare loosely.
      for (let i = 0; i < this.inputHistory.length; i++) {
        const input = this.inputHistory[i];
        if (Math.abs(input.dirX - dx) <= 0.03 && Math.abs(input.dirY - dy) <= 0.03) {
          const sample = now - input.sentAt;
          if (sample >= 0 && sample < 2000) {
            this.rttEstimateMs =
              this.rttEstimateMs === null ? sample : this.rttEstimateMs * 0.8 + sample * 0.2;
          }
          this.inputHistory.splice(0, i + 1);
          break;
        }
      }
    }

    this._lastServerDirX = dx;
    this._lastServerDirY = dy;
  }

  /**
   * Round trip delay used to align snapshots with the local prediction trace.
   * @param {number} simulatedLatencyMs
   * @returns {number}
   */
  _effectiveRttMs(simulatedLatencyMs) {
    const simulated = Math.max(0, Number(simulatedLatencyMs) || 0);
    const measured = this.rttEstimateMs;
    const rtt = measured === null ? simulated + this.fallbackRttMs : Math.max(measured, simulated);
    return Math.max(0, Math.min(1000, rtt));
  }

  /**
   * Snaps hard to the authoritative position, discarding prediction state.
   * @param {number} x
   * @param {number} y
   */
  _hardSnap(x, y) {
    this.predictedX = x;
    this.predictedY = y;
    this.errorX = 0;
    this.errorY = 0;
    this.positionHistory = [{ t: this._now(), x, y }];
  }

  /**
   * Reconciles local predicted state with authoritative state from server STATE_SYNC.
   *
   * The snapshot describes the world as it was one round trip ago, so it is compared with
   * the position this client held one round trip ago, never with the current one. The
   * resulting error is applied to the simulation immediately and cancelled out of the
   * rendered position, which then eases back over ~200ms instead of snapping.
   *
   * @param {object} serverLocalPlayer Server player from syncData.players
   * @param {Array<object>} serverProjectiles All active server projectiles
   * @param {number} [simulatedLatencyMs=0] Current simulated latency in ms
   */
  reconcile(serverLocalPlayer, serverProjectiles, simulatedLatencyMs = 0) {
    if (!serverLocalPlayer || !this.isInitialized) return;

    if (serverLocalPlayer.id) {
      this.localPlayerId = serverLocalPlayer.id;
    }

    // Update server projectiles regardless of the movement outcome
    this.serverProjectiles = Array.isArray(serverProjectiles) ? serverProjectiles : [];

    if (serverLocalPlayer.isDead) {
      this._hardSnap(serverLocalPlayer.x, serverLocalPlayer.y);
      this.inputHistory = [];
      this._lastServerDirX = null;
      this._lastServerDirY = null;
      this.predictedProjectiles = [];
      return;
    }

    const now = this._now();
    this._observeServerDirection(serverLocalPlayer.dirX, serverLocalPlayer.dirY, now);

    // Where were we standing when the server produced this snapshot?
    const rtt = this._effectiveRttMs(simulatedLatencyMs);
    const past = this._sampleHistory(now - rtt);

    const errorX = serverLocalPlayer.x - past.x;
    const errorY = serverLocalPlayer.y - past.y;
    const errorDist = Math.hypot(errorX, errorY);

    if (errorDist > this.teleportThreshold) {
      // Respawn, teleport or hopeless divergence: accept authority immediately.
      this._hardSnap(serverLocalPlayer.x, serverLocalPlayer.y);
      return;
    }

    if (errorDist <= this.correctionDeadzone) return;

    // Apply the full correction to the simulation, and hide it behind the visual offset
    // so this frame renders in exactly the same place the previous one did.
    this.predictedX += errorX;
    this.predictedY += errorY;
    this.errorX -= errorX;
    this.errorY -= errorY;
    this._shiftHistory(errorX, errorY);

    // Never let the rendered position drift arbitrarily far from the simulated one.
    const offset = Math.hypot(this.errorX, this.errorY);
    if (offset > this.teleportThreshold) {
      const scale = this.teleportThreshold / offset;
      this.errorX *= scale;
      this.errorY *= scale;
    }
  }

  /**
   * Returns effective render coordinates for local player.
   * @returns {{ x: number, y: number, dirX: number, dirY: number }}
   */
  getRenderPosition() {
    return {
      x: this.predictedX + this.errorX,
      y: this.predictedY + this.errorY,
      dirX: this.dirX,
      dirY: this.dirY,
    };
  }

  /**
   * Returns clean list of projectiles to render.
   * Remote projectiles come from server.
   * Local player projectiles come from the local prediction engine to guarantee 0ms instant feedback without ghost duplicates.
   * @returns {Array<object>}
   */
  getProjectilesToRender() {
    const list = [];

    // 1. Remote projectiles (other players, bots, and turrets)
    // NEVER draw server copies of local player's bullets (even after predicted ones expire)
    for (const sp of this.serverProjectiles) {
      if (sp.shooterId && sp.shooterId === this.localPlayerId) {
        continue;
      }
      list.push(sp);
    }

    // 2. Local predicted projectiles for the local player
    for (const lp of this.predictedProjectiles) {
      list.push(lp);
    }

    return list;
  }
}
