package com.elasticworlds.telemetry.sink;

import com.elasticworlds.telemetry.model.NpcServiceStatus;
import org.apache.flink.api.connector.sink2.SinkWriter;
import org.apache.flink.connector.base.sink.writer.ElementConverter;
import org.apache.flink.connector.dynamodb.sink.DynamoDbWriteRequest;
import org.apache.flink.connector.dynamodb.sink.DynamoDbWriteRequestType;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Builds one {@code SERVICE#npc/TASK#<instanceId>} item per NPC replica. Readers
 * sum the fresh items; replicas that scaled in age out through a short TTL.
 */
public class NpcServiceItemConverter implements ElementConverter<NpcServiceStatus, DynamoDbWriteRequest> {
    private static final long serialVersionUID = 1L;

    private final long ttlSeconds;

    public NpcServiceItemConverter(long ttlSeconds) {
        this.ttlSeconds = ttlSeconds;
    }

    @Override
    public DynamoDbWriteRequest apply(NpcServiceStatus s, SinkWriter.Context context) {
        return DynamoDbWriteRequest.builder().setType(DynamoDbWriteRequestType.PUT).setItem(toItem(s)).build();
    }

    public Map<String, AttributeValue> toItem(NpcServiceStatus s) {
        Map<String, AttributeValue> item = new LinkedHashMap<>();
        item.put("pk", AttributeValues.s("SERVICE#npc"));
        item.put("sk", AttributeValues.s("TASK#" + s.instanceId));
        item.put("instanceId", AttributeValues.s(s.instanceId));
        if (s.sampledAt != null) item.put("sampledAt", AttributeValues.s(s.sampledAt));
        item.put("updatedAt", AttributeValues.n(s.updatedAtMs));
        item.put("totalBots", AttributeValues.n(s.totalBots));
        item.put("activeWorlds", AttributeValues.n(s.activeWorlds));
        item.put("ttl", AttributeValues.n(s.updatedAtMs / 1000 + ttlSeconds));
        return item;
    }
}
