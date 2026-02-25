import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface InputProps {
  /** Whether the input should accept keystrokes. */
  isActive: boolean;
  /** Called when the user presses Enter. */
  onSubmit: (value: string) => void;
}

export default function Input({
  isActive,
  onSubmit,
}: InputProps): React.JSX.Element {
  const [value, setValue] = useState("");

  const handleSubmit = (submitted: string) => {
    const trimmed = submitted.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue("");
  };

  return (
    <Box width="100%" borderStyle="round" borderColor={isActive ? "yellow" : "gray"}>
      <Box paddingX={1} width="100%">
        <Text color={isActive ? "yellow" : "gray"} bold>
          {"› "}
        </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          focus={isActive}
          showCursor={isActive}
          placeholder={isActive ? "Type a message..." : "Waiting for response..."}
        />
      </Box>
    </Box>
  );
}
