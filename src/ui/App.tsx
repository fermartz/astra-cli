import React, { useState, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { CoreMessage } from "ai";
import StatusBar from "./StatusBar.js";
import ChatView, { type ChatMessage } from "./ChatView.js";
import Input from "./Input.js";
import Spinner from "./Spinner.js";
import { runAgentTurn } from "../agent/loop.js";
import { isRestartRequested, loadConfig } from "../config/store.js";
import { saveSession } from "../config/sessions.js";
import type { AgentProfile } from "../agent/system-prompt.js";

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
}: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(
    (initialChatMessages as ChatMessage[]) ?? [],
  );
  const [coreMessages, setCoreMessages] = useState<CoreMessage[]>(
    initialCoreMessages ?? [],
  );
  const providerRef = useRef(loadConfig()?.provider ?? "unknown");
  const [streamingText, setStreamingText] = useState<string | undefined>(
    undefined,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [toolName, setToolName] = useState<string | undefined>(undefined);

  // Ctrl+C to exit
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
  });



  const sendMessage = useCallback(
    async (userText: string) => {
      // ── Slash commands (handled locally, never sent to LLM) ────
      if (userText.startsWith("/")) {
        const cmd = userText.split(" ")[0].toLowerCase();

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
                "**Ask me about**",
                "",
                "  \"how do epochs and seasons work?\"",
                "  \"what are the trading rules?\"",
                "  \"how do I earn $ASTRA?\"",
                "  \"show the season leaderboard\"",
                "  \"what is $ASTRA token supply?\"",
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
          "/buy": `Buy ${userText.split(" ").slice(1).join(" ") || "some"} $NOVA.`,
          "/sell": `Sell ${userText.split(" ").slice(1).join(" ") || "some"} $NOVA.`,
        };

        if (shortcuts[cmd]) {
          // Fall through to normal sendMessage flow with the mapped text
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
        { role: "user", content: userText },
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
          profile,
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
          // Trim display messages — show a marker + recent messages
          const marker: ChatMessage = { role: "assistant", content: "— earlier messages compacted —" };
          const recentChat = chatMessages.slice(-12);
          updatedChat = [
            marker,
            ...recentChat,
            { role: "user" as const, content: userText },
            { role: "assistant" as const, content: result.text },
          ];
        } else {
          updatedChat = [
            ...chatMessages,
            { role: "user" as const, content: userText },
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
          setTimeout(() => exit(), 1500); // Brief delay so user sees the message
        }
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        // Log to stderr for debugging (visible after Ink exits)
        process.stderr.write(`[astra] Error: ${message}\n`);
        setChatMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${message}` },
        ]);
        setCoreMessages(newCoreMessages);
        setStreamingText(undefined);
      } finally {
        setIsLoading(false);
        setToolName(undefined);
      }
    },
    [coreMessages, chatMessages, skillContext, tradingContext, walletContext, rewardsContext, onboardingContext, apiContext, profile, agentName, sessionId],
  );

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
        <StatusBar agentName={agentName} journeyStage={profile.journeyStage ?? "full"} />
      </Box>

      <Box flexShrink={0} width="100%" paddingX={2} justifyContent="space-between">
        <Text dimColor>/help · /portfolio · /market · /exit</Text>
        <Text dimColor>Ctrl+C quit</Text>
      </Box>
    </Box>
  );
}
