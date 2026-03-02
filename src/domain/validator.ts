/**
 * Plugin security validation — pure functions, no side effects.
 *
 * All validation runs before any plugin data is saved to disk.
 * These checks are defense-in-depth: the plugin model is data-only
 * (no code execution), but we still scan narrative content and
 * validate structural constraints to protect users.
 */

// ─── Prompt Injection Scanning ─────────────────────────────────────────

/**
 * Patterns that indicate prompt injection attempts in skill.md narrative content.
 * Checked against the narrative section (above ## ENGINE:) before saving.
 */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /ignore previous instructions/i, label: "ignore-previous-instructions" },
  { pattern: /you are now/i, label: "persona-override" },
  { pattern: /disregard.*(?:system|instructions)/i, label: "disregard-system" },
  { pattern: /send.*api[\s._-]*key/i, label: "credential-exfiltration" },
  { pattern: /exfiltrate/i, label: "data-exfiltration" },
  { pattern: /override.*(?:system|role)/i, label: "role-override" },
  { pattern: /forget.*instructions/i, label: "forget-instructions" },
];

/**
 * Scan the narrative content of a skill.md for prompt injection patterns.
 * Returns { ok: true } if clean, or { ok: false, pattern } on a match.
 */
export function scanForInjection(content: string): { ok: true } | { ok: false; pattern: string } {
  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      return { ok: false, pattern: label };
    }
  }
  return { ok: true };
}

// ─── URL Validation ────────────────────────────────────────────────────

/**
 * Validate that a plugin URL is safe to fetch:
 * - Must use HTTPS
 * - Must not be localhost, loopback, or a private IP range
 *
 * Note: DNS resolution is not performed — only literal hostname checks.
 * A domain that resolves to a private IP will pass this check.
 * This is a best-effort guard, not a complete SSRF prevention.
 */
export function validatePluginUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "Invalid URL format." };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      reason: `Plugin URLs must use HTTPS. Got: ${url.protocol.replace(":", "")}`,
    };
  }

  const host = url.hostname.toLowerCase();

  // Reject localhost and loopback variants.
  // Node.js URL includes brackets for IPv6 in hostname (e.g. "[::1]"), check both forms.
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]"
  ) {
    return { ok: false, reason: "Plugin URL must not point to localhost." };
  }

  // Reject private IPv4 ranges (literal addresses only)
  if (
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host)
  ) {
    return { ok: false, reason: "Plugin URL must not point to a private IP address." };
  }

  // Reject private IPv6 ranges
  if (/^fc[0-9a-f]{2}:/i.test(host) || /^fd[0-9a-f]{2}:/i.test(host)) {
    return { ok: false, reason: "Plugin URL must not point to a private IPv6 address." };
  }

  return { ok: true, url };
}

// ─── Path Validation ───────────────────────────────────────────────────

/**
 * Validate that all allowedPaths entries are safe.
 * Paths must start with /api/ or be exactly /health.
 * This prevents plugins from granting the LLM access to arbitrary endpoints.
 */
export function validateAllowedPaths(paths: string[]): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, reason: "allowedPaths must be a non-empty array." };
  }

  for (const p of paths) {
    if (typeof p !== "string" || (!p.startsWith("/api/") && p !== "/health")) {
      return {
        ok: false,
        reason: `Invalid allowedPaths entry "${p}". All paths must start with /api/ or be /health.`,
      };
    }
  }

  return { ok: true };
}
