/**
 * Tests for tools/api.ts — api_call tool.
 *
 * Tests path whitelisting, body resolution (flattened/stringified/null),
 * retry logic, and board post tracking.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "./setup.js";
import { setupFakeAgent, setupTestConfig } from "./setup.js";

// Mock the http module to avoid real API calls
vi.mock("../utils/http.js", () => ({
  apiCall: vi.fn(),
}));

import { apiCallTool } from "../tools/api.js";
import { apiCall } from "../utils/http.js";
import { hasBoardPost } from "../config/store.js";

const mockedApiCall = vi.mocked(apiCall);

// Helper to execute the tool
async function execApiCall(args: Record<string, unknown>): Promise<unknown> {
  const execute = (apiCallTool as unknown as { execute: (args: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown> }).execute;
  return execute(args, {});
}

describe("api_call tool", () => {
  beforeEach(() => {
    setupTestConfig();
    setupFakeAgent("test-agent");
    vi.clearAllMocks();
  });

  // ─── Path Whitelist ──────────────────────────────────────────────────

  describe("Path whitelist", () => {
    it("allows /api/v1/ paths", async () => {
      mockedApiCall.mockResolvedValue({ ok: true, data: { status: "ok" }, status: 200 });
      const result = await execApiCall({ method: "GET", path: "/api/v1/agents/me" });
      expect(result).toEqual({ status: "ok" });
    });

    it("allows /health path", async () => {
      mockedApiCall.mockResolvedValue({ ok: true, data: { healthy: true }, status: 200 });
      const result = await execApiCall({ method: "GET", path: "/health" });
      expect(result).toEqual({ healthy: true });
    });

    it("rejects paths outside whitelist", async () => {
      const result = await execApiCall({ method: "GET", path: "/admin/delete-all" }) as { error: string };
      expect(result.error).toContain("not allowed");
      expect(mockedApiCall).not.toHaveBeenCalled();
    });

    it("rejects empty path", async () => {
      const result = await execApiCall({ method: "GET", path: "" }) as { error: string };
      expect(result.error).toContain("Missing 'path'");
    });

    it("rejects missing path", async () => {
      const result = await execApiCall({ method: "GET" }) as { error: string };
      expect(result.error).toContain("Missing 'path'");
    });
  });

  // ─── Body Resolution ────────────────────────────────────────────────

  describe("Body resolution", () => {
    it("passes proper body object directly", async () => {
      mockedApiCall.mockResolvedValue({ ok: true, data: { success: true }, status: 200 });
      await execApiCall({
        method: "POST",
        path: "/api/v1/trades",
        body: { side: "buy", symbol: "NOVA", amount: 500 },
      });
      expect(mockedApiCall).toHaveBeenCalledWith(
        "POST",
        "/api/v1/trades",
        { side: "buy", symbol: "NOVA", amount: 500 },
        "test-agent",
        expect.anything(),
      );
    });

    it("recovers flattened body params (Codex bug)", async () => {
      mockedApiCall.mockResolvedValue({ ok: true, data: { success: true }, status: 200 });
      // LLM sends: { method, path, side, symbol, amount } instead of { method, path, body: { ... } }
      await execApiCall({
        method: "POST",
        path: "/api/v1/trades",
        side: "buy",
        symbol: "NOVA",
        amount: 500,
      });
      expect(mockedApiCall).toHaveBeenCalledWith(
        "POST",
        "/api/v1/trades",
        expect.objectContaining({ side: "buy", symbol: "NOVA", amount: 500 }),
        "test-agent",
        expect.anything(),
      );
    });

    it("parses stringified body", async () => {
      mockedApiCall.mockResolvedValue({ ok: true, data: { success: true }, status: 200 });
      await execApiCall({
        method: "POST",
        path: "/api/v1/board",
        body: '{"message":"Hello AstraNova!"}',
      });
      expect(mockedApiCall).toHaveBeenCalledWith(
        "POST",
        "/api/v1/board",
        { message: "Hello AstraNova!" },
        "test-agent",
        expect.anything(),
      );
    });

    it("recovers body from null body + extra params", async () => {
      mockedApiCall.mockResolvedValue({ ok: true, data: { success: true }, status: 200 });
      await execApiCall({
        method: "POST",
        path: "/api/v1/board",
        body: null,
        message: "Hello from flattened params!",
      });
      expect(mockedApiCall).toHaveBeenCalledWith(
        "POST",
        "/api/v1/board",
        expect.objectContaining({ message: "Hello from flattened params!" }),
        "test-agent",
        expect.anything(),
      );
    });

    it("omits body for GET requests even with extra params", async () => {
      mockedApiCall.mockResolvedValue({ ok: true, data: { price: 1.5 }, status: 200 });
      await execApiCall({
        method: "GET",
        path: "/api/v1/market/state",
        extraParam: "ignored",
      });
      // GET should not have body
      expect(mockedApiCall).toHaveBeenCalledWith(
        "GET",
        "/api/v1/market/state",
        undefined,
        "test-agent",
        expect.anything(),
      );
    });
  });

  // ─── Retry Logic ────────────────────────────────────────────────────

  describe("Retry decisions", () => {
    it("enables retry for GET requests", async () => {
      mockedApiCall.mockResolvedValue({ ok: true, data: {}, status: 200 });
      await execApiCall({ method: "GET", path: "/api/v1/portfolio" });
      // Should pass retry options (not false)
      const retryArg = mockedApiCall.mock.calls[0][4];
      expect(retryArg).not.toBe(false);
    });

    it("disables retry for POST /api/v1/trades", async () => {
      mockedApiCall.mockResolvedValue({ ok: true, data: {}, status: 200 });
      await execApiCall({ method: "POST", path: "/api/v1/trades", body: { side: "buy", symbol: "NOVA", amount: 100 } });
      const retryArg = mockedApiCall.mock.calls[0][4];
      expect(retryArg).toBe(false);
    });

    it("disables retry for POST /api/v1/board", async () => {
      mockedApiCall.mockResolvedValue({ ok: true, data: {}, status: 200 });
      await execApiCall({ method: "POST", path: "/api/v1/board", body: { message: "Hello" } });
      const retryArg = mockedApiCall.mock.calls[0][4];
      expect(retryArg).toBe(false);
    });

    it("disables retry for POST /api/v1/agents/register", async () => {
      mockedApiCall.mockResolvedValue({ ok: true, data: {}, status: 200 });
      await execApiCall({ method: "POST", path: "/api/v1/agents/register", body: { name: "test" } });
      const retryArg = mockedApiCall.mock.calls[0][4];
      expect(retryArg).toBe(false);
    });

    it("disables retry for POST /api/v1/agents/me/rewards/claim", async () => {
      mockedApiCall.mockResolvedValue({ ok: true, data: {}, status: 200 });
      await execApiCall({ method: "POST", path: "/api/v1/agents/me/rewards/claim" });
      const retryArg = mockedApiCall.mock.calls[0][4];
      expect(retryArg).toBe(false);
    });
  });

  // ─── Board Post Tracking ────────────────────────────────────────────

  describe("Board post tracking", () => {
    it("marks board as posted after successful POST /api/v1/board", async () => {
      mockedApiCall.mockResolvedValue({ ok: true, data: { success: true }, status: 200 });
      expect(hasBoardPost("test-agent")).toBe(false);
      await execApiCall({ method: "POST", path: "/api/v1/board", body: { message: "Hello!" } });
      expect(hasBoardPost("test-agent")).toBe(true);
    });

    it("does not mark board on failed POST", async () => {
      mockedApiCall.mockResolvedValue({ ok: false, status: 500, error: "Server error" });
      await execApiCall({ method: "POST", path: "/api/v1/board", body: { message: "Hello!" } });
      expect(hasBoardPost("test-agent")).toBe(false);
    });

    it("does not mark board on non-POST methods", async () => {
      mockedApiCall.mockResolvedValue({ ok: true, data: [], status: 200 });
      await execApiCall({ method: "GET", path: "/api/v1/board" });
      expect(hasBoardPost("test-agent")).toBe(false);
    });
  });

  // ─── Error Handling ─────────────────────────────────────────────────

  describe("Error handling", () => {
    it("returns structured error on API failure", async () => {
      mockedApiCall.mockResolvedValue({
        ok: false,
        status: 404,
        error: "Agent not found",
        code: "AGENT_NOT_FOUND",
        hint: "Check agent name",
      });
      const result = await execApiCall({ method: "GET", path: "/api/v1/agents/me" }) as Record<string, unknown>;
      expect(result.error).toBe("Agent not found");
      expect(result.status).toBe(404);
      expect(result.code).toBe("AGENT_NOT_FOUND");
      expect(result.hint).toBe("Check agent name");
    });
  });
});
