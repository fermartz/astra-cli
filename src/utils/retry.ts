import type { ApiResult } from "./http.js";

export interface RetryOptions {
  /** Max number of attempts (including the first). Default: 3 */
  attempts: number;
  /** Base delay in ms before first retry. Default: 500 */
  minDelay: number;
  /** Max delay in ms (caps exponential growth). Default: 8000 */
  maxDelay: number;
  /** Jitter factor 0–1 — randomizes delay to avoid thundering herd. Default: 0.3 */
  jitter: number;
}

const DEFAULTS: RetryOptions = {
  attempts: 3,
  minDelay: 500,
  maxDelay: 8_000,
  jitter: 0.3,
};

/**
 * Retry an API call with exponential backoff and jitter.
 *
 * - Retries on 5xx, 429 (rate limit), 408 (timeout), and status 0 (network error).
 * - Does NOT retry 4xx client errors (except 429/408) — those won't self-resolve.
 * - Returns the last result (success or error) once attempts are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<ApiResult<T>>,
  opts: Partial<RetryOptions> = {},
): Promise<ApiResult<T>> {
  const config = { ...DEFAULTS, ...opts };

  for (let attempt = 1; attempt <= config.attempts; attempt++) {
    const result = await fn();

    // Success — done
    if (result.ok) return result;

    // Last attempt — return whatever we got
    if (attempt === config.attempts) return result;

    // Don't retry client errors (4xx) except 429 and 408
    const { status } = result;
    if (status >= 400 && status < 500 && status !== 429 && status !== 408) {
      return result;
    }

    // Exponential backoff with jitter
    const base = Math.min(config.minDelay * 2 ** (attempt - 1), config.maxDelay);
    const jitterMs = base * config.jitter * (Math.random() * 2 - 1); // ± jitter
    const delay = Math.max(0, base + jitterMs);

    process.stderr.write(
      `[astra] Retry ${attempt}/${config.attempts - 1}: ${result.error} — waiting ${Math.round(delay)}ms\n`,
    );

    await sleep(delay);
  }

  // Unreachable, but TypeScript needs it
  throw new Error("Retry loop exited unexpectedly");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
