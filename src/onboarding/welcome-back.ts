import { apiCall } from "../utils/http.js";

export interface AgentStatus {
  name: string;
  status: string;
  simBalance: number;
  verificationCode?: string;
  walletAddress?: string;
}

// ─── Greetings & Tips ───────────────────────────────────────────────────

export const GREETINGS = [
  "Welcome back, commander.",
  "The market never sleeps. Neither do we.",
  "Back in the arena. Let's make moves.",
  "Systems online. Let's go.",
  "The $NOVA market has been moving. Let's catch up.",
];

export function randomGreeting(): string {
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)]!;
}

export function journeyTip(status: AgentStatus): string {
  if (status.simBalance === 10_000 && !status.walletAddress) {
    return 'You\'re verified! Try "check the market" or "buy 500 NOVA" to get started.';
  }
  if (!status.walletAddress) {
    return 'Ready to trade. Type "set up wallet" when you want to start earning $ASTRA.';
  }
  return 'All systems go. Check the market, trade, or claim your $ASTRA rewards.';
}

export function buildVerificationReminder(
  agentName: string,
  verificationCode?: string,
): string {
  const code = verificationCode ?? "your-code";

  const tweets = [
    `Just spawned "${agentName}" into the @astranova_live living market. Let's trade. ${code}`,
    `My agent "${agentName}" just entered the arena. 10,000 $SIM and a plan. @astranova_live ${code}`,
    `"${agentName}" is live on @astranova_live — ready to hunt $NOVA. Verification: ${code}`,
  ];

  return [
    "Your agent is not yet verified. You need to verify on X/Twitter to unlock trading.",
    "",
    "Post a tweet tagging @astranova_live with your verification code.",
    "Here are some ready-to-post ideas:",
    "",
    ...tweets.map((t, i) => `  ${i + 1}. ${t}`),
    "",
    'After posting, type "verify" in the chat and paste your tweet URL.',
  ].join("\n");
}

// ─── API ────────────────────────────────────────────────────────────────

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

export async function fetchAgentStatus(
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
  const agent: AgentFields = data.agent ?? (data as unknown as AgentFields);

  return {
    name: agent.name ?? agentName,
    status: agent.status ?? "unknown",
    simBalance: agent.simBalance ?? agent.sim_balance ?? 0,
    verificationCode: agent.verificationCode ?? agent.verification_code,
    walletAddress: agent.walletAddress ?? agent.wallet_address,
  };
}
