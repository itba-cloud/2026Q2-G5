/**
 * CollisionSystem: High-performance 2D collision resolution powered by a Spatial Hash Grid.
 * Reduces collision query complexity from O(N) linear scans to O(1) local cell lookups.
 */
export class CollisionSystem {
  /**
   * @param {object} [options]
   * @param {number} [options.cellSize=64] Size of each spatial partition cell in pixels
   * @param {boolean} [options.enableResourceCollisions=true]
   * @param {boolean} [options.enableStructureCollisions=true]
   */
  constructor(options = {}) {
    this.cellSize = options.cellSize || 64;
    this.enableResourceCollisions = options.enableResourceCollisions ?? true;
    this.enableStructureCollisions = options.enableStructureCollisions ?? true;

    // Spatial Hash Grid: cellKey -> Set<collider>
    this.grid = new Map();
    // Reverse index: colliderId -> Array<cellKey> (for O(1) removal)
    this.colliderToCells = new Map();
    // Cache of collider objects: colliderId -> collider
    this.collidersById = new Map();

    this.isInitialized = false;
  }

  _getCellKey(cellX, cellY) {
    return `${cellX}_${cellY}`;
  }

  _getCellRange(x, y, radius) {
    return {
      minX: Math.floor((x - radius) / this.cellSize),
      maxX: Math.floor((x + radius) / this.cellSize),
      minY: Math.floor((y - radius) / this.cellSize),
      maxY: Math.floor((y + radius) / this.cellSize),
    };
  }

  /**
   * Inserts a collider into the Spatial Hash Grid.
   * @param {object} collider
   */
  insert(collider) {
    if (!collider || !collider.id) return;

    // If already exists, remove first to update position
    if (this.colliderToCells.has(collider.id)) {
      this.remove(collider.id);
    }

    const radius = collider.radius || 16;
    const { minX, maxX, minY, maxY } = this._getCellRange(collider.x, collider.y, radius);
    const cellKeys = [];

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const key = this._getCellKey(cx, cy);
        let cell = this.grid.get(key);
        if (!cell) {
          cell = new Set();
          this.grid.set(key, cell);
        }
        cell.add(collider.id);
        cellKeys.push(key);
      }
    }

    this.colliderToCells.set(collider.id, cellKeys);
    this.collidersById.set(collider.id, collider);
  }

  /**
   * Removes a collider from the Spatial Hash Grid in O(1).
   * @param {string} colliderId
   */
  remove(colliderId) {
    const cellKeys = this.colliderToCells.get(colliderId);
    if (cellKeys) {
      for (const key of cellKeys) {
        const cell = this.grid.get(key);
        if (cell) {
          cell.delete(colliderId);
          if (cell.size === 0) {
            this.grid.delete(key);
          }
        }
      }
      this.colliderToCells.delete(colliderId);
    }
    this.collidersById.delete(colliderId);
  }

  /**
   * Builds or synchronizes the spatial index with active world entities.
   * @param {object} world
   */
  syncWorld(world) {
    this.clear();

    // 1. Index Solid Resources (Trees, Rocks)
    if (this.enableResourceCollisions && world.resources) {
      for (const res of world.resources.values()) {
        if (res.blocksMovement || res.blocksProjectiles) {
          this.insert({
            id: res.id,
            type: res.type,
            x: res.x,
            y: res.y,
            radius: res.colliderRadius || (res.radius ? res.radius * 0.75 : 14),
            blocksMovement: res.blocksMovement ?? true,
            blocksProjectiles: res.blocksProjectiles ?? (res.blocksMovement ?? true),
          });
        }
      }
    }

    // 2. Index Solid Structures (Walls, Turrets)
    if (this.enableStructureCollisions && world.structures) {
      for (const struct of world.structures.values()) {
        if (struct.blocksMovement || struct.blocksProjectiles) {
          this.insert({
            id: struct.id,
            type: struct.type,
            x: struct.x,
            y: struct.y,
            radius: struct.radius || 18,
            blocksMovement: struct.blocksMovement ?? true,
            blocksProjectiles: struct.blocksProjectiles ?? true,
          });
        }
      }
    }

    this.isInitialized = true;
  }

  /**
   * Queries nearby colliders within the local bounding box in O(1).
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @param {object} world
   * @param {string} [ignoreId]
   * @returns {Array<object>}
   */
  getNearbyColliders(x, y, radius, world, ignoreId = null) {
    if (!this.isInitialized && world) {
      this.syncWorld(world);
    }

    const { minX, maxX, minY, maxY } = this._getCellRange(x, y, radius);
    const nearbyIds = new Set();

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const cell = this.grid.get(this._getCellKey(cx, cy));
        if (cell) {
          for (const id of cell) {
            if (id !== ignoreId) {
              nearbyIds.add(id);
            }
          }
        }
      }
    }

    const result = [];
    for (const id of nearbyIds) {
      const collider = this.collidersById.get(id);
      if (collider) {
        result.push(collider);
      }
    }

    return result;
  }

  /**
   * Checks if a circular position overlaps with any movement obstacle in O(1).
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @param {object} world
   * @param {string} [ignoreId]
   * @returns {boolean}
   */
  isOverlapping(x, y, radius, world, ignoreId = null) {
    // 1. World Bounds check
    if (
      x < radius ||
      x > world.worldWidth - radius ||
      y < radius ||
      y > world.worldHeight - radius
    ) {
      return true;
    }

    // 2. Local Spatial Query (O(1))
    const colliders = this.getNearbyColliders(x, y, radius, world, ignoreId);
    for (const c of colliders) {
      if (c.blocksMovement === false) continue;
      const dist = Math.hypot(x - c.x, y - c.y);
      if (dist < radius + c.radius) {
        return true;
      }
    }

    return false;
  }

  /**
   * Resolves overlaps/penetrations by pushing the entity outward along collision normals.
   * Runs multiple relaxation iterations to resolve multi-obstacle clusters cleanly.
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @param {object} world
   * @param {number} [maxIterations=4]
   * @param {string} [entityId=null]
   * @returns {{ x: number, y: number, pushed: boolean }}
   */
  resolvePenetration(x, y, radius, world, maxIterations = 4, entityId = null) {
    let posX = x;
    let posY = y;
    let anyPushed = false;

    for (let iter = 0; iter < maxIterations; iter++) {
      let iterPushed = false;
      const colliders = this.getNearbyColliders(posX, posY, radius + 20, world, entityId);

      for (const c of colliders) {
        if (c.blocksMovement === false) continue;
        const minDist = radius + c.radius;
        const dx = posX - c.x;
        const dy = posY - c.y;
        const distSq = dx * dx + dy * dy;

        if (distSq < minDist * minDist) {
          const dist = Math.sqrt(distSq);
          let nx, ny, overlap;

          if (dist > 0.0001) {
            nx = dx / dist;
            ny = dy / dist;
            overlap = minDist - dist;
          } else {
            // If centers coincide exactly, push away from world center or to the right
            const toCenterX = posX - (world ? world.worldWidth / 2 : 500);
            const toCenterY = posY - (world ? world.worldHeight / 2 : 500);
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
      if (world) {
        if (posX < radius) {
          posX = radius;
          iterPushed = true;
        } else if (posX > world.worldWidth - radius) {
          posX = world.worldWidth - radius;
          iterPushed = true;
        }

        if (posY < radius) {
          posY = radius;
          iterPushed = true;
        } else if (posY > world.worldHeight - radius) {
          posY = world.worldHeight - radius;
          iterPushed = true;
        }
      }

      // If no obstacles were overlapping in this iteration, we are clean!
      if (!iterPushed) {
        break;
      }
    }

    return {
      x: posX,
      y: posY,
      pushed: anyPushed,
    };
  }

  /**
   * Finds a nearby safe circular position free of solid obstacles.
   * @param {number} startX
   * @param {number} startY
   * @param {number} radius
   * @param {object} world
   * @param {number} [maxRadius=500]
   * @returns {{ x: number, y: number }}
   */
  findSafePosition(startX, startY, radius, world, maxRadius = 500) {
    if (!this.isOverlapping(startX, startY, radius, world)) {
      return { x: startX, y: startY };
    }

    for (let r = 20; r <= maxRadius; r += 20) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
        let testX = Math.round(startX + Math.cos(a) * r);
        let testY = Math.round(startY + Math.sin(a) * r);

        // Clamp to map boundary with radius margin
        testX = Math.max(radius + 5, Math.min(world.worldWidth - radius - 5, testX));
        testY = Math.max(radius + 5, Math.min(world.worldHeight - radius - 5, testY));

        if (!this.isOverlapping(testX, testY, radius, world)) {
          return { x: testX, y: testY };
        }
      }
    }

    // Fallback: search grid points across world
    const margin = radius + 30;
    const step = 40;
    for (let gx = margin; gx <= world.worldWidth - margin; gx += step) {
      for (let gy = margin; gy <= world.worldHeight - margin; gy += step) {
        if (!this.isOverlapping(gx, gy, radius, world)) {
          return { x: gx, y: gy };
        }
      }
    }

    return { x: startX, y: startY };
  }

  /**
   * Resolves continuous movement with smooth sliding and automatic depenetration.
   * Performs O(1) axis-separated (X then Y) collision detection and response.
   * @param {number} currentX
   * @param {number} currentY
   * @param {number} dirX
   * @param {number} dirY
   * @param {number} speed Units per second
   * @param {number} deltaTime Time elapsed in seconds
   * @param {number} radius Entity collision radius
   * @param {object} world
   * @param {string} [entityId]
   * @returns {{ x: number, y: number, collidedX: boolean, collidedY: boolean }}
   */
  resolveMovement(
    currentX,
    currentY,
    dirX,
    dirY,
    speed,
    deltaTime,
    radius,
    world,
    entityId = null
  ) {
    if (dirX === 0 && dirY === 0) {
      const pen = this.resolvePenetration(currentX, currentY, radius, world, 4, entityId);
      return { x: pen.x, y: pen.y, collidedX: false, collidedY: false };
    }

    const moveX = dirX * speed * deltaTime;
    const moveY = dirY * speed * deltaTime;
    const queryMargin = Math.max(Math.abs(moveX), Math.abs(moveY)) + radius + 15;

    // Fetch only colliders in the immediate neighborhood in O(1)
    const colliders = this.getNearbyColliders(currentX, currentY, queryMargin, world, entityId);

    let posX = currentX;
    let posY = currentY;
    let collidedX = false;
    let collidedY = false;

    // --- STEP 1: RESOLVE X-AXIS MOVEMENT ---
    if (moveX !== 0) {
      const targetX = posX + moveX;
      let blockedX = false;
      let closestAllowedX = targetX;

      // World X-boundaries
      if (targetX < radius) {
        closestAllowedX = radius;
        blockedX = true;
      } else if (targetX > world.worldWidth - radius) {
        closestAllowedX = world.worldWidth - radius;
        blockedX = true;
      } else {
        for (const c of colliders) {
          if (c.blocksMovement === false) continue;
          const minDist = radius + c.radius;
          const currentDist = Math.hypot(posX - c.x, posY - c.y);
          const targetDist = Math.hypot(targetX - c.x, posY - c.y);

          // If moving along X would cause or worsen collision
          if (targetDist < minDist) {
            // Check if movement is heading towards obstacle center
            if (targetDist < currentDist || currentDist >= minDist) {
              blockedX = true;
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

      posX = blockedX ? closestAllowedX : targetX;
      collidedX = blockedX;
    }

    // --- STEP 2: RESOLVE Y-AXIS MOVEMENT ---
    if (moveY !== 0) {
      const targetY = posY + moveY;
      let blockedY = false;
      let closestAllowedY = targetY;

      // World Y-boundaries
      if (targetY < radius) {
        closestAllowedY = radius;
        blockedY = true;
      } else if (targetY > world.worldHeight - radius) {
        closestAllowedY = world.worldHeight - radius;
        blockedY = true;
      } else {
        for (const c of colliders) {
          if (c.blocksMovement === false) continue;
          const minDist = radius + c.radius;
          const currentDist = Math.hypot(posX - c.x, posY - c.y);
          const targetDist = Math.hypot(posX - c.x, targetY - c.y);

          // If moving along Y would cause or worsen collision
          if (targetDist < minDist) {
            // Check if movement is heading towards obstacle center
            if (targetDist < currentDist || currentDist >= minDist) {
              blockedY = true;
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

      posY = blockedY ? closestAllowedY : targetY;
      collidedY = blockedY;
    }

    // --- STEP 3: FINAL DEPENETRATION / PUSH OUT ---
    // If any overlap remains, cleanly push the entity out along collision normals
    const depenetrated = this.resolvePenetration(posX, posY, radius, world, 4, entityId);
    posX = depenetrated.x;
    posY = depenetrated.y;

    return {
      x: posX,
      y: posY,
      collidedX,
      collidedY,
    };
  }

  clear() {
    this.grid.clear();
    this.colliderToCells.clear();
    this.collidersById.clear();
    this.isInitialized = false;
  }
}
