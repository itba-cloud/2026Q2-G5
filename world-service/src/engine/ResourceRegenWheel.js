/**
 * ResourceRegenWheel: Circular timing wheel / bucket ring buffer for O(1) resource regeneration scheduling.
 *
 * Each bucket in the wheel represents 1 second in time.
 * With WHEEL_SIZE = 64 (power of 2), delays up to 63 seconds map to distinct future buckets.
 * Scheduling is O(1) and tick evaluation is O(1) amortized.
 */
export class ResourceRegenWheel {
  /**
   * @param {number} [wheelSize=64] Size of the circular buffer (must be > max delay in seconds).
   */
  constructor(wheelSize = 64) {
    this.wheelSize = wheelSize;
    this.mask = wheelSize - 1; // Bitwise mask for power of 2
    this.isPowerOfTwo = (wheelSize & (wheelSize - 1)) === 0;

    this.buckets = Array.from({ length: wheelSize }, () => []);
    this.lastProcessedSecond = Math.floor(Date.now() / 1000);
  }

  _getBucketIndex(second) {
    if (this.isPowerOfTwo) {
      return second & this.mask;
    }
    return ((second % this.wheelSize) + this.wheelSize) % this.wheelSize;
  }

  /**
   * Schedules a resource stage change after delaySeconds.
   * @param {string} resourceId
   * @param {string} targetStage e.g. 'branches' | 'full'
   * @param {number} delaySeconds Delay in seconds (e.g. 30, 60)
   * @param {number} [nowMs=Date.now()] Reference timestamp in milliseconds
   */
  schedule(resourceId, targetStage, delaySeconds, nowMs = Date.now()) {
    const currentSecond = Math.floor(nowMs / 1000);
    if (this.lastProcessedSecond === null || this.lastProcessedSecond > currentSecond) {
      this.lastProcessedSecond = currentSecond;
    }
    const dueSecond = currentSecond + Math.max(1, Math.round(delaySeconds));
    const bucketIndex = this._getBucketIndex(dueSecond);

    this.buckets[bucketIndex].push({
      resourceId,
      targetStage,
      dueSecond,
    });
  }

  /**
   * Advances the wheel to the current time and returns all events that are due.
   * Handles multi-second leaps or stalls seamlessly without missing any events.
   * @param {number} [nowMs=Date.now()] Reference timestamp in milliseconds
   * @returns {Array<{ resourceId: string, targetStage: string, dueSecond: number }>}
   */
  tick(nowMs = Date.now()) {
    const currentSecond = Math.floor(nowMs / 1000);

    if (this.lastProcessedSecond === null) {
      this.lastProcessedSecond = currentSecond;
      return [];
    }

    if (currentSecond <= this.lastProcessedSecond) {
      return [];
    }

    const expired = [];

    // Catch up for any seconds that elapsed since last tick
    while (this.lastProcessedSecond < currentSecond) {
      this.lastProcessedSecond++;
      const bucketIndex = this._getBucketIndex(this.lastProcessedSecond);
      const bucket = this.buckets[bucketIndex];

      if (bucket.length > 0) {
        const remaining = [];
        for (let i = 0; i < bucket.length; i++) {
          const item = bucket[i];
          if (item.dueSecond <= this.lastProcessedSecond) {
            expired.push(item);
          } else {
            // Belongs to a future revolution (if delay exceeded wheel size)
            remaining.push(item);
          }
        }
        this.buckets[bucketIndex] = remaining;
      }
    }

    return expired;
  }

  /**
   * Clears all scheduled regeneration events and resets state.
   */
  clear() {
    for (let i = 0; i < this.wheelSize; i++) {
      this.buckets[i] = [];
    }
    this.lastProcessedSecond = Math.floor(Date.now() / 1000);
  }
}
