package com.elasticworlds.telemetry.logic;

import com.elasticworlds.telemetry.model.WorldLatest;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class WorldAccumulatorTest {
    private static final long T0 = 1_760_000_000_000L;
    private static final int ROLLING = 60;

    private static JsonNode world(String containerId, long uptime, double rssMb, Double recentHz, Double effectiveHz, Double maxMs) throws Exception {
        StringBuilder gl = new StringBuilder("{\"targetHz\":20");
        if (recentHz != null) gl.append(",\"recentHz\":").append(recentHz);
        if (effectiveHz != null) gl.append(",\"effectiveHz\":").append(effectiveHz);
        if (maxMs != null) gl.append(",\"maxDurationMs\":").append(maxMs);
        gl.append("}");
        return Json.MAPPER.readTree("{\"type\":\"world\",\"worldId\":\"world-01\",\"containerId\":\"" + containerId
                + "\",\"timestamp\":\"2026-10-15T12:00:00Z\",\"worldName\":\"Bosque\","
                + "\"players\":{\"total\":3,\"humans\":1,\"bots\":2},"
                + "\"memory\":{\"rssMb\":" + rssMb + ",\"heapUsedMb\":10},"
                + "\"gameLoop\":" + gl + ","
                + "\"entities\":{\"players\":3},"
                + "\"process\":{\"uptimeSeconds\":" + uptime + ",\"pid\":1},"
                + "\"config\":{\"port\":8001}}");
    }

    private static JsonNode npc(int bots, Double avgMs) throws Exception {
        return Json.MAPPER.readTree("{\"type\":\"npc\",\"worldId\":\"world-01\",\"timestamp\":\"2026-10-15T12:00:01Z\","
                + "\"botCount\":" + bots + ",\"aiLatency\":{\"avgMs\":" + avgMs + ",\"p95Ms\":4.2,\"maxMs\":9,\"decisions\":12}}");
    }

    @Test
    void firstSampleStartsSessionWithReportedUptime() throws Exception {
        WorldAccumulator acc = new WorldAccumulator("world-01");
        acc.applyWorld(world("c1", 120, 55, 19.9, 20.0, 8.1), T0, ROLLING);
        WorldLatest l = acc.toLatest(T0, ROLLING);
        assertEquals(120, l.cumulativeActiveSeconds);
        assertEquals(120, l.currentSessionSeconds);
        assertEquals(1, l.sessions);
        assertEquals(T0, l.firstSeenAtMs);
        assertEquals("c1", l.containerId);
        assertTrue(l.hasWorldSample);
        assertEquals("2026-10-15T12:00:00Z", l.sampledAt);
        assertEquals(T0, l.worldUpdatedAtMs);
    }

    @Test
    void repeatedUptimeDoesNotInflateBilling() throws Exception {
        WorldAccumulator acc = new WorldAccumulator("world-01");
        acc.applyWorld(world("c1", 120, 55, 20.0, 20.0, 1.0), T0, ROLLING);
        acc.applyWorld(world("c1", 125, 55, 20.0, 20.0, 1.0), T0 + 5000, ROLLING);
        assertEquals(125, acc.cumulativeActiveSeconds());
        assertEquals(1, acc.sessions);
    }

    @Test
    void containerChangeBanksPreviousSession() throws Exception {
        WorldAccumulator acc = new WorldAccumulator("world-01");
        acc.applyWorld(world("c1", 120, 55, 20.0, 20.0, 1.0), T0, ROLLING);
        acc.applyWorld(world("c2", 30, 55, 20.0, 20.0, 1.0), T0 + 5000, ROLLING);
        assertEquals(150, acc.cumulativeActiveSeconds());
        assertEquals(2, acc.sessions);
        acc.applyWorld(world("c2", 45, 55, 20.0, 20.0, 1.0), T0 + 10000, ROLLING);
        assertEquals(165, acc.cumulativeActiveSeconds());
        assertEquals(T0, acc.firstSeenAtMs, "firstSeenAt survives restarts");
    }

    @Test
    void largeUptimeDropWithSameContainerIsARestart() throws Exception {
        WorldAccumulator acc = new WorldAccumulator("world-01");
        acc.applyWorld(world("c1", 120, 55, 20.0, 20.0, 1.0), T0, ROLLING);
        acc.applyWorld(world("c1", 5, 55, 20.0, 20.0, 1.0), T0 + 5000, ROLLING);
        assertEquals(125, acc.cumulativeActiveSeconds());
        assertEquals(2, acc.sessions);
    }

    @Test
    void smallUptimeDropIsSkewNotRestart() throws Exception {
        WorldAccumulator acc = new WorldAccumulator("world-01");
        acc.applyWorld(world("c1", 120, 55, 20.0, 20.0, 1.0), T0, ROLLING);
        acc.applyWorld(world("c1", 115, 55, 20.0, 20.0, 1.0), T0 + 5000, ROLLING);
        assertEquals(115, acc.cumulativeActiveSeconds());
        assertEquals(1, acc.sessions);
    }

    @Test
    void rollingWindowAveragesAndPrunes() throws Exception {
        WorldAccumulator acc = new WorldAccumulator("world-01");
        acc.applyWorld(world("c1", 10, 50, 20.0, 20.0, 2.0), T0, ROLLING);
        acc.applyWorld(world("c1", 15, 60, 18.0, 20.0, 9.0), T0 + 5000, ROLLING);
        WorldLatest l = acc.toLatest(T0 + 5000, ROLLING);
        assertEquals(2, l.rollingSamples);
        assertEquals(19.0, l.rollingAvgTickHz);
        assertEquals(55.0, l.rollingAvgRssMb);
        assertEquals(9.0, l.rollingMaxTickDurationMs);
        assertEquals(ROLLING, l.rollingWindowSeconds);

        // 61 s later only the newest sample is inside the window.
        acc.applyWorld(world("c1", 80, 70, 16.0, 20.0, 1.0), T0 + 66_000, ROLLING);
        l = acc.toLatest(T0 + 66_000, ROLLING);
        assertEquals(1, l.rollingSamples);
        assertEquals(16.0, l.rollingAvgTickHz);
        assertEquals(70.0, l.rollingAvgRssMb);
        assertEquals(1.0, l.rollingMaxTickDurationMs);
    }

    @Test
    void tickHzFallsBackToEffectiveHz() throws Exception {
        WorldAccumulator acc = new WorldAccumulator("world-01");
        acc.applyWorld(world("c1", 10, 50, null, 19.5, null), T0, ROLLING);
        WorldLatest l = acc.toLatest(T0, ROLLING);
        assertEquals(19.5, l.tickHz);
        assertEquals(19.5, l.rollingAvgTickHz);
        assertNull(l.rollingMaxTickDurationMs);
    }

    @Test
    void sampleJsonKeepsOnlyContractSections() throws Exception {
        WorldAccumulator acc = new WorldAccumulator("world-01");
        acc.applyWorld(world("c1", 10, 50, 20.0, 20.0, 1.0), T0, ROLLING);
        JsonNode sample = Json.MAPPER.readTree(acc.toLatest(T0, ROLLING).sampleJson);
        assertEquals("Bosque", sample.get("worldName").asText());
        assertNotNull(sample.get("players"));
        assertNotNull(sample.get("memory"));
        assertNotNull(sample.get("gameLoop"));
        assertNotNull(sample.get("entities"));
        assertNotNull(sample.get("process"));
        assertNotNull(sample.get("config"));
        assertNull(sample.get("type"));
        assertNull(sample.get("worldId"));
        assertNull(sample.get("containerId"));
        assertNull(sample.get("timestamp"));
    }

    @Test
    void npcRecordMergesIntoAiWithoutTouchingWorldSample() throws Exception {
        WorldAccumulator acc = new WorldAccumulator("world-01");
        acc.applyWorld(world("c1", 10, 50, 20.0, 20.0, 1.0), T0, ROLLING);
        acc.applyNpc(npc(2, 1.8), T0 + 1000);
        WorldLatest l = acc.toLatest(T0 + 1000, ROLLING);
        assertEquals(2, l.botCount);
        assertEquals(1.8, l.aiAvgMs);
        assertEquals(T0, l.worldUpdatedAtMs, "npc record must not refresh the world sample time");
        JsonNode ai = Json.MAPPER.readTree(l.aiJson);
        assertEquals(2, ai.get("botCount").asInt());
        assertEquals(4.2, ai.get("p95Ms").asDouble());
        assertEquals(12, ai.get("decisions").asInt());
        assertEquals("2026-10-15T12:00:01Z", ai.get("sampledAt").asText());
    }

    @Test
    void npcOnlyWorldHasNoWorldSample() throws Exception {
        WorldAccumulator acc = new WorldAccumulator("world-01");
        acc.applyNpc(npc(1, 2.0), T0);
        WorldLatest l = acc.toLatest(T0, ROLLING);
        assertFalse(l.hasWorldSample);
        assertNull(l.sampleJson);
        assertNotNull(l.aiJson);
        assertEquals(0, l.cumulativeActiveSeconds);
    }
}
