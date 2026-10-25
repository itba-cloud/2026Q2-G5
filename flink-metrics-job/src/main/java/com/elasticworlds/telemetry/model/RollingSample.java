package com.elasticworlds.telemetry.model;

/** One world sample kept for the per-world rolling window. */
public class RollingSample {
    public long atMs;
    public Double tickHz;
    public Double rssMb;
    public Double maxTickDurationMs;

    public RollingSample() {}

    public RollingSample(long atMs, Double tickHz, Double rssMb, Double maxTickDurationMs) {
        this.atMs = atMs;
        this.tickHz = tickHz;
        this.rssMb = rssMb;
        this.maxTickDurationMs = maxTickDurationMs;
    }
}
