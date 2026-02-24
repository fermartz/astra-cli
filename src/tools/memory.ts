import fs from "node:fs";
import { tool } from "ai";
import { z } from "zod";
import { memoryPath, ensureDir, agentDir } from "../config/paths.js";
import { getActiveAgent } from "../config/store.js";

const MAX_MEMORY_CHARS = 2000;

export const updateMemorySchema = z.object({
  content: z
    .string()
    .describe(
      "The complete memory content to save. Replaces the entire memory file. Use markdown format. Max 2000 characters.",
    ),
});

/**
 * update_memory tool — persists learnings across sessions.
 *
 * The LLM replaces the entire memory file each time (no append).
 * This ensures the memory stays curated and within the char limit.
 */
export const updateMemoryTool = tool({
  description:
    "Save persistent memory that survives across sessions. Use this to remember important facts about the user, their preferences, trading patterns, or anything worth recalling next time. Content replaces the entire memory — include everything worth keeping. Max 2000 characters.",
  parameters: updateMemorySchema,
  execute: async ({ content }) => {
    const agentName = getActiveAgent();
    if (!agentName) {
      return { error: "No active agent." };
    }

    if (content.length > MAX_MEMORY_CHARS) {
      return {
        error: `Memory content too long (${content.length} chars). Maximum is ${MAX_MEMORY_CHARS} characters. Trim it down and try again.`,
      };
    }

    try {
      ensureDir(agentDir(agentName));
      const filePath = memoryPath(agentName);
      fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
      return { ok: true, chars: content.length };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { error: `Failed to save memory: ${msg}` };
    }
  },
});

/**
 * Load memory content for an agent.
 * Returns empty string if no memory file exists.
 */
export function loadMemory(agentName: string): string {
  const filePath = memoryPath(agentName);
  if (!fs.existsSync(filePath)) return "";
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}
