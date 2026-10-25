package com.elasticworlds.telemetry.logic;

import com.elasticworlds.telemetry.model.TelemetryRecord;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.Optional;

/**
 * Turns a raw Kinesis payload into a {@link TelemetryRecord}. Anything that does not match
 * the contract in .docs/telemetry-pipeline.md is dropped: malformed JSON, unknown type,
 * missing worldId on world-keyed records.
 */
public final class RecordParser {
    private RecordParser() {}

    public static Optional<TelemetryRecord> parse(String raw, long nowMs) {
        if (raw == null || raw.isBlank()) return Optional.empty();
        JsonNode node;
        try {
            node = Json.MAPPER.readTree(raw);
        } catch (Exception e) {
            return Optional.empty();
        }
        if (node == null || !node.isObject()) return Optional.empty();

        String type = Json.text(node, "type");
        if (type == null) return Optional.empty();

        String key;
        switch (type) {
            case TelemetryRecord.TYPE_WORLD:
            case TelemetryRecord.TYPE_NPC:
                key = Json.text(node, "worldId");
                if (key == null || key.isBlank()) return Optional.empty();
                break;
            case TelemetryRecord.TYPE_NPC_SERVICE:
                key = TelemetryRecord.TYPE_NPC_SERVICE;
                break;
            default:
                return Optional.empty();
        }

        String timestamp = Json.text(node, "timestamp");
        Long ts = Json.parseIsoMillis(timestamp);
        if (ts == null) {
            ts = nowMs;
            timestamp = Json.isoMillis(nowMs);
        }
        return Optional.of(new TelemetryRecord(type, key, timestamp, ts, raw));
    }
}
