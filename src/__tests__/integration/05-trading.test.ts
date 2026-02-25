/**
 * Integration Test 05: Trading
 *
 * Tests the full trading flow: check market, buy, check portfolio, sell.
 * Requires: A verified (active) agent with SIM balance.
 *
 * What it tests:
 * - POST /api/v1/trades — buy NOVA
 * - POST /api/v1/trades — sell NOVA
 * - GET /api/v1/trades — trade history
 * - Portfolio updates after trades
 * - Error handling (insufficient funds, invalid side)
 * - Body flattening recovery (simulates Codex bug)
 *
 * NOTE: These tests execute REAL trades on the live market.
 * Use small quantities (10 NOVA) to minimize impact.
 */
import { describe, it, expect } from "vitest";
import { apiCall, executeTool, assertSuccess, delay } from "./harness.js";

describe("Integration: Trading", () => {
  let preTradeBalance: number;
  let preTradeTokens: number;

  it("snapshot pre-trade portfolio", async () => {
    const result = await apiCall("GET", "/api/v1/portfolio");
    assertSuccess(result, "GET /portfolio (pre-trade)");

    const portfolio = result.portfolio as Record<string, unknown>;
    preTradeBalance = portfolio.cash as number;
    preTradeTokens = portfolio.tokens as number;

    console.log(`  Pre-trade: ${preTradeBalance} SIM, ${preTradeTokens} NOVA`);
    expect(preTradeBalance).toBeGreaterThan(0);
  }, 15_000);

  it("BUY 10 NOVA — executes trade", async () => {
    const result = await apiCall("POST", "/api/v1/trades", {
      side: "buy",
      quantity: 10,
    });
    assertSuccess(result, "POST /trades (buy)");

    expect(result.success).toBe(true);
    expect(result.trade).toBeDefined();

    const trade = result.trade as Record<string, unknown>;
    expect(trade.side).toBe("buy");
    expect(trade.quantity).toBe(10);
    expect(typeof trade.price).toBe("number");
    expect(trade.price).toBeGreaterThan(0);
    expect(typeof trade.fee).toBe("number");
    expect(trade.status).toBeDefined();

    // Portfolio should be included in trade response
    expect(result.portfolio).toBeDefined();
    const portfolio = result.portfolio as Record<string, unknown>;
    expect(portfolio.cash).toBeDefined();
    expect(portfolio.tokens).toBeDefined();

    console.log(`  Bought: ${trade.filledQuantity} NOVA @ ${trade.price} (fee: ${trade.fee})`);
    console.log(`  Status: ${trade.status}`);
    console.log(`  Post-trade: ${portfolio.cash} SIM, ${portfolio.tokens} NOVA`);
  }, 30_000);

  it("portfolio reflects buy — more tokens, less cash", async () => {
    await delay(500);
    const result = await apiCall("GET", "/api/v1/portfolio");
    assertSuccess(result, "GET /portfolio (after buy)");

    const portfolio = result.portfolio as Record<string, unknown>;
    const currentTokens = portfolio.tokens as number;
    const currentCash = portfolio.cash as number;

    // Should have more tokens and less cash
    expect(currentTokens).toBeGreaterThan(preTradeTokens);
    expect(currentCash).toBeLessThan(preTradeBalance);

    console.log(`  After buy: ${currentCash} SIM, ${currentTokens} NOVA`);
  }, 15_000);

  it("SELL 5 NOVA — partial position sell", async () => {
    await delay(500);
    const result = await apiCall("POST", "/api/v1/trades", {
      side: "sell",
      quantity: 5,
    });
    assertSuccess(result, "POST /trades (sell)");

    const trade = result.trade as Record<string, unknown>;
    expect(trade.side).toBe("sell");
    expect(typeof trade.price).toBe("number");

    console.log(`  Sold: ${trade.filledQuantity} NOVA @ ${trade.price} (fee: ${trade.fee})`);
  }, 30_000);

  it("GET /api/v1/trades — trade history includes our trades", async () => {
    await delay(500);
    const result = await apiCall("GET", "/api/v1/trades?limit=5");
    assertSuccess(result, "GET /trades");

    expect(result.success).toBe(true);
    expect(result.trades).toBeDefined();
    expect(Array.isArray(result.trades)).toBe(true);

    const trades = result.trades as Array<Record<string, unknown>>;
    expect(trades.length).toBeGreaterThanOrEqual(2); // at least our buy and sell

    // Most recent trade should be our sell
    const latestTrade = trades[0];
    expect(latestTrade.side).toBe("sell");

    console.log(`  Trade history (last ${trades.length}):`);
    for (const t of trades.slice(0, 3)) {
      console.log(`    ${t.side} ${t.filledQuantity} @ ${t.price} — ${t.status}`);
    }
  }, 15_000);

  // ─── Body Flattening (Codex Compatibility) ──────────────────────────

  it("BUY with flattened body — Codex sends params at top level", async () => {
    await delay(500);
    // Simulate what Codex does: sends { method, path, side, quantity }
    // instead of { method, path, body: { side, quantity } }
    const result = await executeTool("api_call", {
      method: "POST",
      path: "/api/v1/trades",
      side: "buy",
      quantity: 5,
    }) as Record<string, unknown>;

    assertSuccess(result, "POST /trades (flattened body)");
    expect(result.success).toBe(true);

    const trade = result.trade as Record<string, unknown>;
    expect(trade.side).toBe("buy");
    console.log(`  Flattened body buy: ${trade.filledQuantity} NOVA @ ${trade.price}`);
  }, 30_000);

  it("BUY with stringified body — another Codex variant", async () => {
    await delay(500);
    // Simulate: body is a JSON string instead of object
    const result = await executeTool("api_call", {
      method: "POST",
      path: "/api/v1/trades",
      body: '{"side":"buy","quantity":5}',
    }) as Record<string, unknown>;

    assertSuccess(result, "POST /trades (stringified body)");
    expect(result.success).toBe(true);

    const trade = result.trade as Record<string, unknown>;
    expect(trade.side).toBe("buy");
    console.log(`  Stringified body buy: ${trade.filledQuantity} NOVA @ ${trade.price}`);
  }, 30_000);

  // ─── Error Cases ────────────────────────────────────────────────────

  it("invalid side — returns clear error", async () => {
    await delay(500);
    const result = await apiCall("POST", "/api/v1/trades", {
      side: "hold",
      quantity: 10,
    });

    expect(result.error).toBeDefined();
    console.log(`  Expected error: ${result.error}`);
  }, 15_000);

  it("sell more than owned — returns error or partial fill", async () => {
    await delay(500);
    const result = await apiCall("POST", "/api/v1/trades", {
      side: "sell",
      quantity: 999_999,
    });

    // Should either error or return partial fill
    if (result.error) {
      expect(result.error).toBeDefined();
      console.log(`  Expected error: ${result.error}`);
    } else {
      const trade = result.trade as Record<string, unknown>;
      // Partial fill — filledQuantity should be less than requested
      expect(trade.filledQuantity).toBeLessThan(999_999);
      console.log(`  Partial fill: ${trade.filledQuantity} of 999999`);
    }
  }, 15_000);

  // ─── Cleanup: sell remaining test tokens ────────────────────────────

  it("cleanup: sell remaining test tokens", async () => {
    await delay(500);
    const portfolio = await apiCall("GET", "/api/v1/portfolio");
    assertSuccess(portfolio, "GET /portfolio (cleanup)");

    const tokens = (portfolio.portfolio as Record<string, unknown>).tokens as number;
    const excessTokens = tokens - preTradeTokens;

    if (excessTokens > 0) {
      const result = await apiCall("POST", "/api/v1/trades", {
        side: "sell",
        quantity: excessTokens,
      });
      if (result.error) {
        console.log(`  Cleanup sell failed (non-critical): ${result.error}`);
      } else {
        console.log(`  Cleaned up: sold ${excessTokens} excess NOVA`);
      }
    } else {
      console.log("  No cleanup needed — token balance at or below pre-test level");
    }
  }, 30_000);
});
