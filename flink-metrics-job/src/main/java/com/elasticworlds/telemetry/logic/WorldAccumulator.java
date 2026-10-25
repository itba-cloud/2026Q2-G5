package com.elasticworlds.telemetry.logic;

import com.elasticworlds.telemetry.model.RollingSample;
import com.elasticworlds.telemetry.model.WorldLatest;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * Per-world keyed state and the rules that update it. Plain Java so it can be unit-tested
 * without a Flink harness; the keyed process function only stores and delegates.
 *
 * <p>Billing ledger: a session is the uptime reported by one container. When the container id
 * changes, or the reported uptime drops by more than {@link #RESTART_DROP_SECONDS}, the previous
 * session is banked and a new one starts. Cumulative = banked + current session.
 *
 * <p>Rolling window: the last {@code rollingWindowSeconds} of samples, averaged on read.
 */
public class WorldAccumulator {
    public static final long RESTART_DROP_SECONDS = 10;
    private static final String[] SAMPLE_SECTIONS = {
            "worldName", "players", "memory", "gameLoop", "entities", "process", "config"
    };

    public String worldId;
    public String containerId;
    public long lastUptimeSeconds;
    public long bankedSeconds;
    public int sessions;
    public long firstSeenAtMs;

    public String sampledAt;
    public long sampledAtMs;
    public long worldUpdatedAtMs;
    public String sampleJson;
    public int playersTotal;
    public int playersHumans;
    public int playersBots;
    public double rssMb;
    public Double tickHz;
    public boolean hasWorldSample;

    public String aiJson;
    public int botCount;
    public Double aiAvgMs;

    public List<RollingSample> rolling = new ArrayList<>();

    public WorldAccumulator() {}

    public WorldAccumulator(String worldId) {
        this.worldId = worldId;
    }

    /** Applies a {@code type:"world"} record received at processing time {@code nowMs}. */
    public void applyWorld(JsonNode record, long nowMs, int rollingWindowSeconds) {
        String newContainerId = Json.text(record, "containerId");
        if (newContainerId == null || newContainerId.isBlank()) newContainerId = "unknown";
        JsonNode process = record.get("process");
        long uptime = Math.max(0, Math.round(Json.number(process, "uptimeSeconds") == null ? 0 : Json.number(process, "uptimeSeconds")));

        if (firstSeenAtMs == 0) {
            firstSeenAtMs = nowMs;
        }

        if (containerId == null) {
            sessions = 1;
        } else if (!containerId.equals(newContainerId) || uptime + RESTART_DROP_SECONDS < lastUptimeSeconds) {
            bankedSeconds += lastUptimeSeconds;
            sessions++;
        }
        containerId = newContainerId;
        lastUptimeSeconds = uptime;

        String ts = Json.text(record, "timestamp");
        Long tsMs = Json.parseIsoMillis(ts);
        sampledAtMs = tsMs == null ? nowMs : tsMs;
        sampledAt = tsMs == null ? Json.isoMillis(nowMs) : ts;
        worldUpdatedAtMs = nowMs;

        ObjectNode sample = Json.MAPPER.createObjectNode();
        for (String section : SAMPLE_SECTIONS) {
            JsonNode v = record.get(section);
            if (v != null && !v.isNull()) sample.set(section, v);
        }
        sampleJson = sample.toString();

        JsonNode players = record.get("players");
        playersTotal = Json.intValue(players, "total", 0);
        playersHumans = Json.intValue(players, "humans", 0);
        playersBots = Json.intValue(players, "bots", Math.max(0, playersTotal - playersHumans));

        JsonNode memory = record.get("memory");
        Double rss = Json.number(memory, "rssMb");
        rssMb = rss == null ? 0 : rss;

        JsonNode gameLoop = record.get("gameLoop");
        Double hz = Json.number(gameLoop, "recentHz");
        if (hz == null) hz = Json.number(gameLoop, "effectiveHz");
        tickHz = hz;
        hasWorldSample = true;

        rolling.add(new RollingSample(nowMs, hz, rss, Json.number(gameLoop, "maxDurationMs")));
        pruneRolling(nowMs, rollingWindowSeconds);
    }

    /** Applies a {@code type:"npc"} record for this world. */
    public void applyNpc(JsonNode record, long nowMs) {
        JsonNode latency = record.get("aiLatency");
        ObjectNode ai = Json.MAPPER.createObjectNode();
        botCount = Json.intValue(record, "botCount", 0);
        ai.put("botCount", botCount);
        putNumberOrNull(ai, "avgMs", Json.number(latency, "avgMs"));
        putNumberOrNull(ai, "p95Ms", Json.number(latency, "p95Ms"));
        putNumberOrNull(ai, "maxMs", Json.number(latency, "maxMs"));
        ai.put("decisions", Json.intValue(latency, "decisions", 0));
        String ts = Json.text(record, "timestamp");
        ai.put("sampledAt", Json.parseIsoMillis(ts) == null ? Json.isoMillis(nowMs) : ts);
        aiAvgMs = Json.number(latency, "avgMs");
        aiJson = ai.toString();
    }

    public long cumulativeActiveSeconds() {
        return bankedSeconds + lastUptimeSeconds;
    }

    void pruneRolling(long nowMs, int rollingWindowSeconds) {
        long cutoff = nowMs - rollingWindowSeconds * 1000L;
        Iterator<RollingSample> it = rolling.iterator();
        while (it.hasNext()) {
            if (it.next().atMs < cutoff) it.remove();
        }
    }

    /** Snapshot of the current state as the emitted record. */
    public WorldLatest toLatest(long nowMs, int rollingWindowSeconds) {
        pruneRolling(nowMs, rollingWindowSeconds);
        WorldLatest out = new WorldLatest();
        out.worldId = worldId;
        out.containerId = containerId;
        out.sampledAt = sampledAt;
        out.sampledAtMs = sampledAtMs;
        out.worldUpdatedAtMs = worldUpdatedAtMs;
        out.updatedAtMs = nowMs;
        out.sampleJson = sampleJson;
        out.aiJson = aiJson;

        out.rollingWindowSeconds = rollingWindowSeconds;
        out.rollingSamples = rolling.size();
        out.rollingAvgTickHz = average(rolling, s -> s.tickHz);
        out.rollingAvgRssMb = average(rolling, s -> s.rssMb);
        out.rollingMaxTickDurationMs = max(rolling, s -> s.maxTickDurationMs);

        out.cumulativeActiveSeconds = cumulativeActiveSeconds();
        out.currentSessionSeconds = lastUptimeSeconds;
        out.sessions = sessions;
        out.firstSeenAtMs = firstSeenAtMs;

        out.playersTotal = playersTotal;
        out.playersHumans = playersHumans;
        out.playersBots = playersBots;
        out.rssMb = rssMb;
        out.tickHz = tickHz;
        out.aiAvgMs = aiAvgMs;
        out.botCount = botCount;
        out.hasWorldSample = hasWorldSample;
        return out;
    }

    private static void putNumberOrNull(ObjectNode node, String field, Double value) {
        if (value == null) node.putNull(field); else node.put(field, value);
    }

    private interface Extractor { Double get(RollingSample s); }

    private static Double average(List<RollingSample> samples, Extractor f) {
        double sum = 0;
        int n = 0;
        for (RollingSample s : samples) {
            Double v = f.get(s);
            if (v != null) { sum += v; n++; }
        }
        return n == 0 ? null : Math.round(sum / n * 100.0) / 100.0;
    }

    private static Double max(List<RollingSample> samples, Extractor f) {
        Double best = null;
        for (RollingSample s : samples) {
            Double v = f.get(s);
            if (v != null && (best == null || v > best)) best = v;
        }
        return best;
    }
}
