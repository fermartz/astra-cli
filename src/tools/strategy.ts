import fs from "node:fs";
import { tool } from "ai";
import { z } from "zod";
import { getActiveAgent, getActivePlugin } from "../config/store.js";
import { agentDir, strategyPath, ensureDir } from "../config/paths.js";

const MAX_STRATEGY_CHARS = 4000;

/**
 * write_strategy — saves the agent's trading strategy to disk.
 * Called by the LLM after the guided strategy creation conversation.
 * Replaces the entire strategy file (full replacement, like update_memory).
 */
export const writeStrategyTool = tool({
  description:
    "Save the agent's trading strategy to disk. Call this after completing the guided strategy creation conversation. Replaces the entire strategy file. Max 4000 characters.",
  parameters: z.object({
    content: z
      .string()
      .describe(
        "The complete trading strategy in markdown format. Replaces the entire strategy file. Max 4000 characters. Use clear sections: approach, buy conditions, sell conditions, position sizing, risk limits.",
      ),
  }),
  execute: async ({ content }) => {
    const agentName = getActiveAgent();
    if (!agentName) return { error: "No active agent." };

    if (content.length > MAX_STRATEGY_CHARS) {
      return {
        error: `Strategy content too long (${content.length} chars). Maximum is ${MAX_STRATEGY_CHARS} characters. Condense it.`,
      };
    }

    try {
      ensureDir(agentDir(agentName, getActivePlugin()));
      fs.writeFileSync(strategyPath(agentName, getActivePlugin()), content, { encoding: "utf-8", mode: 0o600 });
      return { ok: true, chars: content.length };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { error: `Failed to save strategy: ${msg}` };
    }
  },
});

/**
 * read_strategy — reads the agent's current trading strategy from disk.
 * Use when the user asks about their strategy, or before running a manual strategy check.
 */
export const readStrategyTool = tool({
  description:
    "Read the agent's current trading strategy from disk. Use when the user asks about their strategy, or to show the strategy before editing it.",
  parameters: z.object({}),
  execute: async () => {
    const agentName = getActiveAgent();
    if (!agentName) return { error: "No active agent." };

    const filePath = strategyPath(agentName, getActivePlugin());
    if (!fs.existsSync(filePath)) {
      return {
        error:
          "No trading strategy found for this agent. Guide the user through strategy creation — suggest `/strategy setup`.",
      };
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return { ok: true, content };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { error: `Failed to read strategy: ${msg}` };
    }
  },
});

/**
 * Load the strategy for an agent — called at startup and in trigger builder.
 * Returns "" if no strategy exists. Never throws.
 */
export function loadStrategy(agentName: string): string {
  const filePath = strategyPath(agentName, getActivePlugin());
  if (!fs.existsSync(filePath)) return "";
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}
