import { createHttpRuntime } from '../../shared/runtime/http.js';
import { AnnouncementPublisher } from '../../modules/messaging/AnnouncementPublisher.js';

export async function createInternalRuntime(overrides = {}) {
  const runtime = await createHttpRuntime(overrides);
  const publisher = new AnnouncementPublisher({ redisUrl: runtime.config.redisUrl, channel: runtime.config.globalChannel });
  const announcements = { async announce(message) {
    if (!publisher.enabled || publisher.client?.status !== 'ready') {
      if (publisher.client) await publisher.close();
      await publisher.connect();
    }
    return publisher.announce(message);
  } };
  return { ...runtime, announcements,
    async close() { await publisher.close(); await runtime.close(); } };
}
