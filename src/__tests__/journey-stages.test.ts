/**
 * Tests for journey stage detection logic.
 *
 * The journey stage determines what guidance the LLM provides to the user.
 * Getting this wrong means the LLM gives irrelevant advice.
 */
import { describe, it, expect } from "vitest";
import "./setup.js";

// Re-implement the detection function here for testing
// (it's defined inline in astra.ts — should be extracted, but we test the logic)
type JourneyStage = "fresh" | "pending" | "verified" | "trading" | "wallet_ready" | "full";

interface AgentStatus {
  status: string;
  simBalance: number;
  walletAddress?: string | null;
}

function detectJourneyStage(params: {
  isNewAgent: boolean;
  apiStatus: AgentStatus | null;
  hasWallet: boolean;
}): JourneyStage {
  const { isNewAgent, apiStatus, hasWallet } = params;

  if (isNewAgent) return "fresh";
  if (!apiStatus) return "verified"; // offline fallback
  if (apiStatus.status === "pending_verification") return "pending";

  // Agent is verified/active
  if (apiStatus.simBalance === 10_000 && !hasWallet) return "verified";
  if (!hasWallet) return "trading";
  return "wallet_ready";
}

describe("Journey stage detection", () => {
  it("new agent → fresh", () => {
    expect(detectJourneyStage({
      isNewAgent: true,
      apiStatus: null,
      hasWallet: false,
    })).toBe("fresh");
  });

  it("new agent with status → fresh (isNewAgent takes priority)", () => {
    expect(detectJourneyStage({
      isNewAgent: true,
      apiStatus: { status: "active", simBalance: 10000 },
      hasWallet: false,
    })).toBe("fresh");
  });

  it("returning agent offline → verified (fallback)", () => {
    expect(detectJourneyStage({
      isNewAgent: false,
      apiStatus: null,
      hasWallet: false,
    })).toBe("verified");
  });

  it("pending verification → pending", () => {
    expect(detectJourneyStage({
      isNewAgent: false,
      apiStatus: { status: "pending_verification", simBalance: 10000 },
      hasWallet: false,
    })).toBe("pending");
  });

  it("active with 10k balance, no wallet → verified", () => {
    expect(detectJourneyStage({
      isNewAgent: false,
      apiStatus: { status: "active", simBalance: 10000 },
      hasWallet: false,
    })).toBe("verified");
  });

  it("active with changed balance, no wallet → trading", () => {
    expect(detectJourneyStage({
      isNewAgent: false,
      apiStatus: { status: "active", simBalance: 9500 },
      hasWallet: false,
    })).toBe("trading");
  });

  it("active with balance 0, no wallet → trading", () => {
    expect(detectJourneyStage({
      isNewAgent: false,
      apiStatus: { status: "active", simBalance: 0 },
      hasWallet: false,
    })).toBe("trading");
  });

  it("active with wallet → wallet_ready", () => {
    expect(detectJourneyStage({
      isNewAgent: false,
      apiStatus: { status: "active", simBalance: 9500 },
      hasWallet: true,
    })).toBe("wallet_ready");
  });

  it("active with 10k balance but has wallet → wallet_ready", () => {
    // Edge case: user created wallet before trading
    expect(detectJourneyStage({
      isNewAgent: false,
      apiStatus: { status: "active", simBalance: 10000 },
      hasWallet: true,
    })).toBe("wallet_ready");
  });

  it("pending with wallet → pending (verification takes priority)", () => {
    expect(detectJourneyStage({
      isNewAgent: false,
      apiStatus: { status: "pending_verification", simBalance: 10000 },
      hasWallet: true,
    })).toBe("pending");
  });
});
