package com.elasticworlds.telemetry.model;

/**
 * Latest known state of one world, emitted on every update. Maps 1:1 to the
 * {@code WORLD#<worldId>/LATEST} DynamoDB item; the flattened numbers feed the fleet window.
 */
public class WorldLatest {
    public String worldId;
    public String containerId;
    /** Producer timestamp of the last world sample (ISO). */
    public String sampledAt;
    public long sampledAtMs;
    /** Processing time at which the last world sample was applied. */
    public long worldUpdatedAtMs;
    /** Processing time of this emission (world or npc update). */
    public long updatedAtMs;
    /** Raw sample sections as JSON object text: worldName, players, memory, gameLoop, entities, process, config. */
    public String sampleJson;
    /** Raw ai section as JSON object text, or null when no npc record ever arrived. */
    public String aiJson;

    public int rollingWindowSeconds;
    public int rollingSamples;
    public Double rollingAvgTickHz;
    public Double rollingAvgRssMb;
    public Double rollingMaxTickDurationMs;

    public long cumulativeActiveSeconds;
    public long currentSessionSeconds;
    public int sessions;
    public long firstSeenAtMs;

    public int playersTotal;
    public int playersHumans;
    public int playersBots;
    public double rssMb;
    public Double tickHz;
    public Double aiAvgMs;
    public int botCount;
    public boolean hasWorldSample;

    public WorldLatest() {}
}
