/**
 * Tests for agent/codex-provider.ts — SSE parsing, tool conversion, input format.
 */
import { describe, it, expect } from "vitest";
import { convertToolsForCodex } from "../agent/codex-provider.js";

describe("convertToolsForCodex()", () => {
  it("converts a simple tool definition", () => {
    const tools = convertToolsForCodex({
      api_call: {
        description: "Call the API",
        parameters: {
          type: "object",
          properties: {
            method: { type: "string", enum: ["GET", "POST"] },
            path: { type: "string" },
          },
          required: ["method", "path"],
        },
      },
    });

    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe("function");
    expect(tools[0].name).toBe("api_call");
    expect(tools[0].description).toBe("Call the API");
    expect(tools[0].parameters).toEqual({
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST"] },
        path: { type: "string" },
      },
      required: ["method", "path"],
    });
  });

  it("converts multiple tools", () => {
    const tools = convertToolsForCodex({
      read_config: { description: "Read config", parameters: {} },
      create_wallet: { description: "Create wallet", parameters: {} },
    });

    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(["read_config", "create_wallet"]);
  });

  it("handles missing description gracefully", () => {
    const tools = convertToolsForCodex({
      test_tool: { parameters: {} },
    });

    expect(tools[0].description).toBe("");
  });

  it("handles missing parameters gracefully", () => {
    const tools = convertToolsForCodex({
      test_tool: { description: "No params" },
    });

    expect(tools[0].parameters).toEqual({});
  });
});
