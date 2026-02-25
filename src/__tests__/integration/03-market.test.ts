/**
 * Integration Test 03: Market Data
 *
 * Tests market state and epoch history retrieval.
 * Requires: A verified (active) agent.
 *
 * What it tests:
 * - GET /api/v1/market/state — current price, mood, phase
 * - GET /api/v1/market/epochs — epoch history
 * - Response shape validation
 */
import { describe, it, expect } from "vitest";
import { apiCall, assertSuccess } from "./harness.js";

describe("Integration: Market Data", () => {
  it("GET /api/v1/market/state — current market snapshot", async () => {
    const result = await apiCall("GET", "/api/v1/market/state");
    assertSuccess(result, "GET /market/state");

    expect(result.success).toBe(true);
    expect(result.market).toBeDefined();

    const market = result.market as Record<string, unknown>;
    expect(typeof market.price).toBe("number");
    expect(market.price).toBeGreaterThan(0);
    expect(typeof market.mood).toBe("string");
    expect(["crab", "bull", "bear"]).toContain(market.mood);
    expect(typeof market.intensity).toBe("number");
    expect(market.intensity).toBeGreaterThanOrEqual(1);
    expect(market.intensity).toBeLessThanOrEqual(5);
    expect(market.phase).toBeDefined();
    expect(market.epoch).toBeDefined();

    const epoch = market.epoch as Record<string, unknown>;
    expect(typeof epoch.global).toBe("number");

    console.log(`  Price: ${market.price}`);
    console.log(`  Mood: ${market.mood} (intensity: ${market.intensity})`);
    console.log(`  Phase: ${market.phase}`);
    console.log(`  Tension: ${market.tension}, Stress: ${market.stress}`);
    console.log(`  Epoch: ${epoch.global} (season: ${epoch.seasonIndex}, in-season: ${epoch.inSeason})`);
  }, 15_000);

  it("GET /api/v1/market/epochs — epoch history", async () => {
    const result = await apiCall("GET", "/api/v1/market/epochs?limit=5");
    assertSuccess(result, "GET /market/epochs");

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);

    const epochs = result.data as Array<Record<string, unknown>>;
    if (epochs.length > 0) {
      const epoch = epochs[0];
      expect(typeof epoch.epochIndex).toBe("number");
      expect(typeof epoch.openPrice).toBe("number");
      expect(typeof epoch.closePrice).toBe("number");
      expect(epoch.mood).toBeDefined();

      console.log(`  Latest epoch ${epoch.epochIndex}: open=${epoch.openPrice} close=${epoch.closePrice} mood=${epoch.mood}`);
    }
    console.log(`  Total epochs returned: ${epochs.length}`);
  }, 15_000);

  it("market state has valid epoch structure", async () => {
    const result = await apiCall("GET", "/api/v1/market/state");
    assertSuccess(result, "GET /market/state");

    const market = result.market as Record<string, unknown>;
    const epoch = market.epoch as Record<string, unknown>;

    // Epoch numbers should be positive integers
    expect(epoch.global).toBeGreaterThanOrEqual(0);
    expect(epoch.inSeason).toBeGreaterThanOrEqual(0);
    expect(epoch.seasonIndex).toBeGreaterThanOrEqual(0);
  }, 15_000);
});
