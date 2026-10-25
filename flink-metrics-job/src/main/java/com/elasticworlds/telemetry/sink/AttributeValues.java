package com.elasticworlds.telemetry.sink;

import com.fasterxml.jackson.databind.JsonNode;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Generic JSON → DynamoDB AttributeValue conversion plus small typed helpers. */
public final class AttributeValues {
    private AttributeValues() {}

    public static AttributeValue fromJson(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return AttributeValue.builder().nul(true).build();
        }
        if (node.isBoolean()) return AttributeValue.builder().bool(node.asBoolean()).build();
        if (node.isNumber()) {
            double d = node.asDouble();
            if (Double.isNaN(d) || Double.isInfinite(d)) return AttributeValue.builder().nul(true).build();
            return AttributeValue.builder().n(node.numberValue().toString()).build();
        }
        if (node.isTextual()) {
            // DynamoDB rejects empty strings inside maps on older APIs; keep them explicit as null.
            String s = node.asText();
            return s.isEmpty() ? AttributeValue.builder().nul(true).build() : AttributeValue.builder().s(s).build();
        }
        if (node.isArray()) {
            List<AttributeValue> list = new ArrayList<>(node.size());
            for (JsonNode child : node) list.add(fromJson(child));
            return AttributeValue.builder().l(list).build();
        }
        if (node.isObject()) {
            Map<String, AttributeValue> map = new LinkedHashMap<>();
            Iterator<Map.Entry<String, JsonNode>> it = node.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                map.put(e.getKey(), fromJson(e.getValue()));
            }
            return AttributeValue.builder().m(map).build();
        }
        return AttributeValue.builder().s(node.toString()).build();
    }

    public static AttributeValue s(String value) {
        return AttributeValue.builder().s(value).build();
    }

    public static AttributeValue n(long value) {
        return AttributeValue.builder().n(Long.toString(value)).build();
    }

    public static AttributeValue n(double value) {
        return AttributeValue.builder().n(Double.toString(value)).build();
    }

    /** Numeric or NULL, so optional averages keep their slot in the map. */
    public static AttributeValue nOrNull(Double value) {
        return value == null ? AttributeValue.builder().nul(true).build() : n(value);
    }
}
