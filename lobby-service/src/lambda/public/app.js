import { createBaseApp, finishApp } from '../../shared/http/app.js';
import { createWorldApiRoutes } from '../../shared/http/world.routes.js';

export function createPublicApp({ config, worlds, service }) {
  const app = createBaseApp(config, worlds);
  app.use(createWorldApiRoutes(worlds, service, { profile: 'public' }));
  return finishApp(app);
}
