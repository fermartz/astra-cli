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

/** Maximum in-memory autopilot log entries (UI display only). */
export const MAX_LOG_ENTRIES = 100;

/** API calls budgeted per autopilot turn (market + portfolio + potential trade). */
export const CALLS_PER_AUTOPILOT_TURN = 3;

/** Total API calls allowed per epoch. */
export const EPOCH_BUDGET = 10;

/** Reserve calls for user-initiated actions. */
export const BUDGET_BUFFER = 2;

/**
 * Base trigger for semi autopilot — autonomous execution, no user confirmation.
 * Strategy content is appended by buildAutopilotTrigger() when available.
 */
const SEMI_TRIGGER_BASE =
  "AUTOPILOT CHECK (SEMI): Analyze market and execute a trade based on your strategy. Do NOT ask for confirmation — execute autonomously and report the result in 2-3 lines. If conditions are not met, say 'Market checked — holding.' with a brief reason.";

/**
 * Base trigger for full autopilot — fully autonomous, result goes to log only.
 * Strategy content is appended by buildAutopilotTrigger() when available.
 */
const FULL_TRIGGER_BASE =
  "AUTOPILOT CHECK (FULL): Analyze market and execute a trade based on your strategy. Do NOT ask for confirmation. Do NOT ask about trade size — use position sizing from your strategy. Execute immediately if conditions are met, skip if uncertain. Keep response to 2-3 lines max.";

/**
 * One-shot trigger for the /strategy slash command.
 * Strategy content is appended by buildStrategyRunTrigger() when available.
 */
const STRATEGY_RUN_BASE =
  "STRATEGY RUN: Check the market against your strategy and execute a trade if conditions are met. Do NOT ask for confirmation. Report what you did (or why you held) in 2-3 lines.";

/** Build the trigger message for a timed autopilot tick. Embeds strategy inline when provided. */
export function buildAutopilotTrigger(mode: AutopilotMode, strategyContent?: string): string | null {
  const base = mode === "semi" ? SEMI_TRIGGER_BASE : mode === "full" ? FULL_TRIGGER_BASE : null;
  if (!base) return null;
  if (!strategyContent?.trim()) return base;
  return `${base}\n\n## Your Strategy\n${strategyContent.trim()}`;
}

/** Build the trigger message for a one-shot /strategy run. Embeds strategy inline when provided. */
export function buildStrategyRunTrigger(strategyContent?: string): string {
  if (!strategyContent?.trim()) return STRATEGY_RUN_BASE;
  return `${STRATEGY_RUN_BASE}\n\n## Your Strategy\n${strategyContent.trim()}`;
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
