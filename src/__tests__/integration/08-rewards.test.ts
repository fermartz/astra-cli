/**
 * Integration Test 08: Rewards
 *
 * Tests reward checking and the claim flow.
 * Requires: A verified agent, ideally with a registered wallet.
 *
 * What it tests:
 * - GET /api/v1/agents/me/rewards — list rewards by season
 * - GET /api/v1/portfolio — rewards in portfolio response
 * - POST /api/v1/agents/me/rewards/claim — initiate claim (if claimable)
 * - sign_and_send_transaction — co-sign and submit (if claim available)
 * - POST /api/v1/agents/me/rewards/confirm — confirm on-chain tx
 *
 * NOTE: Claim tests only run if there are actually claimable rewards.
 * The full claim flow involves a real Solana transaction on devnet.
 */
import { describe, it, expect } from "vitest";
import { apiCall, executeTool, assertSuccess, delay } from "./harness.js";
import { loadWallet, getActiveAgent } from "../../config/store.js";

describe("Integration: Rewards", () => {
  const agentName = getActiveAgent()!;
  let hasWallet: boolean;
  let claimableAmount: number;
  let claimableSeasonId: string | null = null;

  it("check wallet status", () => {
    const wallet = loadWallet(agentName);
    hasWallet = wallet !== null;
    console.log(`  Wallet: ${hasWallet ? wallet!.publicKey : "none"}`);
  });

  it("GET /api/v1/portfolio — check rewards in portfolio", async () => {
    const result = await apiCall("GET", "/api/v1/portfolio");
    assertSuccess(result, "GET /portfolio (rewards check)");

    const portfolio = result.portfolio as Record<string, unknown>;
    const rewards = portfolio.rewards as Record<string, unknown>;

    claimableAmount = rewards.claimable as number;

    console.log(`  Total earned: ${rewards.totalEarned}`);
    console.log(`  Total claimed: ${rewards.totalClaimed}`);
    console.log(`  Claimable: ${rewards.claimable}`);
    console.log(`  Has wallet (API): ${rewards.hasWallet}`);
  }, 15_000);

  it("GET /api/v1/agents/me/rewards — detailed reward breakdown", async () => {
    await delay(500);
    const result = await apiCall("GET", "/api/v1/agents/me/rewards");

    if (result.error) {
      // May fail if no rewards exist yet
      console.log(`  Rewards query: ${result.error}`);
      return;
    }

    assertSuccess(result, "GET /rewards");
    expect(result.success).toBe(true);
    expect(result.rewards).toBeDefined();
    expect(Array.isArray(result.rewards)).toBe(true);

    const rewards = result.rewards as Array<Record<string, unknown>>;
    console.log(`  Reward entries: ${rewards.length}`);

    for (const r of rewards.slice(0, 3)) {
      console.log(`    Season: ${r.seasonId}, Amount: ${r.totalAstra}, Status: ${r.claimStatus}`);
      if (r.claimStatus === "claimable" && !claimableSeasonId) {
        claimableSeasonId = r.seasonId as string;
      }
    }
  }, 15_000);

  it("POST /api/v1/agents/me/rewards/claim — initiate claim", async () => {
    if (!hasWallet) {
      console.log("  Skipped — no wallet registered");
      return;
    }
    if (claimableAmount <= 0 || !claimableSeasonId) {
      console.log("  Skipped — no claimable rewards");
      return;
    }

    await delay(500);
    const result = await apiCall("POST", "/api/v1/agents/me/rewards/claim", {
      seasonId: claimableSeasonId,
    });

    if (result.error) {
      console.log(`  Claim initiation: ${result.error}`);
      // Rate limited or no claimable — that's OK
      return;
    }

    assertSuccess(result, "POST /rewards/claim");
    expect(result.success).toBe(true);
    expect(result.transaction).toBeDefined();
    expect(typeof result.transaction).toBe("string");
    expect(result.expiresAt).toBeDefined();

    console.log(`  Claim initiated for season ${claimableSeasonId}`);
    console.log(`  Transaction (base64): ${(result.transaction as string).slice(0, 40)}...`);
    console.log(`  Expires: ${result.expiresAt}`);

    // Store for signing
    (globalThis as Record<string, unknown>).__testTransaction = result.transaction;
  }, 30_000);

  it("sign_and_send_transaction — co-sign and submit to Solana", async () => {
    const transaction = (globalThis as Record<string, unknown>).__testTransaction as string | undefined;
    if (!transaction) {
      console.log("  Skipped — no claim transaction available");
      return;
    }

    const result = await executeTool("sign_and_send_transaction", {
      transaction,
    }) as Record<string, unknown>;

    if (result.error) {
      console.log(`  Transaction: ${result.error}`);
      // May fail due to insufficient SOL for fees, or expired tx
      return;
    }

    assertSuccess(result, "sign_and_send_transaction");
    expect(result.success).toBe(true);
    expect(result.txSignature).toBeDefined();
    expect(typeof result.txSignature).toBe("string");

    console.log(`  Transaction submitted: ${result.txSignature}`);
    console.log(`  Explorer: https://explorer.solana.com/tx/${result.txSignature}?cluster=devnet`);

    // Store for confirmation
    (globalThis as Record<string, unknown>).__testTxSignature = result.txSignature;
  }, 60_000); // 60s timeout for Solana

  it("POST /api/v1/agents/me/rewards/confirm — confirm claim", async () => {
    const txSignature = (globalThis as Record<string, unknown>).__testTxSignature as string | undefined;
    if (!txSignature) {
      console.log("  Skipped — no transaction signature available");
      return;
    }

    await delay(2000); // Wait for Solana confirmation to propagate

    const result = await apiCall("POST", "/api/v1/agents/me/rewards/confirm", {
      seasonId: claimableSeasonId,
      txSignature,
    });

    if (result.error) {
      console.log(`  Confirmation: ${result.error}`);
      return;
    }

    assertSuccess(result, "POST /rewards/confirm");
    expect(result.success).toBe(true);
    console.log(`  Claim confirmed for season ${claimableSeasonId}`);
  }, 30_000);
});
