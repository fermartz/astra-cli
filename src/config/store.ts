import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  configPath,
  activeAgentPath,
  statePath,
  credentialsPath,
  walletPath,
  pendingClaimPath,
  epochBudgetPath,
  autopilotLogPath,
  daemonPidPath,
  agentDir,
  ensureDir,
  ensureBaseStructure,
  getRoot,
} from "./paths.js";
import {
  ConfigSchema,
  CredentialsSchema,
  WalletSchema,
  StateSchema,
  type Config,
  type Credentials,
  type Wallet,
  type State,
  type AgentState,
} from "./schema.js";

/**
 * Write a file atomically: write to a temp file in the same directory,
 * then rename. This prevents corruption if the process is killed mid-write.
 * Applies chmod 600 for sensitive files (owner read/write only).
 */
function writeFileSecure(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);

  const tmpPath = path.join(dir, `.tmp-${crypto.randomBytes(6).toString("hex")}`);
  fs.writeFileSync(tmpPath, data, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

/**
 * Read and parse a JSON file with Zod validation.
 * Returns null if the file does not exist.
 * Throws if the file exists but fails validation (corrupted data).
 */
function readJsonFile<T>(filePath: string, schema: { parse: (data: unknown) => T }): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  return schema.parse(parsed);
}

// ---------------------------------------------------------------------------
// CLI Config (~/.config/astranova/config.json)
// ---------------------------------------------------------------------------

/** Check if the CLI has been configured (config.json exists). */
export function isConfigured(): boolean {
  return fs.existsSync(configPath());
}

/** Load the CLI config. Returns null if not yet configured. */
export function loadConfig(): Config | null {
  return readJsonFile(configPath(), ConfigSchema);
}

/** Save the CLI config. Creates base directory structure if needed. */
export function saveConfig(config: Config): void {
  ensureBaseStructure();
  writeFileSecure(configPath(), JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Autopilot Config (per-agent, stored in state.json → agents[name].autopilot)
// ---------------------------------------------------------------------------

/**
 * Load autopilot config for the active agent.
 * Falls back to global config.json for migration, then to defaults.
 */
export function loadAutopilotConfig(): { mode: "off" | "semi" | "full"; intervalMs: number } {
  const agentName = getActiveAgent();
  if (agentName) {
    const state = loadState();
    const agentAutopilot = state?.agents[agentName]?.autopilot;
    if (agentAutopilot) return agentAutopilot;
  }
  // Fallback: legacy global config (migration path) or defaults
  const config = loadConfig();
  return config?.autopilot ?? { mode: "off", intervalMs: 300_000 };
}

/**
 * Save autopilot config for the active agent into state.json.
 * Each agent has independent autopilot settings.
 */
export function saveAutopilotConfig(autopilot: { mode: "off" | "semi" | "full"; intervalMs: number }): void {
  const agentName = getActiveAgent();
  if (!agentName) return;
  updateAgentState(agentName, { autopilot });
}

// ---------------------------------------------------------------------------
// Global State (~/.config/astranova/state.json)
// ---------------------------------------------------------------------------

/** Load the global state. Returns null if not found. */
export function loadState(): State | null {
  return readJsonFile(statePath(), StateSchema);
}

/** Save the global state. */
export function saveState(state: State): void {
  ensureBaseStructure();
  writeFileSecure(statePath(), JSON.stringify(state, null, 2));
}

/** Update metadata for a specific agent in state.json. */
export function updateAgentState(agentName: string, updates: Partial<AgentState>): void {
  const state = loadState();
  if (!state) return;
  const existing = state.agents[agentName] ?? {
    status: "unknown",
    journeyStage: "fresh" as const,
    createdAt: new Date().toISOString(),
  };
  state.agents[agentName] = { ...existing, ...updates };
  saveState(state);
}

// ---------------------------------------------------------------------------
// Active Agent (~/.config/astranova/active_agent + state.json)
// ---------------------------------------------------------------------------

/** Get the currently active agent name. Reads state.json, falls back to active_agent file. */
export function getActiveAgent(): string | null {
  // Try state.json first
  const state = loadState();
  if (state?.activeAgent) return state.activeAgent;

  // Fallback to legacy active_agent file
  const filePath = activeAgentPath();
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const name = fs.readFileSync(filePath, "utf-8").trim();
  return name || null;
}

/** Set the active agent name. Updates both state.json and legacy active_agent file. */
export function setActiveAgent(agentName: string): void {
  ensureBaseStructure();
  // Update legacy file for backwards compat
  writeFileSecure(activeAgentPath(), agentName);
  // Update state.json
  const state = loadState() ?? { activeAgent: agentName, agents: {} };
  state.activeAgent = agentName;
  if (!state.agents[agentName]) {
    state.agents[agentName] = {
      status: "unknown",
      journeyStage: "fresh",
      createdAt: new Date().toISOString(),
    };
  }
  saveState(state);
}

// ---------------------------------------------------------------------------
// Agent Credentials (~/.config/astranova/agents/<name>/credentials.json)
// ---------------------------------------------------------------------------

/** Load credentials for a specific agent. Returns null if not found. */
export function loadCredentials(agentName: string): Credentials | null {
  return readJsonFile(credentialsPath(agentName), CredentialsSchema);
}

/** Save credentials for a specific agent. */
export function saveCredentials(agentName: string, credentials: Credentials): void {
  ensureDir(agentDir(agentName));
  writeFileSecure(credentialsPath(agentName), JSON.stringify(credentials, null, 2));
}

// ---------------------------------------------------------------------------
// Wallet (~/.config/astranova/agents/<name>/wallet.json)
// ---------------------------------------------------------------------------

/** Load wallet for a specific agent. Returns null if not found. */
export function loadWallet(agentName: string): Wallet | null {
  return readJsonFile(walletPath(agentName), WalletSchema);
}

/** Save wallet for a specific agent. */
export function saveWallet(agentName: string, wallet: Wallet): void {
  ensureDir(agentDir(agentName));
  writeFileSecure(walletPath(agentName), JSON.stringify(wallet, null, 2));
}

// ---------------------------------------------------------------------------
// Restart Flag (~/.config/astranova/.restart)
// ---------------------------------------------------------------------------

/** Check if a restart was requested (e.g., after agent switch/create). */
export function isRestartRequested(): boolean {
  return fs.existsSync(path.join(getRoot(), ".restart"));
}

/** Request a CLI restart (called by agent management tools). */
export function requestRestart(): void {
  writeFileSecure(path.join(getRoot(), ".restart"), new Date().toISOString());
}

/** Clear the restart flag. */
export function clearRestartFlag(): void {
  const flagPath = path.join(getRoot(), ".restart");
  if (fs.existsSync(flagPath)) {
    fs.unlinkSync(flagPath);
  }
}

// ---------------------------------------------------------------------------
// Board Post Flag (~/.config/astranova/agents/<name>/board_posted)
// ---------------------------------------------------------------------------

/** Check if an agent has posted to the board. */
export function hasBoardPost(agentName: string): boolean {
  return fs.existsSync(path.join(agentDir(agentName), "board_posted"));
}

/** Mark that an agent has posted to the board. */
export function markBoardPosted(agentName: string): void {
  ensureDir(agentDir(agentName));
  writeFileSecure(path.join(agentDir(agentName), "board_posted"), new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Pending Claim Cache (~/.config/astranova/agents/<name>/pending_claim.json)
// ---------------------------------------------------------------------------

export interface PendingClaim {
  seasonId: string;
  transaction: string;
  expiresAt: string;
  cachedAt: string;
  retryCount: number;
}

/** Save a pending claim blob for retry. */
export function savePendingClaim(agentName: string, data: PendingClaim): void {
  ensureDir(agentDir(agentName));
  writeFileSecure(pendingClaimPath(agentName), JSON.stringify(data, null, 2));
}

/** Load a pending claim blob. Returns null if not found or unparseable. */
export function loadPendingClaim(agentName: string): PendingClaim | null {
  const filePath = pendingClaimPath(agentName);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as PendingClaim;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Epoch Budget (~/.config/astranova/agents/<name>/epoch_budget.json)
// ---------------------------------------------------------------------------

export interface EpochBudget {
  epochId: number;
  callCount: number;
}

/** Load the persisted epoch budget. Returns null if not found or unparseable. */
export function loadEpochBudget(agentName: string): EpochBudget | null {
  const filePath = epochBudgetPath(agentName);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as EpochBudget;
  } catch {
    return null;
  }
}

/** Save the epoch budget. Silently fails on error (non-critical). */
export function saveEpochBudget(agentName: string, data: EpochBudget): void {
  try {
    ensureDir(agentDir(agentName));
    writeFileSecure(epochBudgetPath(agentName), JSON.stringify(data));
  } catch {
    // non-critical
  }
}

/** Delete the pending claim cache. */
export function clearPendingClaim(agentName: string): void {
  const filePath = pendingClaimPath(agentName);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// ---------------------------------------------------------------------------
// Autopilot Log (~/.config/astranova/agents/<name>/autopilot.log)
// ---------------------------------------------------------------------------

export interface AutopilotLogEntry {
  ts: string;
  action: string;
  detail?: string;
  epochId?: number;
}

/** Append a trade result to the autopilot log (NDJSON). Silently fails on error. */
export function appendAutopilotLog(agentName: string, entry: AutopilotLogEntry): void {
  try {
    ensureDir(agentDir(agentName));
    fs.appendFileSync(autopilotLogPath(agentName), JSON.stringify(entry) + "\n", {
      encoding: "utf-8",
    });
  } catch {
    // non-critical
  }
}

/**
 * Load autopilot log entries since a given date.
 * Pass null to load all entries. Returns [] if log is missing or unparseable.
 */
export function loadAutopilotLogSince(agentName: string, since: Date | null): AutopilotLogEntry[] {
  const filePath = autopilotLogPath(agentName);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const entries: AutopilotLogEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AutopilotLogEntry;
        if (!since || new Date(entry.ts) > since) {
          entries.push(entry);
        }
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Daemon PID (~/.config/astranova/agents/<name>/daemon.pid)
// ---------------------------------------------------------------------------

/** Load the daemon PID for an agent. Returns null if not found or invalid. */
export function loadDaemonPid(agentName: string): number | null {
  const filePath = daemonPidPath(agentName);
  if (!fs.existsSync(filePath)) return null;
  try {
    const pid = parseInt(fs.readFileSync(filePath, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Save the daemon PID. */
export function saveDaemonPid(agentName: string, pid: number): void {
  ensureDir(agentDir(agentName));
  writeFileSecure(daemonPidPath(agentName), String(pid));
}

/** Clear the daemon PID file. Silently fails on error. */
export function clearDaemonPid(agentName: string): void {
  const filePath = daemonPidPath(agentName);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // non-critical
    }
  }
}

// ---------------------------------------------------------------------------
// Agent Discovery
// ---------------------------------------------------------------------------

/** List all agent names that have credentials saved locally. */
export function listAgents(): string[] {
  const agentsDir = path.join(getRoot(), "agents");
  if (!fs.existsSync(agentsDir)) {
    return [];
  }

  return fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory()) return false;
      return fs.existsSync(credentialsPath(entry.name));
    })
    .map((entry) => entry.name);
}
