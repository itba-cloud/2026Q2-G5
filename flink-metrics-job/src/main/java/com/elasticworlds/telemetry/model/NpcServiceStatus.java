package com.elasticworlds.telemetry.model;

/** Heartbeat of one NPC replica. Maps to the {@code SERVICE#npc/TASK#<instanceId>} DynamoDB item. */
public class NpcServiceStatus {
    public String instanceId;
    public String sampledAt;
    public long updatedAtMs;
    public int totalBots;
    public int activeWorlds;

    public NpcServiceStatus() {}

    public NpcServiceStatus(String instanceId, String sampledAt, long updatedAtMs, int totalBots, int activeWorlds) {
        this.instanceId = instanceId;
        this.sampledAt = sampledAt;
        this.updatedAtMs = updatedAtMs;
        this.totalBots = totalBots;
        this.activeWorlds = activeWorlds;
    }
}
