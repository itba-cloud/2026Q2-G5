package com.elasticworlds.telemetry;

import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.graph.StreamGraph;
import org.apache.flink.streaming.api.graph.StreamNode;
import org.junit.jupiter.api.Test;

import java.util.Properties;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

/** Builds the job graph locally so builder validation errors surface before deployment. */
class TelemetryJobGraphTest {
    @Test
    void graphContainsEveryStageAndSink() {
        Properties p = new Properties();
        p.setProperty("stream.arn", "arn:aws:kinesis:us-east-1:123456789012:stream/elastic-worlds-telemetry");
        JobConfig config = JobConfig.fromProperties(p);

        StreamExecutionEnvironment env = StreamExecutionEnvironment.createLocalEnvironment();
        TelemetryJob.build(env, config);
        StreamGraph graph = env.getStreamGraph();

        Set<String> names = graph.getStreamNodes().stream().map(StreamNode::getOperatorName).collect(Collectors.toSet());
        for (String expected : new String[]{
                "kinesis-telemetry", "parse-records", "world-state", "fleet-window", "npc-service-status",
                "dynamodb-world-latest", "dynamodb-fleet-history", "dynamodb-npc-service"}) {
            assertTrue(names.stream().anyMatch(n -> n.contains(expected)), "missing operator: " + expected + " in " + names);
        }
    }
}
