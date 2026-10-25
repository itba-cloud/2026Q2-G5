import { loadRuntimeConfig } from '../../shared/runtime/config.js';
import { RdsWorldRepository } from '../../store/RdsWorldRepository.js';

// Administrative deployment task: invoked by Terraform, never by either ALB.
// runMigrations serializes deployments using PostgreSQL's migration lock.
export function createMigrationHandler(load = loadRuntimeConfig, repository = config => new RdsWorldRepository(config)) {
  return async () => {
    const worlds = repository(await load());
    try {
      await worlds.init({ migrate: true });
      return { success: true };
    } finally { await worlds.close().catch(() => {}); }
  };
}

export const handler = createMigrationHandler();
