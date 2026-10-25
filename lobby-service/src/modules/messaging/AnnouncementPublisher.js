import Redis from 'ioredis';

/**
 * Same reconnection policy as the worlds' EventBus: give up quickly while
 * connecting, keep retrying once connected so an ElastiCache failover does not
 * disable announcements.
 * @param {number} attempt
 * @param {boolean} connected
 * @returns {number|null} delay in ms, or null to stop
 */
export function retryDelay(attempt, connected) {
  if (connected) return Math.min(attempt * 200, 2000);
  return attempt > 3 ? null : Math.min(attempt * 200, 1000);
}


/**
 * Publish-only client for the cross-world channel.
 *
 * The Lobby never subscribes: it announces to every world at once without
 * holding a connection to any of them. Worlds run the full duplex EventBus
 * (see world-service/src/messaging/EventBus.js) — this is deliberately the
 * smaller half of that contract, kept separate because the two services ship
 * as independent images.
 *
 * Like the world-side bus, an unreachable Redis disables announcements rather
 * than failing the Lobby.
 */
export class AnnouncementPublisher {
  /**
   * @param {object} options
   * @param {string} options.redisUrl
   * @param {string} options.channel
   */
  constructor({ redisUrl, channel }) {
    this.redisUrl = redisUrl;
    this.channel = channel;
    this.client = null;
    this.enabled = false;
  }

  async connect() {
    if (!this.redisUrl) {
      console.log('[AnnouncementPublisher] No REDIS_URL configured. Announcements disabled.');
      return false;
    }

    try {
      this.client = new Redis(this.redisUrl, {
        lazyConnect: true,
        retryStrategy: (attempt) => retryDelay(attempt, this.enabled),
        maxRetriesPerRequest: 1,
      });

      // Attached before connect(): without a listener ioredis prints its own
      // unhandled-error trace when the first connection fails.
      this.client.on('error', (err) => {
        if (this.enabled) {
          console.warn(`[AnnouncementPublisher] Redis connection issue: ${err.message}`);
        }
      });

      await this.client.connect();
      this.enabled = true;
      console.log(`[AnnouncementPublisher] Connected to Redis. Announcing on "${this.channel}".`);
      return true;
    } catch (err) {
      console.warn(`[AnnouncementPublisher] Could not reach Redis (${err.message}). Announcements disabled.`);
      await this.close();
      return false;
    }
  }

  /**
   * Broadcasts an announcement to every listening world.
   * @param {string} message
   * @returns {Promise<boolean>} whether it was actually published
   */
  async announce(message) {
    if (!this.enabled || !this.client) return false;

    const envelope = JSON.stringify({
      type: 'ANNOUNCEMENT',
      // Announcements come from the control plane, not from a world. The id
      // must not collide with a real one or that world would filter it out as
      // its own echo.
      worldId: '__lobby__',
      worldName: 'Sistema',
      message,
      timestamp: new Date().toISOString(),
    });

    try {
      await this.client.publish(this.channel, envelope);
      return true;
    } catch (err) {
      console.warn(`[AnnouncementPublisher] Failed to publish announcement: ${err.message}`);
      return false;
    }
  }

  async close() {
    this.enabled = false;
    if (!this.client) return;

    try {
      await this.client.quit();
    } catch {
      try {
        this.client.disconnect();
      } catch {
        console.warn('[AnnouncementPublisher] Could not cleanly close the connection.');
      }
    }
    this.client = null;
  }
}
