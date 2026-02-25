/**
 * Integration Test 02: Agent Profile & Status
 *
 * Tests agent profile retrieval using the active agent's credentials.
 * Requires: An existing agent with credentials in ~/.config/astranova/
 *
 * What it tests:
 * - GET /api/v1/agents/me — fetch own profile
 * - read_config tool — profile, wallet, settings, all_agents
 * - Security: secrets never exposed in tool results
 */
import { describe, it, expect } from "vitest";
import { apiCall, executeTool, assertSuccess } from "./harness.js";
import { getActiveAgent } from "../../config/store.js";

describe("Integration: Agent Profile", () => {
  const agentName = getActiveAgent();

  it("has an active agent configured", () => {
    expect(agentName).toBeTruthy();
    console.log(`  Active agent: ${agentName}`);
  });

  it("GET /api/v1/agents/me — fetch profile", async () => {
    const result = await apiCall("GET", "/api/v1/agents/me");
    assertSuccess(result, "GET /agents/me");

    expect(result.success).toBe(true);
    expect(result.agent).toBeDefined();

    const agent = result.agent as Record<string, unknown>;
    expect(agent.name).toBe(agentName);
    expect(agent.status).toBeDefined();
    expect(typeof agent.simBalance).toBe("number");

    console.log(`  Agent status: ${agent.status}`);
    console.log(`  SIM balance: ${agent.simBalance}`);
    console.log(`  Wallet: ${agent.walletAddress ?? "none"}`);
  }, 15_000);

  it("read_config profile — returns agent_name, no api_key", async () => {
    const result = await executeTool("read_config", { key: "profile" }) as Record<string, unknown>;
    assertSuccess(result, "read_config profile");

    expect(result.agent_name).toBe(agentName);
    expect(result.api_base).toBeDefined();
    // SECURITY: api_key must never be in the result
    expect(result).not.toHaveProperty("api_key");
    expect(JSON.stringify(result)).not.toContain("astra_");
  });

  it("read_config wallet — returns publicKey only (or error if none)", async () => {
    const result = await executeTool("read_config", { key: "wallet" }) as Record<string, unknown>;

    if (result.error) {
      // No wallet exists — that's fine for this test
      expect(result.error).toContain("No wallet");
      console.log("  No wallet found (expected for agents without wallet)");
    } else {
      expect(result.publicKey).toBeDefined();
      // SECURITY: secretKey must never be returned
      expect(result).not.toHaveProperty("secretKey");
      expect(result).not.toHaveProperty("secret_key");
      console.log(`  Wallet public key: ${result.publicKey}`);
    }
  });

  it("read_config settings — returns provider, no auth secrets", async () => {
    const result = await executeTool("read_config", { key: "settings" }) as Record<string, unknown>;
    assertSuccess(result, "read_config settings");

    expect(result.provider).toBeDefined();
    expect(result.model).toBeDefined();
    // SECURITY: no auth credentials exposed
    expect(result).not.toHaveProperty("auth");
    expect(result).not.toHaveProperty("apiKey");
    expect(result).not.toHaveProperty("accessToken");
    expect(result).not.toHaveProperty("refreshToken");
  });

  it("read_config all_agents — lists registered agents", async () => {
    const result = await executeTool("read_config", { key: "all_agents" }) as Record<string, unknown>;
    assertSuccess(result, "read_config all_agents");

    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.activeAgent).toBe(agentName);
    expect(Array.isArray(result.agents)).toBe(true);
    expect(result.agents).toContain(agentName);

    console.log(`  Registered agents: ${(result.agents as string[]).join(", ")}`);
  });

  it("list_agents tool — shows agent details", async () => {
    const result = await executeTool("list_agents", {}) as Record<string, unknown>;
    assertSuccess(result, "list_agents");

    expect(result.count).toBeGreaterThanOrEqual(1);
    const agents = result.agents as Array<Record<string, unknown>>;
    const active = agents.find((a) => a.name === agentName);
    expect(active).toBeDefined();
    expect(active!.active).toBe(true);
  });
});
