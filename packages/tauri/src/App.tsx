import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Send, Loader2, AlertCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { ChatMessage } from "@/components/chat-message";
import { Onboarding } from "@/components/onboarding";
import { StatusBar } from "@/components/status-bar";
import { AgentSwitcher } from "@/components/agent-switcher";
import { useTheme } from "@/hooks/use-theme";
import { useSidecar } from "@/hooks/use-sidecar";
import MarkdownText from "@/components/markdown-text";
import { AgentAvatar } from "@/components/agent-avatar";
import { BrandLogo } from "@/components/brand-logo";

const HELP_TEXT = `**Available Commands**

**Quick Actions**
- \`/portfolio\` — Show your portfolio
- \`/market\` — Current market state
- \`/rewards\` — Check claimable $ASTRA
- \`/trades\` — Recent trade history
- \`/board\` — Browse the board
- \`/wallet\` — Wallet status
- \`/buy <amount>\` — Buy $NOVA
- \`/sell <amount>\` — Sell $NOVA

**Strategy & Autopilot**
- \`/strategy\` — Run strategy once (or create if none)
- \`/strategy setup\` — Create or edit your strategy
- \`/strategy status\` — View current strategy
- \`/auto on\` — Enable semi-auto mode
- \`/auto full\` — Start persistent daemon (runs when app is closed)
- \`/auto off\` — Disable autopilot
- \`/auto 5m\` — Set interval (1m–60m)
- \`/auto status\` — Show autopilot status
- \`/auto report\` — Show autopilot trade log

**System**
- \`/model [provider]\` — Switch LLM provider (claude, openai, gemini, codex)
- \`/help\` — Show this help
- \`/clear\` — Clear chat history`;

function parseIntervalStr(input: string): number | null {
  const match = input.match(/^(\d+)m$/);
  if (!match) return null;
  const minutes = parseInt(match[1], 10);
  if (minutes < 1 || minutes > 60) return null;
  return minutes * 60_000;
}

function formatIntervalMs(ms: number): string {
  return `${Math.round(ms / 60_000)}m`;
}

function App() {
  const [input, setInput] = useState("");
  const { theme, mode, setTheme, toggleMode } = useTheme();
  const {
    status,
    plugin,
    agentName,
    messages,
    streamingText,
    activeToolName,
    error,
    sendMessage,
    addLocalMessage,
    addUserMessage,
    clearMessages,
    onboardingPhase,
    onboardingData,
    marketData,
    portfolioData,
    agentsList,
    requestAgentsList,
    switchAgent,
    autopilotState,
    autopilotReport,
    setAutopilot,
    requestAutopilotStatus,
    requestAutopilotReport,
    modelSwitchPhase,
    modelSwitchData,
    switchModel,
    validateModelKey,
    submitModelOAuthPaste,
    cancelModelSwitch,
    runStrategy,
    setupStrategy,
    daemonRunning,
    startDaemon,
    stopDaemon,
  } = useSidecar();

  // Error dismissal
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const visibleError = error && error !== dismissedError ? error : null;

  // Display autopilot status/report when they arrive (skip initial null)
  const prevAutoState = useRef(autopilotState);
  useEffect(() => {
    if (autopilotState && autopilotState !== prevAutoState.current) {
      const { mode, intervalMs, budgetUsed, budgetMax } = autopilotState;
      addLocalMessage(`**Autopilot Status**\n\nMode: ${mode.toUpperCase()}\nInterval: ${formatIntervalMs(intervalMs)}\nEpoch Budget: ${budgetUsed}/${budgetMax} calls used`, "info");
    }
    prevAutoState.current = autopilotState;
  }, [autopilotState, addLocalMessage]);

  const prevAutoReport = useRef(autopilotReport);
  useEffect(() => {
    if (autopilotReport.length > 0 && autopilotReport !== prevAutoReport.current) {
      const lines = autopilotReport.map((e) => `\`${e.ts.slice(11, 16)}\` ${e.action}`);
      addLocalMessage(lines.length > 0
        ? `**Autopilot log** (last ${lines.length} entries):\n\n${lines.join("\n")}`
        : "No autopilot trades logged yet.",
        "info",
      );
    }
    prevAutoReport.current = autopilotReport;
  }, [autopilotReport, addLocalMessage]);

  // Listen for tray menu events
  useEffect(() => {
    const unlistenToggle = listen<void>("tray:toggle-daemon", () => {
      if (daemonRunning) {
        void stopDaemon();
      } else {
        void startDaemon();
      }
    });
    return () => { unlistenToggle.then((u) => u()); };
  }, [daemonRunning, startDaemon, stopDaemon]);

  // Update tray menu when daemon state changes
  useEffect(() => {
    invoke("update_tray", { daemonRunning }).catch(() => {
      // Tray may not be available — silent no-op
    });
  }, [daemonRunning]);

  // Auto-scroll to bottom on new messages / streaming
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  // Auto-focus textarea
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (status === "ready") {
      textareaRef.current?.focus();
    }
  }, [status]);

  // Auto-resize textarea
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Clamp to ~4 lines (each line ~24px, max 96px)
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [input, adjustHeight]);

  const handleSlashCommand = (text: string) => {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(" ");

    // System commands
    switch (cmd) {
      case "/help":
      case "/?":
        addLocalMessage(HELP_TEXT, "info");
        return;
      case "/clear":
        clearMessages();
        return;
    }

    // AstraNova shortcuts — map to LLM prompt
    const SHORTCUTS: Record<string, string | ((a: string) => string)> = {
      "/portfolio": "Show my portfolio using the card format.",
      "/market": "Show the current market state — price, mood, and recent trend.",
      "/rewards": "Check my rewards status and show if anything is claimable.",
      "/trades": "Show my recent trade history.",
      "/board": "Show recent posts from the board.",
      "/wallet": "Check my wallet status — do I have one set up?",
      "/buy": (a) => a ? `Buy ${a} $NOVA.` : "How much $NOVA should I buy?",
      "/sell": (a) => a ? `Sell ${a} $NOVA.` : "How much $NOVA should I sell?",
    };

    const shortcut = SHORTCUTS[cmd];
    if (shortcut) {
      const prompt = typeof shortcut === "function" ? shortcut(args) : shortcut;
      void sendMessage(prompt);
      return;
    }

    // Strategy commands — sidecar loads strategy from disk and injects into prompt
    if (cmd === "/strategy") {
      const sub = parts[1]?.toLowerCase();
      if (sub === "status") {
        void sendMessage("Show my current trading strategy.");
      } else if (sub === "setup") {
        void setupStrategy();
      } else if (!sub) {
        void runStrategy();
      } else {
        addLocalMessage("Usage: `/strategy` · `/strategy setup` · `/strategy status`", "error");
      }
      return;
    }

    // Autopilot commands
    if (cmd === "/auto") {
      const sub = parts[1]?.toLowerCase();

      if (!sub || sub === "status") {
        void requestAutopilotStatus();
        return;
      }
      if (sub === "on" || sub === "semi") {
        void setAutopilot("semi");
        return;
      }
      if (sub === "full") {
        void startDaemon();
        return;
      }
      if (sub === "off") {
        void setAutopilot("off");
        if (daemonRunning) void stopDaemon();
        return;
      }
      if (sub === "report") {
        void requestAutopilotReport();
        return;
      }
      // Try parsing interval (e.g. "5m", "10m")
      const parsed = parseIntervalStr(sub);
      if (parsed !== null) {
        void setAutopilot("semi", parsed);
        return;
      }
      addLocalMessage("Usage: `/auto on` · `/auto full` · `/auto off` · `/auto 5m` · `/auto status` · `/auto report`", "error");
      return;
    }

    // Model switch
    if (cmd === "/model") {
      void switchModel(args);
      return;
    }

    addLocalMessage(`Unknown command: \`${cmd}\`. Type \`/help\` for available commands.`, "error");
  };

  const handleSend = async () => {
    if (!input.trim() || status !== "ready") return;
    const text = input.trim();
    setInput("");

    // Intercept input during model switch
    if (modelSwitchPhase === "need-key") {
      if (text.toLowerCase() === "cancel") {
        cancelModelSwitch();
        return;
      }
      addUserMessage(text);
      void validateModelKey(modelSwitchData.provider!, text);
      return;
    }
    if (modelSwitchPhase === "oauth-paste") {
      if (text.toLowerCase() === "cancel") {
        cancelModelSwitch();
        return;
      }
      addUserMessage(text);
      void submitModelOAuthPaste(text);
      return;
    }

    if (text.startsWith("/")) {
      handleSlashCommand(text);
      return;
    }

    await sendMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const showWelcome = status === "ready" && messages.length === 0;
  const showThinking =
    status === "streaming" && !streamingText && !activeToolName;

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <BrandLogo size={40} />
          <h1 className="text-lg font-semibold tracking-tight">Astra</h1>
          <AgentSwitcher
            currentAgent={agentName}
            agents={agentsList}
            onRequestList={requestAgentsList}
            onSwitch={switchAgent}
            disabled={status === "streaming" || status === "connecting" || status === "onboarding"}
          />
        </div>
        <ThemeSwitcher
          theme={theme}
          mode={mode}
          onThemeChange={setTheme}
          onToggleMode={toggleMode}
        />
      </div>

      {/* Onboarding view */}
      {status === "onboarding" && onboardingPhase && (
        <ScrollArea className="flex-1">
          <Onboarding phase={onboardingPhase} data={onboardingData} />
        </ScrollArea>
      )}

      {/* Messages area */}
      {status !== "onboarding" && <ScrollArea className="flex-1">
        <div className="flex flex-col p-4 pb-8">
          {/* Connecting state */}
          {status === "connecting" && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Connecting to agent...</span>
            </div>
          )}

          {/* Error state (no messages yet) */}
          {status === "error" && !messages.length && (
            <ErrorCard
              message={
                error ??
                "Failed to connect. Run the CLI first to set up your account."
              }
            />
          )}

          {/* Exited state */}
          {status === "exited" && (
            <div className="text-sm p-3 border border-border rounded-md text-muted-foreground">
              Sidecar exited. Please restart the app.
            </div>
          )}

          {/* Welcome / empty state */}
          {showWelcome && (
            <div className="flex-1 flex flex-col items-center justify-center py-24 text-center">
              <AgentAvatar size={48} className="mb-3" />
              <h2 className="text-xl font-semibold tracking-tight mb-1">
                Astra
              </h2>
              <p className="text-sm text-muted-foreground">
                Your AI trading companion
              </p>
            </div>
          )}

          {/* Messages */}
          {messages.map((msg, i) => {
            const prev = i > 0 ? messages[i - 1] : null;
            const isFollowUp = prev?.role === msg.role && !msg.systemIcon && !prev?.systemIcon;
            return (
              <ChatMessage
                key={i}
                role={msg.role}
                content={msg.content}
                isFollowUp={isFollowUp}
                systemIcon={msg.systemIcon}
              />
            );
          })}

          {/* Tool call indicator */}
          {activeToolName && (
            <div className="flex gap-3 mt-4">
              <div className="w-8 shrink-0" />
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>Running {activeToolName}...</span>
              </div>
            </div>
          )}

          {/* Thinking indicator */}
          {showThinking && (
            <div className="flex gap-3 mt-4">
              <div className="w-8 shrink-0 pt-0.5">
                <AgentAvatar size={32} />
              </div>
              <div className="flex items-center gap-1 pt-2">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          )}

          {/* Streaming text */}
          {streamingText && (
            <div className="flex gap-3 mt-4">
              <div className="w-8 shrink-0 pt-0.5">
                <AgentAvatar size={32} />
              </div>
              <div className="min-w-0 max-w-[90%] text-sm">
                <MarkdownText>{streamingText}</MarkdownText>
                <span className="inline-block w-0.5 h-4 bg-foreground/70 animate-pulse ml-0.5 align-text-bottom" />
              </div>
            </div>
          )}

          {/* Inline error */}
          {visibleError && messages.length > 0 && (
            <div className="mt-4">
              <ErrorCard
                message={visibleError}
                onDismiss={() => setDismissedError(visibleError)}
              />
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>}

      {/* Status bar — hidden during onboarding */}
      {status !== "onboarding" && (
        <StatusBar
          market={marketData}
          portfolio={portfolioData}
          activeToolName={activeToolName}
          status={status}
          pluginName={plugin}
          agentName={agentName}
        />
      )}

      {/* Input bar — hidden during onboarding */}
      {status !== "onboarding" && (
        <div className="flex items-end gap-2 p-4 border-t border-border">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              modelSwitchPhase === "need-key"
                ? modelSwitchData.placeholder || "Paste your API key..."
                : modelSwitchPhase === "oauth-paste"
                  ? "Paste callback URL..."
                  : status === "ready"
                    ? "Type a message or /help"
                    : "Waiting..."
            }
            disabled={status !== "ready"}
            rows={1}
            className="flex-1 resize-none bg-muted border-none rounded-lg px-4 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            style={{ maxHeight: "96px" }}
          />
          <Button
            variant="ghost"
            size="icon"
            disabled={status !== "ready" || !input.trim()}
            onClick={handleSend}
            className="shrink-0 mb-0.5"
          >
            {status === "streaming" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Styled error card with optional dismiss */
function ErrorCard({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss?: () => void;
}) {
  return (
    <div className="flex items-start gap-2.5 bg-destructive/10 border border-destructive/30 rounded-md p-3 text-sm">
      <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
      <span className="flex-1 text-destructive">{message}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="text-destructive/60 hover:text-destructive shrink-0"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export default App;
