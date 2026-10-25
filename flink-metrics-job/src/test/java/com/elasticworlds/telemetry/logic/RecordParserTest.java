package com.elasticworlds.telemetry.logic;

import com.elasticworlds.telemetry.model.TelemetryRecord;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

class RecordParserTest {
    private static final long NOW = 1_760_000_000_000L;

    @Test
    void parsesWorldRecordWithIsoTimestamp() {
        Optional<TelemetryRecord> r = RecordParser.parse(
                "{\"type\":\"world\",\"worldId\":\"world-01\",\"timestamp\":\"2026-10-15T12:00:00.000Z\"}", NOW);
        assertTrue(r.isPresent());
        assertEquals("world", r.get().type);
        assertEquals("world-01", r.get().worldId);
        assertEquals(1_792_065_600_000L, r.get().timestampMs);
        assertTrue(r.get().isWorldKeyed());
    }

    @Test
    void acceptsPythonStyleOffsetTimestamp() {
        Optional<TelemetryRecord> r = RecordParser.parse(
                "{\"type\":\"npc\",\"worldId\":\"w\",\"timestamp\":\"2026-10-15T12:00:00+00:00\"}", NOW);
        assertTrue(r.isPresent());
        assertEquals(1_792_065_600_000L, r.get().timestampMs);
    }

    @Test
    void npcServiceRecordsAreKeyedByFixedKey() {
        Optional<TelemetryRecord> r = RecordParser.parse(
                "{\"type\":\"npc-service\",\"timestamp\":\"2026-10-15T12:00:00Z\",\"totalBots\":4}", NOW);
        assertTrue(r.isPresent());
        assertEquals("npc-service", r.get().worldId);
        assertFalse(r.get().isWorldKeyed());
    }

    @Test
    void missingTimestampFallsBackToProcessingTime() {
        Optional<TelemetryRecord> r = RecordParser.parse("{\"type\":\"world\",\"worldId\":\"w\"}", NOW);
        assertTrue(r.isPresent());
        assertEquals(NOW, r.get().timestampMs);
        assertNotNull(r.get().timestamp);
    }

    @Test
    void dropsMalformedJson() {
        assertTrue(RecordParser.parse("{not json", NOW).isEmpty());
        assertTrue(RecordParser.parse("", NOW).isEmpty());
        assertTrue(RecordParser.parse(null, NOW).isEmpty());
        assertTrue(RecordParser.parse("[1,2]", NOW).isEmpty());
    }

    @Test
    void dropsUnknownType() {
        assertTrue(RecordParser.parse("{\"type\":\"lobby\",\"worldId\":\"w\"}", NOW).isEmpty());
        assertTrue(RecordParser.parse("{\"worldId\":\"w\"}", NOW).isEmpty());
    }

    @Test
    void dropsWorldKeyedRecordsWithoutWorldId() {
        assertTrue(RecordParser.parse("{\"type\":\"world\"}", NOW).isEmpty());
        assertTrue(RecordParser.parse("{\"type\":\"npc\",\"worldId\":\"\"}", NOW).isEmpty());
    }
}
