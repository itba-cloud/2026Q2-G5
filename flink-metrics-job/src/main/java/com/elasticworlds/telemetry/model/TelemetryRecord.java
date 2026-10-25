package com.elasticworlds.telemetry.model;

/** One parsed Kinesis record. The payload is kept as JSON text so the POJO stays serializer-friendly. */
public class TelemetryRecord {
    public static final String TYPE_WORLD = "world";
    public static final String TYPE_NPC = "npc";
    public static final String TYPE_NPC_SERVICE = "npc-service";

    public String type;
    /** Partition key for keyed processing. "npc-service" for service heartbeats. */
    public String worldId;
    public String timestamp;
    public long timestampMs;
    public String json;

    public TelemetryRecord() {}

    public TelemetryRecord(String type, String worldId, String timestamp, long timestampMs, String json) {
        this.type = type;
        this.worldId = worldId;
        this.timestamp = timestamp;
        this.timestampMs = timestampMs;
        this.json = json;
    }

    public boolean isWorldKeyed() {
        return TYPE_WORLD.equals(type) || TYPE_NPC.equals(type);
    }
}
