package com.elasticworlds.telemetry;

import com.elasticworlds.telemetry.functions.FleetWindowFunction;
import com.elasticworlds.telemetry.functions.NpcServiceMapper;
import com.elasticworlds.telemetry.functions.WorldStateFunction;
import com.elasticworlds.telemetry.logic.RecordParser;
import com.elasticworlds.telemetry.model.FleetPoint;
import com.elasticworlds.telemetry.model.NpcServiceStatus;
import com.elasticworlds.telemetry.model.TelemetryRecord;
import com.elasticworlds.telemetry.model.WorldLatest;
import com.elasticworlds.telemetry.sink.FleetItemConverter;
import com.elasticworlds.telemetry.sink.NpcServiceItemConverter;
import com.elasticworlds.telemetry.sink.WorldItemConverter;
import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.connector.aws.config.AWSConfigConstants;
import org.apache.flink.connector.base.sink.writer.ElementConverter;
import org.apache.flink.connector.dynamodb.sink.DynamoDbSink;
import org.apache.flink.connector.dynamodb.sink.DynamoDbWriteRequest;
import org.apache.flink.connector.kinesis.source.KinesisStreamsSource;
import org.apache.flink.connector.kinesis.source.config.KinesisSourceConfigOptions;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.windowing.assigners.TumblingProcessingTimeWindows;
import org.apache.flink.streaming.api.windowing.time.Time;
import org.apache.flink.util.Collector;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Arrays;
import java.util.Optional;
import java.util.Properties;

/**
 * Elastic Worlds telemetry job: Kinesis → per-world keyed state (billing ledger, rolling
 * window) and fleet tumbling windows → DynamoDB. See .docs/telemetry-pipeline.md.
 */
public final class TelemetryJob {
    /** A replica that scaled in stops reporting; its item lingers at most this long. */
    static final long NPC_REPLICA_TTL_SECONDS = 3600;

    private static final Logger LOG = LoggerFactory.getLogger(TelemetryJob.class);

    private TelemetryJob() {}

    public static void main(String[] args) throws Exception {
        JobConfig config = JobConfig.load(args);
        LOG.info("Starting telemetry job with {}", config);

        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
        build(env, config);
        env.execute("elastic-worlds-telemetry");
    }

    static void build(StreamExecutionEnvironment env, JobConfig config) {
        Configuration sourceConfig = new Configuration();
        sourceConfig.set(KinesisSourceConfigOptions.STREAM_INITIAL_POSITION,
                KinesisSourceConfigOptions.InitialPosition.LATEST);
        sourceConfig.setString(AWSConfigConstants.AWS_REGION, config.region);

        KinesisStreamsSource<String> source = KinesisStreamsSource.<String>builder()
                .setStreamArn(config.streamArn)
                .setSourceConfig(sourceConfig)
                .setDeserializationSchema(new SimpleStringSchema())
                .build();

        DataStream<TelemetryRecord> records = env
                .fromSource(source, WatermarkStrategy.noWatermarks(), "kinesis-telemetry", Types.STRING)
                .flatMap((String raw, Collector<TelemetryRecord> out) -> {
                    Optional<TelemetryRecord> parsed = RecordParser.parse(raw, System.currentTimeMillis());
                    parsed.ifPresent(out::collect);
                })
                .returns(TelemetryRecord.class)
                .name("parse-records");

        DataStream<WorldLatest> worldUpdates = records
                .filter(TelemetryRecord::isWorldKeyed)
                .keyBy(r -> r.worldId)
                .process(new WorldStateFunction(config.rollingWindowSeconds))
                .name("world-state");

        worldUpdates
                .sinkTo(dynamoSink(config, new WorldItemConverter(config.itemTtlDays)))
                .name("dynamodb-world-latest");

        DataStream<FleetPoint> fleet = worldUpdates
                .windowAll(TumblingProcessingTimeWindows.of(Time.seconds(config.fleetWindowSeconds)))
                .process(new FleetWindowFunction(config.fleetWindowSeconds))
                .name("fleet-window");

        fleet
                .sinkTo(dynamoSink(config, new FleetItemConverter(config.historyTtlHours)))
                .name("dynamodb-fleet-history");

        DataStream<NpcServiceStatus> npcService = records
                .filter(r -> TelemetryRecord.TYPE_NPC_SERVICE.equals(r.type))
                .map(new NpcServiceMapper())
                .name("npc-service-status");

        npcService
                .sinkTo(dynamoSink(config, new NpcServiceItemConverter(NPC_REPLICA_TTL_SECONDS)))
                .name("dynamodb-npc-service");
    }

    private static <T> DynamoDbSink<T> dynamoSink(JobConfig config, ElementConverter<T, DynamoDbWriteRequest> converter) {
        Properties props = new Properties();
        props.setProperty(AWSConfigConstants.AWS_REGION, config.region);
        return DynamoDbSink.<T>builder()
                .setDynamoDbProperties(props)
                .setTableName(config.tableName)
                .setElementConverter(converter)
                // Several updates of one key inside a batch would be rejected by BatchWriteItem;
                // keep only the last one per (pk, sk).
                .setOverwriteByPartitionKeys(Arrays.asList("pk", "sk"))
                .setFailOnError(false)
                .build();
    }
}
