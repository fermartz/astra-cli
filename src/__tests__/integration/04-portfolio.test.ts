/**
 * Integration Test 04: Portfolio
 *
 * Tests portfolio retrieval and response shape.
 * Requires: A verified (active) agent.
 *
 * What it tests:
 * - GET /api/v1/portfolio — current holdings, P&L, rewards
 * - Response shape matches what the TUI expects
 * - Rewards sub-object structure
 */
import { describe, it, expect } from "vitest";
import { apiCall, assertSuccess } from "./harness.js";

describe("Integration: Portfolio", () => {
  it("GET /api/v1/portfolio — full portfolio snapshot", async () => {
    const result = await apiCall("GET", "/api/v1/portfolio");
    assertSuccess(result, "GET /portfolio");

    expect(result.success).toBe(true);
    expect(result.portfolio).toBeDefined();

    const portfolio = result.portfolio as Record<string, unknown>;
    expect(typeof portfolio.cash).toBe("number");
    expect(typeof portfolio.tokens).toBe("number");
    expect(typeof portfolio.portfolioValue).toBe("number");
    expect(typeof portfolio.currentPrice).toBe("number");

    // P&L fields
    expect(portfolio.pnl).toBeDefined();
    expect(portfolio.pnlPct).toBeDefined();

    console.log(`  Cash (SIM): ${portfolio.cash}`);
    console.log(`  Tokens (NOVA): ${portfolio.tokens}`);
    console.log(`  Portfolio value: ${portfolio.portfolioValue}`);
    console.log(`  P&L: ${portfolio.pnl} (${portfolio.pnlPct}%)`);
    console.log(`  Current price: ${portfolio.currentPrice}`);
  }, 15_000);

  it("portfolio includes rewards sub-object", async () => {
    const result = await apiCall("GET", "/api/v1/portfolio");
    assertSuccess(result, "GET /portfolio");

    const portfolio = result.portfolio as Record<string, unknown>;
    expect(portfolio.rewards).toBeDefined();

    const rewards = portfolio.rewards as Record<string, unknown>;
    expect(typeof rewards.totalEarned).toBe("number");
    expect(typeof rewards.totalClaimed).toBe("number");
    expect(typeof rewards.claimable).toBe("number");
    expect(typeof rewards.hasWallet).toBe("boolean");

    console.log(`  Rewards earned: ${rewards.totalEarned}`);
    console.log(`  Rewards claimed: ${rewards.totalClaimed}`);
    console.log(`  Rewards claimable: ${rewards.claimable}`);
    console.log(`  Has wallet: ${rewards.hasWallet}`);
  }, 15_000);

  it("portfolio values are non-negative", async () => {
    const result = await apiCall("GET", "/api/v1/portfolio");
    assertSuccess(result, "GET /portfolio");

    const portfolio = result.portfolio as Record<string, unknown>;
    expect(portfolio.cash).toBeGreaterThanOrEqual(0);
    expect(portfolio.tokens).toBeGreaterThanOrEqual(0);
    expect(portfolio.portfolioValue).toBeGreaterThanOrEqual(0);
    expect(portfolio.currentPrice).toBeGreaterThan(0);
  }, 15_000);
});
