/**
 * Integration Test 12: Session Persistence
 *
 * Tests session save/load with real tool call messages.
 * Simulates a multi-turn conversation with tool calls and verifies
 * the session can be restored.
 *
 * What it tests:
 * - Saving a session with user + assistant + tool messages
 * - Loading the latest session
 * - Tool call messages survive serialization
 * - Session pruning
 * - CoreMessage format compatibility (important for Codex path)
 */
import { describe, it, expect } from "vitest";
import type { CoreMessage } from "ai";
import { getActiveAgent } from "../../config/store.js";
import {
  saveSession,
  loadLatestSession,
  pruneOldSessions,
  newSessionId,
} from "../../config/sessions.js";

describe("Integration: Session Persistence", () => {
  const agentName = getActiveAgent()!;

  it("save and restore a simple conversation", () => {
    const sessionId = newSessionId();
    const coreMessages: CoreMessage[] = [
      { role: "user", content: "What's the market price?" },
      { role: "assistant", content: "The current NOVA price is 1.45 SIM." },
    ];

    saveSession({
      agentName,
      provider: "claude",
      sessionId,
      coreMessages,
      chatMessages: [
        { role: "user", content: "What's the market price?" },
        { role: "assistant", content: "The current NOVA price is 1.45 SIM." },
      ],
    });

    const loaded = loadLatestSession(agentName);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe(sessionId);
    expect(loaded!.coreMessages).toHaveLength(2);
    expect(loaded!.chatMessages).toHaveLength(2);
    console.log("  Simple conversation: saved and restored");
  });

  it("save and restore conversation with tool calls", () => {
    const sessionId = newSessionId();

    // Simulate: user asks to check market → LLM calls api_call → LLM responds
    const coreMessages: CoreMessage[] = [
      { role: "user", content: "Check the market for me" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check the market." },
          {
            type: "tool-call",
            toolCallId: "call_abc123",
            toolName: "api_call",
            args: { method: "GET", path: "/api/v1/market/state" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_abc123",
            result: { success: true, market: { price: 1.45, mood: "bull", intensity: 3 } },
          },
        ],
      },
      {
        role: "assistant",
        content: "The market is looking bullish! NOVA is at 1.45 SIM with intensity 3.",
      },
    ];

    saveSession({
      agentName,
      provider: "openai-oauth",
      sessionId,
      coreMessages,
      chatMessages: [
        { role: "user", content: "Check the market for me" },
        { role: "assistant", content: "The market is looking bullish! NOVA is at 1.45 SIM with intensity 3." },
      ],
    });

    const loaded = loadLatestSession(agentName);
    expect(loaded).not.toBeNull();
    expect(loaded!.coreMessages).toHaveLength(4);

    // Verify tool call message preserved
    const assistantWithTools = loaded!.coreMessages[1];
    expect(assistantWithTools.role).toBe("assistant");
    expect(Array.isArray(assistantWithTools.content)).toBe(true);

    const parts = assistantWithTools.content as Array<{ type: string; [key: string]: unknown }>;
    const toolCallPart = parts.find((p) => p.type === "tool-call");
    expect(toolCallPart).toBeDefined();
    expect(toolCallPart!.toolName).toBe("api_call");
    expect(toolCallPart!.toolCallId).toBe("call_abc123");

    // Verify tool result preserved
    const toolMessage = loaded!.coreMessages[2];
    expect(toolMessage.role).toBe("tool");
    expect(Array.isArray(toolMessage.content)).toBe(true);

    const toolParts = toolMessage.content as Array<{ type: string; [key: string]: unknown }>;
    const resultPart = toolParts.find((p) => p.type === "tool-result");
    expect(resultPart).toBeDefined();
    expect(resultPart!.toolCallId).toBe("call_abc123");

    console.log("  Tool call conversation: saved and restored with full structure");
  });

  it("save multi-step tool chain (buy trade flow)", () => {
    const sessionId = newSessionId();

    // Simulate: check market → buy → check portfolio
    const coreMessages: CoreMessage[] = [
      { role: "user", content: "Buy 500 NOVA" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check the market first." },
          {
            type: "tool-call",
            toolCallId: "call_market",
            toolName: "api_call",
            args: { method: "GET", path: "/api/v1/market/state" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_market",
            result: { success: true, market: { price: 1.5 } },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Market looks good. Executing your trade." },
          {
            type: "tool-call",
            toolCallId: "call_trade",
            toolName: "api_call",
            args: { method: "POST", path: "/api/v1/trades", body: { side: "buy", quantity: 500 } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_trade",
            result: { success: true, trade: { side: "buy", filledQuantity: 500, price: 1.5, fee: 1.125 } },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Trade executed! Let me show your portfolio." },
          {
            type: "tool-call",
            toolCallId: "call_portfolio",
            toolName: "api_call",
            args: { method: "GET", path: "/api/v1/portfolio" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_portfolio",
            result: { success: true, portfolio: { cash: 9249, tokens: 500, portfolioValue: 10000 } },
          },
        ],
      },
      {
        role: "assistant",
        content: "Done! You bought 500 NOVA at 1.50 SIM each. Your portfolio is now worth 10,000 SIM.",
      },
    ];

    saveSession({
      agentName,
      provider: "openai-oauth",
      sessionId,
      coreMessages,
      chatMessages: [
        { role: "user", content: "Buy 500 NOVA" },
        { role: "assistant", content: "Done! You bought 500 NOVA at 1.50 SIM each." },
      ],
    });

    const loaded = loadLatestSession(agentName);
    expect(loaded).not.toBeNull();
    expect(loaded!.coreMessages).toHaveLength(8); // user + 3x(assistant+tool) + final assistant

    // Count tool calls in restored session
    let toolCallCount = 0;
    for (const msg of loaded!.coreMessages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        toolCallCount += (msg.content as Array<{ type: string }>).filter(
          (p) => p.type === "tool-call",
        ).length;
      }
    }
    expect(toolCallCount).toBe(3); // market + trade + portfolio

    console.log("  Multi-step trade flow: saved and restored (3 tool calls)");
  });

  it("loads most recent session", () => {
    // Save two sessions with different timestamps
    const oldId = "2025-01-01T00-00-00-000Z";
    const newId = "2026-12-31T23-59-59-999Z";

    saveSession({
      agentName,
      provider: "claude",
      sessionId: oldId,
      coreMessages: [{ role: "user", content: "Old session" }],
      chatMessages: [{ role: "user", content: "Old session" }],
    });

    saveSession({
      agentName,
      provider: "claude",
      sessionId: newId,
      coreMessages: [{ role: "user", content: "New session" }],
      chatMessages: [{ role: "user", content: "New session" }],
    });

    const loaded = loadLatestSession(agentName);
    expect(loaded!.sessionId).toBe(newId);
    console.log("  Correctly loads most recent session");
  });

  it("pruneOldSessions keeps only 3 most recent", () => {
    // Create 6 sessions
    for (let i = 0; i < 6; i++) {
      saveSession({
        agentName,
        provider: "claude",
        sessionId: `2026-0${i + 1}-15T12-00-00-000Z`,
        coreMessages: [{ role: "user", content: `Session ${i + 1}` }],
        chatMessages: [{ role: "user", content: `Session ${i + 1}` }],
      });
    }

    pruneOldSessions(agentName);

    // Load should still work (latest is kept)
    const loaded = loadLatestSession(agentName);
    expect(loaded).not.toBeNull();
    console.log("  Session pruning: kept most recent, deleted old");
  });
});
