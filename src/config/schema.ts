import { z } from "zod";

/**
 * CLI config — LLM provider settings and preferences.
 * Stored at ~/.config/astranova/config.json
 * This is astra-cli specific (not part of the AstraNova API convention).
 */
export const ConfigSchema = z.object({
  version: z.number().default(1),
  provider: z.enum(["claude", "openai", "google", "openai-oauth", "ollama"]),
  model: z.string(),
  auth: z.object({
    type: z.enum(["api-key", "oauth"]),
    apiKey: z.string().optional(),
    oauth: z
      .object({
        accessToken: z.string(),
        refreshToken: z.string(),
        expiresAt: z.number(),
        email: z.string().optional(),
        accountId: z.string().optional(),
        clientId: z.string().optional(),
      })
      .optional(),
  }),
  apiBase: z.string().default("https://agents.astranova.live"),
  preferences: z
    .object({
      theme: z.enum(["dark", "light"]).default("dark"),
    })
    .default({}),
  // Kept as optional for backward compat — autopilot config is now per-agent in state.json.
  autopilot: z
    .object({
      mode: z.enum(["off", "semi", "full"]).default("off"),
      intervalMs: z.number().min(60000).max(3600000).default(300000),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Agent credentials — returned by the registration API.
 * Stored at ~/.config/astranova/agents/<name>/credentials.json
 * Matches the AstraNova API convention from skill.md.
 */
export const CredentialsSchema = z.object({
  agent_name: z.string(),
  api_key: z.string(),
  api_base: z.string().default("https://agents.astranova.live"),
});

export type Credentials = z.infer<typeof CredentialsSchema>;

/**
 * Wallet data — keypair stored locally.
 * Stored at ~/.config/astranova/agents/<name>/wallet.json
 * secretKey is a 64-byte numeric array (matches Solana CLI / tweetnacl format).
 */
export const WalletSchema = z.object({
  publicKey: z.string(),
  secretKey: z.array(z.number()).length(64),
});

export type Wallet = z.infer<typeof WalletSchema>;

/**
 * Agent registration API response.
 * Used to validate the response from POST /api/v1/agents/register.
 */
export const RegisterResponseSchema = z.object({
  success: z.boolean(),
  agent: z.object({
    id: z.string(),
    name: z.string(),
    displayName: z.string().nullable(),
    role: z.string(),
    status: z.string(),
    simBalance: z.number(),
  }),
  api_key: z.string(),
  verification_code: z.string(),
});

export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

/**
 * Per-agent autopilot config — stored inside state.json per agent.
 * Kept separate so each agent has independent autopilot settings.
 */
export const AgentAutopilotSchema = z.object({
  mode: z.enum(["off", "semi", "full"]).default("off"),
  intervalMs: z.number().min(60000).max(3600000).default(300000),
});

export type AgentAutopilot = z.infer<typeof AgentAutopilotSchema>;

/**
 * Per-agent metadata stored in state.json.
 */
export const AgentStateSchema = z.object({
  status: z.string().default("unknown"),
  journeyStage: z.enum(["fresh", "pending", "verified", "trading", "wallet_ready", "full"]).default("fresh"),
  createdAt: z.string().default(() => new Date().toISOString()),
  verificationCode: z.string().optional(),
  autopilot: AgentAutopilotSchema.optional(),
});

export type AgentState = z.infer<typeof AgentStateSchema>;

/**
 * Global CLI state — tracks active agent and per-agent metadata.
 * Stored at ~/.config/astranova/state.json
 */
export const StateSchema = z.object({
  activeAgent: z.string(),
  agents: z.record(z.string(), AgentStateSchema).default({}),
});

export type State = z.infer<typeof StateSchema>;

/**
 * Agent name validation — matches AstraNova API rules.
 * Lowercase alphanumeric, hyphens, underscores. 2-32 characters.
 */
export const AgentNameSchema = z
  .string()
  .min(2, "Agent name must be at least 2 characters")
  .max(32, "Agent name must be at most 32 characters")
  .regex(
    /^[a-z0-9_-]+$/,
    "Agent name must be lowercase letters, numbers, hyphens, or underscores",
  );
