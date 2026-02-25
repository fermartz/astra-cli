/**
 * Integration test harness.
 *
 * Provides helpers to execute tools directly (simulating LLM tool calls)
 * against the real AstraNova API. Uses the real config directory — NOT isolated.
 *
 * These tests are meant to be run manually (not in CI) since they:
 * - Hit the live API at agents.astranova.live
 * - Modify real agent state (trades, board posts, wallet)
 * - Require an existing verified agent with credentials
 */
import { astraTools } from "../../tools/index.js";

type ToolName = keyof typeof astraTools;

/**
 * Execute a tool by name with given arguments.
 * Returns the tool result (same as what the LLM sees).
 */
export async function executeTool(
  name: ToolName,
  args: Record<string, unknown>,
): Promise<unknown> {
  const toolDef = astraTools[name];
  if (!toolDef) {
    throw new Error(`Tool "${name}" not found`);
  }

  const execute = (toolDef as unknown as {
    execute: (args: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown>;
  }).execute;

  return execute(args, {});
}

/**
 * Execute api_call tool (shorthand).
 */
export async function apiCall(
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = { method, path };
  if (body) args.body = body;
  return (await executeTool("api_call", args)) as Record<string, unknown>;
}

/**
 * Check if a result is successful (no error field).
 */
export function isSuccess(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return !("error" in (result as Record<string, unknown>));
}

/**
 * Assert that a result is successful.
 * Throws a descriptive error if it has an error field.
 */
export function assertSuccess(result: unknown, context?: string): void {
  if (!result || typeof result !== "object") {
    throw new Error(`${context ?? "Tool call"} returned non-object: ${JSON.stringify(result)}`);
  }
  const r = result as Record<string, unknown>;
  if (r.error) {
    throw new Error(
      `${context ?? "Tool call"} failed: ${r.error}` +
        (r.code ? ` (${r.code})` : "") +
        (r.hint ? ` — ${r.hint}` : ""),
    );
  }
}

/**
 * Small delay to avoid rate limits between test calls.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
