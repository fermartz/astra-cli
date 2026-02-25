/**
 * Tests for config/schema.ts — Zod schema validation.
 */
import { describe, it, expect } from "vitest";
import {
  ConfigSchema,
  CredentialsSchema,
  WalletSchema,
  AgentNameSchema,
  AgentStateSchema,
} from "../config/schema.js";

describe("ConfigSchema", () => {
  it("validates a complete config", () => {
    const config = ConfigSchema.parse({
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      auth: { type: "api-key", apiKey: "sk-ant-test" },
    });
    expect(config.provider).toBe("claude");
    expect(config.version).toBe(1); // default
    expect(config.apiBase).toBe("https://agents.astranova.live"); // default
  });

  it("rejects invalid provider", () => {
    expect(() =>
      ConfigSchema.parse({
        provider: "invalid-provider",
        model: "test",
        auth: { type: "api-key" },
      }),
    ).toThrow();
  });

});

describe("CredentialsSchema", () => {
  it("validates credentials with defaults", () => {
    const creds = CredentialsSchema.parse({
      agent_name: "test-agent",
      api_key: "astra_key_123",
    });
    expect(creds.api_base).toBe("https://agents.astranova.live");
  });

  it("rejects missing agent_name", () => {
    expect(() =>
      CredentialsSchema.parse({ api_key: "key" }),
    ).toThrow();
  });
});

describe("WalletSchema", () => {
  it("validates a proper wallet", () => {
    const wallet = WalletSchema.parse({
      publicKey: "7xKp3mNv",
      secretKey: Array.from({ length: 64 }, (_, i) => i),
    });
    expect(wallet.publicKey).toBe("7xKp3mNv");
    expect(wallet.secretKey).toHaveLength(64);
  });

  it("rejects wrong secretKey length", () => {
    expect(() =>
      WalletSchema.parse({
        publicKey: "abc",
        secretKey: [1, 2, 3], // too short
      }),
    ).toThrow();
  });
});

describe("AgentNameSchema", () => {
  it("accepts valid names", () => {
    expect(AgentNameSchema.parse("phantom-fox")).toBe("phantom-fox");
    expect(AgentNameSchema.parse("agent_01")).toBe("agent_01");
    expect(AgentNameSchema.parse("ab")).toBe("ab"); // min length
  });

  it("rejects uppercase", () => {
    expect(() => AgentNameSchema.parse("BadName")).toThrow();
  });

  it("rejects spaces", () => {
    expect(() => AgentNameSchema.parse("bad name")).toThrow();
  });

  it("rejects too short", () => {
    expect(() => AgentNameSchema.parse("a")).toThrow();
  });

  it("rejects too long", () => {
    expect(() => AgentNameSchema.parse("a".repeat(33))).toThrow();
  });

  it("rejects special characters", () => {
    expect(() => AgentNameSchema.parse("agent@123")).toThrow();
    expect(() => AgentNameSchema.parse("agent.123")).toThrow();
  });
});

describe("AgentStateSchema", () => {
  it("applies defaults", () => {
    const state = AgentStateSchema.parse({});
    expect(state.status).toBe("unknown");
    expect(state.journeyStage).toBe("fresh");
    expect(state.createdAt).toBeDefined();
  });

  it("accepts valid journey stages", () => {
    const stages = ["fresh", "pending", "verified", "trading", "wallet_ready", "full"];
    for (const stage of stages) {
      const state = AgentStateSchema.parse({ journeyStage: stage });
      expect(state.journeyStage).toBe(stage);
    }
  });
});
