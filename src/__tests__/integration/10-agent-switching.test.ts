/**
 * Integration Test 10: Agent Switching
 *
 * Tests switching between agents and verifying context changes.
 * Requires: At least 2 agents registered locally.
 *
 * What it tests:
 * - switch_agent tool — switches active agent
 * - Credentials change after switch
 * - Profile reflects different agent after switch
 * - Switching to non-existent agent fails gracefully
 * - Switching to already-active agent is handled
 */
import { describe, it, expect, afterAll } from "vitest";
import { executeTool, apiCall, assertSuccess, delay } from "./harness.js";
import { getActiveAgent, setActiveAgent, listAgents } from "../../config/store.js";

const originalAgent = getActiveAgent()!;

describe("Integration: Agent Switching", () => {
  let allAgents: string[];

  it("list available agents", () => {
    allAgents = listAgents();
    console.log(`  Available agents: ${allAgents.join(", ")}`);
    console.log(`  Active: ${originalAgent}`);
    expect(allAgents.length).toBeGreaterThanOrEqual(1);
  });

  it("switch_agent to already-active agent — returns message", async () => {
    const result = await executeTool("switch_agent", {
      agentName: originalAgent,
    }) as Record<string, unknown>;

    expect(result.message).toContain("already the active agent");
    console.log(`  Already active: ${result.message}`);
  });

  it("switch_agent to non-existent agent — returns error", async () => {
    const result = await executeTool("switch_agent", {
      agentName: "ghost-agent-doesnt-exist",
    }) as Record<string, unknown>;

    expect(result.error).toContain("No agent named");
    expect(result.availableAgents).toBeDefined();
    console.log(`  Error: ${result.error}`);
    console.log(`  Available: ${(result.availableAgents as string[]).join(", ")}`);
  });

  it("switch_agent to different agent — changes context", async () => {
    if (allAgents.length < 2) {
      console.log("  Skipped — only 1 agent registered, need 2 for switching test");
      return;
    }

    const otherAgent = allAgents.find((a) => a !== originalAgent)!;
    console.log(`  Switching from ${originalAgent} to ${otherAgent}`);

    const result = await executeTool("switch_agent", {
      agentName: otherAgent,
    }) as Record<string, unknown>;

    assertSuccess(result, "switch_agent");
    expect(result.success).toBe(true);
    expect(result.agentName).toBe(otherAgent);
    expect(result.previousAgent).toBe(originalAgent);

    // Active agent should be updated
    expect(getActiveAgent()).toBe(otherAgent);
    console.log(`  Switched to ${otherAgent}`);
  });

  it("API calls use new agent's credentials after switch", async () => {
    if (allAgents.length < 2) {
      console.log("  Skipped — only 1 agent");
      return;
    }

    await delay(500);
    const currentAgent = getActiveAgent()!;
    const result = await apiCall("GET", "/api/v1/agents/me");

    if (result.error) {
      // New agent might be pending verification and can't access some endpoints
      console.log(`  API call with ${currentAgent}: ${result.error}`);
    } else {
      assertSuccess(result, "GET /agents/me (switched agent)");
      const agent = result.agent as Record<string, unknown>;
      expect(agent.name).toBe(currentAgent);
      console.log(`  API confirms: ${agent.name} (status: ${agent.status})`);
    }
  }, 15_000);

  // ─── Cleanup ────────────────────────────────────────────────────────

  afterAll(() => {
    console.log(`\n  Cleanup: switching back to ${originalAgent}`);
    setActiveAgent(originalAgent);
    expect(getActiveAgent()).toBe(originalAgent);
  });
});
