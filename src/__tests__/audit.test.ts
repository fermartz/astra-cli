/**
 * Tests for utils/audit.ts — audit logging and secret sanitization.
 */
import { describe, it, expect } from "vitest";
import "./setup.js";
import { setupTestConfig } from "./setup.js";
import { sanitize, writeAuditEntry } from "../utils/audit.js";
import { auditLogPath } from "../config/paths.js";
import fs from "node:fs";

describe("Audit sanitization", () => {
  it("redacts secretKey", () => {
    const result = sanitize({ publicKey: "abc", secretKey: [1, 2, 3] });
    expect(result).toEqual({ publicKey: "abc", secretKey: "[REDACTED]" });
  });

  it("redacts api_key", () => {
    const result = sanitize({ agent_name: "test", api_key: "astra_secret_123" });
    expect(result).toEqual({ agent_name: "test", api_key: "[REDACTED]" });
  });

  it("redacts accessToken", () => {
    const result = sanitize({ accessToken: "bearer_token", email: "user@test.com" });
    expect(result).toEqual({ accessToken: "[REDACTED]", email: "user@test.com" });
  });

  it("redacts refreshToken", () => {
    const result = sanitize({ refreshToken: "refresh_abc" });
    expect(result).toEqual({ refreshToken: "[REDACTED]" });
  });

  it("redacts nested sensitive keys", () => {
    const result = sanitize({
      outer: { inner: { api_key: "nested_secret", safe: "ok" } },
    });
    expect(result).toEqual({
      outer: { inner: { api_key: "[REDACTED]", safe: "ok" } },
    });
  });

  it("handles arrays", () => {
    const result = sanitize([{ api_key: "secret" }, { name: "test" }]);
    expect(result).toEqual([{ api_key: "[REDACTED]" }, { name: "test" }]);
  });

  it("handles null and undefined", () => {
    expect(sanitize(null)).toBeNull();
    expect(sanitize(undefined)).toBeUndefined();
  });

  it("handles primitives", () => {
    expect(sanitize("hello")).toBe("hello");
    expect(sanitize(42)).toBe(42);
    expect(sanitize(true)).toBe(true);
  });
});

describe("writeAuditEntry()", () => {
  it("writes an audit entry to the log file", () => {
    setupTestConfig(); // ensures base dir exists

    writeAuditEntry({
      ts: "2026-01-01T00:00:00Z",
      tool: "api_call",
      args: { method: "GET", path: "/api/v1/agents/me" },
      result: { status: "active", simBalance: 9500 },
      ok: true,
      durationMs: 150,
    });

    const logPath = auditLogPath();
    expect(fs.existsSync(logPath)).toBe(true);

    const content = fs.readFileSync(logPath, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.tool).toBe("api_call");
    expect(entry.ok).toBe(true);
  });

  it("sanitizes sensitive data in audit entries", () => {
    setupTestConfig();

    writeAuditEntry({
      ts: "2026-01-01T00:00:00Z",
      tool: "write_config",
      args: { api_key: "astra_secret_key" },
      result: { success: true },
      ok: true,
      durationMs: 10,
    });

    const logPath = auditLogPath();
    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).not.toContain("astra_secret_key");
    expect(content).toContain("[REDACTED]");
  });
});
