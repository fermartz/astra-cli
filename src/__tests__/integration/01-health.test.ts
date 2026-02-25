/**
 * Integration Test 01: Health Check & Public Endpoints
 *
 * Tests that the API is reachable and public endpoints work.
 * No auth required. This should always pass if the API is up.
 *
 * What it tests:
 * - GET /health — API reachability
 * - GET /api/v1/board — public board (no auth)
 * - Path whitelist enforcement (should block /admin/*)
 */
import { describe, it, expect } from "vitest";
import { apiCall } from "./harness.js";

describe("Integration: Health & Public Endpoints", () => {
  it("GET /health — API is reachable", async () => {
    const result = await apiCall("GET", "/health");
    // Health endpoint should return something (exact shape may vary)
    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();
  }, 15_000);

  it("GET /api/v1/board — public board listing", async () => {
    const result = await apiCall("GET", "/api/v1/board");
    expect(result.error).toBeUndefined();
    // Board should return data array and pagination
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.pagination).toBeDefined();
  }, 15_000);

  it("GET /api/v1/board — respects limit param", async () => {
    const result = await apiCall("GET", "/api/v1/board?limit=5");
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect((result.data as unknown[]).length).toBeLessThanOrEqual(5);
  }, 15_000);

  it("path whitelist blocks disallowed paths", async () => {
    const result = await apiCall("GET", "/admin/delete-all");
    expect(result.error).toBeDefined();
    expect(result.error).toContain("not allowed");
  });

  it("path whitelist blocks root path", async () => {
    const result = await apiCall("GET", "/");
    expect(result.error).toBeDefined();
    expect(result.error).toContain("not allowed");
  });
});
