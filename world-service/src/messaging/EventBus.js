import Redis from 'ioredis';

/**
 * Reconnection delay for ioredis. Before the bus is up, give up after a few
 * attempts: a world that starts without Redis logs once and moves on. Once up,
 * keep retrying: an ElastiCache failover takes tens of seconds, and giving up
 * would leave the world without the bus until it restarts.
 * @param {number} attempt
 * @param {boolean} connected
 * @returns {number|null} delay in ms, or null to stop
 */
export function retryDelay(attempt, connected) {
  if (connected) return Math.min(attempt * 200, 2000);
  return attempt > 3 ? null : Math.min(attempt * 200, 1000);
}


/**
 * Cross-world message bus backed by Redis Pub/Sub.
 *
 * Every world instance publishes to and subscribes from a single shared channel,
 * so worlds exchange messages without knowing about each other's existence.
 *
 * The bus is deliberately non-critical: if Redis is unreachable the world keeps
 * running with messaging silently disabled. A dropped chat line must never take
 * down a game session.
 */
export class EventBus {
  /**
   * @param {object} options
   * @param {string} options.redisUrl Connection string, e.g. redis://10.0.10.20:6379
   * @param {string} options.channel Shared Pub/Sub channel name
   * @param {string} options.worldId Identity used to discard our own echo
   * @param {string} options.worldName Human readable name stamped on outgoing messages
   * @param {Function} [options.onMessage] Invoked with each message from *other* worlds
   */
  constructor({ redisUrl, channel, worldId, worldName, onMessage = null }) {
    this.redisUrl = redisUrl;
    this.channel = channel;
    this.worldId = worldId;
    this.worldName = worldName;
    this.onMessage = onMessage;

    // Redis puts a connection into subscriber mode exclusively, so publishing
    // needs a second one.
    this.publisher = null;
    this.subscriber = null;
    this.enabled = false;
  }

  /**
   * Connects both clients and starts listening. Resolves even on failure —
   * callers get a disabled bus rather than an exception.
   * @returns {Promise<boolean>} whether the bus came up
   */
  async connect() {
    if (!this.redisUrl) {
      console.log('[EventBus] No REDIS_URL configured. Cross-world messaging disabled.');
      return false;
    }

    const options = {
      lazyConnect: true,
      retryStrategy: (attempt) => retryDelay(attempt, this.enabled),
      maxRetriesPerRequest: 1,
    };

    try {
      this.publisher = new Redis(this.redisUrl, options);
      this.subscriber = new Redis(this.redisUrl, options);

      // Attach before connecting: without a listener ioredis prints its own
      // "Unhandled error event" trace when the very first connection fails.
      this.publisher.on('error', (err) => this._handleRuntimeError(err));
      this.subscriber.on('error', (err) => this._handleRuntimeError(err));

      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);

      this.subscriber.on('message', (channel, raw) => {
        if (channel === this.channel) {
          this._handleIncoming(raw);
        }
      });

      await this.subscriber.subscribe(this.channel);

      this.enabled = true;
      console.log(`[EventBus] Connected to Redis. Subscribed to "${this.channel}".`);
      return true;
    } catch (err) {
      console.warn(`[EventBus] Could not reach Redis (${err.message}). Cross-world messaging disabled.`);
      await this.close();
      this.enabled = false;
      return false;
    }
  }

  /**
   * Swallows connection errors. Before the bus is up, connect() already reports
   * the failure to the caller, so logging here would just duplicate it; once it
   * is up, a dropped link is worth a line while ioredis retries.
   */
  _handleRuntimeError(err) {
    if (this.enabled) {
      console.warn(`[EventBus] Redis connection issue: ${err.message}`);
    }
  }

  /**
   * Parses an inbound payload and forwards it, unless we published it ourselves.
   * @param {string} raw
   */
  _handleIncoming(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      console.warn('[EventBus] Discarded malformed message from channel.');
      return;
    }

    if (!message || typeof message.type !== 'string') return;

    // Pub/Sub echoes back to the publisher; our own players already saw this.
    if (message.worldId === this.worldId) return;

    if (typeof this.onMessage === 'function') {
      try {
        this.onMessage(message);
      } catch (err) {
        console.warn(`[EventBus] Handler threw while processing ${message.type}: ${err.message}`);
      }
    }
  }

  /**
   * Publishes a message stamped with this world's identity. Failures are logged,
   * never thrown, so callers can ignore the result — but the promise is returned
   * so a shutdown path can await the flush before closing the connection.
   * @param {string} type
   * @param {object} data Merged into the envelope
   * @returns {Promise<void>}
   */
  publish(type, data = {}) {
    if (!this.enabled || !this.publisher) return Promise.resolve();

    const envelope = JSON.stringify({
      type,
      worldId: this.worldId,
      worldName: this.worldName,
      timestamp: new Date().toISOString(),
      ...data,
    });

    return this.publisher.publish(this.channel, envelope).catch((err) => {
      console.warn(`[EventBus] Failed to publish ${type}: ${err.message}`);
    });
  }

  async close() {
    this.enabled = false;

    const shutdown = async (client, label) => {
      if (!client) return;
      try {
        await client.quit();
      } catch {
        // A half-open socket can reject quit(); drop it outright.
        try {
          client.disconnect();
        } catch {
          console.warn(`[EventBus] Could not cleanly close ${label} connection.`);
        }
      }
    };

    await shutdown(this.subscriber, 'subscriber');
    await shutdown(this.publisher, 'publisher');

    this.subscriber = null;
    this.publisher = null;
  }
}

/**
 * Message types carried on the shared channel.
 */
export const BusMessageTypes = Object.freeze({
  CHAT: 'CHAT',
  WORLD_ONLINE: 'WORLD_ONLINE',
  WORLD_OFFLINE: 'WORLD_OFFLINE',
  ANNOUNCEMENT: 'ANNOUNCEMENT',
});
