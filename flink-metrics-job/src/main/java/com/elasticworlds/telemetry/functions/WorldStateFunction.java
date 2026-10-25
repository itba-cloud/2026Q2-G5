package com.elasticworlds.telemetry.functions;

import com.elasticworlds.telemetry.logic.Json;
import com.elasticworlds.telemetry.logic.WorldAccumulator;
import com.elasticworlds.telemetry.model.TelemetryRecord;
import com.elasticworlds.telemetry.model.WorldLatest;
import com.fasterxml.jackson.databind.JsonNode;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;

/** Holds one {@link WorldAccumulator} per world id and emits the updated state on every record. */
public class WorldStateFunction extends KeyedProcessFunction<String, TelemetryRecord, WorldLatest> {
    private static final long serialVersionUID = 1L;

    private final int rollingWindowSeconds;
    private transient ValueState<WorldAccumulator> state;

    public WorldStateFunction(int rollingWindowSeconds) {
        this.rollingWindowSeconds = rollingWindowSeconds;
    }

    @Override
    public void open(Configuration parameters) {
        state = getRuntimeContext().getState(new ValueStateDescriptor<>("world-accumulator", WorldAccumulator.class));
    }

    @Override
    public void processElement(TelemetryRecord record, Context ctx, Collector<WorldLatest> out) throws Exception {
        WorldAccumulator acc = state.value();
        if (acc == null) acc = new WorldAccumulator(ctx.getCurrentKey());

        JsonNode node = Json.MAPPER.readTree(record.json);
        long now = ctx.timerService().currentProcessingTime();
        if (TelemetryRecord.TYPE_WORLD.equals(record.type)) {
            acc.applyWorld(node, now, rollingWindowSeconds);
        } else if (TelemetryRecord.TYPE_NPC.equals(record.type)) {
            acc.applyNpc(node, now);
        } else {
            return;
        }
        state.update(acc);
        out.collect(acc.toLatest(now, rollingWindowSeconds));
    }
}
