/**
 * Tests for tools/memory.ts — update_memory tool and loadMemory function.
 */
import { describe, it, expect } from "vitest";
import "./setup.js";
import { setupFakeAgent } from "./setup.js";
import { updateMemoryTool } from "../tools/memory.js";
import { loadMemory } from "../tools/memory.js";

async function execUpdateMemory(args: Record<string, unknown>): Promise<unknown> {
  const execute = (updateMemoryTool as unknown as { execute: (args: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown> }).execute;
  return execute(args, {});
}

describe("update_memory tool", () => {
  describe("Happy path", () => {
    it("saves memory content", async () => {
      setupFakeAgent("memory-agent");
      const result = await execUpdateMemory({
        content: "User prefers aggressive trading. Favorite token: NOVA.",
      }) as Record<string, unknown>;

      expect(result.ok).toBe(true);
      expect(result.chars).toBeGreaterThan(0);
    });

    it("memory content can be loaded back", async () => {
      setupFakeAgent("recall-agent");
      const content = "Remember: user's timezone is UTC+2. They trade in the mornings.";
      await execUpdateMemory({ content });

      const loaded = loadMemory("recall-agent");
      expect(loaded).toBe(content);
    });

    it("replaces entire memory on update", async () => {
      setupFakeAgent("replace-agent");
      await execUpdateMemory({ content: "First memory" });
      await execUpdateMemory({ content: "Second memory replaces first" });

      const loaded = loadMemory("replace-agent");
      expect(loaded).toBe("Second memory replaces first");
      expect(loaded).not.toContain("First memory");
    });
  });

  describe("Character limit", () => {
    it("rejects memory exceeding 2000 chars", async () => {
      setupFakeAgent("limit-agent");
      const longContent = "x".repeat(2001);
      const result = await execUpdateMemory({ content: longContent }) as Record<string, unknown>;

      expect(result.error).toContain("too long");
      expect(result.error).toContain("2001");
    });

    it("accepts memory at exactly 2000 chars", async () => {
      setupFakeAgent("exact-agent");
      const content = "y".repeat(2000);
      const result = await execUpdateMemory({ content }) as Record<string, unknown>;

      expect(result.ok).toBe(true);
    });
  });

  describe("Error cases", () => {
    it("returns error when no active agent", async () => {
      const result = await execUpdateMemory({ content: "orphan memory" }) as Record<string, unknown>;
      expect(result.error).toContain("No active agent");
    });
  });
});

describe("loadMemory()", () => {
  it("returns empty string for agent without memory", () => {
    setupFakeAgent("no-memory");
    expect(loadMemory("no-memory")).toBe("");
  });

  it("returns empty string for non-existent agent", () => {
    expect(loadMemory("ghost")).toBe("");
  });
});
