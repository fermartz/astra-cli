/**
 * Integration Test 11: Memory Persistence
 *
 * Tests the update_memory tool with real file operations.
 * Uses the active agent's config directory.
 *
 * What it tests:
 * - update_memory tool — saves content
 * - loadMemory function — reads it back
 * - Replace semantics (not append)
 * - Character limit enforcement
 * - Content survives across tool calls (simulates across sessions)
 */
import { describe, it, expect } from "vitest";
import { executeTool, assertSuccess } from "./harness.js";
import { loadMemory } from "../../tools/memory.js";
import { getActiveAgent } from "../../config/store.js";

describe("Integration: Memory Persistence", () => {
  const agentName = getActiveAgent()!;

  it("save memory content", async () => {
    const content = [
      "# Agent Memory",
      "",
      "## User Preferences",
      "- Prefers aggressive trading strategy",
      "- Timezone: UTC-5 (EST)",
      "- Trades in the morning",
      "",
      "## Trading Notes",
      "- NOVA tends to dip at epoch boundaries",
      "- User likes to buy dips around price 1.2",
      "",
      `## Last Updated: ${new Date().toISOString()}`,
    ].join("\n");

    const result = await executeTool("update_memory", { content }) as Record<string, unknown>;
    assertSuccess(result, "update_memory");

    expect(result.ok).toBe(true);
    expect(result.chars).toBe(content.length);
    console.log(`  Saved ${result.chars} chars of memory`);
  });

  it("loadMemory reads back saved content", () => {
    const loaded = loadMemory(agentName);
    expect(loaded).toContain("# Agent Memory");
    expect(loaded).toContain("aggressive trading strategy");
    expect(loaded).toContain("UTC-5");
    console.log(`  Loaded ${loaded.length} chars`);
  });

  it("update replaces entire content (not append)", async () => {
    const newContent = "Completely new memory — old content should be gone.";
    const result = await executeTool("update_memory", { content: newContent }) as Record<string, unknown>;
    assertSuccess(result, "update_memory (replace)");

    const loaded = loadMemory(agentName);
    expect(loaded).toBe(newContent);
    expect(loaded).not.toContain("Agent Memory");
    expect(loaded).not.toContain("aggressive trading");
    console.log("  Confirmed: replace semantics (not append)");
  });

  it("rejects content over 2000 chars", async () => {
    const longContent = "x".repeat(2001);
    const result = await executeTool("update_memory", { content: longContent }) as Record<string, unknown>;

    expect(result.error).toContain("too long");
    console.log(`  Correctly rejected: ${result.error}`);
  });

  it("accepts exactly 2000 chars", async () => {
    const maxContent = "y".repeat(2000);
    const result = await executeTool("update_memory", { content: maxContent }) as Record<string, unknown>;
    assertSuccess(result, "update_memory (2000 chars)");
    expect(result.ok).toBe(true);
    console.log("  Accepted 2000 chars (max)");
  });

  it("cleanup: restore original memory or clear test content", async () => {
    // Set a clean memory state
    const cleanContent = "Integration test completed. Memory reset.";
    await executeTool("update_memory", { content: cleanContent });
    console.log("  Memory cleaned up");
  });
});
