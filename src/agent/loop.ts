import { streamText, type CoreMessage } from "ai";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodType } from "zod";
import { getModel, isCodexOAuth, getCodexAccessToken } from "./provider.js";
import { buildSystemPrompt, type AgentProfile } from "./system-prompt.js";
import { astraTools } from "../tools/index.js";
import { callCodex, convertToolsForCodex, type CodexInputItem } from "./codex-provider.js";
import { loadConfig } from "../config/store.js";
import { writeAuditEntry } from "../utils/audit.js";

/** Maximum time (ms) for a single agent turn before we abort. */
const TURN_TIMEOUT_MS = 90_000; // 90 seconds

/** Debug logging — only outputs when ASTRA_DEBUG env var is set. */
const DEBUG = !!process.env.ASTRA_DEBUG;
function debugLog(msg: string): void {
  if (DEBUG) process.stderr.write(`[astra] ${msg}\n`);
}

export interface AgentLoopCallbacks {
  /** Called with each text chunk as the LLM streams its response. */
  onTextChunk: (chunk: string) => void;
  /** Called when the LLM starts a tool call. */
  onToolCallStart?: (toolName: string) => void;
  /** Called when a tool call completes. */
  onToolCallEnd?: (toolName: string) => void;
}

export interface AgentLoopResult {
  /** The complete assistant text response. */
  text: string;
  /** Messages to append to conversation history (assistant + tool results). */
  responseMessages: CoreMessage[];
}

/**
 * Run one turn of the agent loop.
 *
 * Sends the conversation to the LLM via streamText() with tools enabled.
 * For Codex OAuth, uses a custom SSE provider (the Vercel AI SDK can't
 * parse the Codex backend's streaming format).
 *
 * Includes a 90-second timeout to prevent hanging.
 */
export async function runAgentTurn(
  messages: CoreMessage[],
  skillContext: string,
  tradingContext: string,
  walletContext: string,
  rewardsContext: string,
  onboardingContext: string,
  apiContext: string,
  profile: AgentProfile,
  callbacks: AgentLoopCallbacks,
  memoryContent?: string,
): Promise<AgentLoopResult> {
  const systemPrompt = buildSystemPrompt(skillContext, tradingContext, walletContext, rewardsContext, onboardingContext, apiContext, profile, memoryContent);

  // Route to the appropriate provider
  if (isCodexOAuth()) {
    return runCodexTurn(messages, systemPrompt, callbacks);
  }
  return runSdkTurn(messages, systemPrompt, callbacks);
}

// ─── Codex OAuth Turn (custom SSE) ──────────────────────────────────────

async function runCodexTurn(
  messages: CoreMessage[],
  systemPrompt: string,
  callbacks: AgentLoopCallbacks,
): Promise<AgentLoopResult> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), TURN_TIMEOUT_MS);

  try {
    const accessToken = await getCodexAccessToken();
    const config = loadConfig();
    const model = config?.model ?? "gpt-5.3-codex";

    // Convert CoreMessage[] to Codex input items — preserve tool call context
    const codexInput: CodexInputItem[] = [];
    for (const m of messages) {
      if (m.role === "user" || m.role === "assistant") {
        // Assistant messages with tool_calls content parts need special handling
        if (m.role === "assistant" && Array.isArray(m.content)) {
          // Extract text parts as assistant message
          const textParts = m.content.filter(
            (p): p is { type: "text"; text: string } => p.type === "text",
          );
          if (textParts.length > 0) {
            codexInput.push({
              role: "assistant",
              content: textParts.map((p) => p.text).join(""),
            });
          }
          // Extract tool-call parts as function_call items
          for (const part of m.content) {
            if (part.type === "tool-call") {
              const tc = part as { type: "tool-call"; toolCallId: string; toolName: string; args: unknown };
              codexInput.push({
                type: "function_call",
                id: tc.toolCallId,
                call_id: tc.toolCallId,
                name: tc.toolName,
                arguments: JSON.stringify(tc.args),
              });
            }
          }
        } else {
          codexInput.push({
            role: m.role as "user" | "assistant",
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          });
        }
      } else if (m.role === "tool") {
        // Tool result messages — map to function_call_output
        if (Array.isArray(m.content)) {
          for (const part of m.content) {
            if (part.type === "tool-result") {
              const tr = part as { type: "tool-result"; toolCallId: string; result: unknown };
              codexInput.push({
                type: "function_call_output",
                call_id: tr.toolCallId,
                output: JSON.stringify(tr.result),
              });
            }
          }
        }
      }
    }

    // Convert tools to Codex format — extract JSON schema from Zod-based tools
    const codexTools = convertToolsForCodex(
      Object.fromEntries(
        Object.entries(astraTools).map(([name, t]) => [
          name,
          {
            description: (t as { description?: string }).description,
            parameters: extractJsonSchema(t),
          },
        ]),
      ),
    );

    // Accumulate text and structured response messages for session persistence
    let accumulatedText = "";
    const responseMessages: CoreMessage[] = [];

    // First call
    let result = await callCodex({
      accessToken,
      model,
      instructions: systemPrompt,
      input: codexInput,
      tools: codexTools,
      abortSignal: abortController.signal,
      callbacks,
    });
    accumulatedText += result.text;

    // Handle tool calls (up to 10 steps — wallet registration needs ~6)
    let steps = 0;
    debugLog(`Codex response: text=${result.text.length}chars, toolCalls=${result.toolCalls.map(tc => tc.name).join(",") || "none"}`);
    while (result.toolCalls.length > 0 && steps < 10) {
      steps++;

      // Build assistant message with text + tool calls for this step
      const assistantContent: Array<{ type: string; [key: string]: unknown }> = [];
      if (result.text) {
        assistantContent.push({ type: "text", text: result.text });
      }

      // Collect tool results for this step
      const toolResultParts: Array<{ type: string; [key: string]: unknown }> = [];

      // Execute each tool call
      for (const tc of result.toolCalls) {
        const toolDef = astraTools[tc.name as keyof typeof astraTools];

        // Add tool-call part to assistant message
        let parsedArgs: Record<string, unknown> = {};
        try { parsedArgs = JSON.parse(tc.arguments) as Record<string, unknown>; } catch { /* use empty */ }

        assistantContent.push({
          type: "tool-call",
          toolCallId: tc.callId,
          toolName: tc.name,
          args: parsedArgs,
        });

        if (!toolDef) {
          const errorResult = { error: `Tool "${tc.name}" not found.` };
          toolResultParts.push({
            type: "tool-result",
            toolCallId: tc.callId,
            result: errorResult,
          });
          codexInput.push({
            type: "function_call",
            id: tc.id,
            call_id: tc.callId,
            name: tc.name,
            arguments: tc.arguments,
          });
          codexInput.push({
            type: "function_call_output",
            call_id: tc.callId,
            output: JSON.stringify(errorResult),
          });
          continue;
        }

        callbacks.onToolCallStart?.(tc.name);
        const startTime = Date.now();

        try {
          debugLog(`Tool ${tc.name}(${tc.callId}) args: ${JSON.stringify(parsedArgs)}`);
          const execute = (toolDef as unknown as { execute: (args: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown> }).execute;
          const toolResult = await execute(parsedArgs, {});
          debugLog(`Tool ${tc.name}(${tc.callId}) result: ${JSON.stringify(toolResult).slice(0, 200)}`);

          writeAuditEntry({
            ts: new Date().toISOString(),
            tool: tc.name,
            args: parsedArgs,
            result: toolResult,
            ok: !(toolResult as Record<string, unknown>)?.error,
            durationMs: Date.now() - startTime,
          });

          callbacks.onToolCallEnd?.(tc.name);

          toolResultParts.push({
            type: "tool-result",
            toolCallId: tc.callId,
            result: toolResult,
          });
          codexInput.push({
            type: "function_call",
            id: tc.id,
            call_id: tc.callId,
            name: tc.name,
            arguments: tc.arguments,
          });
          codexInput.push({
            type: "function_call_output",
            call_id: tc.callId,
            output: JSON.stringify(toolResult),
          });
        } catch (toolError: unknown) {
          callbacks.onToolCallEnd?.(tc.name);

          const errMsg = toolError instanceof Error ? toolError.message : "Tool execution failed";
          debugLog(`Tool ${tc.name}(${tc.callId}) error: ${errMsg}`);
          const errorResult = { error: errMsg };

          writeAuditEntry({
            ts: new Date().toISOString(),
            tool: tc.name,
            args: parsedArgs,
            result: errorResult,
            ok: false,
            durationMs: Date.now() - startTime,
          });

          toolResultParts.push({
            type: "tool-result",
            toolCallId: tc.callId,
            result: errorResult,
          });
          codexInput.push({
            type: "function_call",
            id: tc.id,
            call_id: tc.callId,
            name: tc.name,
            arguments: tc.arguments,
          });
          codexInput.push({
            type: "function_call_output",
            call_id: tc.callId,
            output: JSON.stringify(errorResult),
          });
        }
      }

      // Append structured messages for session persistence (matches SDK format)
      responseMessages.push({ role: "assistant", content: assistantContent } as CoreMessage);
      if (toolResultParts.length > 0) {
        responseMessages.push({ role: "tool", content: toolResultParts } as CoreMessage);
      }

      // Call again with tool results
      result = await callCodex({
        accessToken,
        model,
        instructions: systemPrompt,
        input: codexInput,
        tools: codexTools,
        abortSignal: abortController.signal,
        callbacks,
      });
      accumulatedText += result.text;
      debugLog(`Codex step ${steps}: text=${result.text.length}chars, toolCalls=${result.toolCalls.map(tc => tc.name).join(",") || "none"}`);
    }

    debugLog(`Codex loop done after ${steps} steps, totalText=${accumulatedText.length}chars`);
    const text = accumulatedText || "(No text response)";

    // Add final text-only assistant message
    responseMessages.push({ role: "assistant", content: text });

    return { text, responseMessages };
  } catch (error: unknown) {
    clearTimeout(timeout);

    if (abortController.signal.aborted) {
      throw new Error("Response timed out after 90 seconds. Please try again.");
    }

    const message = error instanceof Error ? error.message : String(error);
    debugLog(`Codex error: ${message}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── SDK Turn (Claude, OpenAI API key, Gemini) ────────────────────────

async function runSdkTurn(
  messages: CoreMessage[],
  systemPrompt: string,
  callbacks: AgentLoopCallbacks,
): Promise<AgentLoopResult> {
  const model = await getModel();

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), TURN_TIMEOUT_MS);

  try {
    const result = streamText({
      model,
      system: systemPrompt,
      messages,
      tools: astraTools,
      maxSteps: 10,
      temperature: 0.7,
      abortSignal: abortController.signal,
      onStepFinish: ({ toolCalls, toolResults }) => {
        if (toolCalls && toolCalls.length > 0) {
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            const tr = toolResults?.[i];
            callbacks.onToolCallEnd?.(tc.toolName);
            writeAuditEntry({
              ts: new Date().toISOString(),
              tool: tc.toolName,
              args: tc.args,
              result: tr?.result,
              ok: !(tr?.result as Record<string, unknown>)?.error,
              durationMs: 0, // not available from SDK callback
            });
          }
        }
      },
    });

    for await (const chunk of result.textStream) {
      callbacks.onTextChunk(chunk);
    }

    const response = await result.response;
    const text = await result.text;

    return {
      text: text || "(No response from LLM)",
      responseMessages: response.messages as CoreMessage[],
    };
  } catch (error: unknown) {
    clearTimeout(timeout);

    if (abortController.signal.aborted) {
      throw new Error("Response timed out after 90 seconds. Please try again.");
    }

    const message = error instanceof Error ? error.message : String(error);
    debugLog(`Agent loop error: ${message}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract JSON schema from a Vercel AI SDK tool definition.
 * Tools defined with tool({ parameters: z.object({...}) }) store a Zod schema
 * in the parameters property. We convert it to JSON Schema for the Codex API.
 */
function extractJsonSchema(toolDef: unknown): Record<string, unknown> {
  const t = toolDef as { parameters?: unknown };
  if (!t.parameters) return {};

  // Check if it's a Zod schema (has _def property)
  const params = t.parameters as { _def?: unknown };
  if (params._def) {
    try {
      return zodToJsonSchema(params as ZodType) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  return {};
}
