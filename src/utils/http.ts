import { loadCredentials, loadConfig } from "../config/store.js";
import { withRetry, type RetryOptions } from "./retry.js";

/** Default timeout for a single API attempt (15s when retrying, 30s without). */
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_RETRY_MS = 15_000;

export interface ApiResponse<T = unknown> {
  ok: true;
  data: T;
  status: number;
}

export interface ApiError {
  ok: false;
  status: number;
  error: string;
  code?: string;
  hint?: string;
}

export type ApiResult<T = unknown> = ApiResponse<T> | ApiError;

/**
 * Call the AstraNova Agent API.
 *
 * - Reads base URL from config (default: https://agents.astranova.live).
 * - Injects Authorization header from agent credentials when agentName is provided.
 * - Returns structured result — never throws on HTTP errors.
 * - No secrets appear in error messages.
 * - Supports automatic retry with exponential backoff (opt-in via retryOpts).
 */
export async function apiCall<T = unknown>(
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  body?: Record<string, unknown>,
  agentName?: string,
  retryOpts?: Partial<RetryOptions> | false,
): Promise<ApiResult<T>> {
  const config = loadConfig();
  const baseUrl = config?.apiBase ?? "https://agents.astranova.live";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Inject auth header if we have credentials for this agent
  if (agentName) {
    const creds = loadCredentials(agentName);
    if (creds?.api_key) {
      headers["Authorization"] = `Bearer ${creds.api_key}`;
    }
  }

  const url = `${baseUrl}${path}`;
  const willRetry = retryOpts !== false && (retryOpts?.attempts ?? 3) > 1;
  const timeoutMs = willRetry ? FETCH_TIMEOUT_RETRY_MS : FETCH_TIMEOUT_MS;

  const doFetch = async (): Promise<ApiResult<T>> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return parseErrorResponse(response);
      }

      const data = (await response.json()) as T;
      return { ok: true, data, status: response.status };
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      if (controller.signal.aborted) {
        return {
          ok: false,
          status: 0,
          error: `Request to ${path} timed out after ${timeoutMs / 1000}s`,
          hint: "The AstraNova API may be slow or unreachable. Try again.",
        };
      }

      const message = error instanceof Error ? error.message : "Unknown network error";
      return {
        ok: false,
        status: 0,
        error: `Network error: ${message}`,
        hint: "Check your internet connection and try again.",
      };
    }
  };

  // Skip retry if explicitly disabled
  if (retryOpts === false) return doFetch();

  return withRetry(doFetch, retryOpts ?? {});
}

async function parseErrorResponse(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as {
      error?: string;
      code?: string;
      hint?: string;
      message?: string;
    };

    return {
      ok: false,
      status: response.status,
      error: body.error ?? body.message ?? `HTTP ${response.status}`,
      code: body.code,
      hint: body.hint,
    };
  } catch {
    return {
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}: ${response.statusText}`,
    };
  }
}
