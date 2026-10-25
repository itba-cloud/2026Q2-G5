/**
 * LobbyApiRepository: Read-only view of the world and host registry, obtained from
 * the Lobby Service REST API.
 *
 * The collector only needs `listWorlds()` and `listHosts()`. Reading them over HTTP
 * keeps this service free of any disk or database dependency: it runs on its own
 * host and follows whatever registry the Lobby is using. A Lobby that does not
 * answer yields an empty registry for that cycle, which the collector already treats
 * as "nothing active" rather than as a failure.
 */
export class LobbyApiRepository {
  /**
   * @param {object} params
   * @param {string} params.lobbyUrl Base URL of the Lobby Service, e.g. http://10.0.10.5:3000
   * @param {number} [params.timeoutMs] Per-request timeout
   */
  constructor({ lobbyUrl, timeoutMs = 2000 }) {
    this.lobbyUrl = lobbyUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    /** @type {boolean} whether the last request to the Lobby succeeded */
    this.lobbyReachable = false;
  }

  async init() {}

  /**
   * @returns {Promise<object[]>}
   */
  async listWorlds() {
    const data = await this._fetchJson('/api/worlds');
    return Array.isArray(data?.worlds) ? data.worlds : [];
  }

  /**
   * @returns {Promise<object[]>}
   */
  async listHosts() {
    const data = await this._fetchJson('/api/hosts');
    return Array.isArray(data?.hosts) ? data.hosts : [];
  }

  /**
   * Fetches JSON from the Lobby, resolving to null on any failure or timeout.
   * @param {string} path
   * @returns {Promise<object|null>}
   */
  async _fetchJson(path) {
    try {
      const res = await fetch(`${this.lobbyUrl}${path}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        this.lobbyReachable = false;
        return null;
      }
      const data = await res.json();
      this.lobbyReachable = true;
      return data;
    } catch {
      this.lobbyReachable = false;
      return null;
    }
  }
}
