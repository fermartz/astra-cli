import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "./Spinner.js";
import Input from "./Input.js";

interface PluginDetails {
  name: string;
  version: string;
  description: string;
  apiHost: string;
  isCertified: boolean;
}

interface PluginInstallerProps {
  manifestUrl: string;
  /** Called to run the install pipeline. Returns plugin details on success, throws on failure. */
  onInstall: (url: string) => Promise<{
    details: PluginDetails;
    /** Call this to save the plugin to disk after confirmation. */
    confirm: () => void;
  }>;
}

type Phase = "fetching" | "confirm" | "saving" | "done" | "error";

export default function PluginInstaller({
  manifestUrl,
  onInstall,
}: PluginInstallerProps): React.JSX.Element {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>("fetching");
  const [details, setDetails] = useState<PluginDetails | null>(null);
  const [confirmFn, setConfirmFn] = useState<(() => void) | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [messages, setMessages] = useState<string[]>([]);

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
  });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const result = await onInstall(manifestUrl);
        if (cancelled) return;
        setDetails(result.details);
        setConfirmFn(() => result.confirm);
        setMessages((prev) => [
          ...prev,
          `Plugin:      ${result.details.name} v${result.details.version}`,
          `Description: ${result.details.description}`,
          `API:         ${result.details.apiHost}`,
          result.details.isCertified
            ? "Certified ✓  Official @astra-cli registry"
            : `Uncertified  Source: ${new URL(manifestUrl).hostname}`,
        ]);
        setPhase("confirm");
      } catch (err) {
        if (cancelled) return;
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConfirmInput = (input: string) => {
    const lower = input.trim().toLowerCase();
    if (lower === "y" || lower === "yes") {
      setPhase("saving");
      try {
        confirmFn?.();
        setMessages((prev) => [...prev, `Plugin "${details!.name}" installed successfully.`]);
        setPhase("done");
        setTimeout(() => exit(), 500);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setPhase("error");
        setTimeout(() => exit(), 1500);
      }
    } else if (lower === "n" || lower === "no") {
      setMessages((prev) => [...prev, "Installation cancelled."]);
      setPhase("done");
      setTimeout(() => exit(), 500);
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="#00ffff"> astra add </Text>
      <Text> </Text>

      {messages.map((msg, i) => (
        <Text key={i}>{msg}</Text>
      ))}

      {phase === "fetching" && <Spinner label={`Fetching ${new URL(manifestUrl).hostname}...`} />}

      {phase === "confirm" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            {details?.isCertified
              ? `Install ${details.name}? (y/n):`
              : `Install uncertified plugin "${details?.name}"? API calls will go to ${details?.apiHost} (y/n):`}
          </Text>
          <Input isActive={true} onSubmit={handleConfirmInput} />
        </Box>
      )}

      {phase === "error" && (
        <Text color="red">{errorMessage}</Text>
      )}
    </Box>
  );
}
