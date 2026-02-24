/**
 * Custom Codex provider — raw SSE streaming to chatgpt.com/backend-api/codex.
 *
 * The Vercel AI SDK's `.responses()` provider cannot parse the Codex backend's
 * SSE format correctly (textStream returns 0 chunks, result.text hangs).
 * This module handles the raw API interaction directly.
 */

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex/responses";

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
}

/**
 * Call the Codex Responses API with streaming.
 *
 * Returns the full text response and any tool calls.
 * Text chunks are streamed via the onTextChunk callback.
 */
export async function callCodex(params: {
  accessToken: string;
  model: string;
  instructions: string;
  input: CodexInputItem[];
  tools?: CodexTool[];
  abortSignal?: AbortSignal;
  callbacks?: CodexStreamCallbacks;
}): Promise<CodexResult> {
  const { accessToken, model, instructions, input, tools, abortSignal, callbacks } = params;

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

  const response = await fetch(CODEX_BASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: abortSignal,
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
    throw new Error(`Codex API error: ${detail}`);
  }

  if (!response.body) {
    throw new Error("Codex API returned no response body");
  }

  return parseSSEStream(response.body, callbacks);
}

/**
 * Parse the SSE stream from the Codex Responses API.
 *
 * Events we care about:
 * - response.output_text.delta → text chunk
 * - response.function_call_arguments.delta → tool call argument chunk
 * - response.output_item.added → detect new tool call items
 * - response.completed → done
 */
async function parseSSEStream(
  body: ReadableStream<Uint8Array>,
  callbacks?: CodexStreamCallbacks,
): Promise<CodexResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  let fullText = "";
  const toolCalls: Map<string, { itemId: string; callId: string; name: string; args: string }> = new Map();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

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
                callbacks?.onToolCallStart?.(event.item.name);
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
              if (event.item_id) {
                const tc = toolCalls.get(event.item_id);
                if (tc) {
                  callbacks?.onToolCallEnd?.(tc.name);
                }
              }
              break;

            // Ignore other events (response.created, response.in_progress, etc.)
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    text: fullText,
    toolCalls: Array.from(toolCalls.values()).map((tc) => ({
      id: tc.itemId,
      callId: tc.callId,
      name: tc.name,
      arguments: tc.args,
    })),
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
