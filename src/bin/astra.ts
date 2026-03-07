import process from "node:process";
import React from "react";
import { render } from "ink";
import { execFileSync } from "node:child_process";
import { setActiveManifest } from "../domain/plugin.js";
import AppErrorBoundary from "../ui/AppErrorBoundary.js";
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
import { fetchAgentStatus, randomGreeting, journeyTip, buildVerificationReminder } from "../onboarding/welcome-back.js";
import type { AgentStatus } from "../onboarding/welcome-back.js";
import { getSkillContext, fetchRemoteContext } from "../remote/skill.js";
import type { AgentProfile } from "../agent/system-prompt.js";
import { loadLatestSession, pruneOldSessions, newSessionId } from "../config/sessions.js";
import { loadMemory } from "../tools/memory.js";
import { loadStrategy } from "../tools/strategy.js";
import { runDaemon } from "../daemon/autopilot-worker.js";
import { addPlugin, listInstalledPlugins, runPluginsPicker, loadPluginMap } from "../domain/loader.js";
import { PLUGIN_REGISTRY } from "../domain/registry.js";
import { LOGO, TAGLINE, VERSION, pluginTagline } from "../ui/logo.js";
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

  // --plugins-picker: run the plugin picker in a fresh process (clean terminal state)
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

  // Load plugin-map for non-AstraNova plugins (status bar + command hints)
  const pluginMap = activePluginName === "astranova" ? null : loadPluginMap(activePluginName);

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

  // Whether this plugin uses AstraNova-specific features (journey stages, trading, wallet, etc.)
  const isAstraNova = !!manifest.extensions?.journeyStages;

  // Build welcome banner for Ink to display as first chat message
  const welcomeBanner = [
    LOGO,
    `  ${TAGLINE}`,
    `  ${pluginTagline(manifest.name, manifest.tagline ?? manifest.description)}`,
    `  ${VERSION}`,
  ].join("\n");

  // Step 1: Determine mode — onboarding, returning, or needs-registration
  const isReturning = isConfigured();

  if (!isReturning) {
    // First-time user — launch Ink with onboarding flow
    const { waitUntilExit } = render(
      React.createElement(AppErrorBoundary, null,
        React.createElement(App, {
          skillContext: "",
          tradingContext: "",
          walletContext: "",
          rewardsContext: "",
          onboardingContext: "",
          apiContext: "",
          sessionId: newSessionId(),
          debug,
          pluginMap,
          isOnboarding: true,
          welcomeBanner,
          onOnboardingComplete: () => {
            // Onboarding complete — relaunch to load full context
            try {
              execFileSync(process.execPath, process.argv.slice(1), {
                stdio: "inherit",
                env: process.env,
              });
            } catch {
              // expected
            }
            process.exit(0);
          },
        }),
      ),
    );
    await waitUntilExit();
    return;
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
  let needsRegistration = false;

  if (!agentName) {
    // No agent for the active plugin — new plugin selected with no registered agent yet.
    const currentPlugin = getActivePlugin();
    if (currentPlugin !== "astranova") {
      needsRegistration = true;
      agentName = ""; // Will be set during registration
    } else {
      console.error("No active agent found. Delete ~/.config/astra/ and re-run to start fresh.");
      process.exit(1);
    }
  }

  if (needsRegistration) {
    // Launch Ink with registration flow (skip provider selection)
    const { waitUntilExit } = render(
      React.createElement(AppErrorBoundary, null,
        React.createElement(App, {
          skillContext: "",
          tradingContext: "",
          walletContext: "",
          rewardsContext: "",
          onboardingContext: "",
          apiContext: "",
          sessionId: newSessionId(),
          debug,
          pluginMap,
          needsRegistration: true,
          welcomeBanner,
          onOnboardingComplete: () => {
            try {
              execFileSync(process.execPath, process.argv.slice(1), {
                stdio: "inherit",
                env: process.env,
              });
            } catch {
              // expected
            }
            process.exit(0);
          },
        }),
      ),
    );
    await waitUntilExit();
    return;
  }

  const credentials = loadCredentials(agentName);
  if (!credentials) {
    console.error(
      `No credentials found for agent "${agentName}". Delete ~/.config/astra/ and re-run to start fresh.`,
    );
    process.exit(1);
  }

  // Step 3: Fetch remote context (cached, graceful fallback)
  // Non-AstraNova plugins: only fetch skill.md — no trading/wallet/rewards guides
  const skillContext = await getSkillContext();
  const [tradingContext, walletContext, rewardsContext, onboardingContext, apiContext] = isAstraNova
    ? await Promise.all([
        fetchRemoteContext("TRADING.md").then((c) => c ?? ""),
        fetchRemoteContext("WALLET.md").then((c) => c ?? ""),
        fetchRemoteContext("REWARDS.md").then((c) => c ?? ""),
        fetchRemoteContext("ONBOARDING.md").then((c) => c ?? ""),
        fetchRemoteContext("API.md").then((c) => c ?? ""),
      ])
    : ["", "", "", "", ""];

  // Step 4: Ensure state.json exists with the current plugin/agent
  if (!loadState()) {
    const plugin = activePluginName;
    saveState({
      activePlugin: plugin,
      activeAgents: { [plugin]: agentName },
      agents: {
        [plugin]: {
          [agentName]: {
            status: "active",
            journeyStage: "fresh",
            createdAt: new Date().toISOString(),
          },
        },
      },
    });
  }

  // Step 5: Build agent profile
  // AstraNova: full journey detection with API status, wallet, board post.
  // Generic plugins: minimal profile — no journey, no AstraNova-specific state.
  let profile: AgentProfile;

  if (isAstraNova) {
    // For returning AstraNova users, apiStatus will be fetched in App's mount effect.
    // Build a preliminary profile here — will be refined after welcome-back completes.
    const hasWallet = loadWallet(agentName) !== null;
    const boardPosted = hasBoardPost(agentName);
    const hasStrategy = !!loadStrategy(agentName);

    // Use a preliminary stage — the welcome-back flow will update this
    const preliminaryStage = detectJourneyStage({ isNewAgent: false, apiStatus: null, hasWallet });

    profile = {
      agentName,
      status: "active",
      walletLocal: hasWallet,
      isNewAgent: false,
      boardPosted,
      journeyStage: preliminaryStage,
      hasStrategy,
    };
  } else {
    // Generic plugin — active, no journey overhead
    updateAgentState(agentName, { status: "active" });
    profile = { agentName, status: "active", isNewAgent: false };
  }

  // Step 6: Session resume + memory
  pruneOldSessions(agentName);
  const memoryContent = loadMemory(agentName);

  let sessionId = newSessionId();
  let initialCoreMessages: import("ai").CoreMessage[] | undefined;
  let initialChatMessages: Array<{ role: string; content: string }> | undefined;
  let session: ReturnType<typeof loadLatestSession> = null;

  if (shouldContinue) {
    session = loadLatestSession(agentName);
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

  // Step 7: Welcome-back fetch (AstraNova returning users)
  // Done BEFORE Ink mounts so messages are ready on first render — no async height changes.
  let apiStatus: import("../onboarding/welcome-back.js").AgentStatus | null = null;
  if (isReturning && isAstraNova) {
    process.stdout.write("  Loading...\r");
    apiStatus = await fetchAgentStatus(agentName);
    process.stdout.write("             \r"); // clear the loading text

    const greeting = randomGreeting();
    const welcomeMessages: Array<{ role: string; content: string }> = [];

    if (!apiStatus) {
      welcomeMessages.push(
        { role: "assistant", content: greeting },
        { role: "assistant", content: "Could not reach the API. Launching in offline mode." },
      );
    } else {
      const statusLine = `Agent **"${apiStatus.name}"** — ${apiStatus.status}`;
      if (apiStatus.status === "pending_verification") {
        const reminder = buildVerificationReminder(apiStatus.name, apiStatus.verificationCode);
        welcomeMessages.push(
          { role: "assistant", content: greeting },
          { role: "assistant", content: statusLine },
          { role: "assistant", content: reminder },
        );
      } else {
        const tip = journeyTip(apiStatus);
        welcomeMessages.push(
          { role: "assistant", content: greeting },
          { role: "assistant", content: `${statusLine}\n\n${tip}` },
        );
      }

      // Refine profile with real API status
      const hasWallet = loadWallet(agentName) !== null;
      const stage = detectJourneyStage({ isNewAgent: false, apiStatus, hasWallet });
      profile = { ...profile, journeyStage: stage, verificationCode: apiStatus.verificationCode };
      updateAgentState(agentName, {
        status: apiStatus.status,
        journeyStage: stage,
        verificationCode: apiStatus.verificationCode,
      });
    }

    // Prepend welcome messages to initialChatMessages
    initialChatMessages = [...welcomeMessages, ...(initialChatMessages ?? [])];
  }

  // Step 8: Load autopilot config + check for pending daemon trades
  const initialAutopilotConfig = loadAutopilotConfig();

  // Count trades logged by the full autopilot daemon since the last session
  const lastSessionAt = shouldContinue && session
    ? new Date(session.updatedAt)
    : null;
  const pendingTrades = loadAutopilotLogSince(agentName, lastSessionAt);
  const initialPendingTrades = pendingTrades.length;

  // Step 8: Launch Ink TUI
  const { waitUntilExit } = render(
    React.createElement(AppErrorBoundary, null,
      React.createElement(App, {
        agentName,
        welcomeBanner,
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
        pluginMap,
        isReturning: false,
      }),
    ),
  );

  await waitUntilExit();

  // Check if the plugins picker was requested (by /plugins TUI command).
  // Relaunch as a fresh process so the terminal is fully restored.
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
