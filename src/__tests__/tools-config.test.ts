/**
 * Tests for tools/config.ts — read_config and write_config tools.
 *
 * Tests security (never expose secrets), config reads, and safe writes.
 */
import { describe, it, expect } from "vitest";
import "./setup.js";
import { setupFakeAgent, setupTestConfig } from "./setup.js";
import { readConfigTool, writeConfigTool } from "../tools/config.js";
import { loadCredentials } from "../config/store.js";

// Helper to execute tools
async function execReadConfig(args: Record<string, unknown>): Promise<unknown> {
  const execute = (readConfigTool as unknown as { execute: (args: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown> }).execute;
  return execute(args, {});
}

async function execWriteConfig(args: Record<string, unknown>): Promise<unknown> {
  const execute = (writeConfigTool as unknown as { execute: (args: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown> }).execute;
  return execute(args, {});
}

describe("read_config tool", () => {
  // ─── Security ────────────────────────────────────────────────────────

  describe("Security — never expose secrets", () => {
    it("profile: returns agent_name and api_base, NOT api_key", async () => {
      setupFakeAgent("secure-agent");
      const result = await execReadConfig({ key: "profile" }) as Record<string, unknown>;
      expect(result.agent_name).toBe("secure-agent");
      expect(result.api_base).toBe("https://agents.astranova.live");
      expect(result).not.toHaveProperty("api_key");
    });

    it("wallet: returns publicKey only, NOT secretKey", async () => {
      setupFakeAgent("wallet-agent", { withWallet: true });
      const result = await execReadConfig({ key: "wallet" }) as Record<string, unknown>;
      expect(result.publicKey).toBeDefined();
      expect(result).not.toHaveProperty("secretKey");
    });

    it("settings: returns provider/model/preferences, NOT auth credentials", async () => {
      setupTestConfig();
      setupFakeAgent("settings-agent");
      const result = await execReadConfig({ key: "settings" }) as Record<string, unknown>;
      expect(result.provider).toBe("claude");
      expect(result.model).toBeDefined();
      expect(result).not.toHaveProperty("auth");
      expect(result).not.toHaveProperty("apiKey");
    });
  });

  // ─── Happy Paths ────────────────────────────────────────────────────

  describe("Happy paths", () => {
    it("reads profile for active agent", async () => {
      setupFakeAgent("my-agent");
      const result = await execReadConfig({ key: "profile" }) as Record<string, unknown>;
      expect(result.agent_name).toBe("my-agent");
    });

    it("reads profile for specific agent name", async () => {
      setupFakeAgent("agent-a");
      setupFakeAgent("agent-b");
      const result = await execReadConfig({ key: "profile", agentName: "agent-b" }) as Record<string, unknown>;
      expect(result.agent_name).toBe("agent-b");
    });

    it("reads all_agents with correct count", async () => {
      setupFakeAgent("alpha");
      setupFakeAgent("beta");
      const result = await execReadConfig({ key: "all_agents" }) as Record<string, unknown>;
      expect(result.count).toBe(2);
      expect(result.activeAgent).toBeDefined();
      expect(result.agents).toEqual(expect.arrayContaining(["alpha", "beta"]));
    });
  });

  // ─── Error Cases ────────────────────────────────────────────────────

  describe("Error cases", () => {
    it("returns error when no active agent (profile)", async () => {
      const result = await execReadConfig({ key: "profile" }) as Record<string, unknown>;
      expect(result.error).toContain("No active agent");
    });

    it("returns error when wallet not found", async () => {
      setupFakeAgent("no-wallet-agent");
      const result = await execReadConfig({ key: "wallet" }) as Record<string, unknown>;
      expect(result.error).toContain("No wallet found");
    });

    it("returns error when no config (settings)", async () => {
      // Don't call setupTestConfig — no config.json exists
      setupFakeAgent("some-agent");
      const result = await execReadConfig({ key: "settings" }) as Record<string, unknown>;
      expect(result.error).toContain("No config found");
    });
  });
});

describe("write_config tool", () => {
  // ─── Security ────────────────────────────────────────────────────────

  describe("Security", () => {
    it("rejects wallet data in credentials write", async () => {
      setupFakeAgent("target");
      const result = await execWriteConfig({
        agentName: "target",
        file: "credentials",
        data: { secretKey: [1, 2, 3] },
      }) as Record<string, unknown>;
      expect(result.error).toContain("Cannot write wallet data");
    });
  });

  // ─── Credentials Merge ──────────────────────────────────────────────

  describe("Credentials merge", () => {
    it("preserves api_key when updating credentials", async () => {
      setupFakeAgent("merge-agent");
      const originalCreds = loadCredentials("merge-agent");
      expect(originalCreds!.api_key).toBe("astra_test_key_12345");

      await execWriteConfig({
        agentName: "merge-agent",
        file: "credentials",
        data: { api_base: "https://new-api.example.com" },
      });

      const updated = loadCredentials("merge-agent");
      expect(updated!.api_key).toBe("astra_test_key_12345"); // preserved
      expect(updated!.api_base).toBe("https://new-api.example.com"); // updated
    });
  });

  // ─── Profile/Settings Write ─────────────────────────────────────────

  describe("Profile/settings writes", () => {
    it("writes profile data successfully", async () => {
      setupFakeAgent("profile-agent");
      const result = await execWriteConfig({
        agentName: "profile-agent",
        file: "profile",
        data: { displayName: "The Fox", bio: "A cunning trader" },
      }) as Record<string, unknown>;
      expect(result.success).toBe(true);
      expect(result.file).toBe("profile.json");
    });
  });
});
