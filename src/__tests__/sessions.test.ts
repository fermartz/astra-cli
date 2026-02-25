/**
 * Tests for config/sessions.ts — session persistence, loading, pruning.
 */
import { describe, it, expect } from "vitest";
import "./setup.js";
import { setupFakeAgent } from "./setup.js";
import {
  saveSession,
  loadLatestSession,
  pruneOldSessions,
  newSessionId,
} from "../config/sessions.js";
import type { CoreMessage } from "ai";
import fs from "node:fs";
import { sessionsDir } from "../config/paths.js";

describe("Session persistence", () => {
  describe("newSessionId()", () => {
    it("generates a timestamp-based ID", () => {
      const id = newSessionId();
      expect(id).toBeTruthy();
      expect(id.length).toBeGreaterThan(10);
      // Should not contain colons or dots (replaced with dashes)
      expect(id).not.toContain(":");
      expect(id).not.toContain(".");
    });
  });

  describe("saveSession / loadLatestSession", () => {
    it("saves and loads a session", () => {
      setupFakeAgent("session-agent");
      const sessionId = "2026-01-01T00-00-00-000Z";
      const coreMessages: CoreMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there! I'm your AstraNova agent." },
      ];
      const chatMessages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there! I'm your AstraNova agent." },
      ];

      saveSession({
        agentName: "session-agent",
        provider: "claude",
        sessionId,
        coreMessages,
        chatMessages,
      });

      const loaded = loadLatestSession("session-agent");
      expect(loaded).not.toBeNull();
      expect(loaded!.sessionId).toBe(sessionId);
      expect(loaded!.coreMessages).toHaveLength(2);
      expect(loaded!.chatMessages).toHaveLength(2);
    });

    it("serializes tool call messages correctly", () => {
      setupFakeAgent("tool-session");
      const sessionId = "2026-02-01T00-00-00-000Z";
      const coreMessages: CoreMessage[] = [
        { role: "user", content: "Check the market" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check the market for you." },
            {
              type: "tool-call",
              toolCallId: "call_123",
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
              toolCallId: "call_123",
              result: { price: 1.5, mood: "bullish" },
            },
          ],
        },
        { role: "assistant", content: "The market is looking bullish!" },
      ];

      saveSession({
        agentName: "tool-session",
        provider: "claude",
        sessionId,
        coreMessages,
        chatMessages: [
          { role: "user", content: "Check the market" },
          { role: "assistant", content: "The market is looking bullish!" },
        ],
      });

      const loaded = loadLatestSession("tool-session");
      expect(loaded).not.toBeNull();
      expect(loaded!.coreMessages).toHaveLength(4);

      // Verify assistant message with tool call was serialized
      const assistantMsg = loaded!.coreMessages[1];
      expect(assistantMsg.role).toBe("assistant");
      expect(Array.isArray(assistantMsg.content)).toBe(true);
    });

    it("truncates to 100 messages", () => {
      setupFakeAgent("truncate-agent");
      const coreMessages: CoreMessage[] = [];
      const chatMessages: Array<{ role: string; content: string }> = [];

      for (let i = 0; i < 120; i++) {
        coreMessages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}` });
        chatMessages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}` });
      }

      saveSession({
        agentName: "truncate-agent",
        provider: "claude",
        sessionId: "2026-03-01T00-00-00-000Z",
        coreMessages,
        chatMessages,
      });

      const loaded = loadLatestSession("truncate-agent");
      expect(loaded!.coreMessages.length).toBeLessThanOrEqual(100);
      expect(loaded!.chatMessages.length).toBeLessThanOrEqual(100);
    });
  });

  describe("loadLatestSession edge cases", () => {
    it("returns null when no sessions exist", () => {
      setupFakeAgent("empty-agent");
      expect(loadLatestSession("empty-agent")).toBeNull();
    });

    it("returns null for non-existent agent", () => {
      expect(loadLatestSession("ghost")).toBeNull();
    });

    it("loads the most recent session when multiple exist", () => {
      setupFakeAgent("multi-session");

      // Save two sessions
      saveSession({
        agentName: "multi-session",
        provider: "claude",
        sessionId: "2026-01-01T00-00-00-000Z",
        coreMessages: [{ role: "user", content: "First session" }],
        chatMessages: [{ role: "user", content: "First session" }],
      });

      saveSession({
        agentName: "multi-session",
        provider: "claude",
        sessionId: "2026-02-01T00-00-00-000Z",
        coreMessages: [{ role: "user", content: "Second session" }],
        chatMessages: [{ role: "user", content: "Second session" }],
      });

      const loaded = loadLatestSession("multi-session");
      expect(loaded!.sessionId).toBe("2026-02-01T00-00-00-000Z");
    });
  });

  describe("pruneOldSessions()", () => {
    it("keeps only 3 most recent sessions", () => {
      setupFakeAgent("prune-agent");

      // Create 5 sessions
      for (let i = 1; i <= 5; i++) {
        saveSession({
          agentName: "prune-agent",
          provider: "claude",
          sessionId: `2026-0${i}-01T00-00-00-000Z`,
          coreMessages: [{ role: "user", content: `Session ${i}` }],
          chatMessages: [{ role: "user", content: `Session ${i}` }],
        });
      }

      const dir = sessionsDir("prune-agent");
      const beforePrune = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      expect(beforePrune).toHaveLength(5);

      pruneOldSessions("prune-agent");

      const afterPrune = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      expect(afterPrune).toHaveLength(3);
    });

    it("does nothing for agent with no sessions", () => {
      setupFakeAgent("no-sessions");
      // Should not throw
      expect(() => pruneOldSessions("no-sessions")).not.toThrow();
    });
  });
});
