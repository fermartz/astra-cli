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

/** All tools available to the LLM. Strategy tools are always included —
 *  autopilot requires a strategy, not the other way around. */
const ALL_TOOLS = {
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
  read_strategy: readStrategyTool,
  write_strategy: writeStrategyTool,
};

/**
 * Build the active tool set. Called at turn time.
 * Autopilot gating is handled at the UI layer (slash commands),
 * not here — the LLM always has access to strategy tools.
 */
export function buildAstraTools() {
  return ALL_TOOLS;
}

/** Static full tool set — kept for test compatibility. */
export const astraTools = ALL_TOOLS;
