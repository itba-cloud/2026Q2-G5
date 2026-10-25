import { LocalJsonWorldRepository } from './LocalJsonWorldRepository.js';
import { RdsWorldRepository } from './RdsWorldRepository.js';

/**
 * Factory to instantiate the appropriate repository implementation based on configuration.
 * @param {object} config
 * @returns {import('./IWorldRepository.js').IWorldRepository}
 */
export function createWorldRepository(config) {
  const mode = (config.storageMode || 'local').toLowerCase();

  switch (mode) {
    case 'rds':
      return new RdsWorldRepository(config);

    case 'local':
    default:
      return new LocalJsonWorldRepository(config);
  }
}

export { LocalJsonWorldRepository, RdsWorldRepository };
