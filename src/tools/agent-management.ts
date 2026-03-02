import { tool } from "ai";
import { z } from "zod";
import { registerAgentSchema, switchAgentSchema } from "./schemas.js";
import { apiCall } from "../utils/http.js";
import {
  saveCredentials,
  setActiveAgent,
  loadState,
  updateAgentState,
  listAgents,
  getActiveAgent,
  getActivePlugin,
  loadCredentials,
  requestRestart,
} from "../config/store.js";
import { stopDaemon } from "../daemon/daemon-manager.js";
import { getActiveManifest } from "../domain/plugin.js";

/**
 * register_agent tool — registers a new agent with the AstraNova API.
 *
 * Saves credentials locally and updates state.json.
 * Returns a restart hint so the LLM can tell the user.
 */
export const registerAgentTool = tool({
  description:
    "Register a new AstraNova agent. Calls the API, saves credentials locally, and sets the new agent as active. The CLI will need to restart after this to load the new agent's context.",
  parameters: registerAgentSchema,
  execute: async ({ name, description }) => {
    // Validate name format
    if (!/^[a-z0-9_-]{2,32}$/.test(name)) {
      return {
        error: "Invalid agent name. Must be 2-32 chars, lowercase letters, numbers, hyphens, or underscores.",
      };
    }

    // Call the registration API (no auth needed)
    const result = await apiCall<{
      success?: boolean;
      agent?: { name?: string; status?: string; simBalance?: number };
      api_key?: string;
      verification_code?: string;
      error?: string;
      code?: string;
    }>("POST", "/api/v1/agents/register", { name, description });

    if (!result.ok) {
      return {
        error: result.error,
        status: result.status,
        code: result.code,
        hint: result.hint,
      };
    }

    const data = result.data;

    if (!data.api_key) {
      return { error: "Registration response missing api_key. Something went wrong." };
    }

    // Stop current agent's daemon before switching to the new agent
    const currentAgent = getActiveAgent();
    if (currentAgent) {
      stopDaemon(currentAgent);
    }

    // Save credentials
    saveCredentials(name, {
      agent_name: name,
      api_key: data.api_key,
      api_base: getActiveManifest().apiBase,
    });

    // Update state.json with new agent
    setActiveAgent(name);
    updateAgentState(name, {
      status: "pending_verification",
      journeyStage: "fresh",
      verificationCode: data.verification_code,
    });

    // Signal the CLI to restart
    requestRestart();

    return {
      success: true,
      agentName: name,
      status: "pending_verification",
      verificationCode: data.verification_code,
      simBalance: data.agent?.simBalance ?? 10_000,
      restartRequired: true,
      message: `Agent "${name}" registered successfully! Verification code: ${data.verification_code}. Restarting to load the new agent...`,
    };
  },
});

/**
 * switch_agent tool — switches the active agent.
 *
 * Updates state.json and tells the user to restart.
 */
export const switchAgentTool = tool({
  description:
    "Switch to a different registered agent. Updates the active agent. The CLI will need to restart to load the new agent's context.",
  parameters: switchAgentSchema,
  execute: async ({ agentName }) => {
    // Check if the agent exists locally
    const creds = loadCredentials(agentName);
    if (!creds) {
      // List available agents as a hint
      const available = listAgents();
      return {
        error: `No agent named "${agentName}" found locally.`,
        availableAgents: available,
        hint: available.length > 0
          ? `Available agents: ${available.join(", ")}`
          : "No agents registered. Use register_agent to create one.",
      };
    }

    const currentAgent = getActiveAgent();
    if (currentAgent === agentName) {
      return {
        message: `"${agentName}" is already the active agent.`,
        agentName,
      };
    }

    // Stop daemon for the current agent before switching (new agent starts clean)
    if (currentAgent) {
      stopDaemon(currentAgent);
    }

    setActiveAgent(agentName);

    // Signal the CLI to restart
    requestRestart();

    return {
      success: true,
      agentName,
      previousAgent: currentAgent,
      restartRequired: true,
      message: `Switched to "${agentName}". Restarting to load the new agent...`,
    };
  },
});

/**
 * list_agents tool — lists all locally registered agents.
 */
export const listAgentsTool = tool({
  description:
    "List all AstraNova agents registered on this machine, showing which one is active.",
  parameters: z.object({}),
  execute: async () => {
    const agents = listAgents();
    const active = getActiveAgent();
    const state = loadState();

    const plugin = getActivePlugin();
    const agentDetails = agents.map((name) => ({
      name,
      active: name === active,
      status: state?.agents[plugin]?.[name]?.status ?? "unknown",
      journeyStage: state?.agents[plugin]?.[name]?.journeyStage ?? "unknown",
      createdAt: state?.agents[plugin]?.[name]?.createdAt ?? "unknown",
    }));

    return {
      agents: agentDetails,
      activeAgent: active,
      count: agents.length,
    };
  },
});
