/**
 * Autopilot types and trigger messages.
 *
 * Pure logic — no React dependencies. Used by App.tsx to drive
 * the autopilot timer and by system-prompt.ts for LLM instructions.
 */

export type AutopilotMode = "off" | "semi" | "full";

export interface AutopilotConfig {
  mode: AutopilotMode;
  intervalMs: number;
}

export interface AutopilotLogEntry {
  ts: Date;
  action: string;
  detail?: string;
}

/** Maximum autopilot log entries kept in memory. */
export const MAX_LOG_ENTRIES = 100;

/** API calls budgeted per autopilot turn (market + portfolio + potential trade). */
export const CALLS_PER_AUTOPILOT_TURN = 3;

/** Total API calls allowed per epoch. */
export const EPOCH_BUDGET = 10;

/** Reserve calls for user-initiated actions. */
export const BUDGET_BUFFER = 2;

/**
 * Semi-autopilot trigger — injected into chat via sendMessage().
 * The LLM sees this in the conversation and proposes a trade for user approval.
 */
export const SEMI_TRIGGER_MSG =
  "AUTOPILOT CHECK: Analyze market and propose a trade if signal is clear. Ask me to confirm before executing.";

/**
 * Full-autopilot trigger — injected into coreMessages only (not chat).
 * The LLM executes trades autonomously; results go to the autopilot log.
 */
export const FULL_TRIGGER_MSG =
  "AUTOPILOT CHECK: Analyze market and execute a trade if signal is clear. If uncertain, skip. Keep response to 2-3 lines max.";

/** Build the appropriate trigger message for the given mode. Returns null for "off". */
export function buildAutopilotTrigger(mode: AutopilotMode): string | null {
  switch (mode) {
    case "semi":
      return SEMI_TRIGGER_MSG;
    case "full":
      return FULL_TRIGGER_MSG;
    case "off":
      return null;
  }
}

/** Format an interval in ms to a human-readable string like "5m" or "30m". */
export function formatInterval(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return `${minutes}m`;
}

/** Parse an interval string like "5m", "10m", "30m" to milliseconds. Returns null if invalid. */
export function parseInterval(input: string): number | null {
  const match = input.match(/^(\d+)m$/);
  if (!match) return null;
  const minutes = parseInt(match[1], 10);
  if (minutes < 1 || minutes > 60) return null;
  return minutes * 60_000;
}
