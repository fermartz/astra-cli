import process from "node:process";
import React from "react";
import { render } from "ink";
import { execFileSync } from "node:child_process";
import { setActiveManifest } from "../domain/plugin.js";
import { ASTRANOVA_MANIFEST } from "../domain/astranova/manifest.js";
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
  isPluginsPickerRequested,
  clearPluginsPickerFlag,
  loadAutopilotConfig,
  loadAutopilotLogSince,
  getActivePlugin,
  setActivePlugin,
  loadPluginManifest,
} from "../config/store.js";
import { ensureBaseStructure } from "../config/paths.js";
import { runOnboarding } from "../onboarding/index.js";
import { showWelcomeBack } from "../onboarding/welcome-back.js";
import type { AgentStatus } from "../onboarding/welcome-back.js";
import { getSkillContext, fetchRemoteContext } from "../remote/skill.js";
import type { AgentProfile } from "../agent/system-prompt.js";
import { loadLatestSession, pruneOldSessions, newSessionId } from "../config/sessions.js";
import { loadMemory } from "../tools/memory.js";
import { loadStrategy } from "../tools/strategy.js";
import { runDaemon } from "../daemon/autopilot-worker.js";
import { addPlugin, listInstalledPlugins, runPluginsPicker } from "../domain/loader.js";
import { PLUGIN_REGISTRY } from "../domain/registry.js";
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
  // full = wallet registered with API (completed full setup)
  // wallet_ready = local wallet exists but not yet registered with API
  if (apiStatus.walletAddress) return "full";
  return "wallet_ready";
}


async function main(): Promise<void> {
  ensureBaseStructure();

  // Parse CLI args
  const args = process.argv.slice(2);
  const shouldContinue = args.includes("--continue") || args.includes("-c");
  const debug = args.includes("--debug") || args.includes("-d");
  const isDaemonMode = args.includes("--daemon");

  // --plugins-picker: run the clack plugin picker in a fresh process (clean terminal state)
  if (args.includes("--plugins-picker")) {
    await runPluginsPicker();
    process.exit(0);
  }

  // --add <url>: install a plugin and exit (no TUI needed)
  const addIdx = args.indexOf("--add");
  if (addIdx !== -1) {
    const addUrl = args[addIdx + 1];
    if (!addUrl || addUrl.startsWith("--")) {
      console.error("Usage: astra --add <url>");
      console.error("Example: astra --add https://moltbook.com/skill.md");
      process.exit(1);
    }
    await addPlugin(addUrl);
    process.exit(0);
  }

  // --plugins: show registry with install status and exit
  if (args.includes("--plugins")) {
    const activePluginName = getActivePlugin();
    const installed = listInstalledPlugins();
    const installedNames = new Set(["astranova", ...installed.map((p) => p.name)]);
    console.log("\n  Plugins:\n");
    for (const entry of PLUGIN_REGISTRY) {
      const isActive = entry.name === activePluginName;
      const isInstalled = installedNames.has(entry.name);
      const status = isActive ? "(active)" : isInstalled ? "(installed)" : "(not installed)";
      console.log(`    ${entry.name.padEnd(14)} ${status.padEnd(16)} ${entry.tagline}`);
    }
    console.log("\n  Use /plugins inside the TUI to install or switch.\n");
    process.exit(0);
  }

  // --plugin <name>: override active plugin for this session only
  const pluginIdx = args.indexOf("--plugin");
  const pluginArg = pluginIdx !== -1 ? args[pluginIdx + 1] : undefined;

  // Load the active plugin manifest (from --plugin arg, state.json, or AstraNova default)
  const activePluginName = pluginArg ?? getActivePlugin();
  let manifest =
    activePluginName === "astranova" ? ASTRANOVA_MANIFEST : loadPluginManifest(activePluginName);

  if (!manifest) {
    if (pluginArg) {
      console.error(`Plugin "${pluginArg}" is not installed. Run: astra --add <url>`);
      process.exit(1);
    }
    // Active plugin from state.json is missing — fall back to AstraNova
    console.error(
      `Warning: active plugin "${activePluginName}" not found. Falling back to AstraNova.`,
    );
    manifest = ASTRANOVA_MANIFEST;
  }

  // Set the active manifest before any tool or remote context call
  setActiveManifest(manifest);

  // Daemon mode — skip onboarding + TUI, run background worker
  if (isDaemonMode) {
    await runDaemon();
    return;
  }

  // Clear any stale flags from a previous session that wasn't consumed
  if (isRestartRequested()) clearRestartFlag();
  if (isPluginsPickerRequested()) clearPluginsPickerFlag();

  // Activate debug logging in agent loop when --debug flag is set
  if (debug) {
    process.env.ASTRA_DEBUG = "1";
  }

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
      "No config found. Delete ~/.config/astra/ and re-run to start fresh.",
    );
    process.exit(1);
  }

  let agentName = getActiveAgent();
  if (!agentName) {
    // No agent for the active plugin — likely a newly installed plugin with no registered agent.
    // Revert to astranova (which always has an agent) and relaunch.
    const currentPlugin = getActivePlugin();
    if (currentPlugin !== "astranova") {
      console.log(`\n  No agent registered for plugin "${currentPlugin}". Reverting to astranova...\n`);
      setActivePlugin("astranova");
      try {
        execFileSync(process.execPath, process.argv.slice(1), { stdio: "inherit", env: process.env });
      } catch { /* expected */ }
      process.exit(0);
    }
    console.error("No active agent found. Delete ~/.config/astra/ and re-run to start fresh.");
    process.exit(1);
  }

  const credentials = loadCredentials(agentName);
  if (!credentials) {
    console.error(
      `No credentials found for agent "${agentName}". Delete ~/.config/astra/ and re-run to start fresh.`,
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

  // Step 5: Ensure state.json exists with the current plugin/agent
  if (!loadState()) {
    const plugin = activePluginName;
    saveState({
      activePlugin: plugin,
      activeAgents: { [plugin]: agentName },
      agents: {
        [plugin]: {
          [agentName]: {
            status: apiStatus?.status ?? "unknown",
            journeyStage: "fresh",
            createdAt: new Date().toISOString(),
            verificationCode: onboardingResult?.verificationCode ?? apiStatus?.verificationCode,
          },
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

  const hasStrategy = !!loadStrategy(agentName);

  const profile: AgentProfile = {
    agentName,
    status: apiStatus?.status ?? (isNewAgent ? "pending_verification" : "active"),
    simBalance: apiStatus?.simBalance,
    walletAddress: apiStatus?.walletAddress,
    walletLocal: hasWallet,
    verificationCode: onboardingResult?.verificationCode ?? apiStatus?.verificationCode,
    isNewAgent,
    boardPosted,
    journeyStage: stage,
    hasStrategy,
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

  // Step 8: Load autopilot config + check for pending daemon trades
  const initialAutopilotConfig = loadAutopilotConfig();

  // Count trades logged by the full autopilot daemon since the last session
  const lastSessionAt = shouldContinue
    ? (() => { const s = loadLatestSession(agentName); return s ? new Date(s.updatedAt) : null; })()
    : null;
  const pendingTrades = loadAutopilotLogSince(agentName, lastSessionAt);
  const initialPendingTrades = pendingTrades.length;

  // Step 9: Launch Ink TUI
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
      initialAutopilotConfig,
      initialPendingTrades,
      debug,
    }),
  );

  await waitUntilExit();

  // Check if the plugins picker was requested (by /plugins TUI command).
  // Relaunch as a fresh process so the terminal is fully restored before clack runs.
  if (isPluginsPickerRequested()) {
    clearPluginsPickerFlag();
    try {
      execFileSync(process.execPath, [...process.argv.slice(1), "--plugins-picker"], {
        stdio: "inherit",
        env: process.env,
      });
    } catch {
      // execFileSync throws when the child exits — that's expected
    }
    process.exit(0);
  }

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
