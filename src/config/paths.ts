import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/**
 * Root config directory for the Astra CLI.
 * All agent data lives under ~/.config/astra/
 *
 * Override with ASTRA_TEST_DIR env var for isolated testing.
 * Uses a getter so tests can set the env var after import.
 */
const _defaultRoot = path.join(os.homedir(), ".config", "astra");

/** @internal Resolve root — checks env var each call for test isolation. */
function _root(): string {
  return process.env.ASTRA_TEST_DIR ?? _defaultRoot;
}

/** Get the current root directory (dynamic, respects ASTRA_TEST_DIR). */
export function getRoot(): string {
  return _root();
}

export const ASTRA_DIR = _defaultRoot;
export const CACHE_DIR = path.join(_defaultRoot, ".cache");

/** Path to the CLI config file (LLM provider, model, preferences). */
export function configPath(): string {
  return path.join(_root(), "config.json");
}

/** Path to the global state file. */
export function statePath(): string {
  return path.join(_root(), "state.json");
}

/**
 * Path to a specific agent's directory.
 * Composite key: (pluginName, agentName) — agents with the same name in different
 * plugins are completely separate entities stored in separate directories.
 */
export function agentDir(agentName: string, pluginName: string = "astranova"): string {
  const spacesRoot = path.join(_root(), "spaces", pluginName, "agents");
  const resolved = path.resolve(spacesRoot, agentName);
  if (!resolved.startsWith(spacesRoot + path.sep)) {
    throw new Error("Invalid agent name");
  }
  return resolved;
}

/** Path to an agent's credentials file. */
export function credentialsPath(agentName: string, pluginName?: string): string {
  return path.join(agentDir(agentName, pluginName), "credentials.json");
}

/** Path to an agent's wallet file. */
export function walletPath(agentName: string, pluginName?: string): string {
  return path.join(agentDir(agentName, pluginName), "wallet.json");
}

/** Path to the audit log file. */
export function auditLogPath(): string {
  return path.join(_root(), "audit.log");
}

/** Directory containing session files for an agent. */
export function sessionsDir(agentName: string, pluginName?: string): string {
  return path.join(agentDir(agentName, pluginName), "sessions");
}

/** Path to an agent's memory file (persistent learnings across sessions). */
export function memoryPath(agentName: string, pluginName?: string): string {
  return path.join(agentDir(agentName, pluginName), "memory.md");
}

/** Path to an agent's pending claim cache (transaction blob for retry). */
export function pendingClaimPath(agentName: string, pluginName?: string): string {
  return path.join(agentDir(agentName, pluginName), "pending_claim.json");
}

/** Path to an agent's epoch budget file. */
export function epochBudgetPath(agentName: string, pluginName?: string): string {
  return path.join(agentDir(agentName, pluginName), "epoch_budget.json");
}

/** Path to an agent's trading strategy file. */
export function strategyPath(agentName: string, pluginName?: string): string {
  return path.join(agentDir(agentName, pluginName), "strategy.md");
}

/** Path to an agent's autopilot trade log (NDJSON). */
export function autopilotLogPath(agentName: string, pluginName?: string): string {
  return path.join(agentDir(agentName, pluginName), "autopilot.log");
}

/** Path to an agent's daemon PID file. */
export function daemonPidPath(agentName: string, pluginName?: string): string {
  return path.join(agentDir(agentName, pluginName), "daemon.pid");
}

/** Path to a cached remote file (e.g., skill.md). */
export function cachePath(fileName: string): string {
  return path.join(_root(), ".cache", fileName);
}

/** Path to a plugin's local data directory. */
export function pluginDir(pluginName: string): string {
  return path.join(_root(), "plugins", pluginName);
}

/** Path to a plugin's saved manifest (parsed from skill.md ENGINE:META). */
export function pluginManifestPath(pluginName: string): string {
  return path.join(pluginDir(pluginName), "manifest.json");
}

/** Path to a plugin's saved skill.md content (raw, used as LLM context). */
export function pluginSkillPath(pluginName: string): string {
  return path.join(pluginDir(pluginName), "skill.md");
}

/** Path to a plugin's generated plugin-map.json (status + command hints for the TUI). */
export function pluginMapPath(pluginName: string): string {
  return path.join(pluginDir(pluginName), "plugin-map.json");
}

/**
 * Ensure a directory exists. Creates it recursively if needed.
 * Applies chmod 700 to the root dir and all spaces subdirectories (owner-only access).
 */
export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const root = _root();
  if (dirPath === root || dirPath.startsWith(path.join(root, "spaces"))) {
    fs.chmodSync(dirPath, 0o700);
  }
}

/**
 * Ensure the base directory structure exists.
 * Called once at startup.
 */
export function ensureBaseStructure(): void {
  const root = _root();
  ensureDir(root);
  ensureDir(path.join(root, "spaces"));
  ensureDir(path.join(root, ".cache"));
}
