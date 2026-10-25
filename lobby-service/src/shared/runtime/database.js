import { loadRuntimeConfig } from './config.js';
import { RdsWorldRepository } from '../../store/RdsWorldRepository.js';

export async function createDatabaseRuntime(overrides = {}) {
  const config = await loadRuntimeConfig(overrides);
  const worlds = new RdsWorldRepository(config);
  try {
    await worlds.init({ migrate: false });
    return { config, worlds, close: () => worlds.close() };
  } catch (err) {
    await worlds.close().catch(() => {});
    throw err;
  }
}
