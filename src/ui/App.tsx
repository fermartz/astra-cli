import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { CoreMessage } from "ai";
import StatusBar from "./StatusBar.js";
import ChatView, { type ChatMessage } from "./ChatView.js";
import Input from "./Input.js";
import Spinner from "./Spinner.js";
import { runAgentTurn } from "../agent/loop.js";
import { isRestartRequested, loadConfig, saveAutopilotConfig, loadEpochBudget, saveEpochBudget, appendAutopilotLog, loadAutopilotLogSince, requestPluginsPicker } from "../config/store.js";
import { saveSession } from "../config/sessions.js";
import type { AgentProfile } from "../agent/system-prompt.js";
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
    [skillContext, tradingContext, walletContext, rewardsContext, onboardingContext, apiContext, profile, autopilotMode, agentName, sessionId, memoryContent, addLogEntry],
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
    [coreMessages, chatMessages, skillContext, tradingContext, walletContext, rewardsContext, onboardingContext, apiContext, profile, autopilotMode, agentName, sessionId, memoryContent, addLogEntry],
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
      </Box>

      {isLoading && toolName && <Spinner label={`Calling ${toolName}...`} />}
      {isLoading && !toolName && <Spinner label={streamingText ? "Thinking..." : undefined} />}

      <Box flexShrink={0} width="100%">
        <Input isActive={!isLoading} onSubmit={handleSubmit} />
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
        />
      </Box>

      <Box flexShrink={0} width="100%" paddingX={2} marginTop={1} justifyContent="space-between">
        {hasJourneyStages ? (
          <>
            <Text dimColor>/help · /portfolio · /market · /strategy · /exit</Text>
            <Text dimColor>/auto on·off·set · Ctrl+C quit</Text>
          </>
        ) : (
          <>
            <Text dimColor>/help · /exit · Ctrl+C quit</Text>
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
