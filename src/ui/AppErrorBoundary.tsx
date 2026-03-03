import React from "react";
import { Text, Box } from "ink";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary for the Ink TUI.
 *
 * Catches any render error that escapes per-component boundaries.
 * Displays a recovery message instead of crashing to terminal.
 */
export default class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    process.stderr.write(`[astra] Fatal render error: ${error.stack ?? error.message}\n`);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Text bold color="red">Something went wrong</Text>
          <Text> </Text>
          <Text dimColor>{this.state.error.message}</Text>
          <Text> </Text>
          <Text>Press Ctrl+C to exit. Your session has been saved.</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
