import React from "react";
import { Box, Text } from "ink";
import type { AutopilotLogEntry } from "../autopilot/scheduler.js";

interface AutopilotLogProps {
  entries: AutopilotLogEntry[];
  width: number;
}

export default function AutopilotLog({
  entries,
  width,
}: AutopilotLogProps): React.JSX.Element {
  // Show the most recent entries that fit (newest at bottom)
  const maxVisible = 20;
  const visible = entries.slice(-maxVisible);

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      <Text bold color="cyan">AUTOPILOT LOG</Text>
      <Text dimColor>{"─".repeat(Math.max(0, width - 4))}</Text>

      {visible.length === 0 && (
        <Text dimColor>No activity yet</Text>
      )}

      {visible.map((entry, i) => {
        const time = formatTime(entry.ts);
        return (
          <Box key={i} flexDirection="column">
            <Box>
              <Text dimColor>{time} </Text>
              <Text wrap="truncate-end">{entry.action}</Text>
            </Box>
            {entry.detail && (
              <Box marginLeft={6}>
                <Text dimColor wrap="truncate-end">{entry.detail}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}
