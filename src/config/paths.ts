import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/**
 * Root config directory — matches AstraNova API convention.
 * All agent data lives under ~/.config/astranova/
 */
export const ASTRANOVA_DIR = path.join(os.homedir(), ".config", "astranova");

/** Directory containing all agent subdirectories. */
export const AGENTS_DIR = path.join(ASTRANOVA_DIR, "agents");

/** Cache directory for remote context files (skill.md, etc). */
export const CACHE_DIR = path.join(ASTRANOVA_DIR, ".cache");

/** Path to the CLI config file (LLM provider, model, preferences). */
export function configPath(): string {
  return path.join(ASTRANOVA_DIR, "config.json");
}

/** Path to the active agent marker file (plain text, agent name). */
export function activeAgentPath(): string {
  return path.join(ASTRANOVA_DIR, "active_agent");
}

/** Path to the global state file. */
export function statePath(): string {
  return path.join(ASTRANOVA_DIR, "state.json");
}

/** Path to a specific agent's directory. */
export function agentDir(agentName: string): string {
  return path.join(AGENTS_DIR, agentName);
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
  return path.join(ASTRANOVA_DIR, "audit.log");
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
  return path.join(CACHE_DIR, fileName);
}

/**
 * Ensure a directory exists. Creates it recursively if needed.
 * Applies chmod 700 to the astranova root dir (owner-only access).
 */
export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  // If this is the root astranova dir or agents dir, restrict access
  if (dirPath === ASTRANOVA_DIR || dirPath.startsWith(AGENTS_DIR)) {
    fs.chmodSync(dirPath, 0o700);
  }
}

/**
 * Ensure the base directory structure exists.
 * Called once at startup.
 */
export function ensureBaseStructure(): void {
  ensureDir(ASTRANOVA_DIR);
  ensureDir(AGENTS_DIR);
  ensureDir(CACHE_DIR);
}
