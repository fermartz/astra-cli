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

/**
 * All available tools for the agent loop.
 * Passed to Vercel AI SDK's streamText({ tools }).
 */
export const astraTools = {
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
