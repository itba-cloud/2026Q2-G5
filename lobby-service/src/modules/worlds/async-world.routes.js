import { createWorldApiRoutes } from '../../shared/http/world.routes.js';
import { createWorldControlRoutes } from '../../lambda/internal/world-control.routes.js';

// Adapter for the legacy/local server. Lambda packages mount their own routes.
export function createAsyncWorldRoutes(repository, service, options = {}) {
  const router = createWorldApiRoutes(repository, service, options);
  if (options.profile !== 'public') router.use(createWorldControlRoutes(repository, service));
  return router;
}
