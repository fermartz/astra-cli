/**
 * Custom Codex provider — raw SSE streaming to chatgpt.com/backend-api/codex.
 *
 * The Vercel AI SDK's `.responses()` provider cannot parse the Codex backend's
 * SSE format correctly (textStream returns 0 chunks, result.text hangs).
 * This module handles the raw API interaction directly.
 */

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex/responses";

/** Debug logging — only outputs when ASTRA_DEBUG env var is set. */
const DEBUG = !!process.env.ASTRA_DEBUG;
function debugLog(msg: string): void {
  if (DEBUG) process.stderr.write(`[astra:codex] ${msg}\n`);
}

// ─── Error Classes ───────────────────────────────────────────────────

/** Typed error for Codex API stream failures (response.failed events). */
export class CodexStreamError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CodexStreamError";
  }
}

// ─── Types ───────────────────────────────────────────────────────────

/** Tool definition in OpenAI Responses API format. */
interface CodexTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Tool call returned by the model. */
export interface CodexToolCall {
  /** The output item ID (e.g., "fc_abc123") — used in the echoed function_call's `id` field. */
  id: string;
  /** The call ID — used to match function_call_output to this call. */
  callId: string;
  name: string;
  arguments: string; // JSON string
}

/** Streaming callbacks. */
export interface CodexStreamCallbacks {
  onTextChunk?: (chunk: string) => void;
  onToolCallStart?: (name: string) => void;
  onToolCallEnd?: (name: string) => void;
}

/**
 * Input item for the Codex Responses API.
 *
 * Supports:
 * - Role-based messages (user/assistant text)
 * - function_call items (model's tool call, echoed back for context)
 * - function_call_output items (tool execution results)
 */
export type CodexInputItem =
  | { role: "user" | "assistant"; content: string }
  | { type: "function_call"; id: string; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/** Result of a Codex API call. */
export interface CodexResult {
  text: string;
  toolCalls: CodexToolCall[];
  incomplete?: boolean;
  incompleteReason?: string;
}

// ─── Core API Call ───────────────────────────────────────────────────

/**
 * Call the Codex Responses API with streaming.
 *
 * Returns the full text response and any tool calls.
 * Text chunks are streamed via the onTextChunk callback.
 * Includes a per-call timeout (default 90s).
 */
export async function callCodex(params: {
  accessToken: string;
  model: string;
  instructions: string;
  input: CodexInputItem[];
  tools?: CodexTool[];
  abortSignal?: AbortSignal;
  callbacks?: CodexStreamCallbacks;
  timeoutMs?: number;
  baseUrl?: string;
}): Promise<CodexResult> {
  const { accessToken, model, instructions, input, tools, abortSignal, callbacks, timeoutMs = 90_000, baseUrl = CODEX_BASE_URL } = params;

  // Per-call timeout via internal AbortController
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Chain caller's abort signal if provided
  if (abortSignal) {
    if (abortSignal.aborted) {
      clearTimeout(timeout);
      controller.abort();
    } else {
      abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  try {
    const body: Record<string, unknown> = {
      model,
      instructions,
      input,
      store: false,
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      let detail = `HTTP ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText) as { detail?: string; error?: { message?: string } };
        detail = errorJson.detail ?? errorJson.error?.message ?? detail;
      } catch {
        // Use raw text if not JSON
        if (errorText) detail = errorText.slice(0, 200);
      }
      throw new Error(`Responses API error: ${detail}`);
    }

    if (!response.body) {
      throw new Error("Responses API returned no response body");
    }

    return await parseSSEStream(response.body, callbacks);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Retry Wrapper ───────────────────────────────────────────────────

const CODEX_RETRY_ATTEMPTS = 3;
const CODEX_RETRY_BASE_MS = 1000;
const CODEX_RETRY_MAX_MS = 15000;
const CODEX_RETRY_JITTER = 0.3;

/**
 * Call Codex with automatic retry on transient failures.
 *
 * Retries on: 429, 5xx, network errors, stream stalls, retryable stream errors.
 * On 401, attempts a single token refresh via onTokenExpired callback.
 * Non-retryable errors (quota, context_length) bail immediately.
 */
export async function callCodexWithRetry(
  params: Parameters<typeof callCodex>[0] & {
    onTokenExpired?: () => Promise<string>;
  },
): Promise<CodexResult> {
  let lastError: Error | null = null;
  let currentToken = params.accessToken;

  for (let attempt = 1; attempt <= CODEX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await callCodex({ ...params, accessToken: currentToken });
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message.toLowerCase();

      // 401 — try refreshing token once
      if (msg.includes("401") && attempt === 1 && params.onTokenExpired) {
        debugLog(`Codex 401 — refreshing token and retrying`);
        currentToken = await params.onTokenExpired();
        continue;
      }

      // CodexStreamError from response.failed — bail on non-retryable
      if (lastError instanceof CodexStreamError && !lastError.retryable) {
        throw lastError;
      }

      // Retryable: 429, 5xx, network errors, retryable stream errors, stalled streams
      const isRetryable =
        (lastError instanceof CodexStreamError && lastError.retryable) ||
        msg.includes("429") ||
        msg.includes("rate limit") ||
        msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504") ||
        msg.includes("network") || msg.includes("fetch failed") ||
        msg.includes("connection refused") || msg.includes("upstream connect error") ||
        msg.includes("econnrefused") || msg.includes("econnreset") ||
        msg.includes("stalled");

      if (!isRetryable || attempt === CODEX_RETRY_ATTEMPTS) {
        throw lastError;
      }

      const base = Math.min(CODEX_RETRY_BASE_MS * 2 ** (attempt - 1), CODEX_RETRY_MAX_MS);
      const jitter = base * CODEX_RETRY_JITTER * (Math.random() * 2 - 1);
      const delay = Math.max(0, base + jitter);

      debugLog(`Codex retry ${attempt}/${CODEX_RETRY_ATTEMPTS}: ${lastError.message} — waiting ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError!;
}

// ─── SSE Stream Parser ──────────────────────────────────────────────

/**
 * Parse the SSE stream from the Codex Responses API.
 *
 * Events we care about:
 * - response.output_text.delta → text chunk
 * - response.function_call_arguments.delta → tool call argument chunk
 * - response.output_item.added → detect new tool call items
 * - response.failed → API error (throws CodexStreamError)
 * - response.incomplete → partial result (marks result as incomplete)
 * - response.completed → done
 *
 * Includes an idle timeout (default 45s) — if no data arrives for 45 seconds,
 * the stream is cancelled and an error is thrown (caught by retry logic).
 */
async function parseSSEStream(
  body: ReadableStream<Uint8Array>,
  callbacks?: CodexStreamCallbacks,
  idleTimeoutMs: number = 45_000,
): Promise<CodexResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  let fullText = "";
  const toolCalls: Map<string, { itemId: string; callId: string; name: string; args: string }> = new Map();
  let buffer = "";
  let incomplete = false;
  let incompleteReason: string | undefined;
  let parseFailures = 0;

  // Idle timeout — cancel stream if no data for idleTimeoutMs
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleAborted = false;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleAborted = true;
      reader.cancel("idle timeout").catch(() => {});
    }, idleTimeoutMs);
  };

  resetIdle();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;

        try {
          const event = JSON.parse(jsonStr) as {
            type: string;
            delta?: string;
            item?: {
              id?: string;
              type?: string;
              call_id?: string;
              name?: string;
            };
            output_index?: number;
            item_id?: string;
            response?: {
              status_details?: {
                error?: { code?: string; message?: string };
                reason?: string;
              };
              error?: { code?: string; message?: string };
            };
          };

          switch (event.type) {
            case "response.output_text.delta":
              if (event.delta) {
                fullText += event.delta;
                callbacks?.onTextChunk?.(event.delta);
              }
              break;

            case "response.output_item.added":
              if (event.item?.type === "function_call" && event.item.name) {
                // Key by item.id because delta events reference item_id (not call_id)
                const itemId = event.item.id ?? `fc_${toolCalls.size}`;
                const callId = event.item.call_id ?? itemId;
                toolCalls.set(itemId, {
                  itemId,
                  callId,
                  name: event.item.name,
                  args: "",
                });
                // onToolCallStart is fired by the loop-level caller (loop.ts:311),
                // not here — avoids duplicate spinner flashes.
              }
              break;

            case "response.function_call_arguments.delta":
              if (event.delta && event.item_id) {
                const tc = toolCalls.get(event.item_id);
                if (tc) {
                  tc.args += event.delta;
                }
              }
              break;

            case "response.function_call_arguments.done":
              // onToolCallEnd is fired by the loop-level caller (loop.ts:329/350),
              // not here — avoids duplicate spinner flashes.
              break;

            case "response.failed": {
              const resp = (event as Record<string, unknown>).response as Record<string, unknown> | undefined;
              const statusDetails = resp?.status_details as Record<string, unknown> | undefined;
              const errInfo = (statusDetails?.error ?? resp?.error ?? {}) as { code?: string; message?: string };
              const code = errInfo.code ?? "unknown_error";
              const msg = errInfo.message ?? "The model returned an error.";
              const retryable = ["rate_limit_exceeded", "server_error"].includes(code);
              throw new CodexStreamError(msg, code, retryable);
            }

            case "response.incomplete": {
              const resp = (event as Record<string, unknown>).response as Record<string, unknown> | undefined;
              const statusDetails = resp?.status_details as Record<string, unknown> | undefined;
              const reason = (statusDetails?.reason as string) ?? "unknown";
              incomplete = true;
              incompleteReason = reason;
              break;
            }

            // Ignore other events (response.created, response.in_progress, etc.)
          }
        } catch (e) {
          // Re-throw CodexStreamError (from response.failed handler)
          if (e instanceof CodexStreamError) throw e;
          // Count other parse failures (malformed JSON)
          parseFailures++;
          debugLog(`SSE parse failure #${parseFailures}: ${line.slice(0, 100)}`);
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    reader.releaseLock();
  }

  // Stalled stream — throw so retry logic can handle it
  if (idleAborted) {
    throw new Error("Responses API stream stalled — no data received for 45 seconds.");
  }

  // If stream produced nothing usable and had parse failures, the API format may have changed
  if (parseFailures > 0 && fullText === "" && toolCalls.size === 0) {
    throw new Error(
      `Responses API returned no usable events (${parseFailures} parse failures). The API format may have changed.`,
    );
  }

  return {
    text: fullText,
    toolCalls: Array.from(toolCalls.values()).map((tc) => ({
      id: tc.itemId,
      callId: tc.callId,
      name: tc.name,
      arguments: tc.args,
    })),
    incomplete,
    incompleteReason,
  };
}

/**
 * Convert our tool definitions (Vercel AI SDK format) to Codex Responses API format.
 */
export function convertToolsForCodex(
  tools: Record<string, { description?: string; parameters?: unknown }>,
): CodexTool[] {
  return Object.entries(tools).map(([name, def]) => ({
    type: "function" as const,
    name,
    description: def.description ?? "",
    parameters: (def.parameters ?? {}) as Record<string, unknown>,
  }));
}
