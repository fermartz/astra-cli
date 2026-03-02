import { streamText, generateText, type CoreMessage, type TextPart, type ToolCallPart, type ToolResultPart } from "ai";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodType } from "zod";
import { getModel, isCodexOAuth, isOpenAIResponses, getCodexAccessToken, getOpenAIApiKey } from "./provider.js";
import { buildSystemPrompt, type AgentProfile } from "./system-prompt.js";
import { buildAstraTools } from "../tools/index.js";
import { callCodex, callCodexWithRetry, convertToolsForCodex, type CodexInputItem } from "./codex-provider.js";
import { loadConfig } from "../config/store.js";
import { writeAuditEntry } from "../utils/audit.js";
import {
  estimateTokens,
  needsCompaction,
  compactMessages,
  forceCompact,
  isContextLengthError,
  COMPACTION_PROMPT,
} from "./compaction.js";

/** Maximum time (ms) for a single agent turn before we abort (SDK path only). */
const TURN_TIMEOUT_MS = Number(process.env.ASTRA_TIMEOUT) || 180_000; // 3 minutes (configurable via ASTRA_TIMEOUT)
const IDLE_TIMEOUT_MS = 30_000; // 30s — abort if no data arrives

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
  /** If compaction occurred, the new base messages to replace the pre-compaction history. */
  compactedMessages?: CoreMessage[];
}

/**
 * Run one turn of the agent loop.
 *
 * Sends the conversation to the LLM via streamText() with tools enabled.
 * For Codex OAuth, uses a custom SSE provider (the Vercel AI SDK can't
 * parse the Codex backend's streaming format).
 *
 * Codex path: each callCodexWithRetry manages its own per-call timeout + retry.
 * SDK path: uses a single 90s timeout for the entire streamText() call.
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
  const config = loadConfig();
  const provider = config?.provider ?? "openai";

  // ── Compaction check ──────────────────────────────────────────────
  const systemPromptTokens = estimateTokens(systemPrompt);
  let compacted = false;

  if (needsCompaction(messages, systemPromptTokens, provider)) {
    debugLog("Context approaching limit — compacting...");
    const result = await compactMessages(
      messages,
      provider,
      profile,
      (msgs) => summarizeForCompaction(msgs, systemPrompt, provider, config?.model),
    );
    debugLog(`Compacted: ${result.tokensBefore} → ${result.tokensAfter} tokens`);
    messages = result.messages;
    compacted = true;
  }

  // ── Run the turn (with resilient retry) ─────────────────────────
  const runTurn = () =>
    isCodexOAuth()
      ? runCodexTurn(messages, systemPrompt, callbacks, config)
      : isOpenAIResponses()
        ? runOpenAIResponsesTurn(messages, systemPrompt, callbacks, config)
        : runSdkTurn(messages, systemPrompt, callbacks);

  let result: AgentLoopResult;
  try {
    result = await runTurn();
  } catch (error) {
    // Context-length error fallback — emergency compaction without LLM
    if (isContextLengthError(error) && !compacted) {
      debugLog("Context length error — emergency compaction");
      messages = forceCompact(messages, profile);
      compacted = true;
      result = await runTurn();
    } else {
      throw error;
    }
  }

  // ── Resilient retry on empty/broken response ──────────────────
  if (isEmptyResponse(result) && !compacted) {
    debugLog("Empty response from LLM — retrying with nudge");
    callbacks.onTextChunk("\n\nHold on, let me try that again...\n\n");

    // Add a nudge message so the LLM has a fresh signal
    messages = [
      ...messages,
      { role: "assistant", content: "(My previous response was empty — retrying.)" } as CoreMessage,
      { role: "user", content: "Please continue — I'm waiting for your response." } as CoreMessage,
    ];

    try {
      const retry = isCodexOAuth()
        ? await runCodexTurn(messages, systemPrompt, callbacks, config)
        : isOpenAIResponses()
          ? await runOpenAIResponsesTurn(messages, systemPrompt, callbacks, config)
          : await runSdkTurn(messages, systemPrompt, callbacks);

      if (!isEmptyResponse(retry)) {
        result = retry;
      }
    } catch (retryError) {
      debugLog(`Retry also failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
      // Fall through — return the original empty result
    }
  }

  // Attach compacted base if compaction occurred
  if (compacted) {
    result.compactedMessages = messages;
  }

  return result;
}

// ─── Responses API Turns (Codex OAuth + OpenAI API key) ─────────────────

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

/** Configuration for a Responses API turn (shared by Codex and OpenAI paths). */
interface ResponsesTurnConfig {
  model: string;
  baseUrl?: string;
  getAccessToken: () => Promise<string>;
  onTokenExpired?: () => Promise<string>;
}

/** Codex OAuth turn — delegates to shared Responses API turn with OAuth token refresh. */
async function runCodexTurn(
  messages: CoreMessage[],
  systemPrompt: string,
  callbacks: AgentLoopCallbacks,
  config?: ReturnType<typeof loadConfig>,
): Promise<AgentLoopResult> {
  return runResponsesApiTurn(messages, systemPrompt, callbacks, {
    model: config?.model ?? "gpt-5.3-codex",
    getAccessToken: () => getCodexAccessToken(),
    onTokenExpired: () => getCodexAccessToken(),
  });
}

/** OpenAI Responses API turn — same protocol, static API key, public endpoint. */
async function runOpenAIResponsesTurn(
  messages: CoreMessage[],
  systemPrompt: string,
  callbacks: AgentLoopCallbacks,
  config?: ReturnType<typeof loadConfig>,
): Promise<AgentLoopResult> {
  const apiKey = getOpenAIApiKey();
  return runResponsesApiTurn(messages, systemPrompt, callbacks, {
    model: config?.model ?? "gpt-4o-mini",
    baseUrl: OPENAI_RESPONSES_URL,
    getAccessToken: async () => apiKey,
    // No onTokenExpired — API keys don't expire
  });
}

/**
 * Shared Responses API turn — handles the tool execution loop.
 *
 * Used by both Codex OAuth (chatgpt.com backend) and OpenAI API key
 * (api.openai.com/v1/responses). Same SSE format, same tool calling,
 * same request body — only the base URL and auth differ.
 */
async function runResponsesApiTurn(
  messages: CoreMessage[],
  systemPrompt: string,
  callbacks: AgentLoopCallbacks,
  turnConfig: ResponsesTurnConfig,
): Promise<AgentLoopResult> {
  // No outer timeout — each callCodexWithRetry manages its own per-call timeout + retry.
  const { model, baseUrl, getAccessToken, onTokenExpired } = turnConfig;

  // Build the active tool set for this turn (filtered by plugin manifest)
  const tools = buildAstraTools();

  // Convert CoreMessage[] to Codex input items — preserve tool call context
  const codexInput: CodexInputItem[] = convertToCodexInput(messages);

  // Convert tools to Responses API format — extract JSON schema from Zod-based tools
  const codexTools = convertToolsForCodex(
    Object.fromEntries(
      Object.entries(tools).map(([name, t]) => [
        name,
        {
          description: (t as { description?: string }).description,
          parameters: extractJsonSchema(t),
        },
      ]),
    ),
  );

  // Track structured response messages for session persistence
  const responseMessages: CoreMessage[] = [];

  // First call
  let accessToken = await getAccessToken();
  let result = await callCodexWithRetry({
    accessToken,
    model,
    instructions: systemPrompt,
    input: codexInput,
    tools: codexTools,
    callbacks,
    baseUrl,
    onTokenExpired,
  });

  // Track only the latest response text (don't accumulate across steps — avoids duplication)
  let finalText = result.text;

  // Handle incomplete responses
  if (result.incomplete) {
    debugLog(`Response incomplete: ${result.incompleteReason}`);
    // Discard tool calls from incomplete responses (args may be truncated)
    if (result.toolCalls.length > 0) {
      debugLog(`Discarding ${result.toolCalls.length} tool calls from incomplete response`);
      result = { ...result, toolCalls: [] };
    }
    finalText += "\n\n(Response was truncated — try a shorter message or start a new session.)";
  }

  // Handle tool calls (up to 10 steps — wallet registration needs ~6)
  let steps = 0;
  debugLog(`Response: text=${result.text.length}chars, toolCalls=${result.toolCalls.map(tc => tc.name).join(",") || "none"}`);
  while (result.toolCalls.length > 0 && steps < 10) {
    steps++;

    // Build assistant message with text + tool calls for this step
    const assistantContent: Array<TextPart | ToolCallPart> = [];
    if (result.text) {
      assistantContent.push({ type: "text", text: result.text });
    }

    // Collect tool results for this step
    const toolResultParts: Array<ToolResultPart> = [];

    // Execute each tool call
    for (const tc of result.toolCalls) {
      const toolDef = tools[tc.name as keyof typeof tools];

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
          toolName: tc.name,
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
          toolName: tc.name,
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
          toolName: tc.name,
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
    accessToken = await getAccessToken();
    result = await callCodexWithRetry({
      accessToken,
      model,
      instructions: systemPrompt,
      input: codexInput,
      tools: codexTools,
      callbacks,
      baseUrl,
      onTokenExpired,
    });

    // Overwrite — only keep the latest step's text
    finalText = result.text;

    // Handle incomplete responses mid-loop
    if (result.incomplete) {
      debugLog(`Step ${steps} incomplete: ${result.incompleteReason}`);
      if (result.toolCalls.length > 0) {
        debugLog(`Discarding ${result.toolCalls.length} tool calls from incomplete response`);
        result = { ...result, toolCalls: [] };
      }
      finalText += "\n\n(Response was truncated — try a shorter message or start a new session.)";
    }

    debugLog(`Step ${steps}: text=${result.text.length}chars, toolCalls=${result.toolCalls.map(tc => tc.name).join(",") || "none"}`);
  }

  debugLog(`Responses loop done after ${steps} steps, finalText=${finalText.length}chars`);
  let text = finalText;

  // Tools ran but model returned no summary text — retry the final call once.
  // The tool results are already in codexInput, so the LLM just needs to summarize.
  if (!text && steps > 0) {
    debugLog("Tools ran but no summary text — nudging model for a summary");
    codexInput.push({ role: "user", content: "Please summarize what just happened." });
    accessToken = await getAccessToken();
    const summaryRetry = await callCodexWithRetry({
      accessToken,
      model,
      instructions: systemPrompt,
      input: codexInput,
      tools: codexTools,
      callbacks,
      baseUrl,
      onTokenExpired,
    });
    text = summaryRetry.text;
  }

  if (!text && steps > 0) {
    text = "I ran the requested action but the model returned no summary. Please try asking again.";
  } else if (!text) {
    text = "(No response from model)";
  }

  // Add final text-only assistant message
  responseMessages.push({ role: "assistant", content: text });

  return { text, responseMessages };
}

// ─── SDK Turn (Claude, OpenAI API key, Gemini) ────────────────────────

async function runSdkTurn(
  messages: CoreMessage[],
  systemPrompt: string,
  callbacks: AgentLoopCallbacks,
): Promise<AgentLoopResult> {
  debugLog(`SDK turn starting — getting model...`);
  const model = await getModel();
  const tools = buildAstraTools();
  debugLog(`Model ready: ${model.modelId ?? "unknown"} — calling streamText...`);

  const abortController = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOutBy: "overall" | "idle" | undefined;

  const overallTimer = setTimeout(() => {
    debugLog("SDK turn timeout — aborting after overall timeout");
    timedOutBy = "overall";
    abortController.abort();
  }, TURN_TIMEOUT_MS);

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      debugLog("SDK turn idle timeout — no data for 30s, aborting");
      timedOutBy = "idle";
      abortController.abort();
    }, IDLE_TIMEOUT_MS);
  };

  try {
    const result = streamText({
      model,
      system: systemPrompt,
      messages,
      tools,
      maxSteps: 10,
      temperature: 0.7,
      abortSignal: abortController.signal,
      onStepFinish: ({ toolCalls, toolResults }) => {
        resetIdleTimer();
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

    // Create a promise that rejects when abort fires — used to race against SDK calls
    const abortPromise = new Promise<never>((_, reject) => {
      abortController.signal.addEventListener("abort", () => {
        const label = timedOutBy === "idle"
          ? `No response for ${IDLE_TIMEOUT_MS / 1000}s`
          : `Response timed out after ${TURN_TIMEOUT_MS / 1000}s`;
        reject(new Error(`${label}. Please try again.`));
      });
    });

    debugLog("streamText created — consuming textStream...");
    resetIdleTimer(); // Start idle timer when stream begins

    // Race stream consumption against abort
    await Promise.race([
      (async () => {
        for await (const chunk of result.textStream) {
          resetIdleTimer();
          callbacks.onTextChunk(chunk);
        }
      })(),
      abortPromise,
    ]);
    debugLog("textStream consumed — awaiting response...");

    const response = await Promise.race([result.response, abortPromise]);
    const text = await Promise.race([result.text, abortPromise]);
    debugLog(`SDK turn done — text=${(text as string).length}chars, messages=${response.messages.length}`);

    return {
      text: (text as string) || "(No response from LLM)",
      responseMessages: response.messages as CoreMessage[],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`SDK turn error: ${message}`);
    throw error;
  } finally {
    clearTimeout(overallTimer);
    if (idleTimer) clearTimeout(idleTimer);
  }
}

// ─── Codex Input Conversion ──────────────────────────────────────────

/**
 * Convert CoreMessage[] to CodexInputItem[] for the Codex Responses API.
 * Handles user/assistant text, tool-call parts, and tool-result parts.
 */
export function convertToCodexInput(messages: CoreMessage[]): CodexInputItem[] {
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
            // Codex API requires `id` to start with "fc_" — generate one if needed
            const fcId = tc.toolCallId.startsWith("fc_") ? tc.toolCallId : `fc_${tc.toolCallId}`;
            codexInput.push({
              type: "function_call",
              id: fcId,
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
  return codexInput;
}

// ─── Summarization for Compaction ────────────────────────────────────

/**
 * Call the LLM to generate a compaction summary (no tools).
 * Routes to SDK or Codex depending on provider.
 */
async function summarizeForCompaction(
  messages: CoreMessage[],
  systemPrompt: string,
  provider: string,
  modelName?: string,
): Promise<string> {
  const summaryInstruction = `${systemPrompt}\n\n---\n\n${COMPACTION_PROMPT}`;

  if (provider === "openai-oauth") {
    // Codex path — use callCodex directly (no tools, no retry needed for summary)
    const accessToken = await getCodexAccessToken();
    const codexInput = convertToCodexInput(messages);
    const result = await callCodex({
      accessToken,
      model: modelName ?? "gpt-5.3-codex",
      instructions: summaryInstruction,
      input: codexInput,
      timeoutMs: 60_000,
    });
    return result.text || "No summary generated.";
  }

  if (provider === "openai") {
    // OpenAI Responses API path — same protocol, different URL/auth
    const apiKey = getOpenAIApiKey();
    const codexInput = convertToCodexInput(messages);
    const result = await callCodex({
      accessToken: apiKey,
      model: modelName ?? "gpt-4o-mini",
      instructions: summaryInstruction,
      input: codexInput,
      timeoutMs: 60_000,
      baseUrl: OPENAI_RESPONSES_URL,
    });
    return result.text || "No summary generated.";
  }

  // SDK path — use generateText (no streaming needed)
  const model = await getModel();
  const result = await generateText({
    model,
    system: summaryInstruction,
    messages,
    temperature: 0.3,
  });
  return result.text || "No summary generated.";
}

// ─── Response Validation ─────────────────────────────────────────────

/** Sentinel texts that indicate the LLM returned nothing useful. */
const EMPTY_SENTINELS = [
  "(No response from model)",
  "(No response from LLM)",
  "I ran the requested action but the model returned no summary.",
];

/** Check if an AgentLoopResult is effectively empty / broken. */
function isEmptyResponse(result: AgentLoopResult): boolean {
  if (!result.text) return true;
  const t = result.text.trim();
  return EMPTY_SENTINELS.some((s) => t === s || t.startsWith(s));
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
    } catch (e) {
      process.stderr.write(
        `Warning: Failed to convert tool schema to JSON Schema: ${e instanceof Error ? e.message : "unknown error"}\n`,
      );
      return {};
    }
  }

  // Not a Zod schema — try using it directly as JSON Schema
  if (typeof t.parameters === "object") {
    return t.parameters as Record<string, unknown>;
  }

  return {};
}
