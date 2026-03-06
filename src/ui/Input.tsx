import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

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

  useInput((input, key) => {
    if (!isActive) return;

    if (key.return) {
      const trimmed = value.trim();
      if (!trimmed) return;
      onSubmit(trimmed);
      setValue("");
      return;
    }

    if (key.backspace || key.delete) {
      setValue(prev => prev.slice(0, -1));
      return;
    }

    // Ignore control/meta keys
    if (key.ctrl || key.meta || key.escape ||
        key.upArrow || key.downArrow || key.leftArrow || key.rightArrow ||
        key.tab || key.pageUp || key.pageDown || key.home || key.end) {
      return;
    }

    if (input) {
      setValue(prev => prev + input);
    }
  }, { isActive });

  return (
    <Box width="100%" paddingX={2} paddingY={1}>
      <Text color={isActive ? "yellow" : "gray"} bold>{"❯❯  "}</Text>
      <Text>{value}</Text>
      {isActive && <Text color="green">█</Text>}
    </Box>
  );
}
