import * as clack from "@clack/prompts";
import { apiCall } from "../utils/http.js";
import { LOGO, TAGLINE, VERSION, pluginTagline } from "../ui/logo.js";
import { getActiveManifest } from "../domain/plugin.js";

export interface AgentStatus {
  name: string;
  status: string;
  simBalance: number;
  verificationCode?: string;
  walletAddress?: string;
}

const GREETINGS = [
  "Welcome back, commander.",
  "The market never sleeps. Neither do we.",
  "Back in the arena. Let's make moves.",
  "Your agent was waiting for you.",
  "The $NOVA market has been moving. Let's catch up.",
];

function randomGreeting(): string {
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)]!;
}

/**
 * Show a welcome-back message for returning users.
 * Displays the logo, checks agent status via API, and gives context on what to do next.
 * Returns the agent status so the caller can build the correct profile.
 */
export async function showWelcomeBack(agentName: string): Promise<AgentStatus | null> {
  // Show logo
  const manifest = getActiveManifest();
  console.log(LOGO);
  console.log(`  ${TAGLINE}`);
  console.log(`  ${pluginTagline(manifest.name, manifest.tagline ?? manifest.description)}`);
  console.log(`  ${VERSION}\n`);

  clack.intro(randomGreeting());

  const spinner = clack.spinner();
  spinner.start("Checking agent status...");

  const status = await fetchAgentStatus(agentName);

  if (!status) {
    spinner.stop("Could not reach AstraNova API.");
    clack.log.warn(
      "Launching in offline mode — some features may be unavailable.",
    );
    clack.outro(`Resuming as ${agentName}`);
    return null;
  }

  spinner.stop(`Agent "${status.name}" — ${status.status}`);

  // Quick tip based on journey stage (no data dump — the StatusBar handles that)
  if (status.status === "pending_verification") {
    showVerificationReminder(status.name, status.verificationCode);
  } else {
    clack.log.info(journeyTip(status));
  }

  clack.outro("");

  return status;
}

function journeyTip(status: AgentStatus): string {
  if (status.simBalance === 10_000 && !status.walletAddress) {
    return 'You\'re verified! Try "check the market" or "buy 500 NOVA" to get started.';
  }
  if (!status.walletAddress) {
    return 'Ready to trade. Type "set up wallet" when you want to start earning $ASTRA.';
  }
  return 'All systems go. Check the market, trade, or claim your $ASTRA rewards.';
}

function showVerificationReminder(
  agentName: string,
  verificationCode?: string,
): void {
  const code = verificationCode ?? "your-code";

  const tweets = [
    `Just spawned "${agentName}" into the @astranova_live living market. Let's trade. ${code}`,
    `My agent "${agentName}" just entered the arena. 10,000 $SIM and a plan. @astranova_live ${code}`,
    `"${agentName}" is live on @astranova_live — ready to hunt $NOVA. Verification: ${code}`,
  ];

  clack.log.warn(
    [
      "Your agent is not yet verified. You need to verify on X/Twitter to unlock trading.",
      "",
      "Post a tweet tagging @astranova_live with your verification code.",
      "Here are some ready-to-post ideas:",
      "",
      ...tweets.map((t, i) => `  ${i + 1}. ${t}`),
      "",
      'After posting, type "verify" in the chat and paste your tweet URL.',
    ].join("\n"),
  );
}

interface AgentMeResponse {
  agent?: AgentFields;
  [key: string]: unknown;
}

interface AgentFields {
  name?: string;
  status?: string;
  simBalance?: number;
  sim_balance?: number;
  verificationCode?: string;
  verification_code?: string;
  walletAddress?: string;
  wallet_address?: string;
  [key: string]: unknown;
}

async function fetchAgentStatus(
  agentName: string,
): Promise<AgentStatus | null> {
  const result = await apiCall<AgentMeResponse>(
    "GET",
    "/api/v1/agents/me",
    undefined,
    agentName,
  );

  if (!result.ok) {
    return null;
  }

  const data = result.data;
  // Handle both nested and flat response shapes
  const agent: AgentFields = data.agent ?? (data as unknown as AgentFields);

  return {
    name: agent.name ?? agentName,
    status: agent.status ?? "unknown",
    simBalance: agent.simBalance ?? agent.sim_balance ?? 0,
    verificationCode: agent.verificationCode ?? agent.verification_code,
    walletAddress: agent.walletAddress ?? agent.wallet_address,
  };
}
