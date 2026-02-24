import React, { useState, useCallback, useRef } from "react";
import { Box, useApp, useInput } from "ink";
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

        const updatedChat = [
          ...chatMessages,
          { role: "user" as const, content: userText },
          { role: "assistant" as const, content: result.text },
        ];
        const updatedCore = [...newCoreMessages, ...result.responseMessages];

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
      <Box flexShrink={0} width="100%">
        <StatusBar agentName={agentName} journeyStage={profile.journeyStage ?? "full"} />
      </Box>

      <ChatView messages={chatMessages} streamingText={streamingText} />

      {isLoading && toolName && <Spinner label={`Calling ${toolName}...`} />}
      {isLoading && !toolName && streamingText === "" && <Spinner />}

      <Box flexShrink={0} width="100%">
        <Input isActive={!isLoading} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
}
