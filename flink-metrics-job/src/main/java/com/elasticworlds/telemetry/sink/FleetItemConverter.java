package com.elasticworlds.telemetry.sink;

import com.elasticworlds.telemetry.logic.Json;
import com.elasticworlds.telemetry.model.FleetPoint;
import org.apache.flink.api.connector.sink2.SinkWriter;
import org.apache.flink.connector.base.sink.writer.ElementConverter;
import org.apache.flink.connector.dynamodb.sink.DynamoDbWriteRequest;
import org.apache.flink.connector.dynamodb.sink.DynamoDbWriteRequestType;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;

import java.util.LinkedHashMap;
import java.util.Map;

/** Builds the {@code FLEET/<windowEnd>} item. */
public class FleetItemConverter implements ElementConverter<FleetPoint, DynamoDbWriteRequest> {
    private static final long serialVersionUID = 1L;

    private final long ttlSeconds;

    public FleetItemConverter(int historyTtlHours) {
        this.ttlSeconds = historyTtlHours * 3600L;
    }

    @Override
    public DynamoDbWriteRequest apply(FleetPoint p, SinkWriter.Context context) {
        return DynamoDbWriteRequest.builder().setType(DynamoDbWriteRequestType.PUT).setItem(toItem(p)).build();
    }

    public Map<String, AttributeValue> toItem(FleetPoint p) {
        Map<String, AttributeValue> item = new LinkedHashMap<>();
        item.put("pk", AttributeValues.s("FLEET"));
        item.put("sk", AttributeValues.s(sortKey(p.windowEndMs)));
        item.put("timestamp", AttributeValues.s(Json.isoMillis(p.windowEndMs)));
        item.put("windowSeconds", AttributeValues.n(p.windowSeconds));
        item.put("activeWorlds", AttributeValues.n(p.activeWorlds));
        item.put("totalPlayers", AttributeValues.n(p.totalPlayers));
        item.put("humanPlayers", AttributeValues.n(p.humanPlayers));
        item.put("botPlayers", AttributeValues.n(p.botPlayers));
        item.put("totalMemoryMb", AttributeValues.n(p.totalMemoryMb));
        if (p.avgTickHz != null) item.put("avgTickHz", AttributeValues.n(p.avgTickHz));
        if (p.avgAiLatencyMs != null) item.put("avgAiLatencyMs", AttributeValues.n(p.avgAiLatencyMs));
        item.put("totalBots", AttributeValues.n(p.totalBots));
        item.put("ttl", AttributeValues.n(p.windowEndMs / 1000 + ttlSeconds));
        return item;
    }

    public static String sortKey(long windowEndMs) {
        return String.format("%013d", windowEndMs);
    }
}
