import React, { useState, useEffect } from "react";
import { Text } from "ink";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

interface SpinnerProps {
  label?: string;
}

export default function Spinner({ label }: SpinnerProps): React.JSX.Element {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % FRAMES.length);
    }, INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text dimColor>
      {FRAMES[frame]} {label ?? "Thinking..."}
    </Text>
  );
}
