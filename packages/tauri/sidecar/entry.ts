/**
 * Astra Sidecar — NDJSON protocol over stdin/stdout
 *
 * Spawned by the Tauri app. Reuses all CLI agent logic.
 * stdout is EXCLUSIVELY for protocol JSON. All debug output goes to stderr.
 */

import { Writable } from "node:stream";

// ── Step 0: Redirect stdout BEFORE any CLI imports ──
// Save the real stdout as our protocol channel
const protocolOut = process.stdout;

// Replace process.stdout with stderr so console.log / accidental writes
// from CLI internals go to stderr (visible in Tauri devtools, not protocol)
Object.defineProperty(process, "stdout", {
  value: process.stderr,
  writable: true,
  configurable: true,
});

// Also redirect console.log/warn/info to stderr
const stderrWrite = (...args: unknown[]) => {
  process.stderr.write(args.map(String).join(" ") + "\n");
};
console.log = stderrWrite;
console.warn = stderrWrite;
console.info = stderrWrite;

// ── Step 1: Now safe to import CLI modules ──

import type { SidecarRequest, SidecarResponse } from "../src/lib/protocol.js";
import type { CoreMessage } from "ai";

// Config & paths
import {
  isConfigured,
  loadConfig,
  saveConfig,
  loadCredentials,
  getActiveAgent,
  setActiveAgent,
  listAgents,
  loadState,
  getActivePlugin,
  loadWallet,
  hasBoardPost,
  updateAgentState,
  isRestartRequested,
  clearRestartFlag,
  saveAutopilotConfig,
  loadEpochBudget,
  loadAutopilotLogSince,
  appendAutopilotLog,
} from "../../../src/config/store.js";
import { ensureBaseStructure } from "../../../src/config/paths.js";
import { saveSession, newSessionId, pruneOldSessions, loadLatestSession } from "../../../src/config/sessions.js";

// Agent
import { runAgentTurn } from "../../../src/agent/loop.js";
import type { AgentLoopCallbacks } from "../../../src/agent/loop.js";
import type { AgentProfile, JourneyStage } from "../../../src/agent/system-prompt.js";

// Domain
import { setActiveManifest } from "../../../src/domain/plugin.js";
import { ASTRANOVA_MANIFEST } from "../../../src/domain/astranova/manifest.js";

// Remote context
import { getSkillContext, fetchRemoteContext } from "../../../src/remote/skill.js";

// Onboarding (pure logic)
import { fetchAgentStatus, randomGreeting, journeyTip, buildVerificationReminder } from "../../../src/onboarding/welcome-back.js";
import type { AgentStatus } from "../../../src/onboarding/welcome-back.js";
import { validateApiKey, DEFAULT_MODELS, PROVIDER_OPTIONS, API_KEY_LABELS, API_KEY_PLACEHOLDERS, openBrowser } from "../../../src/onboarding/provider.js";
import { pickRandomNames, pickRandomDescriptions, validateAgentName, registerAgentApi } from "../../../src/onboarding/register.js";
import { generatePkce, buildAuthorizeUrl, exchangeCodeForTokens, parseCallbackUrl } from "../../../src/onboarding/oauth.js";
import { waitForCallback } from "../../../src/onboarding/callback-server.js";

// Tools
import { loadMemory } from "../../../src/tools/memory.js";
import { loadStrategy } from "../../../src/tools/strategy.js";

// Autopilot
import { buildAutopilotTrigger, buildStrategyRunTrigger, parseInterval, formatInterval, EPOCH_BUDGET, BUDGET_BUFFER } from "../../../src/autopilot/scheduler.js";
import type { AutopilotMode } from "../../../src/autopilot/scheduler.js";

// Daemon
import { startDaemon, stopDaemon, isDaemonRunning } from "../../../src/daemon/daemon-manager.js";
import { autopilotLogPath } from "../../../src/config/paths.js";
import fs from "node:fs";

// HTTP (for status polling)
import { apiCall } from "../../../src/utils/http.js";

// ── Protocol helpers ──

function send(msg: SidecarResponse): void {
  protocolOut.write(JSON.stringify(msg) + "\n");
}

function debug(msg: string): void {
  process.stderr.write(`[sidecar] ${msg}\n`);
}

// ── Journey stage detection (copied from astra.ts — pure function) ──

function detectJourneyStage(params: {
  isNewAgent: boolean;
  apiStatus: AgentStatus | null;
  hasWallet: boolean;
}): JourneyStage {
  const { isNewAgent, apiStatus, hasWallet } = params;

  if (isNewAgent) return "fresh";
  if (!apiStatus) return "verified"; // offline fallback
  if (apiStatus.status === "pending_verification") return "pending";

  if (apiStatus.simBalance === 10_000 && !hasWallet) return "verified";
  if (!hasWallet) return "trading";
  if (apiStatus.walletAddress) return "full";
  return "wallet_ready";
}

// ── State ──

interface SidecarState {
  agentName: string;
  config: ReturnType<typeof loadConfig>;
  profile: AgentProfile;
  skillContext: string;
  tradingContext: string;
  walletContext: string;
  rewardsContext: string;
  onboardingContext: string;
  apiContext: string;
  memoryContent: string;
  coreMessages: CoreMessage[];
  sessionId: string;
}

// ── Init sequence ──

async function initialize(): Promise<SidecarState | null> {
  ensureBaseStructure();

  const config = loadConfig();
  if (!config) {
    send({ type: "init:error", message: "Config corrupted. Delete ~/.config/astra/ and re-run the CLI." });
    return null;
  }

  const agentName = getActiveAgent();
  if (!agentName) {
    send({ type: "init:error", message: "No active agent. Run the CLI to create an agent first." });
    return null;
  }

  const credentials = loadCredentials(agentName);
  if (!credentials) {
    send({ type: "init:error", message: `No credentials for agent "${agentName}". Run the CLI to re-register.` });
    return null;
  }

  // Set active manifest (required before any tool/remote call)
  setActiveManifest(ASTRANOVA_MANIFEST);

  // Fetch remote contexts in parallel
  debug("Fetching remote contexts...");
  const [skillContext, tradingContext, walletContext, rewardsContext, onboardingContext, apiContext] =
    await Promise.all([
      getSkillContext(),
      fetchRemoteContext("TRADING.md").then((c) => c ?? ""),
      fetchRemoteContext("WALLET.md").then((c) => c ?? ""),
      fetchRemoteContext("REWARDS.md").then((c) => c ?? ""),
      fetchRemoteContext("ONBOARDING.md").then((c) => c ?? ""),
      fetchRemoteContext("API.md").then((c) => c ?? ""),
    ]);

  // Fetch API status for welcome-back
  debug("Fetching agent status...");
  const apiStatus = await fetchAgentStatus(agentName);

  // Build profile
  const hasWallet = loadWallet(agentName) !== null;
  const boardPosted = hasBoardPost(agentName);
  const journeyStage = detectJourneyStage({ isNewAgent: false, apiStatus, hasWallet });

  const hasStrategy = !!loadStrategy(agentName);
  const profile: AgentProfile = {
    agentName,
    status: apiStatus?.status ?? "active",
    simBalance: apiStatus?.simBalance,
    walletAddress: apiStatus?.walletAddress,
    walletLocal: hasWallet,
    boardPosted,
    journeyStage,
    isNewAgent: false,
    hasStrategy,
    verificationCode: apiStatus?.verificationCode,
  };

  // Build welcome messages
  const welcomeMessages: Array<{ role: "assistant"; content: string }> = [];

  if (apiStatus) {
    const greeting = randomGreeting();
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

    updateAgentState(agentName, {
      status: apiStatus.status,
      journeyStage,
      verificationCode: apiStatus.verificationCode,
    });
  } else {
    welcomeMessages.push(
      { role: "assistant", content: randomGreeting() },
      { role: "assistant", content: "Could not reach the API. Running in offline mode." },
    );
  }

  // Session housekeeping
  pruneOldSessions(agentName);
  const memoryContent = loadMemory(agentName);

  // Fresh session every launch — no auto-resume
  const coreMessages: CoreMessage[] = [];
  const sessionId = newSessionId();

  // Check daemon status + "trades while you were away"
  const daemonRunning = isDaemonRunning(agentName);
  if (daemonRunning) {
    // Show trades since last session (use latest session timestamp as cutoff)
    const latestSession = loadLatestSession(agentName);
    const sessionTs = latestSession ? new Date(latestSession.sessionId) : null;
    const recentTrades = loadAutopilotLogSince(agentName, sessionTs).slice(-20);
    if (recentTrades.length > 0) {
      const shown = recentTrades.slice(-5);
      const lines = shown.map((e) => `\`${e.ts.slice(11, 16)}\` ${e.action}`);
      let summary = `**Trades while you were away** (${recentTrades.length} total):\n\n${lines.join("\n")}`;
      if (recentTrades.length > 5) {
        summary += `\n\n_...and ${recentTrades.length - 5} more. Use \`/auto report\` to see all._`;
      }
      welcomeMessages.push({ role: "assistant", content: summary });
    }
    welcomeMessages.push({ role: "assistant", content: "Full autopilot daemon is running." });
    startLogWatcher(agentName);
  }

  send({
    type: "init:ok",
    plugin: getActivePlugin(),
    agentName,
    provider: config.provider,
    journeyStage,
    welcomeMessages,
    daemonRunning,
  });

  debug(`Initialized: agent=${agentName} provider=${config.provider} stage=${journeyStage}`);

  return {
    agentName,
    config,
    profile,
    skillContext,
    tradingContext,
    walletContext,
    rewardsContext,
    onboardingContext,
    apiContext,
    memoryContent,
    coreMessages,
    sessionId,
  };
}

// ── Onboarding handler ──

const REDIRECT_URI = "http://localhost:1455/auth/callback";

async function runOnboarding(): Promise<void> {
  debug("Entering onboarding mode...");
  ensureBaseStructure();
  setActiveManifest(ASTRANOVA_MANIFEST);

  // Filter out Ollama ("coming soon")
  const providers = PROVIDER_OPTIONS.filter((p) => p.value !== "ollama");
  send({ type: "onboard:providers", providers });

  // Onboarding state
  let selectedProvider: string | null = null;
  let oauthVerifier: string | null = null;
  let oauthState: string | null = null;

  // NDJSON reader for onboarding messages
  const readMessages = (): void => {
    let buffer = "";
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as SidecarRequest;
          handleOnboardingMessage(msg);
        } catch {
          debug(`Failed to parse stdin message: ${line}`);
        }
      }
    });
  };

  const handleOnboardingMessage = async (msg: SidecarRequest): Promise<void> => {
    switch (msg.type) {
      case "onboard:set-provider": {
        selectedProvider = msg.provider;
        debug(`Provider selected: ${selectedProvider}`);

        if (selectedProvider === "openai-oauth") {
          // Start OAuth flow
          const pkce = generatePkce();
          oauthVerifier = pkce.verifier;
          oauthState = (await import("node:crypto")).randomBytes(16).toString("hex");
          const authorizeUrl = buildAuthorizeUrl({ state: oauthState, challenge: pkce.challenge });

          send({ type: "onboard:oauth-waiting", authorizeUrl });

          // Try to open browser
          try {
            openBrowser(authorizeUrl);
          } catch {
            debug("Failed to open browser");
          }

          // Start callback server
          try {
            const result = await waitForCallback({
              redirectUri: REDIRECT_URI,
              expectedState: oauthState,
            });

            const tokens = await exchangeCodeForTokens({
              code: result.code,
              codeVerifier: oauthVerifier,
            });

            saveConfig({
              provider: "openai-oauth",
              model: DEFAULT_MODELS["openai-oauth"]!,
              auth: {
                type: "oauth",
                oauth: {
                  accessToken: tokens.accessToken,
                  refreshToken: tokens.refreshToken,
                  expiresAt: tokens.expiresAt,
                  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
                },
              },
            });

            send({ type: "onboard:oauth-ok" });
            sendNeedDetails();
          } catch (err) {
            const message = err instanceof Error ? err.message : "OAuth failed";
            debug(`OAuth callback failed: ${message}`);
            send({ type: "onboard:oauth-error", message, fallbackToPaste: true });
          }
        } else {
          // API key providers
          const label = API_KEY_LABELS[selectedProvider] ?? "API key";
          const placeholder = API_KEY_PLACEHOLDERS[selectedProvider] ?? "";
          send({ type: "onboard:need-key", label, placeholder });
        }
        break;
      }

      case "onboard:validate-key": {
        debug(`Validating ${msg.provider} key...`);
        const result = await validateApiKey(msg.provider, msg.apiKey);
        if (!result.ok) {
          send({ type: "onboard:key-error", message: result.error ?? "Invalid key" });
          return;
        }

        // Save config
        saveConfig({
          provider: msg.provider,
          model: DEFAULT_MODELS[msg.provider] ?? "gpt-4o-mini",
          auth: { type: "api-key", apiKey: msg.apiKey },
        });

        send({ type: "onboard:key-ok" });
        sendNeedDetails();
        break;
      }

      case "onboard:oauth-paste": {
        if (!oauthState || !oauthVerifier) {
          send({ type: "onboard:oauth-error", message: "No OAuth session active", fallbackToPaste: false });
          return;
        }

        const parsed = parseCallbackUrl(msg.url, oauthState);
        if ("error" in parsed) {
          send({ type: "onboard:oauth-error", message: parsed.error, fallbackToPaste: true });
          return;
        }

        try {
          const tokens = await exchangeCodeForTokens({
            code: parsed.code,
            codeVerifier: oauthVerifier,
          });

          saveConfig({
            provider: "openai-oauth",
            model: DEFAULT_MODELS["openai-oauth"]!,
            auth: {
              type: "oauth",
              oauth: {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                expiresAt: tokens.expiresAt,
                clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
              },
            },
          });

          send({ type: "onboard:oauth-ok" });
          sendNeedDetails();
        } catch (err) {
          const message = err instanceof Error ? err.message : "Token exchange failed";
          send({ type: "onboard:oauth-error", message, fallbackToPaste: true });
        }
        break;
      }

      case "onboard:register": {
        debug(`Registering agent "${msg.agentName}"...`);

        // Validate name
        const nameError = validateAgentName(msg.agentName);
        if (nameError) {
          send({ type: "onboard:register-error", message: nameError, nameConflict: false });
          return;
        }

        const result = await registerAgentApi(msg.agentName, msg.description);
        if (!result.ok) {
          send({
            type: "onboard:register-error",
            message: result.error,
            nameConflict: result.status === 409,
          });
          return;
        }

        send({
          type: "onboard:registered",
          agentName: result.agentName,
          verificationCode: result.verificationCode,
        });

        debug(`Agent "${result.agentName}" registered. Transitioning to chat...`);

        // Now initialize normally
        const state = await initialize();
        if (state) {
          startChatLoop(state);
        }
        break;
      }

      case "ping":
        send({ type: "pong" });
        break;

      default:
        debug(`Unexpected message during onboarding: ${(msg as { type: string }).type}`);
    }
  };

  function sendNeedDetails(): void {
    const nameSuggestions = pickRandomNames(3);
    const descriptionSuggestions = pickRandomDescriptions(3);
    send({ type: "onboard:need-details", nameSuggestions, descriptionSuggestions });
  }

  readMessages();
}

// ── Status polling ──

const STATUS_POLL_MS = 60_000;

interface MarketApiResponse {
  market?: { price?: number; mood?: string; epoch?: { global?: number } };
  price?: number;
  mood?: string;
  epoch?: { global?: number };
}

interface PortfolioApiResponse {
  portfolio?: { cash?: number; tokens?: number; portfolioValue?: number; currentPrice?: number; pnl?: number; pnlPct?: number };
  cash?: number;
  tokens?: number;
  portfolioValue?: number;
  currentPrice?: number;
  pnl?: number;
  pnlPct?: number;
}

async function fetchStatusData(agentName: string): Promise<void> {
  try {
    const [marketRes, portfolioRes] = await Promise.all([
      apiCall<MarketApiResponse>("GET", "/api/v1/market/state", undefined, agentName),
      apiCall<PortfolioApiResponse>("GET", "/api/v1/portfolio", undefined, agentName),
    ]);

    let market = null;
    if (marketRes.ok) {
      const d = marketRes.data;
      const m = d.market ?? d;
      market = {
        price: m.price ?? 0,
        mood: m.mood ?? "",
        epochId: (m.epoch as { global?: number } | undefined)?.global ?? 0,
      };
    }

    let portfolio = null;
    if (portfolioRes.ok) {
      const d = portfolioRes.data;
      const p = d.portfolio ?? d;
      const cash = p.cash ?? 0;
      const tokens = p.tokens ?? 0;
      const currentPrice = p.currentPrice ?? 0;
      portfolio = {
        cash,
        tokens,
        portfolioValue: p.portfolioValue ?? cash + tokens * currentPrice,
        pnl: p.pnl ?? 0,
        pnlPct: p.pnlPct ?? 0,
      };
    }

    if (market || portfolio) {
      send({ type: "status:update", market, portfolio });
    }
  } catch (err) {
    debug(`Status poll error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let statusPollTimer: ReturnType<typeof setInterval> | null = null;

function stopStatusPolling(): void {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

function startStatusPolling(state: SidecarState): void {
  stopStatusPolling();

  debug("Starting status polling (60s interval)");
  void fetchStatusData(state.agentName);
  statusPollTimer = setInterval(() => void fetchStatusData(state.agentName), STATUS_POLL_MS);
}

// ── Model switch handler ──

const PROVIDER_ALIASES: Record<string, string> = {
  claude: "claude",
  anthropic: "claude",
  openai: "openai",
  gpt: "openai",
  gemini: "google",
  google: "google",
  codex: "openai-oauth",
  chatgpt: "openai-oauth",
};

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  openai: "OpenAI",
  google: "Gemini",
  "openai-oauth": "Codex (ChatGPT)",
};

let modelOAuthVerifier: string | null = null;
let modelOAuthState: string | null = null;

function switchProvider(
  config: NonNullable<ReturnType<typeof loadConfig>>,
  newProvider: string,
  newAuth: NonNullable<ReturnType<typeof loadConfig>>["auth"],
): void {
  // Save current auth to savedAuth (works for both api-key and oauth)
  const savedAuth = { ...(config.savedAuth ?? {}), [config.provider]: { ...config.auth } };
  config.savedAuth = savedAuth;

  // Also keep savedKeys in sync for backward compat with CLI
  if (config.auth.type === "api-key" && config.auth.apiKey) {
    config.savedKeys = { ...(config.savedKeys ?? {}), [config.provider]: config.auth.apiKey };
  }

  config.provider = newProvider as typeof config.provider;
  config.model = DEFAULT_MODELS[newProvider] ?? "gpt-4o-mini";
  config.auth = newAuth;
  saveConfig(config);
}

async function handleModelSwitch(msg: SidecarRequest, state: SidecarState): Promise<void> {
  if (msg.type === "model:switch") {
    const config = loadConfig();
    if (!config) {
      send({ type: "model:key-error", message: "Config not found." });
      return;
    }

    // No provider = show current
    if (!msg.provider) {
      const available = PROVIDER_OPTIONS
        .filter((p) => p.value !== "ollama")
        .map((p) => ({ value: p.value, label: p.label }));
      send({
        type: "model:current",
        provider: config.provider,
        model: config.model,
        available,
      });
      return;
    }

    // Resolve alias
    const resolved = PROVIDER_ALIASES[msg.provider.toLowerCase()];
    if (!resolved) {
      send({ type: "model:key-error", message: `Unknown provider "${msg.provider}". Available: claude, openai, gemini, codex` });
      return;
    }

    // Already on this provider?
    if (resolved === config.provider) {
      send({ type: "model:current", provider: config.provider, model: config.model, available: [] });
      return;
    }

    // Check savedAuth before starting OAuth (covers codex switching back)
    const savedBeforeOAuth = config.savedAuth?.[resolved];
    if (savedBeforeOAuth) {
      switchProvider(config, resolved, savedBeforeOAuth);
      state.config = loadConfig()!;
      const model = DEFAULT_MODELS[resolved] ?? "gpt-4o-mini";
      send({ type: "model:switched", provider: resolved, model });
      return;
    }

    // OAuth provider (codex) — no saved auth, need fresh login
    if (resolved === "openai-oauth") {
      const pkce = generatePkce();
      modelOAuthVerifier = pkce.verifier;
      modelOAuthState = (await import("node:crypto")).randomBytes(16).toString("hex");
      const authorizeUrl = buildAuthorizeUrl({ state: modelOAuthState, challenge: pkce.challenge });

      send({ type: "model:oauth-waiting", authorizeUrl });

      try {
        openBrowser(authorizeUrl);
      } catch {
        debug("Failed to open browser for model switch OAuth");
      }

      try {
        const result = await waitForCallback({
          redirectUri: REDIRECT_URI,
          expectedState: modelOAuthState,
        });

        const tokens = await exchangeCodeForTokens({
          code: result.code,
          codeVerifier: modelOAuthVerifier,
        });

        const newAuth = {
          type: "oauth" as const,
          oauth: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
          },
        };

        switchProvider(config, "openai-oauth", newAuth);
        state.config = loadConfig()!;
        const model = DEFAULT_MODELS["openai-oauth"]!;
        send({ type: "model:oauth-ok", provider: "openai-oauth", model });
      } catch (err) {
        const message = err instanceof Error ? err.message : "OAuth failed";
        debug(`Model switch OAuth failed: ${message}`);
        send({ type: "model:oauth-error", message, fallbackToPaste: true });
      }
      return;
    }

    // Check savedAuth first (handles both api-key and oauth)
    const saved = config.savedAuth?.[resolved];
    if (saved) {
      switchProvider(config, resolved, saved);
      state.config = loadConfig()!;
      const model = DEFAULT_MODELS[resolved] ?? "gpt-4o-mini";
      send({ type: "model:switched", provider: resolved, model });
      return;
    }

    // Fallback: check legacy savedKeys (api-key only)
    const savedKey = config.savedKeys?.[resolved];
    if (savedKey) {
      switchProvider(config, resolved, { type: "api-key", apiKey: savedKey });
      state.config = loadConfig()!;
      const model = DEFAULT_MODELS[resolved] ?? "gpt-4o-mini";
      send({ type: "model:switched", provider: resolved, model });
      return;
    }

    // Need a new key
    const label = API_KEY_LABELS[resolved] ?? "API key";
    const placeholder = API_KEY_PLACEHOLDERS[resolved] ?? "";
    send({ type: "model:need-key", provider: resolved, label, placeholder });
    return;
  }

  if (msg.type === "model:validate-key") {
    const config = loadConfig();
    if (!config) {
      send({ type: "model:key-error", message: "Config not found." });
      return;
    }

    debug(`Validating ${msg.provider} key for model switch...`);
    const result = await validateApiKey(msg.provider, msg.apiKey);
    if (!result.ok) {
      send({ type: "model:key-error", message: result.error ?? "Invalid key" });
      return;
    }

    switchProvider(config, msg.provider, { type: "api-key", apiKey: msg.apiKey });
    state.config = loadConfig()!;
    const model = DEFAULT_MODELS[msg.provider] ?? "gpt-4o-mini";
    send({ type: "model:key-ok", provider: msg.provider, model });
    return;
  }

  if (msg.type === "model:oauth-paste") {
    if (!modelOAuthState || !modelOAuthVerifier) {
      send({ type: "model:oauth-error", message: "No OAuth session active", fallbackToPaste: false });
      return;
    }

    const parsed = parseCallbackUrl(msg.url, modelOAuthState);
    if ("error" in parsed) {
      send({ type: "model:oauth-error", message: parsed.error, fallbackToPaste: true });
      return;
    }

    try {
      const config = loadConfig();
      if (!config) {
        send({ type: "model:oauth-error", message: "Config not found.", fallbackToPaste: false });
        return;
      }

      const tokens = await exchangeCodeForTokens({
        code: parsed.code,
        codeVerifier: modelOAuthVerifier,
      });

      const newAuth = {
        type: "oauth" as const,
        oauth: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
        },
      };

      switchProvider(config, "openai-oauth", newAuth);
      state.config = loadConfig()!;
      const model = DEFAULT_MODELS["openai-oauth"]!;
      send({ type: "model:oauth-ok", provider: "openai-oauth", model });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Token exchange failed";
      send({ type: "model:oauth-error", message, fallbackToPaste: true });
    }
    return;
  }
}

// ── Chat handler ──

let busy = false;

// ── Autopilot state ──

let autopilotMode: AutopilotMode = "off";
let autopilotIntervalMs = 300_000;
let autopilotTimer: ReturnType<typeof setInterval> | null = null;

function stopAutopilot(): void {
  if (autopilotTimer) {
    clearInterval(autopilotTimer);
    autopilotTimer = null;
  }
  autopilotMode = "off";
}

function startAutopilot(state: SidecarState, mode: AutopilotMode, intervalMs: number): void {
  stopAutopilot();
  if (mode === "off") return;

  autopilotMode = mode;
  autopilotIntervalMs = intervalMs;

  debug(`Autopilot started: mode=${mode} interval=${formatInterval(intervalMs)}`);

  autopilotTimer = setInterval(() => {
    if (busy) return;

    // Budget check
    const budget = loadEpochBudget(state.agentName);
    const callCount = budget?.callCount ?? 0;
    if (callCount >= EPOCH_BUDGET - BUDGET_BUFFER) {
      debug("Autopilot: budget reached — skipping tick");
      return;
    }

    // Load strategy fresh and build trigger
    const strategy = loadStrategy(state.agentName);
    const trigger = buildAutopilotTrigger(autopilotMode, strategy);
    if (!trigger) return;

    debug("Autopilot: running tick");
    void handleChat(state, trigger);
  }, intervalMs);
}

function sendAutoState(agentName: string): void {
  const budget = loadEpochBudget(agentName);
  send({
    type: "auto:state",
    mode: autopilotMode,
    intervalMs: autopilotIntervalMs,
    budgetUsed: budget?.callCount ?? 0,
    budgetMax: EPOCH_BUDGET,
  });
}

// ── Daemon log watcher ──

let logWatchTimer: ReturnType<typeof setInterval> | null = null;
let logWatchOffset = 0;

function stopLogWatcher(): void {
  if (logWatchTimer) {
    clearInterval(logWatchTimer);
    logWatchTimer = null;
  }
  logWatchOffset = 0;
}

function startLogWatcher(agentName: string): void {
  stopLogWatcher();

  const logPath = autopilotLogPath(agentName);

  // Start from current end of file
  try {
    const stat = fs.statSync(logPath);
    logWatchOffset = stat.size;
  } catch {
    logWatchOffset = 0;
  }

  debug(`Log watcher started: ${logPath} (offset=${logWatchOffset})`);

  logWatchTimer = setInterval(() => {
    try {
      const stat = fs.statSync(logPath);
      if (stat.size <= logWatchOffset) return;

      // Read new bytes
      const fd = fs.openSync(logPath, "r");
      const buf = Buffer.alloc(stat.size - logWatchOffset);
      fs.readSync(fd, buf, 0, buf.length, logWatchOffset);
      fs.closeSync(fd);
      logWatchOffset = stat.size;

      const text = buf.toString("utf8");
      const lines = text.split("\n").filter((l) => l.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { ts: string; action: string };
          send({ type: "daemon:trade", ts: entry.ts, action: entry.action });
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File may not exist yet — that's fine
    }
  }, 5_000);
}

async function handleChat(state: SidecarState, message: string): Promise<void> {
  if (busy) {
    send({ type: "turn:error", message: "A turn is already in progress." });
    return;
  }

  busy = true;
  try {
    // Append user message
    state.coreMessages = [
      ...state.coreMessages,
      { role: "user" as const, content: message },
    ];

    const callbacks: AgentLoopCallbacks = {
      onTextChunk: (chunk) => send({ type: "chunk", text: chunk }),
      onToolCallStart: (toolName) => send({ type: "tool:start", toolName }),
      onToolCallEnd: (toolName) => send({ type: "tool:end", toolName }),
    };

    debug(`Running turn (${state.coreMessages.length} messages)...`);

    const result = await runAgentTurn(
      state.coreMessages,
      state.skillContext,
      state.tradingContext,
      state.walletContext,
      state.rewardsContext,
      state.onboardingContext,
      state.apiContext,
      { ...state.profile, autopilotMode },
      callbacks,
      state.memoryContent,
      null, // pluginMap — null for AstraNova
    );

    // Update core messages for next turn
    const baseMsgs = result.compactedMessages ?? state.coreMessages;
    state.coreMessages = [...baseMsgs, ...result.responseMessages];

    // Save session
    saveSession({
      agentName: state.agentName,
      provider: state.config!.provider,
      sessionId: state.sessionId,
      coreMessages: state.coreMessages,
      chatMessages: [], // display messages are managed by React
    });

    // Check for restart request (agent switch/create)
    if (isRestartRequested()) {
      clearRestartFlag();
      const newAgent = getActiveAgent();
      send({ type: "restart", agentName: newAgent ?? state.agentName });
    }

    send({ type: "turn:done", text: result.text });
    debug("Turn complete.");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error during agent turn";
    debug(`Turn error: ${message}`);
    send({ type: "turn:error", message });
  } finally {
    busy = false;
  }
}

// ── Chat loop ──

function startChatLoop(state: SidecarState): void {
  let buffer = "";

  // Start market/portfolio polling
  startStatusPolling(state);

  // Remove existing stdin listeners (from onboarding) before adding chat handler
  process.stdin.removeAllListeners("data");

  const handleMsg = async (msg: SidecarRequest): Promise<void> => {
    switch (msg.type) {
      case "ping":
        send({ type: "pong" });
        break;
      case "chat:send":
        handleChat(state, msg.message);
        break;
      case "init":
        debug("Ignoring duplicate init request");
        break;
      case "agents:list": {
        const agents = listAgents();
        const active = getActiveAgent();
        const appState = loadState();
        const plugin = getActivePlugin();
        send({
          type: "agents:list",
          agents: agents.map((name) => ({
            name,
            active: name === active,
            status: appState?.agents[plugin]?.[name]?.status ?? "unknown",
            journeyStage: appState?.agents[plugin]?.[name]?.journeyStage ?? "fresh",
            createdAt: appState?.agents[plugin]?.[name]?.createdAt ?? "",
          })),
        });
        break;
      }
      case "agents:switch": {
        const current = getActiveAgent();
        if (msg.agentName === current) {
          debug(`Already on agent "${msg.agentName}", skipping`);
          break;
        }
        const creds = loadCredentials(msg.agentName);
        if (!creds) {
          send({
            type: "agents:switch-error",
            message: `Agent "${msg.agentName}" not found.`,
            availableAgents: listAgents(),
          });
          break;
        }
        debug(`Switching to agent: ${msg.agentName}`);
        setActiveAgent(msg.agentName);
        stopStatusPolling();
        const newState = await initialize();
        if (newState) {
          Object.assign(state, newState);
          startStatusPolling(state);
        }
        break;
      }
      case "strategy:read": {
        const content = loadStrategy(state.agentName);
        if (content) {
          send({ type: "strategy:content", content });
        } else {
          send({ type: "strategy:empty" });
        }
        break;
      }
      case "strategy:run": {
        const strategy = loadStrategy(state.agentName);
        if (strategy) {
          const trigger = buildStrategyRunTrigger(strategy);
          void handleChat(state, trigger);
        } else {
          void handleChat(state, "I want to create a trading strategy. Please guide me through the options.");
        }
        break;
      }

      case "strategy:setup": {
        const existing = loadStrategy(state.agentName);
        const prompt = existing
          ? `I want to review and update my trading strategy. Here it is:\n\n${existing}\n\nLet's go through it and improve or replace it.`
          : "I want to create a trading strategy. Please guide me through the options.";
        void handleChat(state, prompt);
        break;
      }

      case "auto:set": {
        const interval = msg.intervalMs ?? autopilotIntervalMs;
        if (msg.mode === "off") {
          stopAutopilot();
          saveAutopilotConfig({ mode: "off", intervalMs: interval });
          debug("Autopilot disabled");
        } else {
          startAutopilot(state, msg.mode, interval);
          saveAutopilotConfig({ mode: msg.mode, intervalMs: interval });
        }
        sendAutoState(state.agentName);
        break;
      }
      case "auto:status": {
        sendAutoState(state.agentName);
        break;
      }
      case "auto:report": {
        const entries = loadAutopilotLogSince(state.agentName, null)
          .slice(-20)
          .map((e) => ({ ts: e.ts, action: e.action }));
        send({ type: "auto:report", entries });
        break;
      }
      case "model:switch":
      case "model:validate-key":
      case "model:oauth-paste":
        await handleModelSwitch(msg, state);
        break;

      // ── Daemon (full autopilot) ──

      case "daemon:start": {
        const strategy = loadStrategy(state.agentName);
        if (!strategy) {
          send({ type: "daemon:error", message: "No strategy found. Run `/strategy setup` first." });
          break;
        }
        saveAutopilotConfig({ mode: "full", intervalMs: autopilotIntervalMs });
        startDaemon(state.agentName);
        startLogWatcher(state.agentName);
        debug("Daemon started");
        send({ type: "daemon:state", running: true, mode: "full" });
        break;
      }

      case "daemon:stop": {
        stopDaemon(state.agentName);
        saveAutopilotConfig({ mode: "off", intervalMs: autopilotIntervalMs });
        stopLogWatcher();
        debug("Daemon stopped");
        send({ type: "daemon:state", running: false, mode: "off" });
        break;
      }

      case "daemon:status": {
        const running = isDaemonRunning(state.agentName);
        send({ type: "daemon:state", running, mode: running ? "full" : "off" });
        break;
      }
    }
  };

  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as SidecarRequest;
        void handleMsg(msg);
      } catch {
        debug(`Failed to parse stdin message: ${line}`);
      }
    }
  });

  process.stdin.on("end", () => {
    debug("stdin closed — exiting");
    process.exit(0);
  });
}

// ── Main loop ──

/** Wait for a specific message type from stdin */
function waitForMessage(type: string): Promise<void> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as SidecarRequest;
          if (msg.type === type) {
            process.stdin.removeListener("data", onData);
            resolve();
            return;
          }
        } catch {
          debug(`Failed to parse stdin message: ${line}`);
        }
      }
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  // If spawned as daemon (detached background process), skip protocol and run worker directly
  if (process.argv.includes("--daemon")) {
    const { runDaemon } = await import("../../../src/daemon/autopilot-worker.js");
    await runDaemon();
    return;
  }

  debug("Starting sidecar... waiting for init from frontend");

  // Wait for the frontend to signal it's ready
  await waitForMessage("init");
  debug("Received init — checking configuration...");

  ensureBaseStructure();

  if (!isConfigured()) {
    // No config — enter onboarding mode
    await runOnboarding();
    return;
  }

  // Config exists — normal init
  const state = await initialize();
  if (!state) {
    process.exit(1);
  }

  startChatLoop(state);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  debug(`Fatal: ${msg}`);
  try {
    protocolOut.write(JSON.stringify({ type: "init:error", message: `Sidecar crashed: ${msg}` }) + "\n");
  } catch { /* ignore */ }
  process.exit(1);
});
