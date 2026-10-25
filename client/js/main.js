import { ClientConfig } from './config.js';
import { ApiClient } from './api.js';
import { NetworkClient } from './network.js';
import { InputManager } from './input.js';
import { GameRenderer } from './renderer.js';
import { UiManager } from './ui.js';
import { PredictionEngine } from './prediction.js';

function resolveWsUrl(url) {
  if (!url) return null;
  if (typeof window !== 'undefined' && window.location.hostname) {
    try {
      const parsed = new URL(url);
      if (['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname)) {
        parsed.hostname = window.location.hostname;
        return parsed.toString();
      }
    } catch {
      // Return as-is if not valid URL object
    }
  }
  return url;
}

class GameApp {
  constructor() {
    this.api = new ApiClient();
    this.network = new NetworkClient();
    this.ui = new UiManager();

    const canvas = document.getElementById('game-canvas');
    this.renderer = new GameRenderer(canvas);

    // Modular client-side prediction engine
    this.prediction = new PredictionEngine({
      onLocalImpact: (x, y, collider) => {
        // Mirrors the palette/particle counts of the server PLAYER_HIT handler below, so a
        // predicted impact is indistinguishable from a confirmed one.
        if (collider.isPlayer) {
          this.renderer.spawnSparks(x, y, '#ef4444', 12);
          return;
        }
        const color = collider.isStructure ? '#f59e0b' : '#86efac';
        this.renderer.spawnSparks(x, y, color, collider.isStructure ? 10 : 8);
      },
    });
    this.renderer.setPredictionEngine(this.prediction);

    this.input = new InputManager({
      onDirectionChange: (direction) => {
        this.prediction.setMovement(direction);
        this.network.sendMove(direction);
      },
      onAction: (action) => {
        this._handlePlayerAction(action);
      },
    });

    this.selectedWorld = null;
    this.selectedWsUrl = ClientConfig.defaultWorldWsUrl;
  }

  async init() {
    console.log('[GameApp] Initializing Elastic Worlds Client...');

    // 1. Restore saved player name
    const savedName = localStorage.getItem(ClientConfig.storageKeys.playerName);
    if (savedName && this.ui.nameInput) {
      this.ui.nameInput.value = savedName;
    }

    if (this.ui.customWsUrlInput && !this.ui.customWsUrlInput.value) {
      this.ui.customWsUrlInput.value = ClientConfig.defaultWorldWsUrl;
    }

    // 2. Fetch available worlds from Lobby API (or local fallback)
    await this.refreshWorlds();

    // 3. Bind UI & Input Events
    this._bindEvents();
  }

  async refreshWorlds(selectedWorldId = null) {
    this.ui.showWorldsLoading();
    try {
      const worlds = await this.api.fetchWorlds();
      this.ui.renderWorldsList(worlds, (selectedWorld) => {
        this.selectedWorld = selectedWorld;
        this.selectedWsUrl = resolveWsUrl(selectedWorld.wsUrl);
        if (this.ui.customWsUrlInput) {
          this.ui.customWsUrlInput.value = this.selectedWsUrl || '';
          this.ui.customWsUrlInput.dataset.userEdited = '';
        }
      }, selectedWorldId);

      // Keep the selected record and endpoint aligned with the highlighted card.
      this.selectedWorld = worlds.find(world => world.id === selectedWorldId) || worlds[0] || null;
      this.selectedWsUrl = resolveWsUrl(this.selectedWorld?.wsUrl);
      if (this.ui.customWsUrlInput && !this.ui.customWsUrlInput.dataset.userEdited) {
        this.ui.customWsUrlInput.value = this.selectedWsUrl || '';
      }
    } catch (err) {
      console.warn('[GameApp] Could not fetch worlds:', err);
    }
  }

  _bindEvents() {
    // Form Submit (Join Game)
    this.ui.joinForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.joinGame();
    });

    // Refresh worlds button
    if (this.ui.btnRefreshWorlds) {
      this.ui.btnRefreshWorlds.addEventListener('click', async () => {
        this.ui.btnRefreshWorlds.textContent = '⏳';
        await this.refreshWorlds();
        this.ui.btnRefreshWorlds.textContent = '🔄';
        this.ui.showToast('Lista de mundos actualizada', 'info');
      });
    }

    // Open Create World Modal
    if (this.ui.btnOpenCreateWorld) {
      this.ui.btnOpenCreateWorld.addEventListener('click', () => {
        this.ui.openCreateWorldModal();
      });
    }

    // Close Create World Modal
    if (this.ui.btnCloseCreateModal) {
      this.ui.btnCloseCreateModal.addEventListener('click', () => {
        this.createWorldAbort?.abort();
        this.ui.closeCreateWorldModal();
      });
    }
    if (this.ui.btnCancelCreate) {
      this.ui.btnCancelCreate.addEventListener('click', () => {
        this.createWorldAbort?.abort();
        this.ui.closeCreateWorldModal();
      });
    }

    // Create World Form Submit
    if (this.ui.createWorldForm) {
      this.ui.createWorldForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = this.ui.newWorldNameInput?.value.trim();
        const seedStr = this.ui.newWorldSeedInput?.value.trim();
        const biome = this.ui.newWorldBiomeSelect?.value || 'forest';
        const botCountStr = this.ui.newWorldBotsInput?.value.trim();
        const botCount = botCountStr !== '' && !isNaN(Number(botCountStr)) ? Math.max(0, parseInt(botCountStr, 10)) : 2;

        if (!name) {
          this.ui.setCreateWorldStatus('Ingresa un nombre para el mundo', 'error');
          return;
        }

        const seed = seedStr ? parseInt(seedStr, 10) : undefined;

        this.createWorldAbort = new AbortController();
        this.ui.setCreatingWorld(true);
        this.ui.setCreateWorldStatus(null);

        try {
          const res = await this.api.createWorld(name, { seed, biome, botCount }, {
            signal: this.createWorldAbort.signal,
            onProgress: status => this.ui.setCreateWorldStatus(status === 'ACCEPTED' ? 'Solicitud aceptada…' : 'Iniciando el mundo…', 'info'),
          });
          const newWorld = res.world || res;
          this.ui.closeCreateWorldModal();
          this.ui.showToast(`✨ Mundo "${name}" creado exitosamente`, 'success');
          await this.refreshWorlds(newWorld.id || res.worldId);
        } catch (err) {
          if (err.name !== 'AbortError') this.ui.setCreateWorldStatus(err.message || 'Error al crear mundo', err.pending ? 'info' : 'error');
        } finally {
          this.createWorldAbort = null;
          this.ui.setCreatingWorld(false);
        }
      });
    }

    // Custom WS URL change
    if (this.ui.customWsUrlInput) {
      this.ui.customWsUrlInput.addEventListener('input', (e) => {
        this.ui.customWsUrlInput.dataset.userEdited = 'true';
        this.selectedWsUrl = e.target.value.trim();
      });
    }

    // Disconnect Button
    if (this.ui.btnDisconnect) {
      this.ui.btnDisconnect.addEventListener('click', () => {
        this.leaveGame('Has salido de la partida.');
      });
    }

    // Simulated Latency Selector (Dev/Testing tool)
    if (this.ui.selectSimulatedLatency) {
      if (this.network.simulatedLatencyMs > 0) {
        this.ui.selectSimulatedLatency.value = String(this.network.simulatedLatencyMs);
      }
      this.ui.selectSimulatedLatency.addEventListener('change', (e) => {
        const ms = parseInt(e.target.value, 10) || 0;
        this.network.setSimulatedLatency(ms);
        this.ui.showToast(`🌐 Latencia simulada: ${ms}ms (RTT)`, 'info');
      });
    }

    // Hotbar click events
    this.ui.hotbarSlots.forEach((slot) => {
      slot.addEventListener('click', (e) => {
        e.stopPropagation();
        const type = slot.dataset.type;
        this._toggleBuild(type);
      });
    });

    // Hotbar eat button
    if (this.ui.btnHotbarEat) {
      this.ui.btnHotbarEat.addEventListener('click', (e) => {
        e.stopPropagation();
        this.network.send('USE_ITEM', { item: 'food' });
      });
    }

    if (this.ui.btnEatFood) {
      this.ui.btnEatFood.addEventListener('click', (e) => {
        e.stopPropagation();
        this.network.send('USE_ITEM', { item: 'food' });
      });
    }

    // Track mouse on canvas for building preview
    window.addEventListener('mousemove', (e) => {
      this.renderer.updateCursorScreenPos(e.clientX, e.clientY);
    });

    // Cross-World Chat
    this._bindChatEvents();

    // Network Events
    this._bindNetworkEvents();
  }

  /**
   * Wires the chat box.
   *
   * The InputManager already ignores the keyboard while an <input> has focus
   * (see input.js `_isInputActive`), so typing "was" never moves the player.
   * The only thing missing is a way to reach the box without the mouse: Enter
   * focuses it, Escape gives control back to the game.
   */
  _bindChatEvents() {
    if (this.ui.chatInput) {
      this.ui.chatInput.addEventListener('keydown', (e) => {
        // Movement and hotbar keys must not leak to the window listeners.
        e.stopPropagation();

        if (e.key === 'Enter') {
          e.preventDefault();
          this._sendChat(this.ui.chatInput.value);
          this.ui.chatInput.value = '';
          this.ui.chatInput.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.ui.chatInput.value = '';
          this.ui.chatInput.blur();
        }
      });
    }

    this.ui.chatPresets.forEach((button) => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        this._sendChat(button.dataset.text);
      });
    });

    // Enter opens the chat, but only in-game: in the lobby it still submits
    // the join form.
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (!this.ui.gameView.classList.contains('view-active')) return;
      if (document.activeElement === this.ui.chatInput) return;
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

      e.preventDefault();
      this.ui.focusChatInput();
    });
  }

  _sendChat(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    this.network.send('CHAT_SEND', { text: trimmed });
  }

  _bindNetworkEvents() {
    this.network.on('init', (initData) => {
      console.log('[GameApp] Received INIT payload:', initData);
      this.prediction.init(initData);
      this.renderer.initWorld(initData);
      this.ui.updateHudPlayer(initData.player);
      this.ui.updateHudWorld(initData.worldId, initData.players?.length || 1);

      this.renderer.start();
      this.input.start();
      this.ui.showGame();
      this.ui.showToast(`¡Conectado a ${initData.worldId}!`);
    });

    this.network.on('stateSync', (syncData) => {
      this.renderer.updateState(syncData);

      // Reconcile prediction with authoritative server position
      const serverPlayer = syncData.players?.find((p) => p.id === this.network.playerId);
      if (serverPlayer) {
        this.prediction.reconcile(serverPlayer, syncData.projectiles, this.network.simulatedLatencyMs);
      }

      const local = this.renderer.getLocalPlayer();
      if (local) {
        const renderPos = this.prediction.getRenderPosition();
        this.ui.updateHudCoords(renderPos.x, renderPos.y);
        this.ui.updateHudPlayer(local);
      }
      this.ui.updateHudWorld(this.renderer.worldWidth ? 'Bosque Inicial' : 'Mundo', syncData.players?.length || 1);
    });

    this.network.on('playerJoined', (player) => {
      this.renderer.addPlayer(player);
      this.ui.showToast(`🟢 ${player.name} se unió al mundo`);
    });

    this.network.on('playerLeft', (playerId) => {
      this.renderer.removePlayer(playerId);
      this.ui.showToast(`🔴 Un jugador se ha desconectado`);
    });

    this.network.on('RESOURCE_DAMAGED', (payload) => {
      this.renderer.damageResource(payload.resourceId, payload.hp, payload.maxHp);
    });

    this.network.on('RESOURCE_HARVESTED', (payload) => {
      this.renderer.harvestResource(payload.resourceId, payload.resourceType, payload.yieldAmount);
      if (payload.harvestedBy === this.network.playerId && payload.playerInventory) {
        this.ui.updateInventory(payload.playerInventory, payload.resourceType, payload.yieldAmount);
      }
    });

    this.network.on('RESOURCE_REGENERATED', (payload) => {
      this.renderer.regenerateResource(payload);
    });

    this.network.on('STRUCTURE_BUILT', (payload) => {
      this.renderer.addStructure(payload.structure);
      if (payload.structure.ownerId === this.network.playerId && payload.playerInventory) {
        this.ui.updateInventory(payload.playerInventory);
      }
    });

    this.network.on('STRUCTURE_DESTROYED', (payload) => {
      this.renderer.removeStructure(payload.structureId);
    });

    this.network.on('PLAYER_HIT', (payload) => {
      const isLocalShooter = payload.shooterId === this.network.playerId;

      // Always show damage floating text from server confirmation
      if (payload.damage > 0) {
        const textColor = payload.type === 'STRUCTURE' ? '#f59e0b' : '#ef4444';
        this.renderer.addFloatingText(payload.x, payload.y - 12, `-${payload.damage}`, textColor);
      }

      // Only spawn server impact sparks if the shot was fired by a remote entity (another player / turret)
      // because the local player already saw immediate sparks upon local predicted impact at 0ms!
      if (!isLocalShooter) {
        if (payload.type === 'RESOURCE') {
          const color =
            payload.resourceType === 'tree'
              ? '#86efac'
              : payload.resourceType === 'rock'
                ? '#cbd5e1'
                : '#fef08a';
          this.renderer.spawnSparks(payload.x, payload.y, color, 6);
        } else if (payload.type === 'STRUCTURE') {
          this.renderer.spawnSparks(payload.x, payload.y, '#f59e0b', 10);
        } else {
          this.renderer.spawnSparks(payload.x, payload.y, '#ef4444', 12);
        }
      }
    });

    this.network.on('PLAYER_DIED', (payload) => {
      if (payload.playerId === this.network.playerId) {
        // Local player died
        this.ui.showDeathModal(payload.killerName, payload.respawnDelay || 3, payload.playerDeaths);
        this.renderer.spawnSparks(this.renderer.camera.x, this.renderer.camera.y, '#ef4444', 25);
      } else if (payload.killerId === this.network.playerId) {
        // Local player scored an elimination
        this.ui.showKillFeedback(payload.playerName, payload.killerKills);
        this.renderer.addFloatingText(
          this.renderer.camera.x,
          this.renderer.camera.y - 36,
          `🎯 ¡ELIMINASTE A ${payload.playerName.toUpperCase()}!`,
          '#22c55e',
          'bold 16px system-ui, sans-serif'
        );
      } else {
        // Observer notification (another player killed someone)
        this.ui.showToast(`☠️ ${payload.playerName} fue eliminado por ${payload.killerName}`, 'info');
      }
    });

    this.network.on('PLAYER_RESPAWNED', (payload) => {
      if (payload.playerId === this.network.playerId) {
        this.ui.hideDeathModal();
        this.ui.showToast('✨ ¡Has reaparecido!');
      }
    });

    this.network.on('TOAST', (payload) => {
      this.ui.showToast(payload.message, payload.type || 'info');
    });

    // A chat line, either from this world or relayed from another one through
    // the event bus. The server tags the origin so we don't have to guess.
    this.network.on('CHAT_MESSAGE', (payload) => {
      this.ui.appendChatMessage(payload, Boolean(payload.isRemote));
    });

    // Another world woke up or went to sleep, or the Lobby announced something.
    this.network.on('WORLD_NOTICE', (payload) => {
      const icons = {
        WORLD_ONLINE: '🌍',
        WORLD_OFFLINE: '💤',
        ANNOUNCEMENT: '📢',
      };
      this.ui.appendChatNotice(`${icons[payload.kind] || 'ℹ️'} ${payload.message}`);
    });

    this.network.on('close', () => {
      this.leaveGame('Conexión con el servidor cerrada.');
    });

    this.network.on('error', (err) => {
      this.ui.setLobbyStatus(err.message || 'Error de conexión', 'error');
    });
  }

  _handlePlayerAction(action) {
    const local = this.renderer.getLocalPlayer();
    if (!local || local.isDead) return;

    switch (action.type) {
      case 'CLICK': {
        const worldPos = this.renderer.screenToWorld(action.screenX, action.screenY);

        if (this.ui.selectedStructureType) {
          // Send BUILD action
          this.network.send('BUILD', {
            type: this.ui.selectedStructureType,
            x: worldPos.x,
            y: worldPos.y,
          });
          // Auto-clear selection after placing
          this.ui.clearHotbarSelection();
          this.renderer.setBuildPreview(null);
        } else {
          // Shoot towards click angle with immediate client-side projectile prediction.
          // The engine mirrors the server fire rate, so a rejected prediction means the
          // server would have discarded the packet too: don't send it.
          const renderPos = this.prediction.getRenderPosition();
          const angle = Math.atan2(worldPos.y - renderPos.y, worldPos.x - renderPos.x);
          const predicted = this.prediction.spawnPredictedProjectile(
            this.network.playerId,
            renderPos.x,
            renderPos.y,
            angle
          );
          if (predicted) {
            this.network.send('SHOOT', { angle });
          }
        }
        break;
      }

      case 'HARVEST': {
        this.network.send('HARVEST', {});
        break;
      }

      case 'TOGGLE_BUILD': {
        this._toggleBuild(action.structureType);
        break;
      }

      case 'CANCEL_BUILD': {
        this.ui.clearHotbarSelection();
        this.renderer.setBuildPreview(null);
        break;
      }

      case 'EAT': {
        this.network.send('USE_ITEM', { item: 'food' });
        break;
      }

      default:
        break;
    }
  }

  _toggleBuild(structureType) {
    if (this.ui.selectedStructureType === structureType) {
      this.ui.clearHotbarSelection();
      this.renderer.setBuildPreview(null);
    } else {
      this.ui.selectHotbarStructure(structureType);
      this.renderer.setBuildPreview(structureType, this.renderer.buildingCatalog);
      this.ui.showToast(`Modo construcción: ${structureType}. Haz click para colocar o ESC para cancelar.`);
    }
  }

  async joinGame() {
    const playerName = this.ui.nameInput.value.trim();
    if (!playerName) return;

    localStorage.setItem(ClientConfig.storageKeys.playerName, playerName);

    this.ui.setLobbyStatus(null);
    this.ui.setConnecting(true);

    const customUrl = this.ui.customWsUrlInput?.value.trim();
    let wsUrl = customUrl || this.selectedWsUrl || resolveWsUrl(this.selectedWorld?.wsUrl);

    const explicitCustomUrl = customUrl && this.ui.customWsUrlInput?.dataset.userEdited;
    if (this.selectedWorld && !explicitCustomUrl) {
      try {
        const started = await this.api.startWorld(this.selectedWorld.id, {
          onProgress: status => this.ui.setLobbyStatus(status === 'ACCEPTED' ? '⏳ Solicitud aceptada…' : '🚀 Comprobando o iniciando el mundo…', 'info'),
        });
        this.selectedWorld = started.world || started;
        wsUrl = resolveWsUrl(started.wsUrl || this.selectedWorld.wsUrl);
        this.selectedWsUrl = wsUrl;
        if (this.ui.customWsUrlInput) this.ui.customWsUrlInput.value = wsUrl || '';
        await this.refreshWorlds(this.selectedWorld.id);
      } catch (err) {
        this.ui.setConnecting(false);
        this.ui.setLobbyStatus(err.message, 'error');
        return;
      }
    }

    if (!wsUrl && this.selectedWorld) {
      this.ui.setConnecting(false);
      this.ui.setLobbyStatus('El mundo seleccionado todavía no tiene un servidor activo.', 'info');
      return;
    }
    if (!wsUrl) wsUrl = ClientConfig.defaultWorldWsUrl;

    try {
      this.ui.setLobbyStatus(`🔌 Conectando al servidor del mundo en ${wsUrl}...`, 'info');
      await this.network.connect(wsUrl, playerName, 4, 600, explicitCustomUrl ? null : this.selectedWorld?.id);
    } catch (err) {
      console.error('[GameApp] Connection failed:', err);
      this.ui.setConnecting(false);
      this.ui.setLobbyStatus(`No se pudo conectar a ${wsUrl}. Asegúrate de que el World Service esté corriendo.`, 'error');
    }
  }

  leaveGame(statusMessage = '') {
    this.input.stop();
    this.renderer.stop();
    this.network.disconnect();

    this.ui.clearChatLog();
    this.ui.showLobby();
    if (statusMessage) {
      this.ui.setLobbyStatus(statusMessage, 'info');
    }
  }
}

// Bootstrap on DOM ready
window.addEventListener('DOMContentLoaded', () => {
  const app = new GameApp();
  app.init();
});
