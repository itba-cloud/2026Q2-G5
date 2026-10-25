package com.elasticworlds.telemetry.functions;

import com.elasticworlds.telemetry.logic.FleetAggregator;
import com.elasticworlds.telemetry.model.FleetPoint;
import com.elasticworlds.telemetry.model.WorldLatest;
import org.apache.flink.streaming.api.functions.windowing.ProcessAllWindowFunction;
import org.apache.flink.streaming.api.windowing.windows.TimeWindow;
import org.apache.flink.util.Collector;

/** One fleet point per tumbling processing-time window. */
public class FleetWindowFunction extends ProcessAllWindowFunction<WorldLatest, FleetPoint, TimeWindow> {
    private static final long serialVersionUID = 1L;

    private final int windowSeconds;

    public FleetWindowFunction(int windowSeconds) {
        this.windowSeconds = windowSeconds;
    }

    @Override
    public void process(Context ctx, Iterable<WorldLatest> elements, Collector<FleetPoint> out) {
        out.collect(FleetAggregator.aggregate(elements, ctx.window().getEnd(), windowSeconds));
    }
}
