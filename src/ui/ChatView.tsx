import React from "react";
import { Box, Text } from "ink";
import MarkdownText from "./MarkdownText.js";

export interface ChatMessage {
  role: "user" | "assistant";
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
      {messages.map((msg, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          <Text bold color={msg.role === "user" ? "green" : "cyan"}>
            {msg.role === "user" ? " You" : " Agent"}
          </Text>
          <Box marginLeft={1}>
            {msg.role === "assistant" ? (
              <MarkdownText>{msg.content}</MarkdownText>
            ) : (
              <Text wrap="wrap">{msg.content}</Text>
            )}
          </Box>
        </Box>
      ))}

      {streamingText !== undefined && streamingText.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="cyan">
            {" Agent"}
          </Text>
          <Box marginLeft={1}>
            <MarkdownText>{streamingText}</MarkdownText>
          </Box>
        </Box>
      )}
    </Box>
  );
}
