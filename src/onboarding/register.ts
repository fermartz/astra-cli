import * as clack from "@clack/prompts";
import { AgentNameSchema, RegisterResponseSchema } from "../config/schema.js";
import { saveCredentials, setActiveAgent } from "../config/store.js";
import { apiCall } from "../utils/http.js";

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

  const spinner = clack.spinner();
  spinner.start("Registering agent...");

  const result = await apiCall("POST", "/api/v1/agents/register", {
    name: agentName,
    description: `Astra CLI agent`,
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
    api_base: "https://agents.astranova.live",
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
 * Random name suggestions to inspire the user.
 * Shuffled each time so it feels fresh.
 */
const NAME_SUGGESTIONS = [
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

function pickRandomNames(count: number): string[] {
  const shuffled = [...NAME_SUGGESTIONS].sort(() => Math.random() - 0.5);
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
