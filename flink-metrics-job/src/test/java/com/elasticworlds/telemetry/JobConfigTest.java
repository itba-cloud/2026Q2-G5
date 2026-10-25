package com.elasticworlds.telemetry;

import org.junit.jupiter.api.Test;

import java.util.Properties;

import static org.junit.jupiter.api.Assertions.*;

class JobConfigTest {
    @Test
    void appliesContractDefaults() {
        Properties p = new Properties();
        p.setProperty("stream.arn", "arn:aws:kinesis:us-east-1:123:stream/x");
        JobConfig c = JobConfig.fromProperties(p);
        assertEquals("us-east-1", c.region);
        assertEquals("elastic-worlds-telemetry", c.tableName);
        assertEquals(10, c.fleetWindowSeconds);
        assertEquals(60, c.rollingWindowSeconds);
        assertEquals(7, c.itemTtlDays);
        assertEquals(24, c.historyTtlHours);
    }

    @Test
    void requiresStreamArn() {
        assertThrows(IllegalArgumentException.class, () -> JobConfig.fromProperties(new Properties()));
    }

    @Test
    void argumentsOverrideDefaultsWhenNotOnManagedFlink() {
        JobConfig c = JobConfig.load(new String[]{"--stream.arn", "arn:x", "--table.name", "t", "--fleet.window.seconds", "5"});
        assertEquals("arn:x", c.streamArn);
        assertEquals("t", c.tableName);
        assertEquals(5, c.fleetWindowSeconds);
    }
}
