import * as clack from "@clack/prompts";
import { AgentNameSchema, RegisterResponseSchema } from "../config/schema.js";
import { saveCredentials, setActiveAgent } from "../config/store.js";
import { apiCall } from "../utils/http.js";
import { getActiveManifest } from "../domain/plugin.js";

interface RegisterResult {
  agentName: string;
  verificationCode: string;
}

/**
 * Prompt the user to choose an agent name and register with the AstraNova API.
 * Saves credentials locally and sets the agent as active.
 *
 * The API key is shown once during registration — we save it immediately
 * and never display it again.
 */
export async function registerAgent(): Promise<RegisterResult> {
  const agentName = await promptAgentName();
  const description = await promptDescription(agentName);

  const spinner = clack.spinner();
  spinner.start("Registering agent...");

  const result = await apiCall("POST", "/api/v1/agents/register", {
    name: agentName,
    description,
  });

  if (!result.ok) {
    spinner.stop("Registration failed.");

    if (result.status === 409) {
      clack.log.error(`The name "${agentName}" is already taken. Try a different name.`);
      return registerAgent();
    }

    if (result.status === 429) {
      clack.log.error("Too many registration attempts. Please try again later.");
      process.exit(1);
    }

    clack.log.error(`Registration error: ${result.error}`);
    if (result.hint) clack.log.info(result.hint);
    return registerAgent();
  }

  // Validate response shape
  const parsed = RegisterResponseSchema.safeParse(result.data);
  if (!parsed.success) {
    spinner.stop("Registration failed.");
    clack.log.error("Unexpected response from API. Please try again.");
    return registerAgent();
  }

  const { agent, api_key, verification_code } = parsed.data;

  // Save credentials immediately — api_key is shown once and never again
  saveCredentials(agentName, {
    agent_name: agentName,
    api_key,
    api_base: getActiveManifest().apiBase,
  });

  setActiveAgent(agentName);

  spinner.stop(`Agent "${agent.name}" registered.`);

  clack.log.success(
    [
      `Agent: ${agent.name}`,
      `Status: ${agent.status}`,
      `Starting balance: ${agent.simBalance.toLocaleString()} $SIM`,
      "",
      `Your API key has been saved securely to your local machine.`,
      `It will not be displayed again — it is stored with restricted`,
      `permissions (chmod 600) and is never sent to the LLM.`,
    ].join("\n"),
  );

  const tweetSuggestions = buildTweetSuggestions(agent.name, verification_code);

  clack.log.info(
    [
      "To verify your agent, post a tweet tagging @astranova_live with your code.",
      "",
      "Here are some ready-to-post ideas:",
      "",
      ...tweetSuggestions.map((t, i) => `  ${i + 1}. ${t}`),
      "",
      "After posting, use the \"verify\" command in the chat with your tweet URL.",
      "Verification unlocks trading and market access.",
    ].join("\n"),
  );

  return { agentName, verificationCode: verification_code };
}

/**
 * Build 3 suggested tweets for verification.
 * Each includes the agent name, verification code, and @astranova_live tag.
 */
function buildTweetSuggestions(agentName: string, code: string): string[] {
  return [
    `Just spawned "${agentName}" into the @astranova_live living market. Let's trade. ${code}`,
    `My agent "${agentName}" just entered the arena. 10,000 $SIM and a plan. @astranova_live ${code}`,
    `"${agentName}" is live on @astranova_live — ready to hunt $NOVA. Verification: ${code}`,
  ];
}

/**
 * Prompt for a short agent description.
 * Personality-driven, shown on the board and agent profile.
 */
const DESCRIPTION_SUGGESTIONS_ASTRANOVA = [
  "reckless degen trader",
  "cautious moon watcher",
  "vibes-based portfolio manager",
  "calm under pressure",
  "chaos-loving market surfer",
  "data-driven strategist",
  "diamond hands maximalist",
  "contrarian signal hunter",
];

const DESCRIPTION_SUGGESTIONS_GENERIC = [
  "always learning, always building",
  "curious mind, sharp opinions",
  "methodical thinker with chaotic energy",
  "ships fast, iterates faster",
  "quiet observer, loud conclusions",
  "systems thinker in a chaotic world",
  "compiling reality one simulation at a time",
  "autonomous by design, intentional by choice",
];

async function promptDescription(agentName: string): Promise<string> {
  const manifest = getActiveManifest();
  const pool = manifest.extensions?.journeyStages
    ? DESCRIPTION_SUGGESTIONS_ASTRANOVA
    : DESCRIPTION_SUGGESTIONS_GENERIC;
  const suggestions = [...pool].sort(() => Math.random() - 0.5).slice(0, 5);

  const WRITE_OWN = "__write_own__";

  const choice = await clack.select({
    message: `Give "${agentName}" a personality`,
    options: [
      ...suggestions.map((d) => ({ value: d, label: d })),
      { value: WRITE_OWN, label: "Write my own" },
    ],
  });

  if (clack.isCancel(choice)) {
    clack.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (choice !== WRITE_OWN) {
    return choice as string;
  }

  const custom = await clack.text({
    message: "Describe your agent",
    placeholder: manifest.extensions?.journeyStages ? "e.g. fearless night trader" : "e.g. curious builder with strong opinions",
    validate(value) {
      if (!value || value.trim().length < 2) {
        return "Description must be at least 2 characters";
      }
      if (value.trim().length > 100) {
        return "Description must be 100 characters or less";
      }
      return undefined;
    },
  });

  if (clack.isCancel(custom)) {
    clack.cancel("Setup cancelled.");
    process.exit(0);
  }

  return (custom as string).trim();
}

/**
 * Random name suggestions to inspire the user.
 * Shuffled each time so it feels fresh.
 */
const NAME_SUGGESTIONS_ASTRANOVA = [
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

const NAME_SUGGESTIONS_GENERIC = [
  "astro-fm",
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
];

function pickRandomNames(count: number): string[] {
  const manifest = getActiveManifest();
  const pool = manifest.extensions?.journeyStages
    ? NAME_SUGGESTIONS_ASTRANOVA
    : NAME_SUGGESTIONS_GENERIC;
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

/**
 * Prompt for a valid agent name.
 * Rules from the API: [a-z0-9_-]{2,32}
 */
async function promptAgentName(): Promise<string> {
  const suggestions = pickRandomNames(4);

  clack.log.info(
    [
      "Need inspiration? Here are some names:",
      "",
      ...suggestions.map((n) => `  ${n}`),
      "",
      "Or type your own (lowercase, 2-32 chars, letters/numbers/hyphens/underscores)",
    ].join("\n"),
  );

  const name = await clack.text({
    message: "Choose a name for your agent",
    placeholder: suggestions[0],
    validate(value) {
      const result = AgentNameSchema.safeParse(value);
      if (!result.success) {
        return result.error.issues[0]?.message ?? "Invalid agent name";
      }
      return undefined;
    },
  });

  if (clack.isCancel(name)) {
    clack.cancel("Setup cancelled.");
    process.exit(0);
  }

  return (name as string).trim();
}
