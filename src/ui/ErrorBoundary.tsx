import React from "react";
import { Text, Box } from "ink";

interface Props {
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Reusable error boundary for Ink components.
 *
 * Catches render errors in children and displays a fallback message
 * instead of crashing the entire app. Logs the error to stderr.
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    process.stderr.write(`[astra] Render error: ${error.message}\n`);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return this.props.fallback ?? (
        <Box>
          <Text color="red" dimColor>[render error: {this.state.error.message}]</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
