/**
 * Integration Test 13: Codex Body Format Compatibility
 *
 * Tests that all the body format variations from the Codex LLM
 * are handled correctly when hitting the real API.
 *
 * The Codex model frequently sends tool call arguments in unexpected formats:
 * 1. Correct: { method, path, body: { key: value } }
 * 2. Flattened: { method, path, key: value }
 * 3. Stringified: { method, path, body: '{"key":"value"}' }
 * 4. Null body: { method, path, body: null, key: value }
 *
 * These tests use real API calls to verify each format works end-to-end.
 *
 * What it tests:
 * - All 4 body format variations with real API
 * - GET requests ignore extra params (don't send body)
 * - POST requests with all format variations
 */
import { describe, it, expect } from "vitest";
import { executeTool, assertSuccess, delay } from "./harness.js";

// Use api_call tool directly to test body resolution
async function callWithArgs(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await executeTool("api_call", args)) as Record<string, unknown>;
}

describe("Integration: Codex Body Format Compatibility", () => {
  // ─── GET requests ───────────────────────────────────────────────────

  describe("GET requests", () => {
    it("standard GET", async () => {
      const result = await callWithArgs({
        method: "GET",
        path: "/api/v1/market/state",
      });
      assertSuccess(result, "GET standard");
      expect(result.market).toBeDefined();
    }, 15_000);

    it("GET with extra params (should be ignored)", async () => {
      await delay(300);
      const result = await callWithArgs({
        method: "GET",
        path: "/api/v1/portfolio",
        includeHistory: true,
        format: "detailed",
      });
      assertSuccess(result, "GET with extra params");
      expect(result.portfolio).toBeDefined();
    }, 15_000);

    it("GET with null body (should be ignored)", async () => {
      await delay(300);
      const result = await callWithArgs({
        method: "GET",
        path: "/api/v1/agents/me",
        body: null,
      });
      assertSuccess(result, "GET with null body");
      expect(result.agent).toBeDefined();
    }, 15_000);
  });

  // ─── POST requests — body format variations ─────────────────────────

  describe("POST requests — body format variations", () => {
    it("Format 1: proper body object", async () => {
      await delay(500);
      const result = await callWithArgs({
        method: "POST",
        path: "/api/v1/trades",
        body: { side: "buy", quantity: 1 },
      });
      assertSuccess(result, "POST proper body");
      expect(result.trade).toBeDefined();
      console.log("  Format 1 (proper body): OK");
    }, 30_000);

    it("Format 2: flattened params (Codex bug)", async () => {
      await delay(500);
      const result = await callWithArgs({
        method: "POST",
        path: "/api/v1/trades",
        side: "sell",
        quantity: 1,
      });
      assertSuccess(result, "POST flattened body");
      expect(result.trade).toBeDefined();
      console.log("  Format 2 (flattened): OK");
    }, 30_000);

    it("Format 3: stringified body", async () => {
      await delay(500);
      const result = await callWithArgs({
        method: "POST",
        path: "/api/v1/trades",
        body: '{"side":"buy","quantity":1}',
      });
      assertSuccess(result, "POST stringified body");
      expect(result.trade).toBeDefined();
      console.log("  Format 3 (stringified): OK");
    }, 30_000);

    it("Format 4: null body with flattened params", async () => {
      await delay(500);
      const result = await callWithArgs({
        method: "POST",
        path: "/api/v1/trades",
        body: null,
        side: "sell",
        quantity: 1,
      });
      assertSuccess(result, "POST null body + flattened");
      expect(result.trade).toBeDefined();
      console.log("  Format 4 (null body + flattened): OK");
    }, 30_000);
  });

  // ─── Edge cases ─────────────────────────────────────────────────────

  describe("Edge cases", () => {
    it("empty body object on POST → API may return error (no side/quantity)", async () => {
      await delay(500);
      const result = await callWithArgs({
        method: "POST",
        path: "/api/v1/trades",
        body: {},
      });
      // Should fail because no side/quantity — but should NOT crash our tool
      expect(result.error).toBeDefined();
      console.log(`  Empty body error: ${result.error}`);
    }, 15_000);

    it("body as array → should not crash", async () => {
      await delay(500);
      const result = await callWithArgs({
        method: "POST",
        path: "/api/v1/trades",
        body: [{ side: "buy", quantity: 1 }],
      });
      // Arrays aren't valid body objects — should either error or be handled
      // The important thing is it doesn't crash
      console.log(`  Array body: ${result.error ?? "handled somehow"}`);
    }, 15_000);
  });
});
