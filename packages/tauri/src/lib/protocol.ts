// Sidecar JSON protocol — newline-delimited JSON over stdin/stdout

// ── Frontend → Sidecar (stdin) ──

export interface InitRequest {
  type: "init";
}

export interface ChatSendRequest {
  type: "chat:send";
  message: string;
}

export interface PingRequest {
  type: "ping";
}

// Onboarding requests
export interface OnboardSetProviderRequest {
  type: "onboard:set-provider";
  provider: string;
}

export interface OnboardValidateKeyRequest {
  type: "onboard:validate-key";
  provider: string;
  apiKey: string;
}

export interface OnboardStartOAuthRequest {
  type: "onboard:start-oauth";
}

export interface OnboardOAuthPasteRequest {
  type: "onboard:oauth-paste";
  url: string;
}

export interface OnboardRegisterRequest {
  type: "onboard:register";
  agentName: string;
  description: string;
}

// Model switch requests
export interface ModelSwitchRequest {
  type: "model:switch";
  provider: string; // empty = show current
}

export interface ModelValidateKeyRequest {
  type: "model:validate-key";
  provider: string;
  apiKey: string;
}

export interface ModelOAuthPasteRequest {
  type: "model:oauth-paste";
  url: string;
}

// Agent management requests
export interface ListAgentsRequest {
  type: "agents:list";
}

export interface SwitchAgentRequest {
  type: "agents:switch";
  agentName: string;
}

// Strategy & autopilot requests
export interface StrategyReadRequest {
  type: "strategy:read";
}

export interface StrategyRunRequest {
  type: "strategy:run";
}

export interface StrategySetupRequest {
  type: "strategy:setup";
}

export interface AutoSetRequest {
  type: "auto:set";
  mode: "off" | "semi";
  intervalMs?: number;
}

// Daemon requests (full autopilot — persistent background process)
export interface DaemonStartRequest {
  type: "daemon:start";
}

export interface DaemonStopRequest {
  type: "daemon:stop";
}

export interface DaemonStatusRequest {
  type: "daemon:status";
}

export interface AutoStatusRequest {
  type: "auto:status";
}

export interface AutoReportRequest {
  type: "auto:report";
}

export type SidecarRequest =
  | InitRequest
  | ChatSendRequest
  | PingRequest
  | ListAgentsRequest
  | SwitchAgentRequest
  | StrategyReadRequest
  | StrategyRunRequest
  | StrategySetupRequest
  | AutoSetRequest
  | AutoStatusRequest
  | AutoReportRequest
  | OnboardSetProviderRequest
  | OnboardValidateKeyRequest
  | OnboardStartOAuthRequest
  | OnboardOAuthPasteRequest
  | OnboardRegisterRequest
  | ModelSwitchRequest
  | ModelValidateKeyRequest
  | ModelOAuthPasteRequest
  | DaemonStartRequest
  | DaemonStopRequest
  | DaemonStatusRequest;

// ── Sidecar → Frontend (stdout) ──

export interface InitOkResponse {
  type: "init:ok";
  plugin: string;
  agentName: string;
  provider: string;
  journeyStage: string;
  welcomeMessages: Array<{ role: "assistant"; content: string }>;
  /** Previous session messages to restore (user + assistant display messages) */
  sessionMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Whether the full autopilot daemon is currently running */
  daemonRunning?: boolean;
}

export interface InitErrorResponse {
  type: "init:error";
  message: string;
}

export interface ChunkResponse {
  type: "chunk";
  text: string;
}

export interface ToolStartResponse {
  type: "tool:start";
  toolName: string;
}

export interface ToolEndResponse {
  type: "tool:end";
  toolName: string;
}

export interface TurnDoneResponse {
  type: "turn:done";
  text: string;
}

export interface TurnErrorResponse {
  type: "turn:error";
  message: string;
}

export interface RestartResponse {
  type: "restart";
  agentName: string;
}

export interface PongResponse {
  type: "pong";
}

// Onboarding responses
export interface OnboardProvidersResponse {
  type: "onboard:providers";
  providers: Array<{ value: string; label: string; hint: string }>;
}

export interface OnboardNeedKeyResponse {
  type: "onboard:need-key";
  label: string;
  placeholder: string;
}

export interface OnboardKeyOkResponse {
  type: "onboard:key-ok";
}

export interface OnboardKeyErrorResponse {
  type: "onboard:key-error";
  message: string;
}

export interface OnboardOAuthWaitingResponse {
  type: "onboard:oauth-waiting";
  authorizeUrl: string;
}

export interface OnboardOAuthOkResponse {
  type: "onboard:oauth-ok";
}

export interface OnboardOAuthErrorResponse {
  type: "onboard:oauth-error";
  message: string;
  fallbackToPaste: boolean;
}

export interface OnboardNeedDetailsResponse {
  type: "onboard:need-details";
  nameSuggestions: string[];
  descriptionSuggestions: string[];
}

export interface OnboardRegisteredResponse {
  type: "onboard:registered";
  agentName: string;
  verificationCode: string;
}

export interface OnboardRegisterErrorResponse {
  type: "onboard:register-error";
  message: string;
  nameConflict: boolean;
}

// Agent management responses
export interface AgentInfo {
  name: string;
  active: boolean;
  status: string;
  journeyStage: string;
  createdAt: string;
}

export interface AgentsListResponse {
  type: "agents:list";
  agents: AgentInfo[];
}

export interface AgentSwitchErrorResponse {
  type: "agents:switch-error";
  message: string;
  availableAgents: string[];
}

// Strategy & autopilot responses
export interface StrategyContentResponse {
  type: "strategy:content";
  content: string;
}

export interface StrategyEmptyResponse {
  type: "strategy:empty";
}

export interface AutoStateResponse {
  type: "auto:state";
  mode: string;
  intervalMs: number;
  budgetUsed: number;
  budgetMax: number;
}

export interface AutoReportResponse {
  type: "auto:report";
  entries: Array<{ ts: string; action: string }>;
}

// Model switch responses
export interface ModelCurrentResponse {
  type: "model:current";
  provider: string;
  model: string;
  available: Array<{ value: string; label: string }>;
}

export interface ModelNeedKeyResponse {
  type: "model:need-key";
  provider: string;
  label: string;
  placeholder: string;
}

export interface ModelKeyOkResponse {
  type: "model:key-ok";
  provider: string;
  model: string;
}

export interface ModelKeyErrorResponse {
  type: "model:key-error";
  message: string;
}

export interface ModelOAuthWaitingResponse {
  type: "model:oauth-waiting";
  authorizeUrl: string;
}

export interface ModelOAuthOkResponse {
  type: "model:oauth-ok";
  provider: string;
  model: string;
}

export interface ModelOAuthErrorResponse {
  type: "model:oauth-error";
  message: string;
  fallbackToPaste: boolean;
}

export interface ModelSwitchedResponse {
  type: "model:switched";
  provider: string;
  model: string;
}

// Daemon responses (full autopilot)
export interface DaemonStateResponse {
  type: "daemon:state";
  running: boolean;
  mode: string;
}

export interface DaemonTradeResponse {
  type: "daemon:trade";
  ts: string;
  action: string;
}

export interface DaemonErrorResponse {
  type: "daemon:error";
  message: string;
}

// Status bar data
export interface MarketData {
  price: number;
  mood: string;
  epochId: number;
}

export interface PortfolioData {
  cash: number;
  tokens: number;
  portfolioValue: number;
  pnl: number;
  pnlPct: number;
}

export interface StatusUpdateResponse {
  type: "status:update";
  market: MarketData | null;
  portfolio: PortfolioData | null;
}

export interface FunFactShowResponse {
  type: "funfact:show";
  text: string;
}

export type SidecarResponse =
  | InitOkResponse
  | InitErrorResponse
  | ChunkResponse
  | ToolStartResponse
  | ToolEndResponse
  | TurnDoneResponse
  | TurnErrorResponse
  | RestartResponse
  | PongResponse
  | StatusUpdateResponse
  | AgentsListResponse
  | AgentSwitchErrorResponse
  | StrategyContentResponse
  | StrategyEmptyResponse
  | AutoStateResponse
  | AutoReportResponse
  | OnboardProvidersResponse
  | OnboardNeedKeyResponse
  | OnboardKeyOkResponse
  | OnboardKeyErrorResponse
  | OnboardOAuthWaitingResponse
  | OnboardOAuthOkResponse
  | OnboardOAuthErrorResponse
  | OnboardNeedDetailsResponse
  | OnboardRegisteredResponse
  | OnboardRegisterErrorResponse
  | ModelCurrentResponse
  | ModelNeedKeyResponse
  | ModelKeyOkResponse
  | ModelKeyErrorResponse
  | ModelOAuthWaitingResponse
  | ModelOAuthOkResponse
  | ModelOAuthErrorResponse
  | ModelSwitchedResponse
  | DaemonStateResponse
  | DaemonTradeResponse
  | DaemonErrorResponse
  | FunFactShowResponse;
