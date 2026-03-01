import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { CoreMessage } from "ai";
import StatusBar from "./StatusBar.js";
import ChatView, { type ChatMessage } from "./ChatView.js";
import Input from "./Input.js";
import Spinner from "./Spinner.js";
import { runAgentTurn } from "../agent/loop.js";
import { isRestartRequested, loadConfig, saveAutopilotConfig, loadEpochBudget, saveEpochBudget } from "../config/store.js";
import { saveSession } from "../config/sessions.js";
import type { AgentProfile } from "../agent/system-prompt.js";
import type { AutopilotConfig } from "../autopilot/scheduler.js";
import {
  buildAutopilotTrigger,
  formatInterval,
  parseInterval,
  EPOCH_BUDGET,
  BUDGET_BUFFER,
} from "../autopilot/scheduler.js";


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
  debug,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();

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

  // ── runAutopilotTurn (full mode — separate from chat) ─────────────
  const runAutopilotTurn = useCallback(
    async (triggerMsg: string) => {
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
            onTextChunk: () => {},
            onToolCallStart: () => {},
            onToolCallEnd: () => {},
          },
          memoryContent,
        );

        const baseCoreMessages = result.compactedMessages ?? newCoreMessages;
        const updatedCore = [...baseCoreMessages, ...result.responseMessages];
        setCoreMessages(updatedCore);

        // Parse the response — add to log
        const responseText = result.text.trim();
        if (responseText) {
          const firstLine = responseText.split("\n")[0].slice(0, 80);
          const detail = responseText.length > 80 ? responseText.slice(0, 120) : undefined;
          addLogEntry(firstLine, detail !== firstLine ? detail : undefined);
        } else {
          addLogEntry("checked → no response");
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
        addLogEntry("error", message);
      } finally {
        setIsLoading(false);
      }
    },
    [skillContext, tradingContext, walletContext, rewardsContext, onboardingContext, apiContext, profile, autopilotMode, agentName, sessionId, memoryContent, addLogEntry],
  );

  // ── Autopilot timer ────────────────────────────────────────────────
  useEffect(() => {
    if (autopilotMode === "off") return;

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

      const trigger = buildAutopilotTrigger(autopilotMode);
      if (!trigger) return;

      if (autopilotMode === "semi") {
        // Semi: inject into chat with autopilot display role
        void sendMessageRef.current(trigger, "autopilot");
      } else {
        // Full: separate turn, results go to log only
        void runAutopilotTurn(trigger);
      }
    }, autopilotIntervalMs);

    return () => clearInterval(interval);
  }, [autopilotMode, autopilotIntervalMs, addLogEntry, runAutopilotTurn]);

  // ── sendMessage ────────────────────────────────────────────────────
  const sendMessage = useCallback(
    async (userText: string, displayRole: "user" | "autopilot" = "user") => {
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

        // ── /auto slash commands ────
        if (cmd === "/auto") {
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
            setAutopilotMode("semi");
            saveAutopilotConfig({ mode: "semi", intervalMs: autopilotIntervalMs });
            setChatMessages((prev) => [
              ...prev,
              { role: "user", content: userText },
              { role: "assistant", content: `Autopilot enabled: **SEMI** mode (every ${formatInterval(autopilotIntervalMs)}). I'll propose trades for your approval.` },
            ]);
            addLogEntry("Mode set to SEMI");
            return;
          }

          if (sub === "full") {
            setAutopilotMode("full");
            saveAutopilotConfig({ mode: "full", intervalMs: autopilotIntervalMs });
            setChatMessages((prev) => [
              ...prev,
              { role: "user", content: userText },
              { role: "assistant", content: `Autopilot enabled: **FULL** mode (every ${formatInterval(autopilotIntervalMs)}). I'll execute trades autonomously — check the log panel.` },
            ]);
            addLogEntry("Mode set to FULL");
            return;
          }

          if (sub === "off") {
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

        if (cmd === "/help" || cmd === "/?") {
          setChatMessages((prev) => [
            ...prev,
            { role: "user", content: userText },
            {
              role: "assistant",
              content: [
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
                "**Autopilot**",
                "",
                "  `/auto on`     — Enable semi-auto mode",
                "  `/auto full`   — Enable full-auto mode",
                "  `/auto off`    — Disable autopilot",
                "  `/auto 5m`     — Set interval (1m-60m)",
                "  `/auto status` — Show autopilot status",
                "",
                "**System**",
                "",
                "  `/help`      — Show this help",
                "  `/exit`      — Exit (also `/quit`, `/q`)",
                "  `/clear`     — Clear chat display",
                "  `Ctrl+C`     — Exit immediately",
              ].join("\n"),
            },
          ]);
          return;
        }

        // ── Shortcut commands (sent to LLM as natural language) ────
        const shortcuts: Record<string, string> = {
          "/portfolio": "Show my portfolio using the card format.",
          "/market": "Show the current market state — price, mood, and recent trend.",
          "/rewards": "Check my rewards status and show if anything is claimable.",
          "/trades": "Show my recent trade history.",
          "/board": "Show recent posts from the board.",
          "/wallet": "Check my wallet status — do I have one set up?",
          "/buy": `Buy ${parts.slice(1).join(" ") || "some"} $NOVA.`,
          "/sell": `Sell ${parts.slice(1).join(" ") || "some"} $NOVA.`,
        };

        if (shortcuts[cmd]) {
          userText = shortcuts[cmd];
        } else {
          // Unknown slash command — show hint
          setChatMessages((prev) => [
            ...prev,
            { role: "user", content: userText },
            { role: "assistant", content: `Unknown command: ${cmd}. Type /help for available commands.` },
          ]);
          return;
        }
      }

      setChatMessages((prev) => [
        ...prev,
        { role: displayRole, content: userText },
      ]);

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
          journeyStage={profile.journeyStage ?? "full"}
          autopilotMode={autopilotMode}
          autopilotIntervalMs={autopilotIntervalMs}
          onEpochChange={handleEpochChange}
        />
      </Box>

      <Box flexShrink={0} width="100%" paddingX={2} marginTop={1} justifyContent="space-between">
        <Text dimColor>/help · /portfolio · /market · /exit</Text>
        <Text dimColor>/auto on·off·set · Ctrl+C quit</Text>
      </Box>
    </Box>
  );
}

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
