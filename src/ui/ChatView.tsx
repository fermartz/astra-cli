import React from "react";
import { Box, Text } from "ink";
import MarkdownText from "./MarkdownText.js";
import ErrorBoundary from "./ErrorBoundary.js";

export interface ChatMessage {
  role: "user" | "assistant" | "log" | "autopilot";
  content: string;
}

interface ChatViewProps {
  messages: ChatMessage[];
  streamingText?: string;
}

export default function ChatView({
  messages,
  streamingText,
}: ChatViewProps): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" paddingX={1}>
      {messages.map((msg, i) => {
        if (msg.role === "log") {
          return (
            <Box key={i} paddingLeft={2} marginBottom={1}>
              <Text dimColor>{msg.content}</Text>
            </Box>
          );
        }
        if (msg.role === "autopilot") {
          return (
            <Box key={i} flexDirection="column" marginBottom={1}>
              <Text bold color="#ff00ff"> Autopilot</Text>
              <Box marginLeft={1}>
                <Text dimColor wrap="wrap">{msg.content}</Text>
              </Box>
            </Box>
          );
        }
        return (
          <Box key={i} flexDirection="column" marginBottom={1}>
            <Text bold color={msg.role === "user" ? "#00ff00" : "#00ffff"}>
              {msg.role === "user" ? " You" : " Agent"}
            </Text>
            <Box marginLeft={1}>
              {msg.role === "assistant" ? (
                <ErrorBoundary>
                  <MarkdownText>{msg.content}</MarkdownText>
                </ErrorBoundary>
              ) : (
                <Text wrap="wrap">{msg.content}</Text>
              )}
            </Box>
          </Box>
        );
      })}

      {streamingText !== undefined && streamingText.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="#00ffff">
            {" Agent"}
          </Text>
          <Box marginLeft={1}>
            <ErrorBoundary>
              <MarkdownText>{streamingText}</MarkdownText>
            </ErrorBoundary>
          </Box>
        </Box>
      )}
    </Box>
  );
}
