import { tool } from "ai";
import { apiCallSchema } from "./schemas.js";
import { apiCall } from "../utils/http.js";
import {
  getActiveAgent,
  markBoardPosted,
  savePendingClaim,
  loadPendingClaim,
  clearPendingClaim,
} from "../config/store.js";

const DEBUG = !!process.env.ASTRA_DEBUG;
function debugLog(msg: string): void {
  if (DEBUG) process.stderr.write(`[astra] ${msg}\n`);
}

/**
 * Allowed API path prefixes — defense in depth.
 * The LLM can only call AstraNova API paths, not arbitrary URLs.
 */
const ALLOWED_PATH_PREFIXES = ["/api/v1/", "/health"];

function isAllowedPath(path: string): boolean {
  return ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Resolve the body from tool call arguments.
 *
 * LLMs using the Codex Responses API sometimes send args in unexpected formats:
 * 1. Correct: { method, path, body: { message: "..." } }
 * 2. Flattened: { method, path, message: "..." }
 * 3. String body: { method, path, body: '{"message":"..."}' }
 * 4. Null body: { method, path, body: null, message: "..." }
 *
 * This function normalizes all cases into a proper body object.
 */
function resolveBody(
  body: unknown,
  rest: Record<string, unknown>,
  method: string,
): Record<string, unknown> | undefined {
  // Case 1: body is a proper object
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }

  // Case 3: body is a JSON string
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not valid JSON — fall through
    }
  }

  // Case 2 & 4: body missing/null, check for flattened params
  if (Object.keys(rest).length > 0 && method !== "GET") {
    debugLog(`api_call: recovering flattened body: ${JSON.stringify(rest)}`);
    return rest;
  }

  return undefined;
}

/**
 * api_call tool — calls the AstraNova Agent API.
 *
 * - Restricts paths to /api/v1/* and /health only.
 * - Injects Authorization header from stored credentials.
 * - Returns parsed JSON response or structured error.
 * - Handles LLMs that flatten body params or send body as a string.
 */
export const apiCallTool = tool({
  description:
    "Call the AstraNova Agent API. Use this for all API interactions — registration, trading, market data, portfolio, rewards, board posts, and verification. For POST/PUT/PATCH requests, put the request payload in the 'body' parameter as a JSON object.",
  parameters: apiCallSchema,
  execute: async (args) => {
    const { method, path, body, ...rest } = args as {
      method: "GET" | "POST" | "PUT" | "PATCH";
      path: string;
      body?: unknown;
      [key: string]: unknown;
    };

    // Guard against undefined path
    if (!path || typeof path !== "string") {
      return {
        error: "Missing 'path' parameter. Example: /api/v1/agents/me",
      };
    }

    // Path restriction — LLM cannot call arbitrary endpoints
    if (!isAllowedPath(path)) {
      return {
        error: `Path "${path}" is not allowed. Only /api/v1/* and /health paths are permitted.`,
      };
    }

    debugLog(`api_call raw: method=${method} path=${path} body=${JSON.stringify(body)} bodyType=${typeof body} rest=${JSON.stringify(rest)}`);
    let resolvedBody = resolveBody(body, rest, method);

    // GET requests cannot have a body — convert to query string params
    let resolvedPath = path;
    if (method === "GET" && resolvedBody) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(resolvedBody)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) {
        resolvedPath += (path.includes("?") ? "&" : "?") + qs;
      }
      resolvedBody = undefined;
    }

    debugLog(`api_call resolved: ${method} ${resolvedPath} body=${JSON.stringify(resolvedBody)}`);

    const agentName = getActiveAgent();

    // Retry safe calls, skip retry for non-idempotent ones (trades, board, register, claim)
    const noRetryPaths = ["/api/v1/trades", "/api/v1/board", "/api/v1/agents/register", "/api/v1/agents/me/rewards/claim"];
    const isRetryable = method === "GET" || method === "PUT"
      || !noRetryPaths.some((p) => path.startsWith(p));
    const retryOpts = isRetryable ? {} : false as const;

    const isClaimPath = method === "POST" && path.startsWith("/api/v1/agents/me/rewards/claim");
    const result = await apiCall(method, resolvedPath, resolvedBody, agentName ?? undefined, retryOpts);

    if (!result.ok) {
      // ── 409 on claim: try to recover cached blob ──
      if (isClaimPath && result.status === 409 && agentName) {
        const cached = loadPendingClaim(agentName);
        if (cached) {
          const now = Date.now();
          const expires = new Date(cached.expiresAt).getTime();
          const isFresh = expires > now + 120_000; // 2-min safety buffer

          if (isFresh && cached.retryCount < 3) {
            cached.retryCount++;
            savePendingClaim(agentName, cached);
            debugLog(`api_call: recovered cached claim blob (retry #${cached.retryCount})`);
            return {
              success: true,
              transaction: cached.transaction,
              expiresAt: cached.expiresAt,
              _recovered: true,
              message: `Recovered pending claim from cache (attempt ${cached.retryCount}/3). Proceed to sign and submit.`,
            };
          }

          // Expired or too many retries — clear and give actionable error
          clearPendingClaim(agentName);
          if (!isFresh) {
            return {
              error: "The previous pending claim has expired.",
              hint: "Request a fresh claim — the expired one has been cleared.",
            };
          }
          return {
            error: "Claim has failed 3 times with the same transaction blob.",
            hint: "Ask the user what they'd like to do. The pending claim has been cleared so a fresh one can be requested.",
          };
        }
      }

      return {
        error: result.error,
        status: result.status,
        code: result.code,
        hint: result.hint,
      };
    }

    // ── Cache blob on successful claim ──
    if (isClaimPath && agentName) {
      const data = result.data as Record<string, unknown>;
      if (data.transaction && data.expiresAt) {
        savePendingClaim(agentName, {
          seasonId: (resolvedBody?.seasonId as string) ?? "",
          transaction: data.transaction as string,
          expiresAt: data.expiresAt as string,
          cachedAt: new Date().toISOString(),
          retryCount: 0,
        });
        debugLog("api_call: cached claim blob for retry recovery");
      }
    }

    // Auto-track board post flag
    if (method === "POST" && path === "/api/v1/board" && agentName) {
      markBoardPosted(agentName);
    }

    return result.data;
  },
});
