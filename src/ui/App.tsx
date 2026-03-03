import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { CoreMessage } from "ai";
import StatusBar from "./StatusBar.js";
import ChatView, { type ChatMessage } from "./ChatView.js";
import Input from "./Input.js";
import Spinner from "./Spinner.js";
import { runAgentTurn } from "../agent/loop.js";
import { isRestartRequested, loadConfig, saveConfig, saveAutopilotConfig, loadEpochBudget, saveEpochBudget, appendAutopilotLog, loadAutopilotLogSince, requestPluginsPicker } from "../config/store.js";
import { validateApiKey, DEFAULT_MODELS, openBrowser } from "../onboarding/provider.js";
import {
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  parseCallbackUrl,
  REDIRECT_URI,
} from "../onboarding/oauth.js";
import { waitForCallback } from "../onboarding/callback-server.js";
import { saveSession } from "../config/sessions.js";
import type { AgentProfile } from "../agent/system-prompt.js";
import type { Config } from "../config/schema.js";
import type { AutopilotConfig } from "../autopilot/scheduler.js";
import {
  buildAutopilotTrigger,
  buildStrategyRunTrigger,
  formatInterval,
  parseInterval,
  EPOCH_BUDGET,
  BUDGET_BUFFER,
} from "../autopilot/scheduler.js";
import { loadStrategy } from "../tools/strategy.js";
import { startDaemon, stopDaemon } from "../daemon/daemon-manager.js";
import { getActiveManifest } from "../domain/plugin.js";
import type { PluginMap } from "../domain/loader.js";


interface AppProps {
  agentName: string;
  skillContext: string;
  tradingContext: string;
  walletContext: string;
  rewardsContext: string;
  onboardingContext: string;
  apiContext: string;
  profile: AgentProfile;
  sessionId: string;
  memoryContent?: string;
  initialCoreMessages?: CoreMessage[];
  initialChatMessages?: Array<{ role: string; content: string }>;
  initialAutopilotConfig?: AutopilotConfig;
  /** Number of autopilot trades made since the last session (full mode, TUI was closed). */
  initialPendingTrades?: number;
  debug?: boolean;
  pluginMap?: PluginMap | null;
}

export default function App({
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
  initialPendingTrades = 0,
  debug,
  pluginMap,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();

  // Plugin manifest — stable for the lifetime of this session
  const manifest = getActiveManifest();
  const hasAutopilot = manifest.extensions?.autopilot === true;
  const hasJourneyStages = manifest.extensions?.journeyStages === true;

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(
    (initialChatMessages as ChatMessage[]) ?? [],
  );
  const [coreMessages, setCoreMessages] = useState<CoreMessage[]>(
    initialCoreMessages ?? [],
  );
  const providerRef = useRef(loadConfig()?.provider ?? "unknown");
  const [streamingText, setStreamingText] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const isLoadingRef = useRef(false);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);
  const [toolName, setToolName] = useState<string | undefined>(undefined);

  // /model command state — provider ID awaiting API key input, or "oauth-paste" for manual OAuth URL
  const [awaitingApiKey, setAwaitingApiKey] = useState<string | null>(null);
  const [validatingKey, setValidatingKey] = useState(false);
  // OAuth PKCE verifier stored while waiting for callback/paste
  const oauthVerifierRef = useRef<string | null>(null);

  // Autopilot state
  const [autopilotMode, setAutopilotMode] = useState(initialAutopilotConfig?.mode ?? "off");
  const [autopilotIntervalMs, setAutopilotIntervalMs] = useState(initialAutopilotConfig?.intervalMs ?? 300_000);

  // Epoch call budget counter
  const epochCallCountRef = useRef(0);
  const epochIdRef = useRef<number | null>(null);

  // Load persisted epoch budget on mount
  useEffect(() => {
    const saved = loadEpochBudget(agentName);
    if (saved) {
      epochIdRef.current = saved.epochId;
      epochCallCountRef.current = saved.callCount;
    }
  }, [agentName]);

  // Notify user of trades made while TUI was closed (full autopilot daemon)
  useEffect(() => {
    if (initialPendingTrades > 0) {
      const count = initialPendingTrades;
      setChatMessages((prev) => [
        ...prev,
        {
          role: "assistant" as const,
          content: `Hey! Autopilot made **${count}** trade${count > 1 ? "s" : ""} while you were away. Type \`/auto report\` to see what happened.`,
        },
      ]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount only

  // Refs for autopilot timer closure stability
  const coreMessagesRef = useRef(coreMessages);
  useEffect(() => { coreMessagesRef.current = coreMessages; }, [coreMessages]);
  const chatMessagesRef = useRef(chatMessages);
  useEffect(() => { chatMessagesRef.current = chatMessages; }, [chatMessages]);
  // sendMessage ref — lets the autopilot timer (declared earlier) always call the latest version
  const sendMessageRef = useRef<(text: string, role?: "user" | "autopilot") => Promise<void>>(async () => {});

  // Ctrl+C to exit
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
  });

  // Epoch change handler — resets the autopilot call budget when epoch rolls over
  const handleEpochChange = useCallback((newEpoch: number) => {
    if (epochIdRef.current === newEpoch) return;
    epochIdRef.current = newEpoch;
    epochCallCountRef.current = 0;
    saveEpochBudget(agentName, { epochId: newEpoch, callCount: 0 });
  }, [agentName]);

  // Echo autopilot activity to chat as a dimmed log line
  const addLogEntry = useCallback((action: string, detail?: string) => {
    const time = formatTime(new Date());
    const text = detail ? `⟳ ${time}  ${action} — ${detail}` : `⟳ ${time}  ${action}`;
    setChatMessages((prev) => [...prev, { role: "log", content: text }]);
  }, []);

  // ── runAutopilotTurn — autonomous execution (semi + full) ──────────
  // displayMode "chat": result shown as assistant message in chat (semi)
  // displayMode "log":  result shown as dim log line + written to autopilot.log (full)
  const runAutopilotTurn = useCallback(
    async (triggerMsg: string, displayMode: "chat" | "log" = "log") => {
      const currentCore = coreMessagesRef.current;
      const newCoreMessages: CoreMessage[] = [
        ...currentCore,
        { role: "user", content: triggerMsg },
      ];

      setIsLoading(true);
      try {
        const result = await runAgentTurn(
          newCoreMessages,
          skillContext,
          tradingContext,
          walletContext,
          rewardsContext,
          onboardingContext,
          apiContext,
          { ...profile, autopilotMode },
          {
            onTextChunk: displayMode === "chat" ? (chunk) => { setStreamingText((prev) => (prev ?? "") + chunk); } : () => {},
            onToolCallStart: displayMode === "chat" ? (name) => { setToolName(name); } : () => {},
            onToolCallEnd: displayMode === "chat" ? () => { setToolName(undefined); } : () => {},
          },
          memoryContent,
          pluginMap,
        );

        const baseCoreMessages = result.compactedMessages ?? newCoreMessages;
        const updatedCore = [...baseCoreMessages, ...result.responseMessages];
        setCoreMessages(updatedCore);

        const responseText = result.text.trim();

        if (displayMode === "chat") {
          // Semi: show result as regular assistant message in chat
          setStreamingText(undefined);
          setChatMessages((prev) => [
            ...prev,
            { role: "assistant" as const, content: responseText || "Market checked — holding." },
          ]);
        } else {
          // Full: dim log line in chat + persist to autopilot.log
          const summary = responseText.split("\n")[0].slice(0, 120) || "checked → no response";
          addLogEntry(summary);
          appendAutopilotLog(agentName, { ts: new Date().toISOString(), action: summary });
        }

        // Persist session
        const updatedChat = chatMessagesRef.current;
        saveSession({
          agentName,
          provider: providerRef.current,
          sessionId,
          coreMessages: updatedCore,
          chatMessages: updatedChat,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error";
        if (displayMode === "chat") {
          setStreamingText(undefined);
          setChatMessages((prev) => [...prev, { role: "assistant" as const, content: `Autopilot error: ${message}` }]);
        } else {
          addLogEntry("error", message);
        }
      } finally {
        setIsLoading(false);
        if (displayMode === "chat") setToolName(undefined);
      }
    },
    [skillContext, tradingContext, walletContext, rewardsContext, onboardingContext, apiContext, profile, autopilotMode, agentName, sessionId, memoryContent, addLogEntry, pluginMap],
  );

  // ── Autopilot timer (autopilot extension only) ─────────────────────
  useEffect(() => {
    if (!hasAutopilot || autopilotMode === "off") return;

    const interval = setInterval(() => {
      // Skip if a turn is already running
      if (isLoadingRef.current) return;

      // Budget check — count only actual trades, read from disk for accuracy
      const budget = loadEpochBudget(agentName);
      const tradeCount = budget?.callCount ?? 0;
      if (tradeCount >= EPOCH_BUDGET - BUDGET_BUFFER) {
        addLogEntry("Budget reached — skipping until next epoch");
        return;
      }

      // Load strategy fresh at tick time and embed in trigger
      const strategy = loadStrategy(agentName);
      const trigger = buildAutopilotTrigger(autopilotMode, strategy);
      if (!trigger) return;

      if (autopilotMode === "semi") {
        // Semi: autonomous execution, result shown in chat
        void runAutopilotTurn(trigger, "chat");
      } else {
        // Full: autonomous execution, result in log only
        void runAutopilotTurn(trigger, "log");
      }
    }, autopilotIntervalMs);

    return () => clearInterval(interval);
  }, [autopilotMode, autopilotIntervalMs, addLogEntry, runAutopilotTurn]);

  // ── sendMessage ────────────────────────────────────────────────────
  const sendMessage = useCallback(
    async (userText: string, displayRole: "user" | "autopilot" = "user") => {
      let skipChatDisplay = false;

      // ── Awaiting API key or OAuth callback URL for /model flow ────
      if (awaitingApiKey) {
        // /model cancels the flow and re-handles as a command
        if (userText.startsWith("/model")) {
          setAwaitingApiKey(null);
          oauthVerifierRef.current = null;
          // Fall through — will be handled as /model command below
        } else if (awaitingApiKey.startsWith("oauth-paste:")) {
          // Manual OAuth callback URL paste (fallback when callback server fails)
          const expectedState = awaitingApiKey.slice("oauth-paste:".length);
          const trimmed = userText.trim();
          if (!trimmed) return;

          const parsed = parseCallbackUrl(trimmed, expectedState);
          if ("error" in parsed) {
            setChatMessages((prev) => [
              ...prev,
              { role: "user", content: trimmed.slice(0, 40) + "..." },
              { role: "assistant", content: `${parsed.error}\n\nPaste the full redirect URL, or type \`/model\` to cancel.` },
            ]);
            return;
          }

          const verifier = oauthVerifierRef.current;
          if (!verifier) {
            setAwaitingApiKey(null);
            setChatMessages((prev) => [...prev, { role: "assistant", content: "OAuth session expired. Try `/model codex` again." }]);
            return;
          }

          setValidatingKey(true);
          setChatMessages((prev) => [...prev, { role: "user", content: trimmed.slice(0, 40) + "..." }]);

          try {
            const tokens = await exchangeCodeForTokens({ code: parsed.code, codeVerifier: verifier });
            oauthVerifierRef.current = null;
            setValidatingKey(false);

            const cfg = loadConfig()!;
            if (cfg.auth.type === "api-key" && cfg.auth.apiKey) {
              cfg.savedKeys = { ...cfg.savedKeys, [cfg.provider]: cfg.auth.apiKey };
            }
            cfg.provider = "openai-oauth";
            cfg.model = DEFAULT_MODELS["openai-oauth"] ?? "gpt-5.3-codex";
            cfg.auth = {
              type: "oauth",
              oauth: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, clientId: tokens.clientId },
            };
            saveConfig(cfg);
            providerRef.current = "openai-oauth";
            setAwaitingApiKey(null);

            setChatMessages((prev) => [
              ...prev,
              { role: "assistant", content: `Switched to **Codex** (${DEFAULT_MODELS["openai-oauth"]})` },
            ]);
          } catch (error: unknown) {
            setValidatingKey(false);
            const msg = error instanceof Error ? error.message : "Unknown error";
            setChatMessages((prev) => [
              ...prev,
              { role: "assistant", content: `OAuth token exchange failed: ${msg}\n\nTry \`/model codex\` again.` },
            ]);
            setAwaitingApiKey(null);
            oauthVerifierRef.current = null;
          }
          return;
        } else {
          // API key paste flow
          const trimmedKey = userText.trim();
          if (!trimmedKey) return;

          setValidatingKey(true);
          setChatMessages((prev) => [...prev, { role: "user", content: "••••••••" }]);

          const result = await validateApiKey(awaitingApiKey, trimmedKey);
          setValidatingKey(false);

          if (!result.ok) {
            setChatMessages((prev) => [
              ...prev,
              { role: "assistant", content: `Key validation failed: ${result.error}\n\nPaste a valid key to retry, or type \`/model\` to cancel.` },
            ]);
            return;
          }

          // Valid key — save and switch
          const targetProvider = awaitingApiKey;
          const config = loadConfig()!;
          // Save current key to savedKeys before switching
          if (config.auth.type === "api-key" && config.auth.apiKey) {
            config.savedKeys = { ...config.savedKeys, [config.provider]: config.auth.apiKey };
          }
          config.provider = targetProvider as Config["provider"];
          config.model = DEFAULT_MODELS[targetProvider] ?? "";
          config.auth = { type: "api-key", apiKey: trimmedKey };
          // Also save the new key to savedKeys
          config.savedKeys = { ...config.savedKeys, [targetProvider]: trimmedKey };
          saveConfig(config);
          providerRef.current = targetProvider;

          setAwaitingApiKey(null);
          const modelName = DEFAULT_MODELS[targetProvider] ?? targetProvider;
          setChatMessages((prev) => [
            ...prev,
            { role: "assistant", content: `Switched to **${providerLabel(targetProvider)}** (${modelName})` },
          ]);
          return;
        }
      }

      // ── Slash commands (handled locally, never sent to LLM) ────
      if (userText.startsWith("/")) {
        const parts = userText.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();

        if (cmd === "/exit" || cmd === "/quit" || cmd === "/q") {
          exit();
          return;
        }

        if (cmd === "/clear") {
          setChatMessages([]);
          return;
        }

        if (cmd === "/compact") {
          setChatMessages((prev) => [
            ...prev,
            { role: "user", content: userText },
            { role: "assistant", content: "Manual compaction is not implemented yet — it happens automatically when context gets large." },
          ]);
          return;
        }

        if (cmd === "/plugins") {
          setChatMessages((prev) => [
            ...prev,
            { role: "user", content: userText },
            { role: "assistant", content: "Opening plugin picker..." },
          ]);
          requestPluginsPicker();
          setTimeout(() => exit(), 800);
          return;
        }

        // ── /model — switch LLM provider inline ────
        if (cmd === "/model") {
          const arg = parts[1]?.toLowerCase();
          const config = loadConfig()!;
          const currentProvider = config.provider;
          const currentModel = config.model;

          if (!arg) {
            // Show current provider + available options
            const available = ["claude", "openai", "gemini", "codex"].filter(
              (p) => p !== providerAlias(currentProvider),
            );
            setChatMessages((prev) => [
              ...prev,
              { role: "user", content: userText },
              {
                role: "assistant",
                content: `**Current provider:** ${providerLabel(currentProvider)} (${currentModel})\n\n**Switch to:** ${available.map((p) => `\`/model ${p}\``).join(" · ")}`,
              },
            ]);
            return;
          }

          // Resolve alias → provider ID
          const providerAliases: Record<string, string> = {
            claude: "claude", anthropic: "claude",
            openai: "openai", gpt: "openai",
            gemini: "google", google: "google",
            codex: "openai-oauth", chatgpt: "openai-oauth",
          };
          const targetProvider = providerAliases[arg];

          if (!targetProvider) {
            setChatMessages((prev) => [
              ...prev,
              { role: "user", content: userText },
              { role: "assistant", content: `Unknown provider: \`${arg}\`. Available: \`claude\` · \`openai\` · \`gemini\` · \`codex\`` },
            ]);
            return;
          }

          // Already on this provider
          if (targetProvider === currentProvider) {
            setChatMessages((prev) => [
              ...prev,
              { role: "user", content: userText },
              { role: "assistant", content: `Already using **${providerLabel(targetProvider)}** (${currentModel})` },
            ]);
            return;
          }

          // Codex — inline OAuth flow (open browser + callback server)
          if (targetProvider === "openai-oauth") {
            const { verifier, challenge } = generatePkce();
            const oauthState = generateState();
            const authorizeUrl = buildAuthorizeUrl({ state: oauthState, challenge });
            oauthVerifierRef.current = verifier;

            setChatMessages((prev) => [
              ...prev,
              { role: "user", content: userText },
              { role: "assistant", content: "Opening browser for ChatGPT login..." },
            ]);
            setValidatingKey(true);
            openBrowser(authorizeUrl);

            // Try automatic callback server
            try {
              const result = await waitForCallback({
                redirectUri: REDIRECT_URI,
                expectedState: oauthState,
              });
              // Exchange code for tokens
              const tokens = await exchangeCodeForTokens({ code: result.code, codeVerifier: verifier });
              oauthVerifierRef.current = null;
              setValidatingKey(false);

              // Save current key before switching
              const cfg = loadConfig()!;
              if (cfg.auth.type === "api-key" && cfg.auth.apiKey) {
                cfg.savedKeys = { ...cfg.savedKeys, [cfg.provider]: cfg.auth.apiKey };
              }
              cfg.provider = "openai-oauth";
              cfg.model = DEFAULT_MODELS["openai-oauth"] ?? "gpt-5.3-codex";
              cfg.auth = {
                type: "oauth",
                oauth: {
                  accessToken: tokens.accessToken,
                  refreshToken: tokens.refreshToken,
                  expiresAt: tokens.expiresAt,
                  clientId: tokens.clientId,
                },
              };
              saveConfig(cfg);
              providerRef.current = "openai-oauth";

              setChatMessages((prev) => [
                ...prev,
                { role: "assistant", content: `Switched to **Codex** (${DEFAULT_MODELS["openai-oauth"]})` },
              ]);
            } catch {
              // Callback server failed (port conflict or timeout) — fall back to manual paste
              setValidatingKey(false);
              setAwaitingApiKey("oauth-paste:" + oauthState);
              setChatMessages((prev) => [
                ...prev,
                { role: "assistant", content: `Couldn't detect the callback automatically.\n\nPaste the redirect URL from your browser here, or type \`/model\` to cancel.\n\n${authorizeUrl}` },
              ]);
            }
            return;
          }

          // Check savedKeys first
          const savedKey = config.savedKeys?.[targetProvider];
          if (savedKey) {
            // Save current key before switching
            if (config.auth.type === "api-key" && config.auth.apiKey) {
              config.savedKeys = { ...config.savedKeys, [config.provider]: config.auth.apiKey };
            }
            config.provider = targetProvider as Config["provider"];
            config.model = DEFAULT_MODELS[targetProvider] ?? "";
            config.auth = { type: "api-key", apiKey: savedKey };
            saveConfig(config);
            providerRef.current = targetProvider;

            const modelName = DEFAULT_MODELS[targetProvider] ?? targetProvider;
            setChatMessages((prev) => [
              ...prev,
              { role: "user", content: userText },
              { role: "assistant", content: `Switched to **${providerLabel(targetProvider)}** (${modelName})` },
            ]);
            return;
          }

          // No saved key — prompt for one
          const keyLabels: Record<string, string> = {
            claude: "Anthropic API key",
            openai: "OpenAI API key",
            google: "Google AI API key",
          };
          setAwaitingApiKey(targetProvider);
          setChatMessages((prev) => [
            ...prev,
            { role: "user", content: userText },
            { role: "assistant", content: `Enter your ${keyLabels[targetProvider] ?? "API key"}. Your key is stored locally and never shared with the AI model.` },
          ]);
          return;
        }

        // ── /auto slash commands (AstraNova autopilot extension only) ────
        if (hasAutopilot && cmd === "/auto") {
          const sub = parts[1]?.toLowerCase();

          if (!sub || sub === "status") {
            const modeLabel = autopilotMode.toUpperCase();
            const intervalLabel = formatInterval(autopilotIntervalMs);
            const tradeCount = loadEpochBudget(agentName)?.callCount ?? 0;
            const budgetLabel = `${tradeCount}/${EPOCH_BUDGET}`;
            setChatMessages((prev) => [
              ...prev,
              { role: "user", content: userText },
              { role: "assistant", content: `**Autopilot Status**\n\nMode: ${modeLabel}\nInterval: ${intervalLabel}\nEpoch Budget: ${budgetLabel} calls used` },
            ]);
            return;
          }

          if (sub === "on" || sub === "semi") {
            stopDaemon(agentName); // stop full daemon if switching from full mode
            setAutopilotMode("semi");
            saveAutopilotConfig({ mode: "semi", intervalMs: autopilotIntervalMs });
            const hasStrat = !!loadStrategy(agentName);
            setChatMessages((prev) => [
              ...prev,
              { role: "user", content: userText },
              { role: "assistant", content: `Autopilot enabled: **SEMI** mode (every ${formatInterval(autopilotIntervalMs)}). I'll execute trades automatically based on your strategy.${!hasStrat ? "\n\n⚠️ No strategy set yet — I'll use general momentum signals. Use `/strategy setup` to create one." : ""}` },
            ]);
            addLogEntry("Mode set to SEMI");
            return;
          }

          if (sub === "full") {
            const strategy = loadStrategy(agentName);
            if (!strategy) {
              setChatMessages((prev) => [
                ...prev,
                { role: "user", content: userText },
                { role: "assistant", content: "You need a trading strategy before enabling full autopilot. Use `/strategy setup` to create one." },
              ]);
              return;
            }
            setAutopilotMode("full");
            saveAutopilotConfig({ mode: "full", intervalMs: autopilotIntervalMs });
            startDaemon(agentName);
            setChatMessages((prev) => [
              ...prev,
              { role: "user", content: userText },
              { role: "assistant", content: `Autopilot enabled: **FULL** mode (every ${formatInterval(autopilotIntervalMs)}). I'll execute trades autonomously based on your strategy — even when you close the app.` },
            ]);
            addLogEntry("Mode set to FULL — daemon started");
            return;
          }

          if (sub === "report") {
            const entries = loadAutopilotLogSince(agentName, null);
            if (entries.length === 0) {
              setChatMessages((prev) => [
                ...prev,
                { role: "user", content: userText },
                { role: "assistant", content: "No autopilot trades logged yet." },
              ]);
            } else {
              const lines = entries.slice(-20).map((e) => `\`${e.ts.slice(11, 16)}\` ${e.action}`);
              setChatMessages((prev) => [
                ...prev,
                { role: "user", content: userText },
                { role: "assistant", content: `**Autopilot log** (last ${lines.length} entries):\n\n${lines.join("\n")}` },
              ]);
            }
            return;
          }

          if (sub === "off") {
            stopDaemon(agentName); // no-op if not running
            setAutopilotMode("off");
            saveAutopilotConfig({ mode: "off", intervalMs: autopilotIntervalMs });
            setChatMessages((prev) => [
              ...prev,
              { role: "user", content: userText },
              { role: "assistant", content: "Autopilot disabled." },
            ]);
            addLogEntry("Autopilot OFF");
            return;
          }

          // Try parsing interval (e.g., "5m", "10m", "30m")
          const parsed = parseInterval(sub);
          if (parsed !== null) {
            setAutopilotIntervalMs(parsed);
            // If autopilot is off, also turn it on in semi mode
            const newMode = autopilotMode === "off" ? "semi" : autopilotMode;
            setAutopilotMode(newMode);
            saveAutopilotConfig({ mode: newMode, intervalMs: parsed });
            setChatMessages((prev) => [
              ...prev,
              { role: "user", content: userText },
              { role: "assistant", content: `Autopilot interval set to **${formatInterval(parsed)}**. Mode: ${newMode.toUpperCase()}.` },
            ]);
            addLogEntry(`Interval set to ${formatInterval(parsed)}`);
            return;
          }

          // Unknown /auto subcommand
          setChatMessages((prev) => [
            ...prev,
            { role: "user", content: userText },
            { role: "assistant", content: "Usage: `/auto on` · `/auto full` · `/auto off` · `/auto 5m` · `/auto status`" },
          ]);
          return;
        }

        // ── /strategy slash commands (AstraNova autopilot extension only) ────
        if (hasAutopilot && cmd === "/strategy") {
          const sub = parts[1]?.toLowerCase();
          const originalCmd = userText;

          if (sub === "status") {
            const strategy = loadStrategy(agentName);
            setChatMessages((prev) => [
              ...prev,
              { role: "user", content: originalCmd },
              strategy
                ? { role: "assistant", content: `**Your current strategy:**\n\n${strategy}` }
                : { role: "assistant", content: "No strategy set up yet. Use `/strategy setup` to create one." },
            ]);
            return;
          }

          if (sub === "setup") {
            const existing = loadStrategy(agentName);
            userText = existing
              ? `I want to review and update my trading strategy. Here it is:\n\n${existing}\n\nLet's go through it and improve or replace it.`
              : "I want to create a trading strategy. Please guide me through the options.";
            // Add the command as user message, then fall through to LLM with rewritten userText
            setChatMessages((prev) => [...prev, { role: "user", content: originalCmd }]);
            skipChatDisplay = true;
          } else if (!sub) {
            // No subcommand: one-shot run if strategy exists, else guide creation
            const strategy = loadStrategy(agentName);
            if (strategy) {
              const trigger = buildStrategyRunTrigger(strategy);
              setChatMessages((prev) => [...prev, { role: "user", content: originalCmd }]);
              void runAutopilotTurn(trigger, "chat");
              return;
            }
            // No strategy — guide creation
            userText = "I want to create a trading strategy. Please guide me through the options.";
            setChatMessages((prev) => [...prev, { role: "user", content: originalCmd }]);
            skipChatDisplay = true;
          } else {
            // Unknown subcommand
            setChatMessages((prev) => [
              ...prev,
              { role: "user", content: originalCmd },
              { role: "assistant", content: "Usage: `/strategy` · `/strategy setup` · `/strategy status`" },
            ]);
            return;
          }
          // Fall through to LLM — user message already added above
        }

        if (cmd === "/help" || cmd === "/?") {
          const helpLines: string[] = [];

          if (hasJourneyStages) {
            helpLines.push(
              "**Quick Actions**",
              "",
              "  `/portfolio` — Show portfolio card",
              "  `/market`    — Current price, mood & trend",
              "  `/rewards`   — Check claimable $ASTRA",
              "  `/trades`    — Recent trade history",
              "  `/board`     — Browse the board",
              "  `/wallet`    — Check wallet status",
              "  `/buy <amt>` — Buy $NOVA (e.g. `/buy 500`)",
              "  `/sell <amt>`— Sell $NOVA (e.g. `/sell 200`)",
              "",
            );
          }

          if (hasAutopilot) {
            helpLines.push(
              "**Strategy & Autopilot**",
              "",
              "  `/strategy`        — Run strategy once (or create if none)",
              "  `/strategy setup`  — Create or edit your strategy",
              "  `/strategy status` — View current strategy",
              "  `/auto on`         — Enable semi-auto mode",
              "  `/auto full`       — Enable full-auto mode (requires strategy)",
              "  `/auto off`        — Disable autopilot",
              "  `/auto 5m`         — Set interval (1m-60m)",
              "  `/auto status`     — Show autopilot status",
              "  `/auto report`     — Show autopilot trade log",
              "",
            );
          }

          helpLines.push(
            "**System**",
            "",
            "  `/model`     — Show or switch LLM provider",
            "  `/plugins`   — Browse and switch plugins",
            "  `/help`      — Show this help",
            "  `/exit`      — Exit (also `/quit`, `/q`)",
            "  `/clear`     — Clear chat display",
            "  `Ctrl+C`     — Exit immediately",
          );

          setChatMessages((prev) => [
            ...prev,
            { role: "user", content: userText },
            { role: "assistant", content: helpLines.join("\n") },
          ]);
          return;
        }

        // ── Shortcut commands (sent to LLM as natural language) ────
        // AstraNova-specific shortcuts are only available when journeyStages extension is active.
        const shortcuts: Record<string, string> = hasJourneyStages
          ? {
              "/portfolio": "Show my portfolio using the card format.",
              "/market": "Show the current market state — price, mood, and recent trend.",
              "/rewards": "Check my rewards status and show if anything is claimable.",
              "/trades": "Show my recent trade history.",
              "/board": "Show recent posts from the board.",
              "/wallet": "Check my wallet status — do I have one set up?",
              "/buy": `Buy ${parts.slice(1).join(" ") || "some"} $NOVA.`,
              "/sell": `Sell ${parts.slice(1).join(" ") || "some"} $NOVA.`,
            }
          : {};

        if (shortcuts[cmd]) {
          userText = shortcuts[cmd];
        } else if (cmd !== "/strategy" || !hasAutopilot) {
          // Unknown slash command — show hint
          setChatMessages((prev) => [
            ...prev,
            { role: "user", content: userText },
            { role: "assistant", content: `Unknown command: ${cmd}. Type /help for available commands.` },
          ]);
          return;
        }
      }

      if (!skipChatDisplay) {
        setChatMessages((prev) => [
          ...prev,
          { role: displayRole, content: userText },
        ]);
      }

      const newCoreMessages: CoreMessage[] = [
        ...coreMessages,
        { role: "user", content: userText },
      ];

      setIsLoading(true);
      setStreamingText("");
      setToolName(undefined);

      try {
        const result = await runAgentTurn(
          newCoreMessages,
          skillContext,
          tradingContext,
          walletContext,
          rewardsContext,
          onboardingContext,
          apiContext,
          { ...profile, autopilotMode },
          {
            onTextChunk: (chunk) => {
              setStreamingText((prev) => (prev ?? "") + chunk);
            },
            onToolCallStart: (name) => {
              setToolName(name);
            },
            onToolCallEnd: () => {
              setToolName(undefined);
            },
          },
          memoryContent,
          pluginMap,
        );

        // If compaction occurred, use the compacted messages as the new base
        const baseCoreMessages = result.compactedMessages ?? newCoreMessages;
        const updatedCore = [...baseCoreMessages, ...result.responseMessages];

        let updatedChat: ChatMessage[];
        if (result.compactedMessages) {
          const marker: ChatMessage = { role: "assistant", content: "— earlier messages compacted —" };
          const recentChat = chatMessages.slice(-12);
          updatedChat = [
            marker,
            ...recentChat,
            { role: displayRole, content: userText },
            { role: "assistant" as const, content: result.text },
          ];
        } else {
          updatedChat = [
            ...chatMessages,
            { role: displayRole, content: userText },
            { role: "assistant" as const, content: result.text },
          ];
        }

        setChatMessages(updatedChat);
        setCoreMessages(updatedCore);
        setStreamingText(undefined);

        // Persist session to disk
        saveSession({
          agentName,
          provider: providerRef.current,
          sessionId,
          coreMessages: updatedCore,
          chatMessages: updatedChat,
        });

        // Auto-exit if a restart was requested (agent switch/create)
        if (isRestartRequested()) {
          setTimeout(() => exit(), 1500);
        }
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        const stack = error instanceof Error ? error.stack : undefined;
        process.stderr.write(`[astra] Error: ${message}\n`);
        const debugInfo = debug && stack ? `\n\n\`\`\`\n${stack}\n\`\`\`` : "";
        setChatMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${message}${debugInfo}` },
        ]);
        setCoreMessages(newCoreMessages);
        setStreamingText(undefined);
      } finally {
        setIsLoading(false);
        setToolName(undefined);
      }
    },
    [coreMessages, chatMessages, skillContext, tradingContext, walletContext, rewardsContext, onboardingContext, apiContext, profile, autopilotMode, agentName, sessionId, memoryContent, addLogEntry, pluginMap, hasAutopilot, hasJourneyStages, exit, debug, runAutopilotTurn, awaitingApiKey],
  );
  // Keep ref in sync so the autopilot timer always has the latest sendMessage
  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

  const handleSubmit = useCallback(
    (userText: string) => {
      void sendMessage(userText);
    },
    [sendMessage],
  );

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        <ChatView messages={chatMessages} streamingText={streamingText} />
        {validatingKey && <Spinner label="Validating API key..." />}
        {isLoading && toolName && <Spinner label={`Calling ${toolName}...`} />}
        {isLoading && !toolName && <Spinner label={streamingText ? "Thinking..." : undefined} />}
      </Box>

      <Box flexShrink={0} width="100%">
        <Input isActive={!isLoading && !validatingKey} onSubmit={handleSubmit} />
      </Box>

      <Box flexShrink={0} width="100%">
        <StatusBar
          agentName={agentName}
          pluginName={manifest.name}
          isAstraNova={hasJourneyStages}
          journeyStage={profile.journeyStage ?? "full"}
          autopilotMode={autopilotMode}
          autopilotIntervalMs={autopilotIntervalMs}
          onEpochChange={handleEpochChange}
          pluginMap={pluginMap}
        />
      </Box>

      <Box flexShrink={0} width="100%" paddingX={2} marginTop={1} marginBottom={1} justifyContent="space-between">
        {hasJourneyStages ? (
          <>
            <Text dimColor>/help · /portfolio · /market · /model · /exit</Text>
            <Text dimColor>/auto on·off·set · Ctrl+C quit</Text>
          </>
        ) : (
          <>
            <Text dimColor>
              {(pluginMap?.commands?.map((c) => c.command).join(" · ") ?? "/help") + " · /exit"}
            </Text>
            <Text dimColor>{manifest.name}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Map provider ID → friendly display name */
function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    claude: "Claude", openai: "OpenAI GPT", google: "Gemini",
    "openai-oauth": "Codex", ollama: "Ollama",
  };
  return labels[provider] ?? provider;
}

/** Map provider ID → short alias for display/comparison */
function providerAlias(provider: string): string {
  const aliases: Record<string, string> = {
    claude: "claude", openai: "openai", google: "gemini", "openai-oauth": "codex",
  };
  return aliases[provider] ?? provider;
}
