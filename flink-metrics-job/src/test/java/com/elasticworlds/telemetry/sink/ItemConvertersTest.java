package com.elasticworlds.telemetry.sink;

import com.elasticworlds.telemetry.logic.Json;
import com.elasticworlds.telemetry.model.FleetPoint;
import com.elasticworlds.telemetry.model.NpcServiceStatus;
import com.elasticworlds.telemetry.model.WorldLatest;
import org.junit.jupiter.api.Test;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class ItemConvertersTest {

    @Test
    void jsonConversionCoversEveryType() throws Exception {
        AttributeValue v = AttributeValues.fromJson(Json.MAPPER.readTree(
                "{\"s\":\"x\",\"n\":1.5,\"i\":2,\"b\":true,\"z\":null,\"e\":\"\",\"l\":[1,\"a\"],\"m\":{\"k\":3}}"));
        Map<String, AttributeValue> m = v.m();
        assertEquals("x", m.get("s").s());
        assertEquals("1.5", m.get("n").n());
        assertEquals("2", m.get("i").n());
        assertTrue(m.get("b").bool());
        assertTrue(m.get("z").nul());
        assertTrue(m.get("e").nul());
        assertEquals(2, m.get("l").l().size());
        assertEquals("3", m.get("m").m().get("k").n());
    }

    @Test
    void worldItemFollowsContract() {
        WorldLatest w = new WorldLatest();
        w.worldId = "world-01";
        w.containerId = "abc";
        w.sampledAt = "2026-10-15T12:00:00Z";
        w.updatedAtMs = 1_000_000L;
        w.sampleJson = "{\"worldName\":\"B\",\"players\":{\"total\":1}}";
        w.aiJson = "{\"botCount\":2,\"avgMs\":null}";
        w.rollingWindowSeconds = 60;
        w.rollingSamples = 3;
        w.rollingAvgTickHz = 19.5;
        w.cumulativeActiveSeconds = 150;
        w.currentSessionSeconds = 30;
        w.sessions = 2;
        w.firstSeenAtMs = 999L;

        Map<String, AttributeValue> item = new WorldItemConverter(7).toItem(w);
        assertEquals("WORLD#world-01", item.get("pk").s());
        assertEquals("LATEST", item.get("sk").s());
        assertEquals("world-01", item.get("worldId").s());
        assertEquals("abc", item.get("containerId").s());
        assertEquals("2026-10-15T12:00:00Z", item.get("sampledAt").s());
        assertEquals("1000000", item.get("updatedAt").n());
        assertEquals("B", item.get("sample").m().get("worldName").s());
        assertEquals("1", item.get("sample").m().get("players").m().get("total").n());
        Map<String, AttributeValue> rolling = item.get("rolling").m();
        assertEquals("60", rolling.get("windowSeconds").n());
        assertEquals("3", rolling.get("samples").n());
        assertEquals("19.5", rolling.get("avgTickHz").n());
        assertTrue(rolling.get("avgRssMb").nul());
        Map<String, AttributeValue> billing = item.get("billing").m();
        assertEquals("150", billing.get("cumulativeActiveSeconds").n());
        assertEquals("30", billing.get("currentSessionSeconds").n());
        assertEquals("2", billing.get("sessions").n());
        assertEquals("999", billing.get("firstSeenAt").n());
        assertEquals("2", item.get("ai").m().get("botCount").n());
        assertTrue(item.get("ai").m().get("avgMs").nul());
        assertEquals(Long.toString(1000 + 7 * 86400L), item.get("ttl").n());
    }

    @Test
    void worldItemOmitsAiWhenAbsent() {
        WorldLatest w = new WorldLatest();
        w.worldId = "w";
        w.updatedAtMs = 5000L;
        Map<String, AttributeValue> item = new WorldItemConverter(7).toItem(w);
        assertFalse(item.containsKey("ai"));
        assertFalse(item.containsKey("sample"));
        assertTrue(item.containsKey("billing"));
    }

    @Test
    void fleetItemFollowsContract() {
        FleetPoint p = new FleetPoint();
        p.windowEndMs = 1_792_065_600_000L;
        p.windowSeconds = 10;
        p.activeWorlds = 2;
        p.totalPlayers = 5;
        p.humanPlayers = 3;
        p.botPlayers = 2;
        p.totalMemoryMb = 100.5;
        p.avgTickHz = 19.0;
        p.avgAiLatencyMs = null;
        p.totalBots = 2;

        Map<String, AttributeValue> item = new FleetItemConverter(24).toItem(p);
        assertEquals("FLEET", item.get("pk").s());
        assertEquals("1792065600000", item.get("sk").s());
        assertEquals(13, item.get("sk").s().length());
        assertEquals("2026-10-15T12:00:00Z", item.get("timestamp").s());
        assertEquals("10", item.get("windowSeconds").n());
        assertEquals("2", item.get("activeWorlds").n());
        assertEquals("5", item.get("totalPlayers").n());
        assertEquals("100.5", item.get("totalMemoryMb").n());
        assertEquals("19.0", item.get("avgTickHz").n());
        assertFalse(item.containsKey("avgAiLatencyMs"));
        assertEquals("2", item.get("totalBots").n());
        assertEquals(Long.toString(1_792_065_600L + 24 * 3600L), item.get("ttl").n());
    }

    @Test
    void fleetSortKeyIsZeroPaddedTo13Digits() {
        assertEquals("0000000000042", FleetItemConverter.sortKey(42));
    }

    @Test
    void npcServiceItemFollowsContract() {
        Map<String, AttributeValue> item = new NpcServiceItemConverter(3600)
                .toItem(new NpcServiceStatus("0f1e2d", "2026-10-15T12:00:00Z", 2_000_000L, 4, 2));
        assertEquals("SERVICE#npc", item.get("pk").s());
        assertEquals("TASK#0f1e2d", item.get("sk").s());
        assertEquals("0f1e2d", item.get("instanceId").s());
        assertEquals("2026-10-15T12:00:00Z", item.get("sampledAt").s());
        assertEquals("2000000", item.get("updatedAt").n());
        assertEquals("4", item.get("totalBots").n());
        assertEquals("2", item.get("activeWorlds").n());
        assertEquals(Long.toString(2000 + 3600L), item.get("ttl").n());
    }
}
