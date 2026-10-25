package com.elasticworlds.telemetry.logic;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;

/** Shared Jackson mapper and small JSON helpers. */
public final class Json {
    public static final ObjectMapper MAPPER = new ObjectMapper();

    private Json() {}

    public static String text(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
        return v == null || v.isNull() ? null : v.asText();
    }

    public static Double number(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
        return v == null || !v.isNumber() ? null : v.asDouble();
    }

    public static int intValue(JsonNode node, String field, int fallback) {
        JsonNode v = node == null ? null : node.get(field);
        return v == null || !v.isNumber() ? fallback : v.asInt();
    }

    /** Parses an ISO-8601 timestamp with either "Z" or a numeric offset. Null when unparseable. */
    public static Long parseIsoMillis(String iso) {
        if (iso == null || iso.isEmpty()) return null;
        try {
            return Instant.parse(iso).toEpochMilli();
        } catch (DateTimeParseException ignored) {
            // fall through
        }
        try {
            return OffsetDateTime.parse(iso).toInstant().toEpochMilli();
        } catch (DateTimeParseException ignored) {
            return null;
        }
    }

    public static String isoMillis(long epochMs) {
        // ISO_INSTANT always prints seconds (OffsetDateTime.toString drops them when zero).
        return DateTimeFormatter.ISO_INSTANT.format(Instant.ofEpochMilli(epochMs));
    }
}
