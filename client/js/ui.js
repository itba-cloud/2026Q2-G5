/**
 * UiManager: Handles DOM manipulation for Lobby, HUD, Inventory, Hotbar, and Death screens.
 */
export class UiManager {
  constructor() {
    // Views
    this.lobbyView = document.getElementById('lobby-view');
    this.gameView = document.getElementById('game-view');

    // Lobby Elements
    this.joinForm = document.getElementById('join-form');
    this.nameInput = document.getElementById('player-name-input');
    this.worldsList = document.getElementById('worlds-list');
    this.customWsUrlInput = document.getElementById('custom-ws-url');
    this.btnConnect = document.getElementById('btn-connect');
    this.lobbyStatusMsg = document.getElementById('lobby-status-msg');
    this.btnRefreshWorlds = document.getElementById('btn-refresh-worlds');
    this.btnOpenCreateWorld = document.getElementById('btn-open-create-world');

    // Create World Modal Elements
    this.createWorldModal = document.getElementById('create-world-modal');
    this.createWorldForm = document.getElementById('create-world-form');
    this.btnCloseCreateModal = document.getElementById('btn-close-create-modal');
    this.btnCancelCreate = document.getElementById('btn-cancel-create');
    this.newWorldNameInput = document.getElementById('new-world-name');
    this.newWorldSeedInput = document.getElementById('new-world-seed');
    this.newWorldBiomeSelect = document.getElementById('new-world-biome');
    this.newWorldBotsInput = document.getElementById('new-world-bots');
    this.createWorldStatusMsg = document.getElementById('create-world-status-msg');
    this.btnSubmitCreate = document.getElementById('btn-submit-create');

    // HUD Elements
    this.hudPlayerName = document.getElementById('hud-player-name');
    this.hudHealthBar = document.getElementById('hud-health-bar');
    this.hudHealthText = document.getElementById('hud-health-text');
    this.hudWorldName = document.getElementById('hud-world-name');
    this.hudCoords = document.getElementById('hud-coords');
    this.hudPlayersCount = document.getElementById('hud-players-count');
    this.selectSimulatedLatency = document.getElementById('select-simulated-latency');
    this.btnDisconnect = document.getElementById('btn-disconnect');
    this.hudToast = document.getElementById('hud-toast');

    // Cross-World Chat Elements
    this.chatLog = document.getElementById('chat-log');
    this.chatInput = document.getElementById('chat-input');
    this.chatPresets = document.querySelectorAll('.chat-preset');

    // Inventory & Hotbar Elements
    this.invWood = document.getElementById('inv-wood');
    this.invStone = document.getElementById('inv-stone');
    this.invFood = document.getElementById('inv-food');
    this.invKills = document.getElementById('inv-kills');
    this.invDeaths = document.getElementById('inv-deaths');
    this.btnEatFood = document.getElementById('btn-eat-food');
    this.btnHotbarEat = document.getElementById('btn-hotbar-eat');
    this.hotbarSlots = document.querySelectorAll('.hotbar-slot[data-type]');

    // Elimination / Kill Banner
    this.killBanner = document.getElementById('kill-banner');
    this.killVictimName = document.getElementById('kill-victim-name');
    this.killsCount = 0;
    this.deathsCount = 0;
    this.killBannerTimer = null;

    // Death Modal
    this.deathModal = document.getElementById('death-modal');
    this.deathMessage = document.getElementById('death-message');
    this.respawnTimer = document.getElementById('respawn-timer');

    this.toastTimer = null;
    this.countdownInterval = null;
    this.selectedStructureType = null;
    this.maxChatLines = 8;
  }

  /**
   * Appends a chat line to the log.
   *
   * Everything is written with textContent and separate elements: chat text is
   * player-authored and arrives from other worlds, so it never touches innerHTML.
   *
   * @param {object} chat
   * @param {string} chat.playerName
   * @param {string} chat.text
   * @param {string} chat.worldName Origin world
   * @param {boolean} [isRemote] Whether it came from a different world
   */
  appendChatMessage({ playerName, text, worldName }, isRemote = false) {
    if (!this.chatLog) return;

    const line = document.createElement('div');
    line.className = `chat-line${isRemote ? ' chat-remote' : ''}`;

    if (isRemote && worldName) {
      const origin = document.createElement('span');
      origin.className = 'chat-world';
      origin.textContent = `[${worldName}] `;
      line.appendChild(origin);
    }

    const author = document.createElement('span');
    author.className = 'chat-author';
    author.textContent = `${playerName}: `;
    line.appendChild(author);

    line.appendChild(document.createTextNode(text));

    this._pushChatLine(line);
  }

  /**
   * Appends a system notice (a world waking up or going to sleep).
   * @param {string} message
   */
  appendChatNotice(message) {
    if (!this.chatLog) return;

    const line = document.createElement('div');
    line.className = 'chat-line chat-notice';
    line.textContent = message;

    this._pushChatLine(line);
  }

  _pushChatLine(line) {
    this.chatLog.appendChild(line);

    while (this.chatLog.childElementCount > this.maxChatLines) {
      this.chatLog.removeChild(this.chatLog.firstElementChild);
    }

    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  focusChatInput() {
    if (this.chatInput) {
      this.chatInput.focus();
    }
  }

  clearChatLog() {
    if (this.chatLog) {
      this.chatLog.replaceChildren();
    }
  }

  openCreateWorldModal() {
    if (!this.createWorldModal) return;
    this.createWorldModal.classList.remove('hidden');
    if (this.newWorldNameInput) {
      this.newWorldNameInput.value = '';
      this.newWorldNameInput.focus();
    }
    if (this.newWorldSeedInput) {
      this.newWorldSeedInput.value = '';
    }
    if (this.newWorldBotsInput) {
      this.newWorldBotsInput.value = '2';
    }
    this.setCreateWorldStatus(null);
    this.setCreatingWorld(false);
  }

  closeCreateWorldModal() {
    if (!this.createWorldModal) return;
    this.createWorldModal.classList.add('hidden');
  }

  setCreatingWorld(isCreating) {
    if (this.btnSubmitCreate) {
      this.btnSubmitCreate.disabled = isCreating;
      this.btnSubmitCreate.textContent = isCreating ? '⏳ Creando...' : 'Crear y Aprovisionar';
    }
  }

  setCreateWorldStatus(message, type = 'error') {
    if (!this.createWorldStatusMsg) return;
    if (!message) {
      this.createWorldStatusMsg.classList.add('hidden');
      this.createWorldStatusMsg.textContent = '';
      return;
    }
    this.createWorldStatusMsg.textContent = message;
    this.createWorldStatusMsg.className = `status-message status-${type}`;
    this.createWorldStatusMsg.classList.remove('hidden');
  }

  showLobby() {
    this.lobbyView.classList.remove('view-hidden');
    this.lobbyView.classList.add('view-active');

    this.gameView.classList.remove('view-active');
    this.gameView.classList.add('view-hidden');

    this.hideDeathModal();
    this.setConnecting(false);
  }

  showGame() {
    this.lobbyView.classList.remove('view-active');
    this.lobbyView.classList.add('view-hidden');

    this.gameView.classList.remove('view-hidden');
    this.gameView.classList.add('view-active');
  }

  setConnecting(isConnecting) {
    if (this.btnConnect) {
      this.btnConnect.disabled = isConnecting;
      this.btnConnect.textContent = isConnecting ? '⏳ Conectando...' : '🚀 Entrar al Mundo';
    }
  }

  setLobbyStatus(message, type = 'info') {
    if (!this.lobbyStatusMsg) return;

    if (!message) {
      this.lobbyStatusMsg.classList.add('hidden');
      this.lobbyStatusMsg.textContent = '';
      return;
    }

    this.lobbyStatusMsg.textContent = message;
    this.lobbyStatusMsg.className = `status-message status-${type}`;
    this.lobbyStatusMsg.classList.remove('hidden');
  }

  showWorldsLoading() {
    if (!this.worldsList) return;
    this.worldsList.innerHTML = `
      <div class="worlds-loading">
        <div class="spinner"></div>
        <span>Cargando mundos...</span>
      </div>
    `;
  }

  renderWorldsList(worlds, onSelectWorld, selectedWorldId = null) {
    if (!this.worldsList) return;
    this.worldsList.innerHTML = '';

    if (!worlds || worlds.length === 0) {
      this.worldsList.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;padding:8px;">No se encontraron mundos disponibles.</p>';
      return;
    }

    worlds.forEach((w, idx) => {
      const isSelected = selectedWorldId ? w.id === selectedWorldId : idx === 0;
      const card = document.createElement('div');
      card.className = `world-card ${isSelected ? 'world-card-selected' : ''}`;
      card.dataset.url = w.wsUrl || '';
      card.dataset.id = w.id;

      const biomeIcon = w.biome === 'desert' ? '🏜️' : w.biome === 'tundra' ? '❄️' : '🌲';
      const isActive = w.status === 'ACTIVE';
      const statusClass = isActive ? 'status-active' : 'status-inactive';
      const statusText = ({ ACTIVE: '🟢 Activo', STARTING: '⏳ Iniciando', STOPPING: '⏳ Deteniendo', INACTIVE: '⚪ Inactivo' })[w.status] || '⚪ Sin estado';
      const playersText = typeof w.playersCount === 'number' && isActive ? `👥 ${w.playersCount}` : '';

      card.innerHTML = `
        <div class="world-card-info">
          <span class="world-name">${biomeIcon} ${w.name || w.id}</span>
          <span class="world-status ${statusClass}">${statusText} ${playersText ? `| ${playersText}` : ''}</span>
        </div>
        ${w.isDefault ? '<span class="world-badge">Principal</span>' : ''}
      `;

      card.addEventListener('click', () => {
        document.querySelectorAll('.world-card').forEach((c) => c.classList.remove('world-card-selected'));
        card.classList.add('world-card-selected');
        if (typeof onSelectWorld === 'function') {
          onSelectWorld(w);
        }
      });

      this.worldsList.appendChild(card);
    });
  }

  updateHudPlayer(player) {
    if (!player) return;
    if (this.hudPlayerName) this.hudPlayerName.textContent = player.name;

    const hp = Math.max(0, player.hp ?? 100);
    const maxHp = player.maxHp ?? 100;
    const hpPct = Math.max(0, Math.min(100, Math.round((hp / maxHp) * 100)));

    if (this.hudHealthBar) this.hudHealthBar.style.width = `${hpPct}%`;
    if (this.hudHealthText) this.hudHealthText.textContent = `${Math.round(hp)} / ${maxHp}`;

    if (player.kills !== undefined && this.invKills) {
      this.invKills.textContent = player.kills;
      this.killsCount = player.kills;
    }
    if (player.deaths !== undefined && this.invDeaths) {
      this.invDeaths.textContent = player.deaths;
      this.deathsCount = player.deaths;
    }

    if (player.inventory) {
      this.updateInventory(player.inventory);
    }
  }

  updateInventory(inventory = {}, gainedType = null, gainedAmount = 0) {
    if (this.invWood) this.invWood.textContent = inventory.wood ?? 0;
    if (this.invStone) this.invStone.textContent = inventory.stone ?? 0;
    if (this.invFood) this.invFood.textContent = inventory.food ?? 0;

    if (gainedType && gainedAmount > 0) {
      this.animateInventoryGain(gainedType, gainedAmount);
    }
  }

  animateInventoryGain(resourceType, amount) {
    let chipEl = null;
    if (resourceType === 'wood') chipEl = this.invWood?.closest('.inv-chip');
    else if (resourceType === 'stone') chipEl = this.invStone?.closest('.inv-chip');
    else if (resourceType === 'food') chipEl = this.invFood?.closest('.inv-chip');

    if (!chipEl) return;

    // 1. Pop / Bump animation on chip
    chipEl.classList.remove('inv-chip-bump');
    void chipEl.offsetWidth; // Force reflow
    chipEl.classList.add('inv-chip-bump');
    setTimeout(() => {
      chipEl.classList.remove('inv-chip-bump');
    }, 400);

    // 2. Ephemeral floating "+X" badge
    const badge = document.createElement('div');
    badge.className = 'inv-gain-badge';
    badge.textContent = `+${amount}`;
    chipEl.appendChild(badge);

    setTimeout(() => {
      if (badge.parentNode) {
        badge.parentNode.removeChild(badge);
      }
    }, 1200);
  }

  selectHotbarStructure(type) {
    this.selectedStructureType = type;
    this.hotbarSlots.forEach((slot) => {
      if (slot.dataset.type === type) {
        slot.classList.add('active');
      } else {
        slot.classList.remove('active');
      }
    });
  }

  clearHotbarSelection() {
    this.selectedStructureType = null;
    this.hotbarSlots.forEach((slot) => slot.classList.remove('active'));
  }

  updateHudCoords(x, y) {
    if (this.hudCoords) {
      this.hudCoords.textContent = `X: ${Math.round(x)} | Y: ${Math.round(y)}`;
    }
  }

  updateHudWorld(worldId, playerCount = 1) {
    if (this.hudWorldName) this.hudWorldName.textContent = worldId || 'Bosque Inicial';
    if (this.hudPlayersCount) this.hudPlayersCount.textContent = `👥 ${playerCount} ${playerCount === 1 ? 'jugador' : 'jugadores'}`;
  }

  showToast(message, type = 'info', duration = 3000) {
    if (!this.hudToast) return;

    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
    }

    this.hudToast.textContent = message;
    let typeClass = '';
    if (type === 'kill') typeClass = 'toast-kill';
    else if (type === 'death') typeClass = 'toast-death';
    else if (type === 'warning') typeClass = 'toast-warning';
    else if (type === 'error') typeClass = 'toast-error';

    this.hudToast.className = `hud-toast ${typeClass}`.trim();
    this.hudToast.classList.remove('hidden');

    this.toastTimer = setTimeout(() => {
      this.hudToast.classList.add('hidden');
    }, duration);
  }

  showKillFeedback(victimName, newKills = null) {
    if (newKills !== null && newKills !== undefined) {
      this.killsCount = newKills;
    } else {
      this.killsCount += 1;
    }
    if (this.invKills) {
      this.invKills.textContent = this.killsCount;
    }

    // 1. Pop effect & floating badge on Kills chip in HUD
    const killsChip = this.invKills?.closest('.inv-chip');
    if (killsChip) {
      killsChip.classList.remove('kills-bump');
      void killsChip.offsetWidth;
      killsChip.classList.add('kills-bump');

      const badge = document.createElement('div');
      badge.className = 'inv-gain-badge';
      badge.style.background = 'linear-gradient(135deg, #ef4444, #b91c1c)';
      badge.style.color = '#ffffff';
      badge.textContent = '+1 🎯';
      killsChip.appendChild(badge);

      setTimeout(() => {
        killsChip.classList.remove('kills-bump');
        if (badge.parentNode) badge.parentNode.removeChild(badge);
      }, 1200);
    }

    // 2. Kill Banner across top center of screen (sleek red notification)
    if (this.killBanner && this.killVictimName) {
      if (this.killBannerTimer) clearTimeout(this.killBannerTimer);

      this.killVictimName.textContent = victimName || 'un jugador';
      this.killBanner.classList.remove('hidden');

      this.killBannerTimer = setTimeout(() => {
        this.killBanner.classList.add('hidden');
      }, 3000);
    }
  }

  showDeathModal(killerName, delaySeconds = 3, newDeaths = null) {
    if (newDeaths !== null && newDeaths !== undefined) {
      this.deathsCount = newDeaths;
    } else {
      this.deathsCount += 1;
    }
    if (this.invDeaths) {
      this.invDeaths.textContent = this.deathsCount;
    }

    // Animate deaths chip in HUD
    const deathsChip = this.invDeaths?.closest('.inv-chip');
    if (deathsChip) {
      deathsChip.classList.remove('deaths-bump');
      void deathsChip.offsetWidth;
      deathsChip.classList.add('deaths-bump');

      const badge = document.createElement('div');
      badge.className = 'inv-gain-badge';
      badge.style.background = 'linear-gradient(135deg, #ef4444, #991b1b)';
      badge.style.color = '#ffffff';
      badge.textContent = '+1 💀';
      deathsChip.appendChild(badge);

      setTimeout(() => {
        deathsChip.classList.remove('deaths-bump');
        if (badge.parentNode) badge.parentNode.removeChild(badge);
      }, 1200);
    }

    if (this.deathMessage) {
      const killerDisplay = killerName ? `<b>${killerName}</b>` : 'un jugador';
      this.deathMessage.innerHTML = `Te ha eliminado ${killerDisplay}.`;
    }

    let remaining = delaySeconds;
    if (this.respawnTimer) this.respawnTimer.textContent = remaining;

    if (this.deathModal) this.deathModal.classList.remove('hidden');

    // Distinct colored Toast (Red)
    this.showToast(`💀 Fuiste eliminado por ${killerName || 'un proyectil'}`, 'death', 3500);

    if (this.countdownInterval) clearInterval(this.countdownInterval);
    this.countdownInterval = setInterval(() => {
      remaining -= 1;
      if (this.respawnTimer) {
        this.respawnTimer.textContent = Math.max(0, remaining);
      }
      if (remaining <= 0) {
        clearInterval(this.countdownInterval);
        if (this.respawnTimer) {
          this.respawnTimer.textContent = '...';
        }
      }
    }, 1000);
  }

  hideDeathModal() {
    if (this.countdownInterval) clearInterval(this.countdownInterval);
    if (this.deathModal) this.deathModal.classList.add('hidden');
  }
}
