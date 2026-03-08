import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { SidecarResponse, SidecarRequest, MarketData, PortfolioData, AgentInfo } from "@/lib/protocol";
import type { OnboardingPhase, OnboardingData } from "@/components/onboarding";

/** Send a desktop notification (requests permission on first call, silent no-op if denied) */
async function sendDesktopNotification(title: string, body: string): Promise<void> {
  try {
    let permitted = await isPermissionGranted();
    if (!permitted) {
      const result = await requestPermission();
      permitted = result === "granted";
    }
    if (permitted) {
      sendNotification({ title, body });
    }
  } catch {
    // Notification API may not be available — silent no-op
  }
}

export type SidecarStatus =
  | "connecting"
  | "onboarding"
  | "ready"
  | "streaming"
  | "error"
  | "exited";

export type ModelSwitchPhase =
  | "idle"
  | "need-key"
  | "validating"
  | "oauth-waiting"
  | "oauth-paste";

export interface ModelSwitchData {
  provider?: string;
  label?: string;
  placeholder?: string;
  error?: string;
  oauthUrl?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** System message type for icon selection */
  systemIcon?: "info" | "error";
}

export function useSidecar() {
  const [status, setStatus] = useState<SidecarStatus>("connecting");
  const [plugin, setPlugin] = useState<string | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [journeyStage, setJourneyStage] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [activeToolName, setActiveToolName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Onboarding state
  const [onboardingPhase, setOnboardingPhase] = useState<OnboardingPhase | null>(null);
  const [onboardingData, setOnboardingData] = useState<OnboardingData>({});

  // Status bar data
  const [marketData, setMarketData] = useState<MarketData | null>(null);
  const [portfolioData, setPortfolioData] = useState<PortfolioData | null>(null);

  // Agent management
  const [agentsList, setAgentsList] = useState<AgentInfo[]>([]);

  // Model switch
  const [modelSwitchPhase, setModelSwitchPhase] = useState<ModelSwitchPhase>("idle");
  const [modelSwitchData, setModelSwitchData] = useState<ModelSwitchData>({});

  // Autopilot
  const [autopilotState, setAutopilotState] = useState<{ mode: string; intervalMs: number; budgetUsed: number; budgetMax: number } | null>(null);
  const [autopilotReport, setAutopilotReport] = useState<Array<{ ts: string; action: string }>>([]);

  // Daemon (full autopilot)
  const [daemonRunning, setDaemonRunning] = useState(false);

  // Fun fact ticker
  const [funFact, setFunFact] = useState<string | null>(null);
  const funFactTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref for streaming accumulation (avoids stale closure issues)
  const streamRef = useRef("");

  // Pending strategy read callback (resolved when sidecar responds)
  const strategyReadCb = useRef<((content: string | null) => void) | null>(null);

  // Handle a parsed sidecar message
  const handleMessage = useCallback((msg: SidecarResponse) => {
    switch (msg.type) {
      case "init:ok": {
        setPlugin(msg.plugin);
        setAgentName(msg.agentName);
        setProvider(msg.provider);
        setJourneyStage(msg.journeyStage);
        // Clear stale data from previous agent
        setMarketData(null);
        setPortfolioData(null);
        streamRef.current = "";
        setStreamingText("");
        setActiveToolName(null);
        setError(null);
        const history: ChatMessage[] = (msg.sessionMessages ?? []).map((m) => ({
          role: m.role,
          content: m.content,
        }));
        const welcome: ChatMessage[] = msg.welcomeMessages.map((m) => ({
          role: "assistant" as const,
          content: m.content,
        }));
        setMessages([...history, ...welcome]);
        setDaemonRunning(!!msg.daemonRunning);
        setOnboardingPhase(null);
        setStatus("ready");
        break;
      }

      case "init:error":
        setError(msg.message);
        setStatus("error");
        break;

      case "chunk":
        streamRef.current += msg.text;
        setStreamingText(streamRef.current);
        break;

      case "tool:start":
        setActiveToolName(msg.toolName);
        break;

      case "tool:end":
        setActiveToolName(null);
        break;

      case "turn:done": {
        const finalText = streamRef.current || msg.text;
        streamRef.current = "";
        setStreamingText("");
        setActiveToolName(null);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: finalText },
        ]);
        setStatus("ready");
        break;
      }

      case "turn:error":
        streamRef.current = "";
        setStreamingText("");
        setActiveToolName(null);
        setError(msg.message);
        setStatus("ready"); // allow retry
        break;

      case "restart":
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `Switching to agent "${msg.agentName}"... Please relaunch the app.`,
          },
        ]);
        setStatus("exited");
        break;

      case "status:update":
        if (msg.market) setMarketData(msg.market);
        if (msg.portfolio) setPortfolioData(msg.portfolio);
        break;

      case "agents:list":
        setAgentsList(msg.agents);
        break;

      case "agents:switch-error":
        setError(msg.message);
        setStatus("ready");
        break;

      case "strategy:content":
        strategyReadCb.current?.(msg.content);
        strategyReadCb.current = null;
        break;

      case "strategy:empty":
        strategyReadCb.current?.(null);
        strategyReadCb.current = null;
        break;

      case "auto:state":
        setAutopilotState({ mode: msg.mode, intervalMs: msg.intervalMs, budgetUsed: msg.budgetUsed, budgetMax: msg.budgetMax });
        break;

      case "auto:report":
        setAutopilotReport(msg.entries);
        break;

      // ── Model switch messages ──

      case "model:current": {
        const lines = [`**Current Provider:** ${msg.provider} (${msg.model})`];
        if (msg.available.length > 0) {
          lines.push("", "**Available:** " + msg.available.map((p) => `\`${p.value}\``).join(", "));
          lines.push("", "Switch with `/model <provider>`");
        }
        setMessages((prev) => [...prev, { role: "assistant", content: lines.join("\n"), systemIcon: "info" }]);
        setModelSwitchPhase("idle");
        setModelSwitchData({});
        break;
      }

      case "model:need-key":
        setModelSwitchPhase("need-key");
        setModelSwitchData((prev) => ({
          ...prev,
          provider: msg.provider,
          label: msg.label,
          placeholder: msg.placeholder,
          error: undefined,
        }));
        setMessages((prev) => [...prev, { role: "assistant", content: `Enter your **${msg.label}** to switch to ${msg.provider}:`, systemIcon: "info" }]);
        break;

      case "model:key-ok":
        setModelSwitchPhase("idle");
        setModelSwitchData({});
        setProvider(msg.provider);
        setMessages((prev) => [...prev, { role: "assistant", content: `Switched to **${msg.provider}** (${msg.model}). Key saved for instant switching.`, systemIcon: "info" }]);
        break;

      case "model:key-error":
        setModelSwitchPhase("need-key");
        setModelSwitchData((prev) => ({ ...prev, error: msg.message }));
        setMessages((prev) => [...prev, { role: "assistant", content: `Invalid key: ${msg.message}. Try again or type \`cancel\` to abort.`, systemIcon: "error" }]);
        break;

      case "model:oauth-waiting":
        setModelSwitchPhase("oauth-waiting");
        setModelSwitchData((prev) => ({ ...prev, provider: "openai-oauth", oauthUrl: msg.authorizeUrl }));
        setMessages((prev) => [...prev, { role: "assistant", content: "Opening browser for ChatGPT login... If it doesn't open, paste the callback URL below.", systemIcon: "info" }]);
        break;

      case "model:oauth-ok":
        setModelSwitchPhase("idle");
        setModelSwitchData({});
        setProvider(msg.provider);
        setMessages((prev) => [...prev, { role: "assistant", content: `Switched to **Codex** (${msg.model}).`, systemIcon: "info" }]);
        break;

      case "model:oauth-error":
        if (msg.fallbackToPaste) {
          setModelSwitchPhase("oauth-paste");
          setModelSwitchData((prev) => ({ ...prev, error: msg.message }));
          setMessages((prev) => [...prev, { role: "assistant", content: `OAuth error: ${msg.message}. Paste the callback URL below:`, systemIcon: "error" }]);
        } else {
          setModelSwitchPhase("idle");
          setModelSwitchData({});
          setMessages((prev) => [...prev, { role: "assistant", content: `OAuth failed: ${msg.message}`, systemIcon: "error" }]);
        }
        break;

      case "model:switched":
        setModelSwitchPhase("idle");
        setModelSwitchData({});
        setProvider(msg.provider);
        setMessages((prev) => [...prev, { role: "assistant", content: `Switched to **${msg.provider}** (${msg.model}) using saved key.`, systemIcon: "info" }]);
        break;

      // ── Daemon (full autopilot) messages ──

      case "daemon:state":
        setDaemonRunning(msg.running);
        setMessages((prev) => [...prev, {
          role: "assistant",
          content: msg.running
            ? "Full autopilot daemon is now **running**. It will keep trading even if you close this window."
            : "Full autopilot daemon **stopped**.",
          systemIcon: "info",
        }]);
        break;

      case "daemon:trade":
        // Add trade to chat
        setMessages((prev) => [...prev, {
          role: "assistant",
          content: `**Daemon trade** \`${msg.ts.slice(11, 16)}\` — ${msg.action}`,
          systemIcon: "info",
        }]);
        // Send desktop notification
        void sendDesktopNotification("Astra Autopilot", msg.action);
        break;

      case "daemon:error":
        setMessages((prev) => [...prev, {
          role: "assistant",
          content: msg.message,
          systemIcon: "error",
        }]);
        break;

      case "funfact:show":
        if (funFactTimeout.current) clearTimeout(funFactTimeout.current);
        setFunFact(msg.text);
        funFactTimeout.current = setTimeout(() => setFunFact(null), 20_000);
        break;

      case "pong":
        break;

      // ── Onboarding messages ──

      case "onboard:providers":
        setStatus("onboarding");
        setOnboardingPhase("providers");
        setOnboardingData((prev) => ({ ...prev, providers: msg.providers }));
        break;

      case "onboard:need-key":
        setOnboardingPhase("api-key");
        setOnboardingData((prev) => ({
          ...prev,
          keyLabel: msg.label,
          keyPlaceholder: msg.placeholder,
          keyError: undefined,
        }));
        break;

      case "onboard:key-ok":
        // Key validated — wait for need-details
        setOnboardingPhase("api-key-validating");
        break;

      case "onboard:key-error":
        setOnboardingPhase("api-key");
        setOnboardingData((prev) => ({ ...prev, keyError: msg.message }));
        break;

      case "onboard:oauth-waiting":
        setOnboardingPhase("oauth-waiting");
        setOnboardingData((prev) => ({ ...prev, oauthUrl: msg.authorizeUrl }));
        break;

      case "onboard:oauth-ok":
        // OAuth succeeded — wait for need-details
        break;

      case "onboard:oauth-error":
        if (msg.fallbackToPaste) {
          setOnboardingPhase("oauth-paste");
          setOnboardingData((prev) => ({ ...prev, oauthError: msg.message }));
        } else {
          setOnboardingPhase("providers");
          setOnboardingData((prev) => ({ ...prev, keyError: msg.message }));
        }
        break;

      case "onboard:need-details":
        setOnboardingPhase("details");
        setOnboardingData((prev) => ({
          ...prev,
          nameSuggestions: msg.nameSuggestions,
          descriptionSuggestions: msg.descriptionSuggestions,
          registerError: undefined,
          nameConflict: false,
        }));
        break;

      case "onboard:registered":
        setOnboardingPhase("done");
        setOnboardingData((prev) => ({
          ...prev,
          registeredAgent: msg.agentName,
          verificationCode: msg.verificationCode,
        }));
        // init:ok will follow — transitions to chat automatically
        break;

      case "onboard:register-error":
        setOnboardingPhase("details");
        setOnboardingData((prev) => ({
          ...prev,
          registerError: msg.message,
          nameConflict: msg.nameConflict,
        }));
        break;
    }
  }, []);

  // Listen for sidecar events from Tauri
  // NOTE: React StrictMode double-mounts in dev. Use `cancelled` flag
  // to ensure the first mount's async listeners are torn down properly.
  useEffect(() => {
    let cancelled = false;
    let msgUnlisten: UnlistenFn | null = null;
    let exitUnlisten: UnlistenFn | null = null;
    const setup = async () => {
      const mu = await listen<string>("sidecar:message", (event) => {
        if (cancelled) return;
        const line = event.payload.trim();
        if (!line) return;
        try {
          const msg = JSON.parse(line) as SidecarResponse;
          handleMessage(msg);
        } catch {
          console.error("Failed to parse sidecar message:", line);
        }
      });
      if (cancelled) { mu(); return; }
      msgUnlisten = mu;

      const eu = await listen<number>("sidecar:exit", () => {
        if (cancelled) return;
        setStatus("exited");
      });
      if (cancelled) { eu(); return; }
      exitUnlisten = eu;

      // Listeners are ready — tell the sidecar to initialize
      await invoke("send_to_sidecar", {
        message: JSON.stringify({ type: "init" }),
      });
    };

    setup().catch(console.error);

    return () => {
      cancelled = true;
      msgUnlisten?.();
      exitUnlisten?.();
    };
  }, [handleMessage]);

  // Send a chat message
  const sendMessage = useCallback(
    async (text: string) => {
      if (status !== "ready") return;

      // Optimistically add user message
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      setStatus("streaming");
      setError(null);
      streamRef.current = "";
      setStreamingText("");

      const request: SidecarRequest = { type: "chat:send", message: text };
      await invoke("send_to_sidecar", {
        message: JSON.stringify(request),
      });
    },
    [status],
  );

  // Autopilot control
  const setAutopilot = useCallback(async (mode: "off" | "semi", intervalMs?: number) => {
    const request: SidecarRequest = { type: "auto:set", mode, intervalMs };
    await invoke("send_to_sidecar", { message: JSON.stringify(request) });
  }, []);

  const requestAutopilotStatus = useCallback(async () => {
    const request: SidecarRequest = { type: "auto:status" };
    await invoke("send_to_sidecar", { message: JSON.stringify(request) });
  }, []);

  const requestAutopilotReport = useCallback(async () => {
    const request: SidecarRequest = { type: "auto:report" };
    await invoke("send_to_sidecar", { message: JSON.stringify(request) });
  }, []);

  // Strategy commands (load from disk + inject into prompt, like CLI does)
  const readStrategy = useCallback(async (): Promise<string | null> => {
    return new Promise((resolve) => {
      strategyReadCb.current = resolve;
      const request: SidecarRequest = { type: "strategy:read" };
      invoke("send_to_sidecar", { message: JSON.stringify(request) }).catch(() => {
        strategyReadCb.current = null;
        resolve(null);
      });
    });
  }, []);

  const runStrategy = useCallback(async () => {
    setStatus("streaming");
    setError(null);
    streamRef.current = "";
    setStreamingText("");
    const request: SidecarRequest = { type: "strategy:run" };
    await invoke("send_to_sidecar", { message: JSON.stringify(request) });
  }, []);

  const setupStrategy = useCallback(async () => {
    setStatus("streaming");
    setError(null);
    streamRef.current = "";
    setStreamingText("");
    const request: SidecarRequest = { type: "strategy:setup" };
    await invoke("send_to_sidecar", { message: JSON.stringify(request) });
  }, []);

  // Daemon control
  const startDaemon = useCallback(async () => {
    const request: SidecarRequest = { type: "daemon:start" };
    await invoke("send_to_sidecar", { message: JSON.stringify(request) });
  }, []);

  const stopDaemon = useCallback(async () => {
    const request: SidecarRequest = { type: "daemon:stop" };
    await invoke("send_to_sidecar", { message: JSON.stringify(request) });
  }, []);

  const requestDaemonStatus = useCallback(async () => {
    const request: SidecarRequest = { type: "daemon:status" };
    await invoke("send_to_sidecar", { message: JSON.stringify(request) });
  }, []);

  // Model switch actions
  const switchModel = useCallback(async (providerAlias: string) => {
    const request: SidecarRequest = { type: "model:switch", provider: providerAlias };
    await invoke("send_to_sidecar", { message: JSON.stringify(request) });
  }, []);

  const validateModelKey = useCallback(async (provider: string, apiKey: string) => {
    setModelSwitchPhase("validating");
    const request: SidecarRequest = { type: "model:validate-key", provider, apiKey };
    await invoke("send_to_sidecar", { message: JSON.stringify(request) });
  }, []);

  const submitModelOAuthPaste = useCallback(async (url: string) => {
    const request: SidecarRequest = { type: "model:oauth-paste", url };
    await invoke("send_to_sidecar", { message: JSON.stringify(request) });
  }, []);

  const cancelModelSwitch = useCallback(() => {
    setModelSwitchPhase("idle");
    setModelSwitchData({});
    setMessages((prev) => [...prev, { role: "assistant" as const, content: "Model switch cancelled.", systemIcon: "info" as const }]);
  }, []);

  // Local message injection (for slash commands)
  const addLocalMessage = useCallback((content: string, systemIcon?: "info" | "error") => {
    setMessages((prev) => [...prev, { role: "assistant" as const, content, systemIcon }]);
  }, []);

  const addUserMessage = useCallback((content: string) => {
    setMessages((prev) => [...prev, { role: "user" as const, content }]);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  // Request agent list from sidecar
  const requestAgentsList = useCallback(async () => {
    const request: SidecarRequest = { type: "agents:list" };
    await invoke("send_to_sidecar", { message: JSON.stringify(request) });
  }, []);

  // Switch to a different agent
  const switchAgent = useCallback(async (name: string) => {
    setStatus("connecting");
    const request: SidecarRequest = { type: "agents:switch", agentName: name };
    await invoke("send_to_sidecar", { message: JSON.stringify(request) });
  }, []);

  return {
    status,
    plugin,
    agentName,
    provider,
    journeyStage,
    messages,
    streamingText,
    activeToolName,
    error,
    sendMessage,
    onboardingPhase,
    onboardingData,
    marketData,
    portfolioData,
    agentsList,
    requestAgentsList,
    switchAgent,
    addLocalMessage,
    addUserMessage,
    clearMessages,
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
    readStrategy,
    runStrategy,
    setupStrategy,
    daemonRunning,
    startDaemon,
    stopDaemon,
    requestDaemonStatus,
    funFact,
  };
}
