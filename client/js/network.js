/**
 * NetworkClient: Manages real-time WebSocket connection to the World Service.
 */
export class NetworkClient {
  constructor() {
    this.ws = null;
    this.playerId = null;
    this.listeners = new Map();
    this.isConnected = false;

    // Simulated RTT latency in milliseconds (0 = direct, 150 = realistic cloud ping)
    this.simulatedLatencyMs = 0;
    if (typeof window !== 'undefined' && window.location && window.location.search) {
      const params = new URLSearchParams(window.location.search);
      const latParam = params.get('latency');
      if (latParam !== null && !isNaN(Number(latParam))) {
        this.simulatedLatencyMs = Math.max(0, parseInt(latParam, 10));
      }
    }
  }

  /**
   * Sets artificial network RTT delay in milliseconds.
   * @param {number} ms
   */
  setSimulatedLatency(ms) {
    this.simulatedLatencyMs = Math.max(0, Number(ms) || 0);
    console.log(`[NetworkClient] Simulated RTT latency set to ${this.simulatedLatencyMs}ms (${this.simulatedLatencyMs / 2}ms one-way)`);
  }

  /**
   * Registers an event callback.
   * @param {string} event
   * @param {Function} callback
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  _emit(event, data) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(data);
        } catch (err) {
          console.error(`[NetworkClient] Error in listener for ${event}:`, err);
        }
      }
    }
  }

  /**
   * Connects to a World Service WebSocket instance with automatic retries during spin-up.
   * @param {string} wsUrl
   * @param {string} playerName
   * @param {number} [maxRetries=4]
   * @param {number} [retryDelayMs=600]
   * @returns {Promise<object>} Resolves with INIT packet payload
   */
  async connect(wsUrl, playerName, maxRetries = 4, retryDelayMs = 600, expectedWorldId = null) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this._attemptConnect(wsUrl, playerName, expectedWorldId);
      } catch (err) {
        if (err.code === 'WORLD_MISMATCH') throw err;
        lastError = err;
        if (attempt < maxRetries) {
          console.log(`[NetworkClient] Connection attempt ${attempt}/${maxRetries} to ${wsUrl} not ready (${err.message}). Retrying in ${retryDelayMs}ms...`);
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
      }
    }
    throw lastError;
  }

  _attemptConnect(wsUrl, playerName, expectedWorldId) {
    return new Promise((resolve, reject) => {
      try {
        if (this.ws) {
          this.disconnect();
        }

        console.log(`[NetworkClient] Connecting to ${wsUrl}...`);
        this.ws = new WebSocket(wsUrl);

        let isResolved = false;

        const connectTimeout = setTimeout(() => {
          if (!isResolved) {
            this.disconnect();
            reject(new Error('Tiempo de espera agotado al conectar al servidor'));
          }
        }, 5000);

        this.ws.onopen = () => {
          console.log('[NetworkClient] WebSocket connected. Sending JOIN packet...');
          this.isConnected = true;
          this._emit('open');

          // Send JOIN packet
          this.send('JOIN', { playerName });
        };

        this.ws.onmessage = (event) => {
          const processIncoming = () => {
            try {
              const data = JSON.parse(event.data);
              const { type, payload } = data;
              if (type === 'INIT' && expectedWorldId && payload.worldId !== expectedWorldId) {
                isResolved = true;
                clearTimeout(connectTimeout);
                this.disconnect();
                reject(Object.assign(new Error('El puerto pertenece a otro mundo. Actualizá la lista antes de conectarte.'), { code: 'WORLD_MISMATCH' }));
                return;
              }

              // Always emit event by type so all subscribers (e.g. RESOURCE_DAMAGED, RESOURCE_HARVESTED, etc.) receive it
              this._emit(type, payload);

              // Maintain legacy alias handlers
              switch (type) {
                case 'INIT':
                  this.playerId = payload.playerId;
                  if (!isResolved) {
                    isResolved = true;
                    clearTimeout(connectTimeout);
                    resolve(payload);
                  }
                  this._emit('init', payload);
                  break;

                case 'STATE_SYNC':
                  this._emit('stateSync', payload);
                  break;

                case 'PLAYER_JOINED':
                  this._emit('playerJoined', payload.player);
                  break;

                case 'PLAYER_LEFT':
                  this._emit('playerLeft', payload.playerId);
                  break;

                case 'ERROR':
                  this._emit('error', payload.message);
                  break;

                default:
                  break;
              }
            } catch (err) {
              console.error('[NetworkClient] Failed to parse message:', err);
            }
          };

          if (this.simulatedLatencyMs > 0) {
            setTimeout(processIncoming, this.simulatedLatencyMs / 2);
          } else {
            processIncoming();
          }
        };

        this.ws.onclose = (event) => {
          this.isConnected = false;
          this._emit('close', event);
          if (!isResolved) {
            isResolved = true;
            clearTimeout(connectTimeout);
            reject(new Error('Conexión rechazada o cerrada por el servidor'));
          }
        };

        this.ws.onerror = (err) => {
          this._emit('error', err);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Sends formatted JSON message over WebSocket.
   * @param {string} type
   * @param {object} payload
   */
  send(type, payload = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const serialized = JSON.stringify({ type, payload });
      if (this.simulatedLatencyMs > 0) {
        setTimeout(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(serialized);
          }
        }, this.simulatedLatencyMs / 2);
      } else {
        this.ws.send(serialized);
      }
    }
  }

  /**
   * Sends directional movement input.
   * @param {{ x: number, y: number }} direction
   */
  sendMove(direction) {
    this.send('MOVE', { direction });
  }

  /**
   * Closes active socket connection.
   */
  disconnect() {
    if (this.ws) {
      this.ws.onclose = null; // Prevent extra close handlers
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.playerId = null;
  }
}
