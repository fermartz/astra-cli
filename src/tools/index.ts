import { apiCallTool } from "./api.js";
import { readConfigTool, writeConfigTool } from "./config.js";
import {
  createWalletTool,
  signChallengeTool,
  signAndSendTransactionTool,
} from "./wallet.js";
import {
  registerAgentTool,
  switchAgentTool,
  listAgentsTool,
} from "./agent-management.js";
import { updateMemoryTool } from "./memory.js";
import { readStrategyTool, writeStrategyTool } from "./strategy.js";
import { getActiveManifest } from "../domain/plugin.js";

/** Base tools available to every plugin. */
const BASE_TOOLS = {
  api_call: apiCallTool,
  read_config: readConfigTool,
  write_config: writeConfigTool,
  create_wallet: createWalletTool,
  sign_challenge: signChallengeTool,
  sign_and_send_transaction: signAndSendTransactionTool,
  register_agent: registerAgentTool,
  switch_agent: switchAgentTool,
  list_agents: listAgentsTool,
  update_memory: updateMemoryTool,
};

/** AstraNova-only tools (autopilot extension). */
const AUTOPILOT_TOOLS = {
  read_strategy: readStrategyTool,
  write_strategy: writeStrategyTool,
};

/**
 * Build the active tool set based on the current plugin manifest.
 * Called at turn time so the tool set matches the active plugin.
 *
 * - Base tools: always included (api_call, config, wallet, agent management, memory)
 * - Autopilot tools: only when manifest.extensions.autopilot is true
 */
export function buildAstraTools() {
  const manifest = getActiveManifest();
  if (manifest.extensions?.autopilot) {
    return { ...BASE_TOOLS, ...AUTOPILOT_TOOLS };
  }
  return BASE_TOOLS;
}

/**
 * Static full tool set — kept for test compatibility.
 * Production code uses buildAstraTools() for plugin-aware filtering.
 */
export const astraTools = { ...BASE_TOOLS, ...AUTOPILOT_TOOLS };
