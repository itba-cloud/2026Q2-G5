/**
 * CostEstimator: Attributes infrastructure cost to individual worlds and detects
 * oversized provisioning.
 *
 * A world does not own an EC2 instance: it is one container among many on a shared
 * host. Cost is therefore attributed by *slot* — a host that advertises maxWorlds=10
 * sells ten slots, and each running world is charged one slot-hour regardless of how
 * little of it it actually uses. That gap between what a slot costs and what a world
 * consumes is exactly the oversizing signal the dashboard reports.
 */

/** On-demand hourly prices, us-east-1. Source: AWS EC2 pricing, Linux/shared tenancy. */
export const INSTANCE_CATALOG = Object.freeze({
  't2.micro': { vcpu: 1, memoryMb: 1024, hourlyUsd: 0.0116 },
  't2.small': { vcpu: 1, memoryMb: 2048, hourlyUsd: 0.023 },
  't2.medium': { vcpu: 2, memoryMb: 4096, hourlyUsd: 0.0464 },
  't3.micro': { vcpu: 2, memoryMb: 1024, hourlyUsd: 0.0104 },
  't3.small': { vcpu: 2, memoryMb: 2048, hourlyUsd: 0.0208 },
  't3.medium': { vcpu: 2, memoryMb: 4096, hourlyUsd: 0.0416 },
  't3.large': { vcpu: 2, memoryMb: 8192, hourlyUsd: 0.0832 },
  'c5.large': { vcpu: 2, memoryMb: 4096, hourlyUsd: 0.085 },
  'c5.xlarge': { vcpu: 4, memoryMb: 8192, hourlyUsd: 0.17 },
});

const HOURS_PER_MONTH = 730;

/**
 * Last-resort instance spec. `defaultInstanceType` is operator-supplied and may name
 * a type this catalog does not price, so the fallback chain must terminate on a value
 * that is guaranteed to exist rather than on another lookup.
 */
const FALLBACK_SPEC = INSTANCE_CATALOG['t3.medium'];

export class CostEstimator {
  /**
   * @param {object} [pricing]
   * @param {string} [pricing.defaultInstanceType] Assumed type for hosts that do not report one
   * @param {number} [pricing.ebsGbPerHost] Root EBS volume size per host, GB
   * @param {number} [pricing.ebsGbMonthUsd] gp3 price per GB-month
   * @param {number} [pricing.oversizedThreshold] Utilization below which a slot is oversized
   * @param {number} [pricing.undersizedThreshold] Utilization above which a slot is undersized
   * @param {number} [pricing.targetUtilization] Utilization a resized slot should aim for
   * @param {number} [pricing.maxSlotGrowthFactor] Cap on how far one recommendation may raise maxWorlds
   */
  constructor(pricing = {}) {
    this.defaultInstanceType = pricing.defaultInstanceType || 't3.medium';
    this.ebsGbPerHost = pricing.ebsGbPerHost ?? 30;
    this.ebsGbMonthUsd = pricing.ebsGbMonthUsd ?? 0.08;
    this.oversizedThreshold = pricing.oversizedThreshold ?? 0.25;
    this.undersizedThreshold = pricing.undersizedThreshold ?? 0.85;
    // Packing to 100% leaves no room for a player spike, so aim below it.
    this.targetUtilization = pricing.targetUtilization ?? 0.6;
    // One recommendation should be a step the operator can actually take and observe.
    this.maxSlotGrowthFactor = pricing.maxSlotGrowthFactor ?? 4;
    /** @type {Set<string>} instance types already warned about, to log each once */
    this._warnedUnpriced = new Set();
  }

  /**
   * Suggests a new slot count for a host whose worlds are underusing their slots.
   *
   * Memory alone would happily recommend packing dozens of worlds onto two vCPUs, so
   * the CPU budget the game loop actually consumes bounds the answer as well, and a
   * growth cap keeps a single recommendation to a step worth measuring.
   * @param {object} params
   * @param {number} params.currentSlots
   * @param {number} params.memoryUtilization Share of its slot's memory the world uses
   * @param {number|null} params.budgetUtilizationPct Share of the tick budget the loop uses
   * @param {number} params.vcpu vCPUs on the host
   * @returns {{ slots: number, boundBy: string }}
   */
  suggestSlots({ currentSlots, memoryUtilization, budgetUtilizationPct, vcpu }) {
    const memoryBound = Math.floor(
      (currentSlots * this.targetUtilization) / Math.max(memoryUtilization, 0.01)
    );

    // A loop using p% of its tick budget occupies p% of one core continuously.
    const cpuBound = typeof budgetUtilizationPct === 'number' && budgetUtilizationPct > 0
      ? Math.floor((vcpu * this.targetUtilization) / (budgetUtilizationPct / 100))
      : Infinity;

    const growthBound = Math.floor(currentSlots * this.maxSlotGrowthFactor);

    const slots = Math.max(currentSlots, Math.min(memoryBound, cpuBound, growthBound));
    const boundBy = slots === growthBound ? 'crecimiento gradual'
      : slots === cpuBound ? 'CPU del game loop'
      : 'memoria';

    return { slots, boundBy };
  }

  /**
   * Resolves the priced specification of a host.
   * @param {object} host Host record (may carry an `instanceType` field)
   * @returns {{ instanceType: string, vcpu: number, memoryMb: number, hourlyUsd: number, computeHourlyUsd: number, storageHourlyUsd: number }}
   */
  getHostSpec(host = {}) {
    const instanceType = host.instanceType || this.defaultInstanceType;
    const spec = INSTANCE_CATALOG[instanceType]
      || INSTANCE_CATALOG[this.defaultInstanceType]
      || FALLBACK_SPEC;

    if (!INSTANCE_CATALOG[instanceType] && !this._warnedUnpriced.has(instanceType)) {
      this._warnedUnpriced.add(instanceType);
      console.warn(
        `[CostEstimator] No hay precio para el tipo de instancia "${instanceType}". `
        + `Se usa el de "${INSTANCE_CATALOG[this.defaultInstanceType] ? this.defaultInstanceType : 't3.medium'}" para estimar el costo.`
      );
    }

    const computeHourlyUsd = spec.hourlyUsd;
    const storageHourlyUsd = (this.ebsGbPerHost * this.ebsGbMonthUsd) / HOURS_PER_MONTH;

    return {
      instanceType,
      vcpu: spec.vcpu,
      memoryMb: spec.memoryMb,
      computeHourlyUsd,
      storageHourlyUsd,
      hourlyUsd: computeHourlyUsd + storageHourlyUsd,
    };
  }

  /**
   * Cost of a single world slot on a host, in USD per hour.
   * @param {object} host Host record
   * @returns {number}
   */
  getSlotHourlyUsd(host = {}) {
    const spec = this.getHostSpec(host);
    const slots = Math.max(1, host.maxWorlds || 10);
    return spec.hourlyUsd / slots;
  }

  /**
   * Estimates cost and provisioning efficiency for one world.
   * @param {object} params
   * @param {object} params.world World record
   * @param {object|null} params.host Host the world runs on, if any
   * @param {object|null} params.metrics Live metrics scraped from the world, if any
   * @param {number} params.cumulativeActiveSeconds Observed ACTIVE time since collector start
   * @param {number} params.observationSeconds Length of the observation window
   * @returns {object} Cost breakdown for the world
   */
  estimateWorldCost({ world, host, metrics, cumulativeActiveSeconds = 0, observationSeconds = 0 }) {
    const isActive = world.status === 'ACTIVE';
    const spec = host ? this.getHostSpec(host) : this.getHostSpec({});
    const slots = Math.max(1, host?.maxWorlds || 10);
    const slotHourlyUsd = this.getSlotHourlyUsd(host || {});
    const slotMemoryMb = spec.memoryMb / slots;

    // Current container uptime, reported by the world itself.
    const sessionSeconds = isActive ? (metrics?.process?.uptimeSeconds ?? 0) : 0;
    const sessionCostUsd = (sessionSeconds / 3600) * slotHourlyUsd;
    const accruedCostUsd = (cumulativeActiveSeconds / 3600) * slotHourlyUsd;

    // What this world would have cost had it stayed up for the whole window. The
    // window must cover the time the world actually ran: a container can predate the
    // collector (a lobby restart), and a baseline shorter than the accrued time would
    // report a negative saving.
    const baselineSeconds = Math.max(observationSeconds, cumulativeActiveSeconds);
    const alwaysOnCostUsd = (baselineSeconds / 3600) * slotHourlyUsd;

    const usedMemoryMb = metrics?.memory?.rssMb ?? null;
    const memoryUtilization = usedMemoryMb !== null && slotMemoryMb > 0
      ? usedMemoryMb / slotMemoryMb
      : null;

    return {
      instanceType: spec.instanceType,
      vcpu: spec.vcpu,
      hostHourlyUsd: round(spec.hourlyUsd, 6),
      slots,
      slotHourlyUsd: round(slotHourlyUsd, 6),
      slotMemoryMb: round(slotMemoryMb, 1),
      usedMemoryMb: usedMemoryMb !== null ? round(usedMemoryMb, 1) : null,
      memoryUtilization: memoryUtilization !== null ? round(memoryUtilization, 4) : null,
      sessionSeconds: round(sessionSeconds, 0),
      sessionCostUsd: round(sessionCostUsd, 6),
      cumulativeActiveSeconds: round(cumulativeActiveSeconds, 0),
      accruedCostUsd: round(accruedCostUsd, 6),
      projectedMonthlyUsd: isActive ? round(slotHourlyUsd * HOURS_PER_MONTH, 2) : 0,
      alwaysOnCostUsd: round(alwaysOnCostUsd, 6),
      savedByElasticityUsd: round(Math.max(0, alwaysOnCostUsd - accruedCostUsd), 6),
      billing: isActive ? 'BILLING' : 'IDLE_NOT_BILLED',
    };
  }

  /**
   * Produces a right-sizing verdict for a world from its cost and performance profile.
   * @param {object} params
   * @param {object} params.cost Output of estimateWorldCost
   * @param {object|null} params.metrics Live world metrics
   * @param {object} params.world World record
   * @returns {{ verdict: string, severity: string, message: string, action: string|null }}
   */
  analyzeRightSizing({ cost, metrics, world }) {
    if (world.status !== 'ACTIVE' || !metrics) {
      return {
        verdict: 'NOT_RUNNING',
        severity: 'none',
        message: 'El mundo no está activo: no consume cómputo ni genera costo.',
        action: null,
      };
    }

    const tick = metrics.gameLoop || {};
    const targetHz = tick.targetHz || 20;
    // A loop scraped moments after boot has too few ticks for its rate to mean
    // anything; judging it would fire a false stall alert on every world start.
    const hasUsablePerfSignal = tick.recentHz !== null && tick.recentHz !== undefined
      ? true
      : (tick.uptimeSeconds ?? 0) >= 2;
    // Prefer the sliding-window rate: a world up for hours would otherwise average a
    // current stall away and never be flagged.
    const effectiveHz = tick.recentHz ?? tick.effectiveHz ?? targetHz;
    const tickHealth = targetHz > 0 ? effectiveHz / targetHz : 1;
    const util = cost.memoryUtilization;

    // Performance degradation outranks cost: an overloaded slot is a player-facing problem.
    if (hasUsablePerfSignal && (tickHealth < 0.9 || (tick.p95DurationMs ?? 0) > tick.intervalMs)) {
      return {
        verdict: 'UNDERSIZED',
        severity: 'high',
        message: `El game loop corre a ${effectiveHz.toFixed(1)} Hz frente a los ${targetHz} Hz objetivo (p95 de tick: ${(tick.p95DurationMs ?? 0).toFixed(1)}ms).`,
        action: `Bajar maxWorlds del host o mover el mundo a una instancia con más CPU.`,
      };
    }

    if (util === null) {
      return {
        verdict: 'UNKNOWN',
        severity: 'none',
        message: 'Sin métricas de memoria suficientes para evaluar el dimensionamiento.',
        action: null,
      };
    }

    if (util > this.undersizedThreshold) {
      return {
        verdict: 'UNDERSIZED',
        severity: 'high',
        message: `El mundo usa ${cost.usedMemoryMb} MB de los ${cost.slotMemoryMb} MB de su slot (${(util * 100).toFixed(0)}%).`,
        action: 'Reducir maxWorlds del host o escalar a una instancia con más memoria.',
      };
    }

    if (util < this.oversizedThreshold) {
      const { slots: suggestedSlots, boundBy } = this.suggestSlots({
        currentSlots: cost.slots,
        memoryUtilization: util,
        budgetUtilizationPct: tick.budgetUtilizationPct ?? null,
        vcpu: cost.vcpu ?? 2,
      });

      if (suggestedSlots <= cost.slots) {
        return {
          verdict: 'OVERSIZED',
          severity: 'medium',
          message: `El mundo usa ${cost.usedMemoryMb} MB de los ${cost.slotMemoryMb} MB de su slot (${(util * 100).toFixed(0)}%), pero el host ya no admite más densidad.`,
          action: 'Migrar la carga a un tipo de instancia más chico.',
        };
      }

      const potentialSlotUsd = cost.hostHourlyUsd / suggestedSlots;
      const savingPerHour = cost.slotHourlyUsd - potentialSlotUsd;

      return {
        verdict: 'OVERSIZED',
        severity: util < this.oversizedThreshold / 2 ? 'high' : 'medium',
        message: `El mundo usa ${cost.usedMemoryMb} MB de los ${cost.slotMemoryMb} MB de su slot (${(util * 100).toFixed(0)}%) y ${(tick.budgetUtilizationPct ?? 0).toFixed(1)}% del budget de tick. Está pagando capacidad que no consume.`,
        action: `Subir maxWorlds del host de ${cost.slots} a ${suggestedSlots} (límite: ${boundBy}; ahorro estimado: ${(savingPerHour * HOURS_PER_MONTH).toFixed(2)} USD/mes por mundo) o usar un tipo de instancia más chico.`,
      };
    }

    return {
      verdict: 'RIGHT_SIZED',
      severity: 'none',
      message: `Uso de memoria en ${(util * 100).toFixed(0)}% del slot y game loop estable en ${effectiveHz.toFixed(1)} Hz.`,
      action: null,
    };
  }

  /**
   * Aggregates fleet-wide cost across hosts and worlds.
   * @param {object[]} hosts Host records
   * @param {object[]} worldCosts Per-world cost objects produced by estimateWorldCost
   * @param {number} observationSeconds Length of the observation window
   * @returns {object}
   */
  aggregateFleetCost(hosts, worldCosts, observationSeconds = 0) {
    // Hosts bill whether or not a world is running on them: that is the fixed floor.
    const fleetFixedHourlyUsd = hosts.reduce((sum, h) => sum + this.getHostSpec(h).hourlyUsd, 0);

    const billedWorlds = worldCosts.filter((c) => c.billing === 'BILLING');
    const attributedHourlyUsd = billedWorlds.reduce((sum, c) => sum + c.slotHourlyUsd, 0);
    const accruedUsd = worldCosts.reduce((sum, c) => sum + c.accruedCostUsd, 0);

    // Elasticity payoff: what the worlds that actually ran would have cost had they
    // stayed up for the whole window, minus what the on-demand model charged. A world
    // that never started is not a saving — counting it would let ten idle catalogue
    // entries manufacture ten slot-hours of fictional savings per hour.
    const alwaysOnUsd = worldCosts
      .filter((c) => c.cumulativeActiveSeconds > 0)
      .reduce((sum, c) => sum + (Math.max(observationSeconds, c.cumulativeActiveSeconds) / 3600) * c.slotHourlyUsd, 0);
    const savedUsd = Math.max(0, alwaysOnUsd - accruedUsd);

    return {
      fleetFixedHourlyUsd: round(fleetFixedHourlyUsd, 6),
      fleetFixedMonthlyUsd: round(fleetFixedHourlyUsd * HOURS_PER_MONTH, 2),
      attributedHourlyUsd: round(attributedHourlyUsd, 6),
      attributedMonthlyUsd: round(attributedHourlyUsd * HOURS_PER_MONTH, 2),
      idleCapacityHourlyUsd: round(Math.max(0, fleetFixedHourlyUsd - attributedHourlyUsd), 6),
      observationSeconds: round(observationSeconds, 0),
      accruedUsd: round(accruedUsd, 6),
      alwaysOnUsd: round(alwaysOnUsd, 6),
      savedByElasticityUsd: round(savedUsd, 6),
      savedByElasticityPct: alwaysOnUsd > 0 ? round((savedUsd / alwaysOnUsd) * 100, 1) : 0,
    };
  }
}

function round(value, decimals) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
