package com.elasticworlds.telemetry;

import com.amazonaws.services.kinesisanalytics.runtime.KinesisAnalyticsRuntime;
import org.apache.flink.api.java.utils.ParameterTool;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.Serializable;
import java.util.Map;
import java.util.Properties;

/**
 * Runtime configuration of the job. Managed Flink injects it as the property group
 * {@code TelemetryJob}; locally the same keys can be passed as {@code --key value}
 * program arguments, which take precedence.
 */
public final class JobConfig implements Serializable {
    private static final long serialVersionUID = 1L;
    private static final Logger LOG = LoggerFactory.getLogger(JobConfig.class);

    public static final String PROPERTY_GROUP = "TelemetryJob";

    public final String region;
    public final String streamArn;
    public final String tableName;
    public final int fleetWindowSeconds;
    public final int rollingWindowSeconds;
    public final int itemTtlDays;
    public final int historyTtlHours;

    public JobConfig(String region, String streamArn, String tableName, int fleetWindowSeconds,
                     int rollingWindowSeconds, int itemTtlDays, int historyTtlHours) {
        this.region = region;
        this.streamArn = streamArn;
        this.tableName = tableName;
        this.fleetWindowSeconds = fleetWindowSeconds;
        this.rollingWindowSeconds = rollingWindowSeconds;
        this.itemTtlDays = itemTtlDays;
        this.historyTtlHours = historyTtlHours;
    }

    public static JobConfig fromProperties(Properties props) {
        String streamArn = props.getProperty("stream.arn", "").trim();
        if (streamArn.isEmpty()) {
            throw new IllegalArgumentException("stream.arn is required (property group " + PROPERTY_GROUP + ")");
        }
        return new JobConfig(
                props.getProperty("aws.region", "us-east-1").trim(),
                streamArn,
                props.getProperty("table.name", "elastic-worlds-telemetry").trim(),
                Integer.parseInt(props.getProperty("fleet.window.seconds", "10").trim()),
                Integer.parseInt(props.getProperty("rolling.window.seconds", "60").trim()),
                Integer.parseInt(props.getProperty("item.ttl.days", "7").trim()),
                Integer.parseInt(props.getProperty("history.ttl.hours", "24").trim()));
    }

    /** Managed Flink application properties, overridden by program arguments. */
    public static JobConfig load(String[] args) {
        Properties merged = new Properties();
        try {
            Map<String, Properties> groups = KinesisAnalyticsRuntime.getApplicationProperties();
            Properties group = groups == null ? null : groups.get(PROPERTY_GROUP);
            if (group != null) {
                merged.putAll(group);
            } else {
                LOG.info("No '{}' property group found in the runtime; using arguments and defaults.", PROPERTY_GROUP);
            }
        } catch (Exception e) {
            LOG.info("Not running on Managed Flink ({}); using arguments and defaults.", e.getMessage());
        }
        merged.putAll(ParameterTool.fromArgs(args).toMap());
        return fromProperties(merged);
    }

    @Override
    public String toString() {
        return "JobConfig{region=" + region + ", streamArn=" + streamArn + ", tableName=" + tableName
                + ", fleetWindowSeconds=" + fleetWindowSeconds + ", rollingWindowSeconds=" + rollingWindowSeconds
                + ", itemTtlDays=" + itemTtlDays + ", historyTtlHours=" + historyTtlHours + "}";
    }
}
