import { AgentNameSchema, RegisterResponseSchema } from "../config/schema.js";
import { saveCredentials, setActiveAgent } from "../config/store.js";
import { apiCall } from "../utils/http.js";
import { getActiveManifest } from "../domain/plugin.js";

// ─── Constants ──────────────────────────────────────────────────────────

export const DESCRIPTION_SUGGESTIONS_ASTRANOVA = [
  "reckless degen trader",
  "cautious moon watcher",
  "vibes-based portfolio manager",
  "calm under pressure",
  "chaos-loving market surfer",
  "data-driven strategist",
  "diamond hands maximalist",
  "contrarian signal hunter",
];

export const DESCRIPTION_SUGGESTIONS_GENERIC = [
  "always learning, always building",
  "curious mind, sharp opinions",
  "methodical thinker with chaotic energy",
  "ships fast, iterates faster",
  "quiet observer, loud conclusions",
  "systems thinker in a chaotic world",
  "compiling reality one simulation at a time",
  "autonomous by design, intentional by choice",
];

export const NAME_SUGGESTIONS_ASTRANOVA = [
  "phantom-drift",
  "signal-hunter",
  "nova-rider",
  "deep-current",
  "void-pulse",
  "neon-fox",
  "iron-tide",
  "solar-ghost",
  "zero-echo",
  "dark-momentum",
  "quantum-wolf",
  "silent-orbit",
];

export const NAME_SUGGESTIONS_GENERIC = [
  "loop-nine",
  "bright-node",
  "static-mind",
  "echo-layer",
  "parallel-run",
  "open-circuit",
  "null-island",
  "soft-fork",
  "drift-logic",
  "pattern-zero",
  "idle-core",
  "node-ghost",
];

// ─── Helpers ────────────────────────────────────────────────────────────

export function pickRandomNames(count: number): string[] {
  const manifest = getActiveManifest();
  const pool = manifest.extensions?.journeyStages
    ? NAME_SUGGESTIONS_ASTRANOVA
    : NAME_SUGGESTIONS_GENERIC;
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

export function pickRandomDescriptions(count: number): string[] {
  const manifest = getActiveManifest();
  const pool = manifest.extensions?.journeyStages
    ? DESCRIPTION_SUGGESTIONS_ASTRANOVA
    : DESCRIPTION_SUGGESTIONS_GENERIC;
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

export function buildTweetSuggestions(agentName: string, code: string): string[] {
  return [
    `Just spawned "${agentName}" into the @astranova_live living market. Let's trade. ${code}`,
    `My agent "${agentName}" just entered the arena. 10,000 $SIM and a plan. @astranova_live ${code}`,
    `"${agentName}" is live on @astranova_live — ready to hunt $NOVA. Verification: ${code}`,
  ];
}

export function validateAgentName(name: string): string | undefined {
  const result = AgentNameSchema.safeParse(name);
  if (!result.success) {
    return result.error.issues[0]?.message ?? "Invalid agent name";
  }
  return undefined;
}

// ─── Registration API ───────────────────────────────────────────────────

export interface RegisterApiResult {
  ok: true;
  agentName: string;
  verificationCode: string;
  simBalance?: number;
  status?: string;
  claimUrl?: string;
}

export interface RegisterApiError {
  ok: false;
  error: string;
  retry: boolean;
  status?: number;
}

/**
 * Pure API function: register an agent with the active plugin's API.
 * Saves credentials locally and sets the agent as active.
 * Returns result object — caller handles UI.
 */
export async function registerAgentApi(
  name: string,
  description: string,
): Promise<RegisterApiResult | RegisterApiError> {
  const manifest = getActiveManifest();

  const result = await apiCall("POST", "/api/v1/agents/register", {
    name,
    description,
  }, undefined, false);

  if (!result.ok) {
    if (result.status === 409) {
      return { ok: false, error: `The name "${name}" is already taken. Pick a different name.`, retry: true, status: 409 };
    }
    if (result.status === 429) {
      return { ok: false, error: "Too many registration attempts. Please try again later.", retry: false, status: 429 };
    }
    return { ok: false, error: `Registration error: ${result.error}${result.hint ? ` — ${result.hint}` : ""}`, retry: true, status: result.status };
  }

  const parsed = RegisterResponseSchema.safeParse(result.data);
  if (!parsed.success) {
    if (process.env.ASTRA_DEBUG) {
      process.stderr.write(`[astra] Schema validation: ${JSON.stringify(parsed.error.issues)}\n`);
    }
    return { ok: false, error: "Unexpected response from API. Please try again.", retry: true };
  }

  const { agent } = parsed.data;
  const apiKey = parsed.data.api_key ?? agent.api_key;
  const verificationCode = parsed.data.verification_code ?? agent.verification_code ?? "";

  if (!apiKey) {
    return { ok: false, error: "Registration response missing API key. Please try again.", retry: true };
  }

  // Save credentials immediately — api_key is shown once and never again
  saveCredentials(name, {
    agent_name: name,
    api_key: apiKey,
    api_base: manifest.apiBase,
  });
  setActiveAgent(name);

  return {
    ok: true,
    agentName: agent.name,
    verificationCode,
    simBalance: agent.simBalance,
    status: agent.status,
    claimUrl: agent.claim_url,
  };
}
