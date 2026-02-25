import { z } from "zod";

// ---------------------------------------------------------------------------
// Phase 1 tool schemas
// ---------------------------------------------------------------------------

export const apiCallSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH"]),
  path: z.string().describe("API path, e.g. /api/v1/agents/me"),
  body: z
    .record(z.unknown())
    .optional()
    .describe("JSON body for POST/PUT/PATCH requests"),
}).passthrough(); // Allow extra keys — LLMs sometimes flatten body params

export const readConfigSchema = z.object({
  key: z.enum(["profile", "wallet", "all_agents", "settings"]),
  agentName: z
    .string()
    .optional()
    .describe("Agent name. Uses the active agent if not specified."),
});

export const writeConfigSchema = z.object({
  agentName: z.string().describe("Agent name to write config for"),
  data: z.record(z.unknown()).describe("Data to write"),
  file: z
    .enum(["credentials", "settings", "profile"])
    .describe("Which config file to write"),
});

// ---------------------------------------------------------------------------
// Phase 2 tool schemas (defined now, implemented later)
// ---------------------------------------------------------------------------

export const createWalletSchema = z.object({
  agentName: z
    .string()
    .describe("Agent name to associate the wallet with"),
});

export const signChallengeSchema = z.object({
  challenge: z
    .string()
    .describe("The challenge string received from the wallet registration API"),
});

export const signAndSendTransactionSchema = z.object({
  transaction: z
    .string()
    .describe("Base64-encoded partially-signed transaction from the API"),
});

// ---------------------------------------------------------------------------
// Agent management schemas
// ---------------------------------------------------------------------------

export const registerAgentSchema = z.object({
  name: z
    .string()
    .describe("Agent name (2-32 chars, lowercase, letters/numbers/hyphens/underscores)"),
  description: z
    .string()
    .describe("Short agent description — personality-driven, a few words"),
});

export const switchAgentSchema = z.object({
  agentName: z
    .string()
    .describe("Name of the agent to switch to"),
});
