import { ClientConfig } from './config.js';

/**
 * ApiClient: HTTP client for interacting with the Lobby Service (REST API).
 * Includes automatic port retry, on-demand world activation, and offline fallbacks.
 */
export class ApiClient {
  constructor(baseUrl = ClientConfig.lobbyApiUrl, options = {}) {
    this.baseUrl = baseUrl;
    this.fallbackUrl = ClientConfig.fallbackLobbyApiUrl;
    this.request = options.fetch || globalThis.fetch.bind(globalThis);
    this.wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = options.now || Date.now;
    this.pollTimeoutMs = options.pollTimeoutMs || 120000;
    this.storage = options.storage;
    try { if (this.storage === undefined) this.storage = globalThis.sessionStorage; } catch { this.storage = null; }
    this.intents = new Map();
    try { this.intents = new Map(JSON.parse(this.storage?.getItem(this._storageKey()) || '[]')); } catch { /* unavailable storage */ }
    this.hasAsyncOperations = this.intents.size > 0;
  }

  /**
   * Fetches active game worlds from Lobby Service.
   * Probes primary lobby port (3000) and fallback port (3001) before using local offline fallback.
   * @returns {Promise<Array<{ id: string, name: string, status: string, wsUrl: string|null, playersCount: number }>>}
   */
  async fetchWorlds() {
    const urlsToTry = [this.baseUrl, this.fallbackUrl].filter(Boolean);

    for (const url of urlsToTry) {
      try {
        const res = await this.request(`${url}/worlds`, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(4000),
        });

        if (res.ok) {
          const data = await res.json();
          this.baseUrl = url; // Remember working lobby URL
          return Array.isArray(data) ? data : data.worlds || [];
        }
      } catch {
        // Continue to next probe
      }
    }

    if (this.hasAsyncOperations) throw new Error('No se pudo consultar el Lobby. Tu operación sigue registrada; volvé a consultar en unos segundos.');
    console.warn('[ApiClient] Lobby API unreachable at 3000/3001. Using offline default world.');

    // Default local world instance fallback
    return [
      {
        id: 'world-01',
        name: '🌲 Bosque Inicial (Local)',
        status: 'ACTIVE',
        wsUrl: 'ws://localhost:8001',
        playersCount: 0,
        isDefault: true,
      },
    ];
  }

  /**
   * Requests Lobby Service to provision and start a new world instance.
   * @param {string} worldName
   * @param {object} [config={}]
   * @returns {Promise<{ worldId: string, wsUrl: string }>}
   */
  async createWorld(worldName, config = {}, options = {}) {
    return this._mutate('/worlds', { name: worldName, ...config }, options);
  }

  async getWorld(worldId) {
    const response = await this.request(`${this.baseUrl}/worlds/${encodeURIComponent(worldId)}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('No se pudo verificar el estado actual del mundo');
    return (await response.json()).world;
  }

  async startWorld(worldId, options = {}) {
    return this._mutate(`/worlds/${encodeURIComponent(worldId)}/start`, {}, { ...options, requireActive: true });
  }

  _storageKey() { return `ewo:lobby-intents:${this.baseUrl}`; }

  _save() {
    try { this.storage?.setItem(this._storageKey(), JSON.stringify([...this.intents])); } catch { /* storage may be disabled */ }
  }

  _forgetOperation(operationId) {
    for (const [signature, intent] of this.intents) if (intent.operationId === operationId) this.intents.delete(signature);
    this._save();
  }

  _key() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async _mutate(path, payload, options) {
    const body = JSON.stringify(payload);
    const signature = `${path}:${body}`;
    const intent = this.intents.get(signature) || { key: this._key() };
    this.intents.set(signature, intent);
    this._save();
    let data;
    if (!intent.operationId) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          options.signal?.throwIfAborted();
          const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
          const response = await this.request(`${this.baseUrl}${path}`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': intent.key }, body, signal });
          data = await response.json();
          if (response.status >= 500) throw new Error('Servicio temporalmente no disponible');
          if (!response.ok && !(response.status === 409 && data.operationId)) {
            this.intents.delete(signature);
            this._save();
            throw Object.assign(new Error(data.error || `Error del Lobby (${response.status})`), { definitive: true });
          }
          if (response.status === 202 || data.operationId) {
            intent.operationId = data.operationId;
            this.hasAsyncOperations = true;
            this._save();
          }
          break;
        } catch (error) {
          if (error.definitive || options.signal?.aborted) throw error;
          if (attempt === 2) throw Object.assign(new Error('No se pudo confirmar la solicitud. Volvé a intentar: conservamos la misma clave para evitar duplicarla.'), { pending: true });
          await this.wait(300 * (attempt + 1));
        }
      }
    }
    if (intent.operationId) data = await this.waitForOperation(intent.operationId, options);
    this.intents.delete(signature);
    this._save();
    if (options.requireActive && (!data?.world || data.world.status !== 'ACTIVE' || !data.world.wsUrl)) {
      throw new Error('El mundo todavía no tiene un servidor activo para conectarse');
    }
    return data;
  }

  async waitForOperation(operationId, { signal, onProgress = () => {} } = {}) {
    const deadline = this.now() + this.pollTimeoutMs;
    let delay = 500;
    let previousStatus;
    while (this.now() < deadline) {
      signal?.throwIfAborted();
      let data;
      try {
        const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
        const response = await this.request(`${this.baseUrl}/operations/${encodeURIComponent(operationId)}`, { headers: { Accept: 'application/json' }, signal: requestSignal });
        if (response.ok) data = await response.json();
        else if (response.status < 500) {
          this._forgetOperation(operationId);
          throw Object.assign(new Error('No se pudo consultar la operación registrada'), { definitive: true });
        }
      } catch (error) { if (signal?.aborted || error.definitive) throw error; }
      const operation = data?.operation;
      if (operation) {
        if (previousStatus !== operation.status) { onProgress(operation.status); previousStatus = operation.status; }
        if (operation.status === 'SUCCEEDED') {
          const result = operation.result || {};
          if (result.world?.status === 'ACTIVE') {
            // Re-read the current generation; an old successful result is not an endpoint guarantee.
            const currentResponse = await this.request(`${this.baseUrl}/worlds/${encodeURIComponent(operation.worldId)}`, { signal: AbortSignal.timeout(5000) });
            if (!currentResponse.ok) throw new Error('No se pudo verificar el mundo actual');
            const current = (await currentResponse.json()).world;
            if (current?.status !== 'ACTIVE' || current.runtimeId !== result.world.runtimeId || !current.wsUrl) {
              this._forgetOperation(operationId);
              throw new Error('El mundo cambió de ejecución. Actualizá la lista antes de conectarte.');
            }
            return { success: true, ...result, world: current, wsUrl: current.wsUrl };
          }
          return { success: true, ...result };
        }
        if (['FAILED', 'CANCELLED'].includes(operation.status)) {
          // Terminal failure clears this intent, so another explicit action can use a new key.
          this._forgetOperation(operationId);
          throw new Error(operation.error?.message || 'No se pudo completar la operación');
        }
        if (operation.status === 'RECOVERY_PENDING') {
          throw Object.assign(new Error('La operación está en recuperación. Volvé a consultar en unos segundos.'), { operationId, pending: true });
        }
      }
      await this.wait(delay);
      delay = Math.min(3000, Math.round(delay * 1.5));
    }
    throw Object.assign(new Error('La operación sigue registrada, pero se agotó la espera. Volvé a consultar; no se iniciará otra.'), { operationId, pending: true });
  }
}
