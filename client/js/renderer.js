/**
 * GameRenderer: High-performance 2D Canvas rendering engine with camera, lerp interpolation,
 * animated campfires, projectile trails, structure rendering, and building preview.
 */
export class GameRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.worldWidth = 1000;
    this.worldHeight = 1000;
    this.localPlayerId = null;

    // State storage
    this.resources = new Map(); // id -> resource
    this.structures = new Map(); // id -> structure
    this.players = new Map(); // id -> player
    this.projectiles = []; // array of { id, x, y, vx, vy }

    // Particles & FX
    this.particles = []; // array of { x, y, vx, vy, color, size, alpha, ttl, maxTtl }
    this.floatingTexts = []; // array of { x, y, text, color, alpha, ttl, maxTtl }

    // Building Preview
    this.activeBuildType = null; // 'wall' | 'campfire' | 'turret' | null
    this.cursorWorldPos = { x: 500, y: 500 };
    this.buildingCatalog = {};

    // Camera
    this.camera = { x: 500, y: 500 };

    // Client-side physics & prediction engine
    this.predictionEngine = null;

    this.animationFrameId = null;
    this.isRunning = false;
    this.time = 0;

    this._resizeHandler = this._handleResize.bind(this);
  }

  /**
   * Attaches the modular PredictionEngine.
   * @param {object} engine
   */
  setPredictionEngine(engine) {
    this.predictionEngine = engine;
  }

  start() {
    window.addEventListener('resize', this._resizeHandler);
    this._handleResize();

    this.isRunning = true;
    let lastTime = performance.now();

    const loop = (now) => {
      if (!this.isRunning) return;
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;
      this.time += dt;

      if (this.predictionEngine) {
        this.predictionEngine.update(dt, this.structures, this.resources, this.players);
      }

      this._updateFx(dt);
      this._render();
      this.animationFrameId = requestAnimationFrame(loop);
    };
    this.animationFrameId = requestAnimationFrame(loop);
  }

  stop() {
    this.isRunning = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    window.removeEventListener('resize', this._resizeHandler);
  }

  _handleResize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.ctx.scale(dpr, dpr);
    this.displayWidth = window.innerWidth;
    this.displayHeight = window.innerHeight;
  }

  screenToWorld(screenX, screenY) {
    const worldX = screenX - this.displayWidth / 2 + this.camera.x;
    const worldY = screenY - this.displayHeight / 2 + this.camera.y;
    return { x: worldX, y: worldY };
  }

  setBuildPreview(structureType, catalog = {}) {
    this.activeBuildType = structureType;
    if (catalog) this.buildingCatalog = catalog;
  }

  updateCursorScreenPos(screenX, screenY) {
    this.cursorWorldPos = this.screenToWorld(screenX, screenY);
  }

  /**
   * Initializes world parameters, resources, and structures from INIT packet.
   * @param {object} initData
   */
  initWorld(initData) {
    this.worldWidth = initData.worldWidth || 1000;
    this.worldHeight = initData.worldHeight || 1000;
    this.localPlayerId = initData.playerId;
    if (initData.buildingCatalog) {
      this.buildingCatalog = initData.buildingCatalog;
    }

    this.resources.clear();
    if (Array.isArray(initData.resources)) {
      for (const res of initData.resources) {
        this.resources.set(res.id, { ...res });
      }
    }

    this.structures.clear();
    if (Array.isArray(initData.structures)) {
      for (const struct of initData.structures) {
        this.structures.set(struct.id, { ...struct });
      }
    }

    this.players.clear();
    if (Array.isArray(initData.players)) {
      for (const p of initData.players) {
        this.players.set(p.id, {
          id: p.id,
          name: p.name,
          x: p.x,
          y: p.y,
          targetX: p.x,
          targetY: p.y,
          dirX: 0,
          dirY: 0,
          hp: p.hp,
          maxHp: p.maxHp || 100,
          isDead: p.isDead || false,
          inventory: p.inventory || { wood: 0, stone: 0, food: 0 },
        });
      }
    }

    if (initData.player) {
      this.camera.x = initData.player.x;
      this.camera.y = initData.player.y;
    }
  }

  /**
   * Updates state from STATE_SYNC packet.
   * @param {object} syncData
   */
  updateState(syncData) {
    if (!syncData) return;

    // 1. Players
    if (Array.isArray(syncData.players)) {
      const activeIds = new Set();
      for (const p of syncData.players) {
        activeIds.add(p.id);
        let local = this.players.get(p.id);

        if (!local) {
          local = {
            id: p.id,
            name: p.name,
            x: p.x,
            y: p.y,
            targetX: p.x,
            targetY: p.y,
            dirX: p.dirX,
            dirY: p.dirY,
            hp: p.hp,
            maxHp: p.maxHp || 100,
            isDead: p.isDead || false,
            inventory: p.inventory || { wood: 0, stone: 0, food: 0 },
          };
          this.players.set(p.id, local);
        } else {
          local.targetX = p.x;
          local.targetY = p.y;
          local.dirX = p.dirX;
          local.dirY = p.dirY;
          local.hp = p.hp;
          local.maxHp = p.maxHp || 100;
          local.isDead = p.isDead || false;
          if (p.inventory) local.inventory = p.inventory;
        }
      }

      for (const id of this.players.keys()) {
        if (!activeIds.has(id)) {
          this.players.delete(id);
        }
      }
    }

    // 2. Projectiles
    if (Array.isArray(syncData.projectiles)) {
      this.projectiles = syncData.projectiles;
    }

    // 3. Structures
    if (Array.isArray(syncData.structures)) {
      const structIds = new Set();
      for (const s of syncData.structures) {
        structIds.add(s.id);
        const existing = this.structures.get(s.id);
        if (existing) {
          existing.hp = s.hp;
          if (s.angle !== undefined) existing.angle = s.angle;
          if (s.targetId !== undefined) existing.targetId = s.targetId;
        } else {
          this.structures.set(s.id, { ...s });
        }
      }
      for (const id of this.structures.keys()) {
        if (!structIds.has(id)) {
          this.structures.delete(id);
        }
      }
    }
  }

  addStructure(struct) {
    this.structures.set(struct.id, struct);
    this.spawnSparks(struct.x, struct.y, '#f59e0b', 12);
  }

  removeStructure(structId) {
    const s = this.structures.get(structId);
    if (s) {
      this.spawnSparks(s.x, s.y, '#ef4444', 16);
      this.structures.delete(structId);
    }
  }

  damageResource(resourceId, hp, maxHp) {
    const res = this.resources.get(resourceId);
    if (res) {
      res.hp = hp;
      res.maxHp = maxHp;
      res.hitTime = 0.22; // Duration of hit flash and screen shake
      res.punchScale = 1.25; // Quick punchy scale pop

      const color = res.type === 'tree' ? '#86efac' : res.type === 'rock' ? '#cbd5e1' : '#fca5a5';
      this.spawnSparks(res.x, res.y, color, 14);
      this.addFloatingText(res.x, res.y - (res.radius || 18) - 10, '-1', '#fbbf24');
    }
  }

  harvestResource(resourceId, yieldType, yieldAmount) {
    const res = this.resources.get(resourceId);
    const icon = yieldType === 'wood' ? '🪵' : yieldType === 'stone' ? '🪨' : '🍎';
    const x = res ? res.x : this.camera.x;
    const y = res ? res.y : this.camera.y;

    // Floating gain text in bold gold
    this.addFloatingText(x, y - 16, `+${yieldAmount} ${icon}`, '#fbbf24', 'bold 15px system-ui, sans-serif');
    
    // Large celebratory burst of particles (gold sparkles + resource colors)
    this.spawnSparks(x, y, '#fbbf24', 16);
    this.spawnSparks(x, y, yieldType === 'wood' ? '#22c55e' : yieldType === 'stone' ? '#94a3b8' : '#ef4444', 16);

    if (res) {
      if (res.type === 'tree') {
        res.stage = 'stump';
        res.hp = 0;
        res.punchScale = 1.2;
      } else if (res.type === 'bush') {
        res.stage = 'empty';
        res.hp = 0;
        res.punchScale = 1.2;
      } else {
        this.resources.delete(resourceId);
      }
    } else {
      this.resources.delete(resourceId);
    }
  }

  regenerateResource({ resourceId, stage, hp, maxHp }) {
    const res = this.resources.get(resourceId);
    if (!res) return;

    res.stage = stage;
    if (hp !== undefined) res.hp = hp;
    if (maxHp !== undefined) res.maxHp = maxHp;

    res.punchScale = 1.3;
    const color = res.type === 'bush' ? '#ef4444' : '#22c55e';
    this.spawnSparks(res.x, res.y, color, 14);
    if (stage === 'full') {
      const icon = res.type === 'tree' ? '🌲' : '🫐';
      this.addFloatingText(res.x, res.y - (res.radius || 18) - 10, icon, '#86efac', 'bold 14px system-ui, sans-serif');
    }
  }

  addPlayer(p) {
    if (!this.players.has(p.id)) {
      this.players.set(p.id, {
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        targetX: p.x,
        targetY: p.y,
        dirX: 0,
        dirY: 0,
        hp: p.hp,
        maxHp: p.maxHp || 100,
        isDead: false,
        inventory: { wood: 0, stone: 0, food: 0 },
      });
    }
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
  }

  getLocalPlayer() {
    return this.players.get(this.localPlayerId);
  }

  // FX: Particles & Floating Texts
  spawnSparks(x, y, color = '#ffffff', count = 10) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 140;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color,
        size: 2 + Math.random() * 3.5,
        alpha: 1,
        ttl: 0.4 + Math.random() * 0.35,
        maxTtl: 0.75,
      });
    }
  }

  addFloatingText(x, y, text, color = '#ffffff', font = 'bold 13px system-ui, sans-serif') {
    this.floatingTexts.push({
      x,
      y,
      text,
      color,
      font,
      alpha: 1,
      ttl: 1.1,
      maxTtl: 1.1,
    });
  }

  _updateFx(dt) {
    // Update Resource Animation States (hit shake & scale recoil)
    for (const res of this.resources.values()) {
      if (res.hitTime > 0) {
        res.hitTime = Math.max(0, res.hitTime - dt);
      }
      if (res.punchScale && res.punchScale > 1) {
        res.punchScale = Math.max(1, res.punchScale - dt * 2.8);
      }
    }

    // Update Particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.95; // slight air resistance
      p.vy *= 0.95;
      p.ttl -= dt;
      p.alpha = Math.max(0, p.ttl / p.maxTtl);
      if (p.ttl <= 0) {
        this.particles.splice(i, 1);
      }
    }

    // Update Floating Texts
    for (let i = this.floatingTexts.length - 1; i >= 0; i--) {
      const ft = this.floatingTexts[i];
      ft.y -= 28 * dt; // Float upwards
      ft.ttl -= dt;
      ft.alpha = Math.max(0, ft.ttl / ft.maxTtl);
      if (ft.ttl <= 0) {
        this.floatingTexts.splice(i, 1);
      }
    }
  }

  /**
   * Master render loop.
   */
  _render() {
    const ctx = this.ctx;
    const width = this.displayWidth;
    const height = this.displayHeight;

    // 1. Interpolate positions (Lerp for remote players, prediction for local player)
    const lerpFactor = 0.28;
    for (const p of this.players.values()) {
      if (p.id === this.localPlayerId && this.predictionEngine && !p.isDead) {
        const pred = this.predictionEngine.getRenderPosition();
        p.x = pred.x;
        p.y = pred.y;
        p.dirX = pred.dirX;
        p.dirY = pred.dirY;
      } else {
        p.x += (p.targetX - p.x) * lerpFactor;
        p.y += (p.targetY - p.y) * lerpFactor;
      }
    }

    // 2. Follow local player with camera
    const localPlayer = this.getLocalPlayer();
    if (localPlayer) {
      this.camera.x += (localPlayer.x - this.camera.x) * 0.15;
      this.camera.y += (localPlayer.y - this.camera.y) * 0.15;
    }

    // Clear background
    ctx.fillStyle = '#0b1118';
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(Math.round(width / 2 - this.camera.x), Math.round(height / 2 - this.camera.y));

    // 3. Ground & Grid
    this._drawWorldBoundsAndGrid(ctx);

    // 4. Campfire Light / Healing Aura
    this._drawAuras(ctx);

    // 5. Structures
    this._drawStructures(ctx);

    // 6. Resources
    this._drawResources(ctx);

    // 7. Players
    this._drawPlayers(ctx);

    // 8. Projectiles
    this._drawProjectiles(ctx);

    // 9. Particles & Floating Damage Texts
    this._drawFx(ctx);

    // 10. Building Preview (Ghost)
    this._drawBuildPreview(ctx, localPlayer);

    ctx.restore();
  }

  _drawWorldBoundsAndGrid(ctx) {
    ctx.fillStyle = '#141e17';
    ctx.fillRect(0, 0, this.worldWidth, this.worldHeight);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    const gridSize = 50;

    ctx.beginPath();
    for (let x = 0; x <= this.worldWidth; x += gridSize) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.worldHeight);
    }
    for (let y = 0; y <= this.worldHeight; y += gridSize) {
      ctx.moveTo(0, y);
      ctx.lineTo(this.worldWidth, y);
    }
    ctx.stroke();

    // World border
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, this.worldWidth, this.worldHeight);
  }

  _drawAuras(ctx) {
    for (const struct of this.structures.values()) {
      if (struct.type === 'campfire') {
        const healRadius = struct.healRadius || 90;
        const pulse = 1 + Math.sin(this.time * 4) * 0.05;

        // Warm radial light aura
        const grad = ctx.createRadialGradient(
          struct.x, struct.y, 10,
          struct.x, struct.y, healRadius * pulse
        );
        grad.addColorStop(0, 'rgba(245, 158, 11, 0.25)');
        grad.addColorStop(0.7, 'rgba(239, 68, 68, 0.08)');
        grad.addColorStop(1, 'rgba(239, 68, 68, 0)');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(struct.x, struct.y, healRadius * pulse, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  _drawStructures(ctx) {
    for (const s of this.structures.values()) {
      switch (s.type) {
        case 'wall':
          this._drawWall(ctx, s);
          break;
        case 'campfire':
          this._drawCampfire(ctx, s);
          break;
        case 'turret':
          this._drawTurret(ctx, s);
          break;
        default:
          break;
      }

      // Structure HP bar if damaged
      if (s.hp < (s.maxHp || 100)) {
        this._drawMiniHpBar(ctx, s.x, s.y - 22, s.hp, s.maxHp || 100, 30);
      }
    }
  }

  _drawWall(ctx, s) {
    const r = s.radius || 18;
    // Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(s.x - r + 2, s.y - r + 4, r * 2, r * 2);

    // Wood barricade
    ctx.fillStyle = '#78350f';
    ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);

    ctx.strokeStyle = '#92400e';
    ctx.lineWidth = 2;
    ctx.strokeRect(s.x - r, s.y - r, r * 2, r * 2);

    // Cross beam details
    ctx.strokeStyle = '#451a03';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s.x - r, s.y - r);
    ctx.lineTo(s.x + r, s.y + r);
    ctx.moveTo(s.x + r, s.y - r);
    ctx.lineTo(s.x - r, s.y + r);
    ctx.stroke();
  }

  _drawCampfire(ctx, s) {
    const r = s.radius || 16;
    // Stone ring
    ctx.fillStyle = '#475569';
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#334155';
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * 0.7, 0, Math.PI * 2);
    ctx.fill();

    // Flickering fire flame
    const flameFlicker = Math.sin(this.time * 12) * 2;
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(s.x, s.y, 8 + flameFlicker, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc(s.x, s.y, 5 + flameFlicker * 0.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fef08a';
    ctx.beginPath();
    ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawTurret(ctx, s) {
    const r = s.radius || 18;
    // Base
    ctx.fillStyle = '#334155';
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Turret cannon: aim towards target if engaged, else smooth scanning rotation
    const isEngaged = !!s.targetId;
    const cannonAngle = (isEngaged && s.angle !== undefined && s.angle !== null)
      ? s.angle
      : (s.angle !== undefined && s.angle !== null && !isNaN(s.angle) ? s.angle : this.time * 1.5);

    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(cannonAngle);

    // Barrel
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, -4, 20, 8);

    // Barrel muzzle ring
    ctx.fillStyle = isEngaged ? '#ef4444' : '#0f172a';
    ctx.fillRect(16, -5, 4, 10);

    // Core dome
    ctx.fillStyle = isEngaged ? '#ef4444' : '#38bdf8';
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.fill();

    // Highlight
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(-2, -2, 2.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  _drawResources(ctx) {
    for (const res of this.resources.values()) {
      const maxHp = res.maxHp || (res.type === 'tree' ? 3 : res.type === 'rock' ? 4 : 1);
      const hp = res.hp ?? maxHp;
      const ratio = Math.max(0, Math.min(1, hp / maxHp));
      const stage = res.stage || (hp <= 0 ? (res.type === 'tree' ? 'stump' : 'empty') : 'full');

      // 1. Shake offset during hit
      let drawX = res.x;
      let drawY = res.y;
      if (res.hitTime > 0) {
        const intensity = (res.hitTime / 0.22) * 5;
        drawX += (Math.random() - 0.5) * intensity;
        drawY += (Math.random() - 0.5) * intensity;
      }

      // 2. Punch scale recoil & degradation size reduction
      const punch = res.punchScale || 1;
      const degradationScale = 0.84 + 0.16 * ratio;
      const baseRadius = (res.radius || 18) * degradationScale * punch;

      const isHitFlashing = (res.hitTime || 0) > 0.03;

      switch (res.type) {
        case 'tree':
          this._drawTree(ctx, drawX, drawY, baseRadius, ratio, isHitFlashing, stage);
          break;
        case 'rock':
          this._drawRock(ctx, drawX, drawY, baseRadius, ratio, isHitFlashing);
          break;
        case 'bush':
          this._drawBush(ctx, drawX, drawY, baseRadius, ratio, isHitFlashing, stage);
          break;
        default:
          break;
      }

      // 3. Show sleek HP bar if damaged (only when full and damaged)
      if (hp < maxHp && stage === 'full' && hp > 0) {
        this._drawMiniHpBar(ctx, drawX, drawY - baseRadius - 8, hp, maxHp, 26);
      }
    }
  }

  _drawTree(ctx, x, y, r, ratio = 1, isHitFlashing = false, stage = 'full') {
    if (stage === 'stump') {
      // Ground Shadow
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.beginPath();
      ctx.ellipse(x, y + r * 0.45, r * 0.65, r * 0.25, 0, 0, Math.PI * 2);
      ctx.fill();

      // Wood Stump Trunk
      const trunkW = r * 0.55;
      const trunkH = r * 0.45;
      ctx.fillStyle = isHitFlashing ? '#ffffff' : '#78350f';
      ctx.fillRect(x - trunkW / 2, y, trunkW, trunkH);

      // Cut Top Surface (Light Wood Oval)
      ctx.fillStyle = isHitFlashing ? '#fef08a' : '#fef3c7';
      ctx.beginPath();
      ctx.ellipse(x, y, trunkW / 2, trunkW * 0.26, 0, 0, Math.PI * 2);
      ctx.fill();

      // Annual Tree Rings
      ctx.strokeStyle = '#b45309';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(x, y, trunkW * 0.28, trunkW * 0.14, 0, 0, Math.PI * 2);
      ctx.stroke();

      // Outer Bark Outline
      ctx.strokeStyle = '#451a03';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(x, y, trunkW / 2, trunkW * 0.26, 0, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }

    if (stage === 'branches') {
      // Ground Shadow
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.beginPath();
      ctx.ellipse(x, y + r * 0.55, r * 0.75, r * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();

      // Wood Trunk Base
      const trunkW = r * 0.45;
      const trunkH = r * 0.55;
      ctx.fillStyle = isHitFlashing ? '#ffffff' : '#78350f';
      ctx.fillRect(x - trunkW / 2, y + r * 0.1, trunkW, trunkH);

      // Growing Branches
      ctx.strokeStyle = isHitFlashing ? '#ffffff' : '#78350f';
      ctx.lineWidth = 2.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      // Branch Left
      ctx.moveTo(x, y + r * 0.15);
      ctx.lineTo(x - r * 0.55, y - r * 0.25);
      // Branch Right
      ctx.moveTo(x, y + r * 0.15);
      ctx.lineTo(x + r * 0.6, y - r * 0.2);
      // Branch Top
      ctx.moveTo(x, y + r * 0.15);
      ctx.lineTo(x + r * 0.05, y - r * 0.55);
      ctx.stroke();

      // Sprouting Foliage Puffs
      ctx.fillStyle = isHitFlashing ? '#ffffff' : '#4ade80';
      ctx.beginPath();
      ctx.arc(x - r * 0.55, y - r * 0.3, r * 0.32, 0, Math.PI * 2);
      ctx.arc(x + r * 0.6, y - r * 0.25, r * 0.3, 0, Math.PI * 2);
      ctx.arc(x + r * 0.05, y - r * 0.6, r * 0.36, 0, Math.PI * 2);
      ctx.arc(x - r * 0.1, y - r * 0.15, r * 0.22, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(20, 83, 45, 0.5)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      return;
    }

    // Ground Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.beginPath();
    ctx.ellipse(x, y + r * 0.65, r * 0.85, r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();

    // Wood Trunk (with chopped notch if damaged)
    const trunkW = r * 0.45;
    const trunkH = r * 0.6;
    ctx.fillStyle = '#78350f';
    ctx.fillRect(x - trunkW / 2, y + r * 0.2, trunkW, trunkH);

    if (ratio < 1) {
      // Chopped wood notch on trunk side
      const cutDepth = (1 - ratio) * (trunkW * 0.6);
      ctx.fillStyle = '#fef3c7'; // fresh light wood inside cut
      ctx.beginPath();
      ctx.moveTo(x - trunkW / 2, y + r * 0.35);
      ctx.lineTo(x - trunkW / 2 + cutDepth, y + r * 0.5);
      ctx.lineTo(x - trunkW / 2, y + r * 0.65);
      ctx.closePath();
      ctx.fill();
    }

    // Foliage Canopy
    if (isHitFlashing) {
      ctx.fillStyle = '#fef08a'; // Flash bright yellow-white
    } else {
      ctx.fillStyle = ratio < 0.5 ? '#15803d' : '#22c55e';
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // Secondary Canopy Layer / Highlight
    if (isHitFlashing) {
      ctx.fillStyle = '#ffffff';
    } else {
      ctx.fillStyle = ratio < 0.5 ? '#166534' : '#16a34a';
    }
    ctx.beginPath();
    ctx.arc(x - r * 0.22, y - r * 0.22, r * 0.55, 0, Math.PI * 2);
    ctx.fill();

    // Outline
    ctx.strokeStyle = isHitFlashing ? '#ffffff' : 'rgba(20, 83, 45, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  _drawRock(ctx, x, y, r, ratio = 1, isHitFlashing = false) {
    // Ground Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.beginPath();
    ctx.ellipse(x, y + r * 0.55, r * 0.95, r * 0.38, 0, 0, Math.PI * 2);
    ctx.fill();

    // Main Rock Body
    if (isHitFlashing) {
      ctx.fillStyle = '#ffffff';
    } else {
      ctx.fillStyle = ratio < 0.5 ? '#475569' : '#64748b';
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // Rock Top Highlight
    if (isHitFlashing) {
      ctx.fillStyle = '#f1f5f9';
    } else {
      ctx.fillStyle = '#94a3b8';
    }
    ctx.beginPath();
    ctx.arc(x - r * 0.28, y - r * 0.28, r * 0.45, 0, Math.PI * 2);
    ctx.fill();

    // Rock Outline
    ctx.strokeStyle = isHitFlashing ? '#ffffff' : '#334155';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Visible Fracture Cracks when damaged
    if (ratio < 1) {
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      // Primary crack line
      ctx.moveTo(x - r * 0.4, y - r * 0.2);
      ctx.lineTo(x, y + r * 0.1);
      ctx.lineTo(x + r * 0.35, y + r * 0.4);
      if (ratio <= 0.5) {
        // Additional branching fracture
        ctx.moveTo(x, y + r * 0.1);
        ctx.lineTo(x + r * 0.4, y - r * 0.3);
        ctx.moveTo(x - r * 0.1, y + r * 0.25);
        ctx.lineTo(x - r * 0.45, y + r * 0.45);
      }
      ctx.stroke();
    }
  }

  _drawBush(ctx, x, y, r, ratio = 1, isHitFlashing = false, stage = 'full') {
    // Foliage
    ctx.fillStyle = isHitFlashing ? '#ffffff' : '#15803d';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = isHitFlashing ? '#ffffff' : '#14532d';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Red Berries (only if fully grown and not depleted)
    if (stage === 'full' && ratio >= 0.4) {
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(x - r * 0.35, y - r * 0.25, 2.5, 0, Math.PI * 2);
      if (ratio >= 0.7) {
        ctx.arc(x + r * 0.3, y + r * 0.2, 2.5, 0, Math.PI * 2);
        ctx.arc(x + r * 0.1, y - r * 0.35, 2.2, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  _drawPlayers(ctx) {
    for (const p of this.players.values()) {
      if (p.isDead) continue; // Don't draw dead players

      const isLocal = p.id === this.localPlayerId;
      const radius = 16;

      // Shadow
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + radius * 0.7, radius * 0.9, radius * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();

      // Character Body Circle
      ctx.fillStyle = isLocal ? '#38bdf8' : '#a855f7';
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();

      // Border
      ctx.strokeStyle = isLocal ? '#ffffff' : '#e9d5ff';
      ctx.lineWidth = isLocal ? 2.5 : 1.5;
      ctx.stroke();

      // Direction Indicator
      if (p.dirX !== 0 || p.dirY !== 0) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(p.x + p.dirX * (radius - 2), p.y + p.dirY * (radius - 2), 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Name Tag
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 3;
      ctx.fillText(p.name, p.x, p.y - radius - 8);
      ctx.shadowBlur = 0;

      // Mini Health Bar
      this._drawMiniHpBar(ctx, p.x, p.y - radius - 6, p.hp, p.maxHp || 100, 32);
    }
  }

  _drawProjectiles(ctx) {
    const list = this.predictionEngine
      ? this.predictionEngine.getProjectilesToRender()
      : this.projectiles;

    for (const proj of list) {
      // Glow
      ctx.fillStyle = 'rgba(56, 189, 248, 0.3)';
      ctx.beginPath();
      ctx.arc(proj.x, proj.y, 8, 0, Math.PI * 2);
      ctx.fill();

      // Core bullet
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.arc(proj.x, proj.y, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(proj.x, proj.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawFx(ctx) {
    // Draw Particles
    for (const p of this.particles) {
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Draw Floating Texts
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const ft of this.floatingTexts) {
      ctx.fillStyle = ft.color;
      ctx.globalAlpha = ft.alpha;
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 4;
      ctx.fillText(ft.text, ft.x, ft.y);
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  _drawBuildPreview(ctx, localPlayer) {
    if (!this.activeBuildType || !localPlayer) return;

    const spec = this.buildingCatalog[this.activeBuildType];
    const radius = spec?.radius || 18;
    const x = this.cursorWorldPos.x;
    const y = this.cursorWorldPos.y;

    const dist = Math.hypot(x - localPlayer.x, y - localPlayer.y);
    const inRange = dist <= 160;

    // Range Circle around player
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.2)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(localPlayer.x, localPlayer.y, 160, 0, Math.PI * 2);
    ctx.stroke();

    // Ghost Preview Circle
    ctx.fillStyle = inRange ? 'rgba(59, 130, 246, 0.35)' : 'rgba(239, 68, 68, 0.35)';
    ctx.strokeStyle = inRange ? '#3b82f6' : '#ef4444';
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Label
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = inRange ? '#93c5fd' : '#fca5a5';
    ctx.fillText(`${spec?.name || 'Estructura'}`, x, y - radius - 6);
  }

  _drawMiniHpBar(ctx, x, y, hp, maxHp, barW = 32) {
    const barH = 4;
    const hpPct = Math.max(0, Math.min(1, hp / maxHp));

    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(x - barW / 2, y, barW, barH);

    ctx.fillStyle = hpPct > 0.5 ? '#22c55e' : hpPct > 0.25 ? '#f59e0b' : '#ef4444';
    ctx.fillRect(x - barW / 2, y, barW * hpPct, barH);
  }
}
