package com.elasticworlds.telemetry.logic;

import com.elasticworlds.telemetry.model.FleetPoint;
import com.elasticworlds.telemetry.model.WorldLatest;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class FleetAggregatorTest {
    private static final long END = 1_760_000_010_000L;
    private static final int WINDOW = 10;

    private static WorldLatest w(String id, long worldUpdatedAt, long updatedAt, int total, int humans, double rss, Double hz, int bots, Double ai) {
        WorldLatest l = new WorldLatest();
        l.worldId = id;
        l.hasWorldSample = true;
        l.worldUpdatedAtMs = worldUpdatedAt;
        l.updatedAtMs = updatedAt;
        l.playersTotal = total;
        l.playersHumans = humans;
        l.playersBots = total - humans;
        l.rssMb = rss;
        l.tickHz = hz;
        l.botCount = bots;
        l.aiAvgMs = ai;
        return l;
    }

    @Test
    void sumsLatestStateOfEachWorld() {
        FleetPoint p = FleetAggregator.aggregate(List.of(
                w("a", END - 9000, END - 9000, 3, 1, 50, 20.0, 2, 1.0),
                w("a", END - 4000, END - 4000, 4, 2, 60, 18.0, 2, 3.0),
                w("b", END - 2000, END - 2000, 1, 1, 40.5, null, 0, null)
        ), END, WINDOW);
        assertEquals(2, p.activeWorlds);
        assertEquals(5, p.totalPlayers);
        assertEquals(3, p.humanPlayers);
        assertEquals(2, p.botPlayers);
        assertEquals(100.5, p.totalMemoryMb);
        assertEquals(18.0, p.avgTickHz);
        assertEquals(3.0, p.avgAiLatencyMs);
        assertEquals(2, p.totalBots);
        assertEquals(END, p.windowEndMs);
        assertEquals(WINDOW, p.windowSeconds);
    }

    @Test
    void worldsWithoutASampleInsideTheWindowAreNotActive() {
        // Only an npc update arrived in this window; the last world sample is older.
        WorldLatest stale = w("a", END - 30_000, END - 1000, 3, 1, 50, 20.0, 2, 1.0);
        WorldLatest npcOnly = w("b", 0, END - 1000, 0, 0, 0, null, 1, 2.0);
        npcOnly.hasWorldSample = false;
        FleetPoint p = FleetAggregator.aggregate(List.of(stale, npcOnly), END, WINDOW);
        assertEquals(0, p.activeWorlds);
        assertEquals(0, p.totalPlayers);
        assertNull(p.avgTickHz);
        assertNull(p.avgAiLatencyMs);
    }

    @Test
    void emptyWindowProducesZeroPoint() {
        FleetPoint p = FleetAggregator.aggregate(List.of(), END, WINDOW);
        assertEquals(0, p.activeWorlds);
        assertEquals(0.0, p.totalMemoryMb);
        assertNull(p.avgTickHz);
    }

    @Test
    void aiLatencyIgnoresWorldsWithoutBots() {
        FleetPoint p = FleetAggregator.aggregate(List.of(
                w("a", END - 1000, END - 1000, 1, 1, 10, 20.0, 0, 5.0),
                w("b", END - 1000, END - 1000, 2, 1, 10, 20.0, 1, 2.0)
        ), END, WINDOW);
        assertEquals(2.0, p.avgAiLatencyMs);
        assertEquals(1, p.totalBots);
    }
}
