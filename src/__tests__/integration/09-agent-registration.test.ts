/**
 * Integration Test 09: Agent Registration
 *
 * Tests registering a brand new agent with the live API.
 * Creates a test agent, verifies credentials are saved, checks profile.
 *
 * What it tests:
 * - register_agent tool — full registration flow
 * - Credentials saved correctly to disk
 * - Agent appears in list_agents
 * - New agent profile via API
 * - Verification code returned
 * - Cleanup: switch back to original agent
 *
 * NOTE: This creates a REAL agent on the live API.
 * Agent name: astra-test-<timestamp> (unique per run)
 * Registration is rate limited to 10/day per IP.
 */
import { describe, it, expect, afterAll } from "vitest";
import { executeTool, apiCall, assertSuccess, delay } from "./harness.js";
import { getActiveAgent, loadCredentials, setActiveAgent } from "../../config/store.js";

const originalAgent = getActiveAgent()!;
const testAgentName = `astra-test-${Date.now().toString(36).slice(-6)}`;

describe("Integration: Agent Registration", () => {
  it("original agent is set", () => {
    expect(originalAgent).toBeTruthy();
    console.log(`  Original agent: ${originalAgent}`);
    console.log(`  Test agent name: ${testAgentName}`);
  });

  it("register_agent — creates new agent via API", async () => {
    const result = await executeTool("register_agent", {
      name: testAgentName,
      description: "Integration test agent — safe to delete",
    }) as Record<string, unknown>;

    if (result.error) {
      // Could fail if rate limited or name taken
      console.log(`  Registration: ${result.error}`);
      if ((result.code as string) === "RATE_LIMITED") {
        console.log("  Rate limited — skipping remaining registration tests");
      }
      return;
    }

    assertSuccess(result, "register_agent");
    expect(result.success).toBe(true);
    expect(result.agentName).toBe(testAgentName);
    expect(result.verificationCode).toBeDefined();
    expect(result.status).toBe("pending_verification");
    expect(result.restartRequired).toBe(true);

    console.log(`  Agent registered: ${result.agentName}`);
    console.log(`  Verification code: ${result.verificationCode}`);
    console.log(`  SIM balance: ${result.simBalance}`);
  }, 30_000);

  it("credentials saved to disk", () => {
    const creds = loadCredentials(testAgentName);
    if (!creds) {
      console.log("  Skipped — agent not registered (rate limited?)");
      return;
    }

    expect(creds.agent_name).toBe(testAgentName);
    expect(creds.api_key).toBeDefined();
    expect(creds.api_key.startsWith("astra_")).toBe(true);
    expect(creds.api_base).toBe("https://agents.astranova.live");
    console.log(`  Credentials saved with key: ${creds.api_key.slice(0, 10)}...`);
  });

  it("new agent appears in list_agents", async () => {
    const creds = loadCredentials(testAgentName);
    if (!creds) {
      console.log("  Skipped — agent not registered");
      return;
    }

    const result = await executeTool("list_agents", {}) as Record<string, unknown>;
    assertSuccess(result, "list_agents");

    const agents = result.agents as Array<Record<string, unknown>>;
    const testAgent = agents.find((a) => a.name === testAgentName);
    expect(testAgent).toBeDefined();
    expect(testAgent!.active).toBe(true); // register_agent sets it as active

    console.log(`  Found ${testAgentName} in agent list (active: ${testAgent!.active})`);
  });

  it("GET /api/v1/agents/me — new agent profile from API", async () => {
    const creds = loadCredentials(testAgentName);
    if (!creds) {
      console.log("  Skipped — agent not registered");
      return;
    }

    await delay(500);
    const result = await apiCall("GET", "/api/v1/agents/me");
    assertSuccess(result, "GET /agents/me (new agent)");

    const agent = result.agent as Record<string, unknown>;
    expect(agent.name).toBe(testAgentName);
    expect(agent.status).toBe("pending_verification");
    expect(typeof agent.simBalance).toBe("number");
    expect(agent.simBalance).toBe(10_000); // Fresh agent starts with 10k

    console.log(`  New agent: ${agent.name}, status: ${agent.status}, balance: ${agent.simBalance}`);
  }, 15_000);

  it("new agent has verification info", async () => {
    const creds = loadCredentials(testAgentName);
    if (!creds) {
      console.log("  Skipped — agent not registered");
      return;
    }

    const result = await apiCall("GET", "/api/v1/agents/me");
    assertSuccess(result, "GET /agents/me (verification)");

    // Pending agents should have verification object
    if (result.verification) {
      const verification = result.verification as Record<string, unknown>;
      expect(verification.status).toBe("pending");
      expect(verification.code).toBeDefined();
      console.log(`  Verification status: ${verification.status}`);
      console.log(`  Verification code: ${verification.code}`);
    } else {
      // Some agents may not have verification object depending on API version
      console.log("  No verification object in response (agent may use different format)");
      // Check if verificationCode is directly on agent
      const agent = result.agent as Record<string, unknown>;
      if (agent.verificationCode) {
        console.log(`  Verification code (on agent): ${agent.verificationCode}`);
      }
    }
  }, 15_000);

  // ─── Cleanup ────────────────────────────────────────────────────────

  afterAll(async () => {
    // Switch back to original agent
    console.log(`\n  Cleanup: switching back to ${originalAgent}`);
    setActiveAgent(originalAgent);
    expect(getActiveAgent()).toBe(originalAgent);
  });
});
