import fs from "node:fs";
import path from "node:path";
import type { CoreMessage } from "ai";
import { sessionsDir, ensureDir } from "./paths.js";

const MAX_MESSAGES = 100;
const MAX_SESSIONS = 3;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface SessionData {
  version: 1;
  agentName: string;
  provider: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  coreMessages: SerializedCoreMessage[];
  chatMessages: Array<{ role: string; content: string }>;
}

interface SerializedCoreMessage {
  role: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
}

/** Generate a session ID from the current timestamp. */
export function newSessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Serialize CoreMessage[] for disk storage.
 * Strips non-serializable content (functions, symbols, circular refs).
 * Truncates to last MAX_MESSAGES.
 */
function serializeMessages(messages: CoreMessage[]): SerializedCoreMessage[] {
  const recent = messages.slice(-MAX_MESSAGES);

  return recent.map((msg) => {
    let content: string | Array<{ type: string; [key: string]: unknown }>;

    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((part) => typeof part === "object" && part !== null)
        .map((part) => {
          try {
            return JSON.parse(JSON.stringify(part)) as { type: string; [key: string]: unknown };
          } catch {
            return { type: "text", text: "[unserializable content]" };
          }
        });
    } else {
      content = String(msg.content);
    }

    return { role: msg.role, content };
  });
}

/**
 * Save the current session to disk.
 * Called after each complete turn (not mid-stream).
 */
export function saveSession(params: {
  agentName: string;
  provider: string;
  sessionId: string;
  coreMessages: CoreMessage[];
  chatMessages: Array<{ role: string; content: string }>;
}): void {
  try {
    const dir = sessionsDir(params.agentName);
    ensureDir(dir);

    const data: SessionData = {
      version: 1,
      agentName: params.agentName,
      provider: params.provider,
      sessionId: params.sessionId,
      createdAt: params.sessionId,
      updatedAt: new Date().toISOString(),
      coreMessages: serializeMessages(params.coreMessages),
      chatMessages: params.chatMessages.slice(-MAX_MESSAGES),
    };

    const filePath = path.join(dir, `${params.sessionId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // Session saving must never crash the app
    process.stderr.write("[astra] Failed to save session\n");
  }
}

/**
 * Load the most recent session for an agent.
 * Returns null if no sessions exist or the latest is too old.
 */
export function loadLatestSession(agentName: string): SessionData | null {
  const dir = sessionsDir(agentName);
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  try {
    const raw = fs.readFileSync(path.join(dir, files[0]), "utf-8");
    const parsed = JSON.parse(raw) as SessionData;

    if (parsed.version !== 1) return null;

    // Check age — skip sessions older than 7 days
    const updatedAt = new Date(parsed.updatedAt).getTime();
    if (Date.now() - updatedAt > MAX_AGE_MS) return null;

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Clean up old sessions for an agent.
 * Keeps only the last MAX_SESSIONS files and deletes anything older than MAX_AGE_MS.
 */
export function pruneOldSessions(agentName: string): void {
  const dir = sessionsDir(agentName);
  if (!fs.existsSync(dir)) return;

  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();

    for (let i = 0; i < files.length; i++) {
      const filePath = path.join(dir, files[i]);

      // Keep the most recent MAX_SESSIONS, delete the rest
      if (i >= MAX_SESSIONS) {
        fs.unlinkSync(filePath);
        continue;
      }

      // Also delete if older than 7 days
      try {
        const stat = fs.statSync(filePath);
        if (Date.now() - stat.mtimeMs > MAX_AGE_MS) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Ignore stat errors
      }
    }
  } catch {
    // Cleanup must never crash the app
  }
}
