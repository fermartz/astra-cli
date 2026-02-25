import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/**
 * Root config directory — matches AstraNova API convention.
 * All agent data lives under ~/.config/astranova/
 *
 * Override with ASTRA_TEST_DIR env var for isolated testing.
 * Uses a getter so tests can set the env var after import.
 */
const _defaultRoot = path.join(os.homedir(), ".config", "astranova");

/** @internal Resolve root — checks env var each call for test isolation. */
function _root(): string {
  return process.env.ASTRA_TEST_DIR ?? _defaultRoot;
}

/** Get the current root directory (dynamic, respects ASTRA_TEST_DIR). */
export function getRoot(): string {
  return _root();
}

// Exported as a getter-backed property so it always reflects the current env.
// Modules that destructure `import { ASTRANOVA_DIR }` will get the value at import time,
// but functions that call configPath()/agentDir()/etc. always resolve dynamically.
export const ASTRANOVA_DIR = _defaultRoot;
export const AGENTS_DIR = path.join(_defaultRoot, "agents");
export const CACHE_DIR = path.join(_defaultRoot, ".cache");

/** Path to the CLI config file (LLM provider, model, preferences). */
export function configPath(): string {
  return path.join(_root(), "config.json");
}

/** Path to the active agent marker file (plain text, agent name). */
export function activeAgentPath(): string {
  return path.join(_root(), "active_agent");
}

/** Path to the global state file. */
export function statePath(): string {
  return path.join(_root(), "state.json");
}

/** Path to a specific agent's directory. */
export function agentDir(agentName: string): string {
  return path.join(_root(), "agents", agentName);
}

/** Path to an agent's credentials file. */
export function credentialsPath(agentName: string): string {
  return path.join(agentDir(agentName), "credentials.json");
}

/** Path to an agent's wallet file. */
export function walletPath(agentName: string): string {
  return path.join(agentDir(agentName), "wallet.json");
}

/** Path to the audit log file. */
export function auditLogPath(): string {
  return path.join(_root(), "audit.log");
}

/** Directory containing session files for an agent. */
export function sessionsDir(agentName: string): string {
  return path.join(agentDir(agentName), "sessions");
}

/** Path to an agent's memory file (persistent learnings across sessions). */
export function memoryPath(agentName: string): string {
  return path.join(agentDir(agentName), "memory.md");
}

/** Path to a cached remote file (e.g., skill.md). */
export function cachePath(fileName: string): string {
  return path.join(_root(), ".cache", fileName);
}

/**
 * Ensure a directory exists. Creates it recursively if needed.
 * Applies chmod 700 to the astranova root dir (owner-only access).
 */
export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  // If this is under the astranova dir, restrict access
  const root = _root();
  if (dirPath === root || dirPath.startsWith(path.join(root, "agents"))) {
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
  ensureDir(path.join(root, "agents"));
  ensureDir(path.join(root, ".cache"));
}
