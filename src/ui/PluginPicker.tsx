import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Input from "./Input.js";

export interface PluginChoice {
  name: string;
  tagline: string;
  status: "active" | "installed" | "not_installed";
  skillUrl?: string;
}

interface PluginPickerProps {
  choices: PluginChoice[];
  onSelect: (choice: PluginChoice) => void;
  onCancel: () => void;
}

export default function PluginPicker({
  choices,
  onSelect,
  onCancel,
}: PluginPickerProps): React.JSX.Element {
  const { exit } = useApp();
  const [message, setMessage] = useState<string | null>(null);

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
  });

  const handleSubmit = (input: string) => {
    const num = parseInt(input.trim(), 10);
    if (isNaN(num) || num < 1 || num > choices.length) {
      setMessage(`Please enter a number between 1 and ${choices.length}.`);
      return;
    }
    const choice = choices[num - 1];
    onSelect(choice);
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="#00ffff"> astra plugins </Text>
      <Text> </Text>

      <Text>Select a plugin:</Text>
      <Text> </Text>

      {choices.map((c, i) => {
        const statusLabel =
          c.status === "active"
            ? "(active)"
            : c.status === "installed"
              ? "(installed)"
              : "(not installed)";
        return (
          <Text key={c.name}>
            {"  "}
            {i + 1}. {c.name.padEnd(14)} {statusLabel.padEnd(16)} {c.tagline}
          </Text>
        );
      })}

      <Text> </Text>
      {message && <Text color="yellow">{message}</Text>}

      <Text>Type a number (1-{choices.length}), or Ctrl+C to cancel:</Text>
      <Input isActive={true} onSubmit={handleSubmit} />
    </Box>
  );
}
