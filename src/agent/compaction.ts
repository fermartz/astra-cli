/**
 * Context compaction — LLM-generated summaries to keep conversations
 * within context window limits.
 *
 * Follows the Codex CLI pattern: summarize old messages, discard tool
 * call/output noise, preserve recent user messages, re-inject fresh state.
 */

import type { CoreMessage } from "ai";
import type { AgentProfile } from "./system-prompt.js";
import { buildContextRefresh } from "./system-prompt.js";

// ─── Constants ──────────────────────────────────────────────────────

/** Approximate context window sizes per provider (in tokens). */
export const CONTEXT_WINDOWS: Record<string, number> = {
  claude: 180_000,
  openai: 120_000,
  google: 900_000,
  "openai-oauth": 120_000,
  ollama: 8_000,
};

/** Trigger compaction when estimated usage exceeds this fraction of context window. */
const COMPACTION_THRESHOLD = 0.85;

/** Safety margin for token estimation (our heuristic underestimates). */
const SAFETY_MARGIN = 1.4;

/** Max tokens of user messages to preserve after compaction. */
const USER_MSG_BUDGET = 20_000;

/** Max number of user messages to preserve after compaction. */
const MAX_USER_MSGS = 10;

/** Prompt sent to the LLM to generate a compaction summary. */
const COMPACTION_PROMPT = `You are performing a CONTEXT CHECKPOINT for an AstraNova trading agent conversation.
Create a concise handoff summary for the next turn of this conversation.

Include:
- Current progress and what was accomplished
- Key decisions made and user preferences
- Critical data: wallet addresses, transaction signatures, verification codes, balances
- Current agent state: registration status, portfolio position, pending actions
- What remains to be done (clear next steps if any)

Be concise and structured. Focus on information needed to continue seamlessly.`;

/** Prefix prepended to the compaction summary in the new message history. */
const SUMMARY_PREFIX = `A previous part of this conversation was compacted to save context space.
Below is a summary of what happened, followed by the most recent messages.
Use this summary to maintain continuity.

---

`;

// ─── Types ──────────────────────────────────────────────────────────

export interface CompactionResult {
  messages: CoreMessage[];
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
}

// ─── Token Estimation ───────────────────────────────────────────────

/** Rough token estimate — ~4 chars per token (same heuristic as Codex CLI). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate total tokens across an array of CoreMessages. */
export function estimateMessageTokens(messages: CoreMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      total += estimateTokens(m.content);
    } else {
      total += estimateTokens(JSON.stringify(m.content));
    }
  }
  return total;
}

// ─── Compaction Check ───────────────────────────────────────────────

/**
 * Check if the conversation needs compaction based on estimated token usage.
 */
export function needsCompaction(
  messages: CoreMessage[],
  systemPromptTokens: number,
  provider: string,
): boolean {
  const contextWindow = CONTEXT_WINDOWS[provider] ?? 120_000;
  const messageTokens = estimateMessageTokens(messages);
  const estimated = messageTokens * SAFETY_MARGIN + systemPromptTokens;
  return estimated >= contextWindow * COMPACTION_THRESHOLD;
}

// ─── Main Compaction ────────────────────────────────────────────────

/**
 * Compact the conversation by generating an LLM summary and preserving
 * recent user messages.
 *
 * @param messages - Full conversation history
 * @param provider - Current LLM provider name
 * @param profile - Agent profile for context refresh
 * @param llmSummarize - Callback that sends messages to the LLM for summarization
 */
export async function compactMessages(
  messages: CoreMessage[],
  provider: string,
  profile: AgentProfile,
  llmSummarize: (messages: CoreMessage[]) => Promise<string>,
): Promise<CompactionResult> {
  const tokensBefore = estimateMessageTokens(messages);

  // 1. Get LLM summary of the full conversation
  const summary = await llmSummarize(messages);

  // 2. Collect recent user messages (most-recent-first, up to budget)
  const recentUserMsgs: CoreMessage[] = [];
  let userTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;

    const msgTokens = typeof m.content === "string"
      ? estimateTokens(m.content)
      : estimateTokens(JSON.stringify(m.content));

    if (userTokens + msgTokens > USER_MSG_BUDGET) break;
    if (recentUserMsgs.length >= MAX_USER_MSGS) break;

    recentUserMsgs.unshift(m);
    userTokens += msgTokens;
  }

  // 3. Build context refresh from current agent state
  const contextRefresh = buildContextRefresh(profile);

  // 4. Assemble compacted history — summary + refresh as a single user message,
  //    then recent user messages (each will be followed by an assistant turn naturally)
  const summaryMessage: CoreMessage = {
    role: "user",
    content: SUMMARY_PREFIX + summary + "\n\n---\n\n" + contextRefresh,
  };

  // If we have recent user messages, we need an assistant acknowledgment between
  // the summary and the user messages to avoid consecutive same-role messages.
  const compactedMessages: CoreMessage[] = [summaryMessage];

  if (recentUserMsgs.length > 0) {
    compactedMessages.push({
      role: "assistant",
      content: "Understood — I have the context from our earlier conversation. Continuing from where we left off.",
    });
    compactedMessages.push(...recentUserMsgs);
  }

  const tokensAfter = estimateMessageTokens(compactedMessages);

  return {
    messages: compactedMessages,
    compacted: true,
    tokensBefore,
    tokensAfter,
  };
}

// ─── Emergency Fallback ─────────────────────────────────────────────

/**
 * Emergency compaction without an LLM call — used when the LLM itself
 * returns a context-length error.
 *
 * Keeps the last 3 user messages + context refresh.
 */
export function forceCompact(
  messages: CoreMessage[],
  profile: AgentProfile,
): CoreMessage[] {
  const contextRefresh = buildContextRefresh(profile);

  // Grab last 3 user messages
  const recentUserMsgs: CoreMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && recentUserMsgs.length < 3; i--) {
    if (messages[i].role === "user") {
      recentUserMsgs.unshift(messages[i]);
    }
  }

  const summaryMessage: CoreMessage = {
    role: "user",
    content: `Earlier conversation was too long and had to be discarded. Here is the current agent state:\n\n${contextRefresh}`,
  };

  const result: CoreMessage[] = [summaryMessage];
  if (recentUserMsgs.length > 0) {
    result.push({
      role: "assistant",
      content: "Got it — I've lost the earlier context but I can see your recent messages. How can I help?",
    });
    result.push(...recentUserMsgs);
  }

  return result;
}

// ─── Error Detection ────────────────────────────────────────────────

/** Check if an error is a context-length exceeded error from any provider. */
export function isContextLengthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    msg.includes("context_length_exceeded") ||
    msg.includes("maximum context length") ||
    msg.includes("too many tokens") ||
    msg.includes("max_tokens") ||
    msg.includes("content_too_large") ||
    msg.includes("request too large")
  );
}

/** The compaction prompt — exported so the summarization helper can use it. */
export { COMPACTION_PROMPT };
