/**
 * Tests for tools/agent-management.ts — register_agent, switch_agent, list_agents.
 *
 * Tests agent registration (mocked API), switching, listing, and error handling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "./setup.js";
import { setupFakeAgent, setupTestConfig } from "./setup.js";

// Mock http to avoid real API calls
vi.mock("../utils/http.js", () => ({
  apiCall: vi.fn(),
}));

import { registerAgentTool, switchAgentTool, listAgentsTool } from "../tools/agent-management.js";
import { apiCall } from "../utils/http.js";
import { getActiveAgent, loadCredentials, isRestartRequested, clearRestartFlag } from "../config/store.js";

const mockedApiCall = vi.mocked(apiCall);

// Helpers
async function execRegister(args: Record<string, unknown>): Promise<unknown> {
  const execute = (registerAgentTool as unknown as { execute: (args: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown> }).execute;
  return execute(args, {});
}

async function execSwitch(args: Record<string, unknown>): Promise<unknown> {
  const execute = (switchAgentTool as unknown as { execute: (args: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown> }).execute;
  return execute(args, {});
}

async function execListAgents(): Promise<unknown> {
  const execute = (listAgentsTool as unknown as { execute: (args: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown> }).execute;
  return execute({}, {});
}

describe("register_agent tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupTestConfig();
  });

  describe("Happy path", () => {
    it("registers a new agent successfully", async () => {
      mockedApiCall.mockResolvedValue({
        ok: true,
        data: {
          success: true,
          agent: { name: "new-agent", status: "pending_verification", simBalance: 10000 },
          api_key: "astra_new_key_abc",
          verification_code: "VERIFY-123",
        },
        status: 200,
      });

      const result = await execRegister({ name: "new-agent", description: "A brave new agent" }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("new-agent");
      expect(result.verificationCode).toBe("VERIFY-123");
      expect(result.restartRequired).toBe(true);
    });

    it("saves credentials locally after registration", async () => {
      mockedApiCall.mockResolvedValue({
        ok: true,
        data: {
          success: true,
          agent: { name: "cred-agent", status: "pending_verification", simBalance: 10000 },
          api_key: "astra_cred_key_xyz",
          verification_code: "VERIFY-456",
        },
        status: 200,
      });

      await execRegister({ name: "cred-agent", description: "Test credentials" });

      const creds = loadCredentials("cred-agent");
      expect(creds).not.toBeNull();
      expect(creds!.agent_name).toBe("cred-agent");
      expect(creds!.api_key).toBe("astra_cred_key_xyz");
    });

    it("sets new agent as active", async () => {
      mockedApiCall.mockResolvedValue({
        ok: true,
        data: {
          success: true,
          agent: { name: "active-agent" },
          api_key: "astra_key",
          verification_code: "V-789",
        },
        status: 200,
      });

      await execRegister({ name: "active-agent", description: "Will be active" });
      expect(getActiveAgent()).toBe("active-agent");
    });

    it("requests CLI restart after registration", async () => {
      mockedApiCall.mockResolvedValue({
        ok: true,
        data: {
          success: true,
          agent: { name: "restart-agent" },
          api_key: "astra_key",
          verification_code: "V-000",
        },
        status: 200,
      });

      await execRegister({ name: "restart-agent", description: "Needs restart" });
      expect(isRestartRequested()).toBe(true);
      clearRestartFlag(); // cleanup
    });
  });

  describe("Validation", () => {
    it("rejects invalid agent names (uppercase)", async () => {
      const result = await execRegister({ name: "BadName", description: "Fails" }) as Record<string, unknown>;
      expect(result.error).toContain("Invalid agent name");
      expect(mockedApiCall).not.toHaveBeenCalled();
    });

    it("rejects agent names with spaces", async () => {
      const result = await execRegister({ name: "bad name", description: "Fails" }) as Record<string, unknown>;
      expect(result.error).toContain("Invalid agent name");
    });

    it("rejects too-short names", async () => {
      const result = await execRegister({ name: "a", description: "Fails" }) as Record<string, unknown>;
      expect(result.error).toContain("Invalid agent name");
    });
  });

  describe("API errors", () => {
    it("returns error when API registration fails", async () => {
      mockedApiCall.mockResolvedValue({
        ok: false,
        status: 409,
        error: "Agent name already taken",
        code: "AGENT_EXISTS",
      });

      const result = await execRegister({ name: "taken-name", description: "Already exists" }) as Record<string, unknown>;
      expect(result.error).toBe("Agent name already taken");
      expect(result.code).toBe("AGENT_EXISTS");
    });
  });
});

describe("switch_agent tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupTestConfig();
  });

  describe("Happy path", () => {
    it("switches to an existing agent", async () => {
      setupFakeAgent("agent-a");
      setupFakeAgent("agent-b");
      // setupFakeAgent sets the last one as active, so switch back to agent-a first
      const { setActiveAgent } = await import("../config/store.js");
      setActiveAgent("agent-a");

      const result = await execSwitch({ agentName: "agent-b" }) as Record<string, unknown>;
      expect(result.success).toBe(true);
      expect(result.agentName).toBe("agent-b");
      expect(getActiveAgent()).toBe("agent-b");
    });

    it("requests CLI restart after switch", async () => {
      setupFakeAgent("switch-from");
      setupFakeAgent("switch-to");
      const { setActiveAgent } = await import("../config/store.js");
      setActiveAgent("switch-from");

      await execSwitch({ agentName: "switch-to" });
      expect(isRestartRequested()).toBe(true);
      clearRestartFlag();
    });
  });

  describe("Error cases", () => {
    it("returns error for non-existent agent", async () => {
      setupFakeAgent("only-agent");
      const result = await execSwitch({ agentName: "ghost-agent" }) as Record<string, unknown>;
      expect(result.error).toContain("No agent named");
      expect(result.availableAgents).toBeDefined();
    });

    it("handles switching to already-active agent", async () => {
      setupFakeAgent("current");
      const result = await execSwitch({ agentName: "current" }) as Record<string, unknown>;
      expect(result.message).toContain("already the active agent");
    });
  });
});

describe("list_agents tool", () => {
  it("lists all registered agents", async () => {
    setupFakeAgent("alpha");
    setupFakeAgent("beta");
    setupFakeAgent("gamma");

    const result = await execListAgents() as Record<string, unknown>;
    expect(result.count).toBe(3);

    const agents = result.agents as Array<Record<string, unknown>>;
    const names = agents.map((a) => a.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names).toContain("gamma");
  });

  it("marks the active agent correctly", async () => {
    setupFakeAgent("main-agent");
    setupFakeAgent("side-agent");

    const result = await execListAgents() as Record<string, unknown>;
    const agents = result.agents as Array<Record<string, unknown>>;

    // The last agent set up via setupFakeAgent becomes active
    const mainAgent = agents.find((a) => a.name === "main-agent");
    const sideAgent = agents.find((a) => a.name === "side-agent");
    // side-agent was set up last, so it's active
    expect(sideAgent!.active).toBe(true);
  });

  it("returns empty list when no agents exist", async () => {
    const result = await execListAgents() as Record<string, unknown>;
    expect(result.count).toBe(0);
    expect(result.agents).toEqual([]);
  });
});
