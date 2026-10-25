/**
 * IWorldRepository: Interface / Contract for stateless world and host storage.
 * Supports swappable backends: LocalJson (dev/test), PostgreSQL/RDS (production), etc.
 */
export class IWorldRepository {
  async init() {
    throw new Error('Method not implemented: init()');
  }

  // --- World Operations ---
  async listWorlds(filter = {}) {
    throw new Error('Method not implemented: listWorlds()');
  }

  async getWorld(worldId) {
    throw new Error('Method not implemented: getWorld()');
  }

  async createWorld(worldData) {
    throw new Error('Method not implemented: createWorld()');
  }

  async updateWorld(worldId, updates) {
    throw new Error('Method not implemented: updateWorld()');
  }

  async deleteWorld(worldId) {
    throw new Error('Method not implemented: deleteWorld()');
  }

  // --- World Lifecycle Operations ---
  // Reservations serialize the start/stop transitions: reserveWorldStart() and
  // beginWorldStop() return an { outcome, world, token } claim, and every later
  // step requires that token so a stale worker cannot touch a newer reservation.
  async reserveWorldStart(worldId) {
    throw new Error('Method not implemented: reserveWorldStart()');
  }

  async attachWorldContainer(worldId, token, containerId) {
    throw new Error('Method not implemented: attachWorldContainer()');
  }

  async completeWorldStart(worldId, token, launchResult) {
    throw new Error('Method not implemented: completeWorldStart()');
  }

  async failWorldStart(worldId, token) {
    throw new Error('Method not implemented: failWorldStart()');
  }

  async beginWorldStop(worldId) {
    throw new Error('Method not implemented: beginWorldStop()');
  }

  async completeWorldStop(worldId, token) {
    throw new Error('Method not implemented: completeWorldStop()');
  }

  async listExpiredWorldStarts() {
    throw new Error('Method not implemented: listExpiredWorldStarts()');
  }

  async releaseWorldsOnDeadHost(hostId) {
    throw new Error('Method not implemented: releaseWorldsOnDeadHost()');
  }

  // --- Host Fleet Operations ---
  async listHosts(filter = {}) {
    throw new Error('Method not implemented: listHosts()');
  }

  async getHost(hostId) {
    throw new Error('Method not implemented: getHost()');
  }

  async registerHost(hostData) {
    throw new Error('Method not implemented: registerHost()');
  }

  async updateHostLoad(hostId, activeWorldsDelta = 0, updates = {}) {
    throw new Error('Method not implemented: updateHostLoad()');
  }

  async updateHostStatus(hostId, status) {
    throw new Error('Method not implemented: updateHostStatus()');
  }

  async deleteHost(hostId) {
    throw new Error('Method not implemented: deleteHost()');
  }
}
