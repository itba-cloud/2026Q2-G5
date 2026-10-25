import { createBaseApp, finishApp } from '../../shared/http/app.js';
import { createWorldApiRoutes } from '../../shared/http/world.routes.js';
import { createWorldControlRoutes } from './world-control.routes.js';
import { createHostRoutes } from '../../modules/hosts/host.routes.js';
import { createMessagingRoutes } from '../../modules/messaging/messaging.routes.js';

export function createInternalApp({ config, worlds, service, announcements }) {
  const app = createBaseApp(config, worlds);
  app.use(createWorldApiRoutes(worlds, service, { profile: 'internal' }));
  app.use(createWorldControlRoutes(worlds, service));
  app.use(createHostRoutes(worlds));
  app.use(createMessagingRoutes(announcements, config));
  return finishApp(app);
}
