import { Router } from 'express';
import { MessagingController } from './messaging.controller.js';

/**
 * Creates and configures cross-world messaging routes.
 * @param {import('./AnnouncementPublisher.js').AnnouncementPublisher} publisher
 * @param {object} config
 * @returns {Router}
 */
export function createMessagingRoutes(publisher, config) {
  const router = Router();
  const controller = new MessagingController(publisher, config.announcementMaxLength);

  // Broadcast a system message to every running world
  router.post('/announce', controller.postAnnouncement);
  router.post('/api/announce', controller.postAnnouncement);

  return router;
}
