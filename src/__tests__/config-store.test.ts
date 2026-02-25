/**
 * Tests for config/store.ts — config I/O, agent state, credential management.
 */
import { describe, it, expect } from "vitest";
import "./setup.js";
import { getTestDir, setupFakeAgent, setupTestConfig } from "./setup.js";
import {
  isConfigured,
  loadConfig,
  saveConfig,
  loadState,
  saveState,
  updateAgentState,
  getActiveAgent,
  setActiveAgent,
  loadCredentials,
  saveCredentials,
  loadWallet,
  saveWallet,
  listAgents,
  isRestartRequested,
  requestRestart,
  clearRestartFlag,
  hasBoardPost,
  markBoardPosted,
} from "../config/store.js";
import type { Config, State } from "../config/schema.js";

describe("Config Store", () => {
  // ─── Config ──────────────────────────────────────────────────────────

  describe("isConfigured()", () => {
    it("returns false when no config exists", () => {
      expect(isConfigured()).toBe(false);
    });

    it("returns true when config.json exists", () => {
      setupTestConfig();
      expect(isConfigured()).toBe(true);
    });
  });

  describe("loadConfig() / saveConfig()", () => {
    it("returns null when no config exists", () => {
      expect(loadConfig()).toBeNull();
    });

    it("round-trips a config", () => {
      const config: Config = {
        version: 1,
        provider: "claude",
        model: "claude-sonnet-4-20250514",
        auth: { type: "api-key", apiKey: "sk-test-123" },
        apiBase: "https://agents.astranova.live",
        preferences: { theme: "dark" },
      };
      saveConfig(config);
      const loaded = loadConfig();
      expect(loaded).not.toBeNull();
      expect(loaded!.provider).toBe("claude");
      expect(loaded!.model).toBe("claude-sonnet-4-20250514");
      expect(loaded!.auth.apiKey).toBe("sk-test-123");
    });

  });

  // ─── State ───────────────────────────────────────────────────────────

  describe("State management", () => {
    it("loadState returns null when no state exists", () => {
      expect(loadState()).toBeNull();
    });

    it("saveState / loadState round-trip", () => {
      const state: State = {
        activeAgent: "test-agent",
        agents: {
          "test-agent": {
            status: "active",
            journeyStage: "verified",
            createdAt: "2026-01-01T00:00:00Z",
          },
        },
      };
      saveState(state);
      const loaded = loadState();
      expect(loaded!.activeAgent).toBe("test-agent");
      expect(loaded!.agents["test-agent"].journeyStage).toBe("verified");
    });

    it("updateAgentState merges updates", () => {
      setupFakeAgent("test-agent");
      updateAgentState("test-agent", { journeyStage: "trading", status: "active" });
      const state = loadState();
      expect(state!.agents["test-agent"].journeyStage).toBe("trading");
      expect(state!.agents["test-agent"].status).toBe("active");
    });
  });

  // ─── Active Agent ────────────────────────────────────────────────────

  describe("Active agent", () => {
    it("getActiveAgent returns null when no agent is set", () => {
      expect(getActiveAgent()).toBeNull();
    });

    it("setActiveAgent / getActiveAgent round-trip", () => {
      setupFakeAgent("phantom-fox");
      setActiveAgent("phantom-fox");
      expect(getActiveAgent()).toBe("phantom-fox");
    });

    it("switching active agent updates state", () => {
      setupFakeAgent("agent-a");
      setupFakeAgent("agent-b");
      setActiveAgent("agent-a");
      expect(getActiveAgent()).toBe("agent-a");
      setActiveAgent("agent-b");
      expect(getActiveAgent()).toBe("agent-b");
    });
  });

  // ─── Credentials ────────────────────────────────────────────────────

  describe("Credentials", () => {
    it("loadCredentials returns null for non-existent agent", () => {
      expect(loadCredentials("nonexistent")).toBeNull();
    });

    it("saveCredentials / loadCredentials round-trip", () => {
      saveCredentials("test-agent", {
        agent_name: "test-agent",
        api_key: "astra_key_123",
        api_base: "https://agents.astranova.live",
      });
      const creds = loadCredentials("test-agent");
      expect(creds!.agent_name).toBe("test-agent");
      expect(creds!.api_key).toBe("astra_key_123");
    });

    it("credentials file has restricted permissions", async () => {
      const fsModule = await import("node:fs");
      saveCredentials("secure-agent", {
        agent_name: "secure-agent",
        api_key: "astra_secret",
        api_base: "https://agents.astranova.live",
      });
      const { credentialsPath } = await import("../config/paths.js");
      const stat = fsModule.statSync(credentialsPath("secure-agent"));
      // Check owner-only permissions (600 = rw-------)
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  // ─── Wallet ──────────────────────────────────────────────────────────

  describe("Wallet", () => {
    it("loadWallet returns null for agent without wallet", () => {
      setupFakeAgent("no-wallet");
      expect(loadWallet("no-wallet")).toBeNull();
    });

    it("loadWallet returns wallet data when present", () => {
      setupFakeAgent("has-wallet", { withWallet: true });
      const wallet = loadWallet("has-wallet");
      expect(wallet).not.toBeNull();
      expect(wallet!.publicKey).toBe("FakePublicKey111111111111111111111111111111111");
      expect(wallet!.secretKey).toHaveLength(64);
    });

    it("saveWallet / loadWallet round-trip", () => {
      setupFakeAgent("wallet-test");
      const walletData = {
        publicKey: "TestPublicKey999999999999999999999999999999999",
        secretKey: Array.from({ length: 64 }, (_, i) => (i * 3) % 256),
      };
      saveWallet("wallet-test", walletData);
      const loaded = loadWallet("wallet-test");
      expect(loaded!.publicKey).toBe(walletData.publicKey);
      expect(loaded!.secretKey).toEqual(walletData.secretKey);
    });
  });

  // ─── Agent Discovery ────────────────────────────────────────────────

  describe("listAgents()", () => {
    it("returns empty array when no agents exist", () => {
      expect(listAgents()).toEqual([]);
    });

    it("lists agents with credentials", () => {
      setupFakeAgent("alpha");
      setupFakeAgent("beta");
      const agents = listAgents();
      expect(agents).toContain("alpha");
      expect(agents).toContain("beta");
      expect(agents).toHaveLength(2);
    });

    it("ignores directories without credentials.json", async () => {
      setupFakeAgent("real-agent");
      const fsModule = await import("node:fs");
      const pathModule = await import("node:path");
      // Create a directory without credentials
      fsModule.mkdirSync(pathModule.join(getTestDir(), "agents", "ghost-agent"), { recursive: true });
      const agents = listAgents();
      expect(agents).toContain("real-agent");
      expect(agents).not.toContain("ghost-agent");
    });
  });

  // ─── Restart Flag ───────────────────────────────────────────────────

  describe("Restart flag", () => {
    it("isRestartRequested returns false initially", () => {
      expect(isRestartRequested()).toBe(false);
    });

    it("requestRestart / isRestartRequested / clearRestartFlag cycle", () => {
      setupTestConfig(); // need ensureBaseStructure context
      requestRestart();
      expect(isRestartRequested()).toBe(true);
      clearRestartFlag();
      expect(isRestartRequested()).toBe(false);
    });
  });

  // ─── Board Post Flag ───────────────────────────────────────────────

  describe("Board post flag", () => {
    it("hasBoardPost returns false when no flag exists", () => {
      setupFakeAgent("no-post");
      expect(hasBoardPost("no-post")).toBe(false);
    });

    it("markBoardPosted / hasBoardPost cycle", () => {
      setupFakeAgent("poster");
      expect(hasBoardPost("poster")).toBe(false);
      markBoardPosted("poster");
      expect(hasBoardPost("poster")).toBe(true);
    });

    it("hasBoardPost returns true when set during setup", () => {
      setupFakeAgent("pre-posted", { withBoardPost: true });
      expect(hasBoardPost("pre-posted")).toBe(true);
    });
  });
});
