import fs from "node:fs";
import { auditLogPath } from "../config/paths.js";

/** Fields that must NEVER appear in audit logs. */
const SENSITIVE_KEYS = new Set([
  "secretKey", "secret_key", "privateKey", "private_key",
  "api_key", "apiKey", "accessToken", "refreshToken",
  "password", "Authorization", "authorization",
]);

const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface AuditEntry {
  ts: string;
  tool: string;
  args: unknown;
  result: unknown;
  ok: boolean;
  durationMs: number;
}

/**
 * Sanitize an object by redacting sensitive keys.
 * Operates recursively. Values of sensitive keys are replaced with "[REDACTED]".
 */
export function sanitize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(sanitize);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = sanitize(value);
    }
  }
  return result;
}

/**
 * Append an audit entry to the log file.
 * Uses NDJSON format (one JSON object per line) for crash safety.
 * Rotates the log when it exceeds MAX_LOG_SIZE_BYTES.
 */
export function writeAuditEntry(entry: AuditEntry): void {
  const logPath = auditLogPath();

  try {
    // Rotate if file is too large
    if (fs.existsSync(logPath)) {
      const stat = fs.statSync(logPath);
      if (stat.size > MAX_LOG_SIZE_BYTES) {
        const backupPath = logPath.replace(".log", ".old.log");
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
        fs.renameSync(logPath, backupPath);
      }
    }

    const line = JSON.stringify({
      ...entry,
      args: sanitize(entry.args),
      result: truncateResult(sanitize(entry.result)),
    });

    fs.appendFileSync(logPath, line + "\n", { encoding: "utf-8" });
  } catch {
    // Audit logging must never crash the app
  }
}

/**
 * Truncate large tool results to keep the log manageable.
 */
function truncateResult(result: unknown): unknown {
  const str = JSON.stringify(result);
  if (str.length <= 2000) return result;
  return { _truncated: true, preview: str.slice(0, 500) + "..." };
}
