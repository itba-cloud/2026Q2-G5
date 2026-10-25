package com.elasticworlds.telemetry.sink;

import com.elasticworlds.telemetry.logic.Json;
import com.elasticworlds.telemetry.model.WorldLatest;
import org.apache.flink.api.connector.sink2.SinkWriter;
import org.apache.flink.connector.base.sink.writer.ElementConverter;
import org.apache.flink.connector.dynamodb.sink.DynamoDbWriteRequest;
import org.apache.flink.connector.dynamodb.sink.DynamoDbWriteRequestType;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;

import java.util.LinkedHashMap;
import java.util.Map;

/** Builds the {@code WORLD#<worldId>/LATEST} item. */
public class WorldItemConverter implements ElementConverter<WorldLatest, DynamoDbWriteRequest> {
    private static final long serialVersionUID = 1L;

    private final long ttlSeconds;

    public WorldItemConverter(int itemTtlDays) {
        this.ttlSeconds = itemTtlDays * 86400L;
    }

    @Override
    public DynamoDbWriteRequest apply(WorldLatest w, SinkWriter.Context context) {
        return DynamoDbWriteRequest.builder().setType(DynamoDbWriteRequestType.PUT).setItem(toItem(w)).build();
    }

    public Map<String, AttributeValue> toItem(WorldLatest w) {
        Map<String, AttributeValue> item = new LinkedHashMap<>();
        item.put("pk", AttributeValues.s("WORLD#" + w.worldId));
        item.put("sk", AttributeValues.s("LATEST"));
        item.put("worldId", AttributeValues.s(w.worldId));
        if (w.containerId != null) item.put("containerId", AttributeValues.s(w.containerId));
        if (w.sampledAt != null) item.put("sampledAt", AttributeValues.s(w.sampledAt));
        item.put("updatedAt", AttributeValues.n(w.updatedAtMs));
        if (w.sampleJson != null) item.put("sample", AttributeValues.fromJson(readTree(w.sampleJson)));

        Map<String, AttributeValue> rolling = new LinkedHashMap<>();
        rolling.put("windowSeconds", AttributeValues.n(w.rollingWindowSeconds));
        rolling.put("samples", AttributeValues.n(w.rollingSamples));
        rolling.put("avgTickHz", AttributeValues.nOrNull(w.rollingAvgTickHz));
        rolling.put("avgRssMb", AttributeValues.nOrNull(w.rollingAvgRssMb));
        rolling.put("maxTickDurationMs", AttributeValues.nOrNull(w.rollingMaxTickDurationMs));
        item.put("rolling", AttributeValue.builder().m(rolling).build());

        Map<String, AttributeValue> billing = new LinkedHashMap<>();
        billing.put("cumulativeActiveSeconds", AttributeValues.n(w.cumulativeActiveSeconds));
        billing.put("currentSessionSeconds", AttributeValues.n(w.currentSessionSeconds));
        billing.put("sessions", AttributeValues.n(w.sessions));
        billing.put("firstSeenAt", AttributeValues.n(w.firstSeenAtMs));
        item.put("billing", AttributeValue.builder().m(billing).build());

        if (w.aiJson != null) item.put("ai", AttributeValues.fromJson(readTree(w.aiJson)));
        item.put("ttl", AttributeValues.n(w.updatedAtMs / 1000 + ttlSeconds));
        return item;
    }

    private static com.fasterxml.jackson.databind.JsonNode readTree(String json) {
        try {
            return Json.MAPPER.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException("State holds invalid JSON: " + json, e);
        }
    }
}
