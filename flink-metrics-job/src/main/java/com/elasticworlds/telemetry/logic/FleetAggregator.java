package com.elasticworlds.telemetry.logic;

import com.elasticworlds.telemetry.model.FleetPoint;
import com.elasticworlds.telemetry.model.WorldLatest;

import java.util.HashMap;
import java.util.Map;

/**
 * Collapses every {@link WorldLatest} emitted inside one tumbling window into a fleet point.
 * A world counts as active only if a world sample was applied inside the window; npc-only
 * updates refresh its ai figures but cannot keep a dead world alive.
 */
public final class FleetAggregator {
    private FleetAggregator() {}

    public static FleetPoint aggregate(Iterable<WorldLatest> updates, long windowEndMs, int windowSeconds) {
        long windowStartMs = windowEndMs - windowSeconds * 1000L;
        Map<String, WorldLatest> latestByWorld = new HashMap<>();
        for (WorldLatest w : updates) {
            WorldLatest prev = latestByWorld.get(w.worldId);
            if (prev == null || w.updatedAtMs >= prev.updatedAtMs) latestByWorld.put(w.worldId, w);
        }

        FleetPoint p = new FleetPoint();
        p.windowEndMs = windowEndMs;
        p.windowSeconds = windowSeconds;

        double hzSum = 0; int hzCount = 0;
        double aiSum = 0; int aiCount = 0;
        for (WorldLatest w : latestByWorld.values()) {
            if (!w.hasWorldSample || w.worldUpdatedAtMs < windowStartMs) continue;
            p.activeWorlds++;
            p.totalPlayers += w.playersTotal;
            p.humanPlayers += w.playersHumans;
            p.botPlayers += w.playersBots;
            p.totalMemoryMb += w.rssMb;
            p.totalBots += w.botCount;
            if (w.tickHz != null) { hzSum += w.tickHz; hzCount++; }
            if (w.botCount > 0 && w.aiAvgMs != null) { aiSum += w.aiAvgMs; aiCount++; }
        }
        p.totalMemoryMb = Math.round(p.totalMemoryMb * 10.0) / 10.0;
        p.avgTickHz = hzCount == 0 ? null : Math.round(hzSum / hzCount * 100.0) / 100.0;
        p.avgAiLatencyMs = aiCount == 0 ? null : Math.round(aiSum / aiCount * 100.0) / 100.0;
        return p;
    }
}
