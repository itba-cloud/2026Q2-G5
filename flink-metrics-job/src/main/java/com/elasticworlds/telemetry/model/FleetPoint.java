package com.elasticworlds.telemetry.model;

/** Fleet aggregate for one tumbling window. Maps to the {@code FLEET/<windowEnd>} DynamoDB item. */
public class FleetPoint {
    public long windowEndMs;
    public int windowSeconds;
    public int activeWorlds;
    public int totalPlayers;
    public int humanPlayers;
    public int botPlayers;
    public double totalMemoryMb;
    public Double avgTickHz;
    public Double avgAiLatencyMs;
    public int totalBots;

    public FleetPoint() {}
}
