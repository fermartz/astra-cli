import process from "node:process";
import React from "react";
import { render } from "ink";
import { execFileSync } from "node:child_process";
import {
  isConfigured,
  loadConfig,
  loadCredentials,
  getActiveAgent,
  loadWallet,
  hasBoardPost,
  loadState,
  saveState,
  updateAgentState,
  isRestartRequested,
  clearRestartFlag,
} from "../config/store.js";
import { ensureBaseStructure } from "../config/paths.js";
import { runOnboarding } from "../onboarding/index.js";
import { showWelcomeBack } from "../onboarding/welcome-back.js";
import type { AgentStatus } from "../onboarding/welcome-back.js";
import { getSkillContext, fetchRemoteContext } from "../remote/skill.js";
import type { AgentProfile } from "../agent/system-prompt.js";
import { loadLatestSession, pruneOldSessions, newSessionId } from "../config/sessions.js";
import { loadMemory } from "../tools/memory.js";
import App from "../ui/App.js";

/**
 * Agent journey stages — determines what the LLM should guide the user toward.
 *
 * 1. fresh        — just registered, needs X/Twitter verification
 * 2. pending      — returning user still pending verification
 * 3. verified     — verified but hasn't traded yet
 * 4. trading      — has trades but no wallet
 * 5. wallet_ready — wallet set up, can claim rewards
 * 6. full         — everything set up, fully active
 */
type JourneyStage = "fresh" | "pending" | "verified" | "trading" | "wallet_ready" | "full";

function detectJourneyStage(params: {
  isNewAgent: boolean;
  apiStatus: AgentStatus | null;
  hasWallet: boolean;
}): JourneyStage {
  const { isNewAgent, apiStatus, hasWallet } = params;

  if (isNewAgent) return "fresh";
  if (!apiStatus) return "verified"; // offline fallback — assume verified
  if (apiStatus.status === "pending_verification") return "pending";

  // Agent is verified/active
  if (apiStatus.simBalance === 10_000 && !hasWallet) return "verified"; // never traded (still at starting balance, no wallet)
  if (!hasWallet) return "trading";
  return "wallet_ready";
}


async function main(): Promise<void> {
  ensureBaseStructure();

  // Parse CLI args
  const args = process.argv.slice(2);
  const shouldContinue = args.includes("--continue") || args.includes("-c");

  // Step 1: Onboarding or welcome back
  const isReturning = isConfigured();
  let onboardingResult: { agentName: string; verificationCode: string } | null = null;

  if (!isReturning) {
    onboardingResult = await runOnboarding();
    if (!onboardingResult) {
      console.error("Onboarding failed. Please try again.");
      process.exit(1);
    }
  }

  // Step 2: Load config and credentials
  const config = loadConfig();
  if (!config) {
    console.error(
      "No config found. Delete ~/.config/astranova/config.json and re-run to start fresh.",
    );
    process.exit(1);
  }

  const agentName = getActiveAgent();
  if (!agentName) {
    console.error(
      "No active agent found. Delete ~/.config/astranova/ and re-run to start fresh.",
    );
    process.exit(1);
  }

  const credentials = loadCredentials(agentName);
  if (!credentials) {
    console.error(
      `No credentials found for agent "${agentName}". Delete ~/.config/astranova/ and re-run to start fresh.`,
    );
    process.exit(1);
  }

  // Step 3: Welcome back for returning users — also fetches agent status from API
  let apiStatus: AgentStatus | null = null;
  if (isReturning) {
    apiStatus = await showWelcomeBack(agentName);
  }

  // Step 4: Fetch remote context (cached, graceful fallback)
  const [skillContext, tradingContext, walletContext, rewardsContext, onboardingContext, apiContext] = await Promise.all([
    getSkillContext(),
    fetchRemoteContext("TRADING.md").then((c) => c ?? ""),
    fetchRemoteContext("WALLET.md").then((c) => c ?? ""),
    fetchRemoteContext("REWARDS.md").then((c) => c ?? ""),
    fetchRemoteContext("ONBOARDING.md").then((c) => c ?? ""),
    fetchRemoteContext("API.md").then((c) => c ?? ""),
  ]);

  // Step 5: Ensure state.json exists (migrate from legacy active_agent if needed)
  if (!loadState()) {
    saveState({
      activeAgent: agentName,
      agents: {
        [agentName]: {
          status: apiStatus?.status ?? "unknown",
          journeyStage: "fresh",
          createdAt: new Date().toISOString(),
          verificationCode: onboardingResult?.verificationCode ?? apiStatus?.verificationCode,
        },
      },
    });
  }

  // Step 6: Detect journey stage and build profile
  const isNewAgent = !isReturning && onboardingResult !== null;
  const hasWallet = loadWallet(agentName) !== null;
  const boardPosted = hasBoardPost(agentName);

  const stage = detectJourneyStage({ isNewAgent, apiStatus, hasWallet });

  // Persist stage to state.json so we remember between sessions
  updateAgentState(agentName, {
    status: apiStatus?.status ?? (isNewAgent ? "pending_verification" : "active"),
    journeyStage: stage,
    verificationCode: onboardingResult?.verificationCode ?? apiStatus?.verificationCode,
  });

  const profile: AgentProfile = {
    agentName,
    status: apiStatus?.status ?? (isNewAgent ? "pending_verification" : "active"),
    simBalance: apiStatus?.simBalance,
    walletAddress: apiStatus?.walletAddress,
    verificationCode: onboardingResult?.verificationCode ?? apiStatus?.verificationCode,
    isNewAgent,
    boardPosted,
    journeyStage: stage,
  };

  // Step 7: Session resume + memory
  pruneOldSessions(agentName);
  const memoryContent = loadMemory(agentName);

  let sessionId = newSessionId();
  let initialCoreMessages: import("ai").CoreMessage[] | undefined;
  let initialChatMessages: Array<{ role: string; content: string }> | undefined;

  if (shouldContinue) {
    const session = loadLatestSession(agentName);
    if (session) {
      const updatedAt = new Date(session.updatedAt);
      const minutesAgo = Math.round((Date.now() - updatedAt.getTime()) / 60_000);
      console.log(`  Resuming session from ${minutesAgo} minute(s) ago...\n`);
      sessionId = session.sessionId;
      initialCoreMessages = session.coreMessages as import("ai").CoreMessage[];
      initialChatMessages = session.chatMessages;
    } else {
      console.log("  No previous session found. Starting fresh.\n");
    }
  }

  // Step 8: Launch Ink TUI
  const { waitUntilExit } = render(
    React.createElement(App, {
      agentName,
      skillContext,
      tradingContext,
      walletContext,
      rewardsContext,
      onboardingContext,
      apiContext,
      profile,
      sessionId,
      memoryContent,
      initialCoreMessages,
      initialChatMessages,
    }),
  );

  await waitUntilExit();

  // Check if a restart was requested (agent switch/create)
  if (isRestartRequested()) {
    clearRestartFlag();
    const newAgent = getActiveAgent();
    console.log(`\n  Restarting as ${newAgent}...\n`);
    // Relaunch the same process
    try {
      execFileSync(process.execPath, process.argv.slice(1), {
        stdio: "inherit",
        env: process.env,
      });
    } catch {
      // execFileSync throws when the child exits — that's normal
    }
    process.exit(0);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});
