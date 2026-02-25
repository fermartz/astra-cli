/**
 * Integration Test 07: Wallet Creation & Registration
 *
 * Tests the full wallet lifecycle: create keypair, get challenge, sign, register.
 * Requires: A verified (active) agent.
 *
 * What it tests:
 * - create_wallet tool — generates Solana keypair
 * - POST /api/v1/agents/me/wallet/challenge — get signing challenge
 * - sign_challenge tool — sign with local keypair
 * - PUT /api/v1/agents/me/wallet — register wallet with API
 * - Security: secret keys never exposed
 *
 * NOTE: If the agent already has a wallet, creation tests verify duplicate
 * prevention. If no wallet, the full flow runs.
 *
 * CAUTION: Wallet registration is rate-limited to 1/hour. If this test
 * has already been run recently, the PUT step will fail with RATE_LIMITED.
 */
import { describe, it, expect } from "vitest";
import { apiCall, executeTool, assertSuccess, delay } from "./harness.js";
import { getActiveAgent, loadWallet } from "../../config/store.js";

describe("Integration: Wallet", () => {
  const agentName = getActiveAgent()!;
  let walletExists: boolean;
  let publicKey: string;

  it("check if wallet already exists", () => {
    const wallet = loadWallet(agentName);
    walletExists = wallet !== null;
    if (walletExists) {
      publicKey = wallet!.publicKey;
      console.log(`  Wallet already exists: ${publicKey}`);
    } else {
      console.log("  No wallet — will create one");
    }
  });

  it("create_wallet — generates keypair or detects existing", async () => {
    const result = await executeTool("create_wallet", { agentName }) as Record<string, unknown>;

    if (walletExists) {
      // Should return error about existing wallet
      expect(result.error).toContain("already exists");
      expect(result.publicKey).toBe(publicKey);
      console.log("  Correctly detected existing wallet");
    } else {
      // Should create new wallet
      assertSuccess(result, "create_wallet");
      expect(result.success).toBe(true);
      expect(result.publicKey).toBeDefined();
      expect(typeof result.publicKey).toBe("string");
      expect((result.publicKey as string).length).toBeGreaterThan(30);
      publicKey = result.publicKey as string;
      console.log(`  Created wallet: ${publicKey}`);

      // SECURITY: secret key must not be in result
      expect(result).not.toHaveProperty("secretKey");
      expect(result).not.toHaveProperty("secret_key");
    }
  });

  it("read_config wallet — returns publicKey only", async () => {
    const result = await executeTool("read_config", { key: "wallet" }) as Record<string, unknown>;
    assertSuccess(result, "read_config wallet");

    expect(result.publicKey).toBe(publicKey);
    expect(result).not.toHaveProperty("secretKey");
    expect(result).not.toHaveProperty("secret_key");
  });

  it("POST /api/v1/agents/me/wallet/challenge — request challenge", async () => {
    await delay(500);
    const result = await apiCall("POST", "/api/v1/agents/me/wallet/challenge", {
      walletAddress: publicKey,
    });

    if (result.error) {
      // May fail if wallet already registered or rate limited
      console.log(`  Challenge request: ${result.error}`);
      // Skip remaining wallet tests if we can't get a challenge
      return;
    }

    assertSuccess(result, "POST /wallet/challenge");
    expect(result.success).toBe(true);
    expect(result.challenge).toBeDefined();
    expect(typeof result.challenge).toBe("string");
    expect((result.challenge as string)).toContain("AstraNova wallet verification:");
    expect(result.expiresAt).toBeDefined();

    console.log(`  Challenge: ${(result.challenge as string).slice(0, 60)}...`);
    console.log(`  Expires: ${result.expiresAt}`);

    // Store for next test
    (globalThis as Record<string, unknown>).__testChallenge = result.challenge;
  }, 15_000);

  it("sign_challenge — sign with local keypair", async () => {
    const challenge = (globalThis as Record<string, unknown>).__testChallenge as string | undefined;
    if (!challenge) {
      console.log("  Skipped — no challenge available (wallet already registered or rate limited)");
      return;
    }

    const result = await executeTool("sign_challenge", { challenge }) as Record<string, unknown>;
    assertSuccess(result, "sign_challenge");

    expect(result.success).toBe(true);
    expect(result.signature).toBeDefined();
    expect(typeof result.signature).toBe("string");
    expect((result.signature as string).length).toBeGreaterThan(0);
    expect(result.walletAddress).toBe(publicKey);
    expect(result.nonce).toBeDefined();
    expect(typeof result.nonce).toBe("string");

    // SECURITY: secret key must not be exposed
    expect(result).not.toHaveProperty("secretKey");
    expect(result).not.toHaveProperty("secret_key");

    console.log(`  Signature: ${(result.signature as string).slice(0, 30)}...`);
    console.log(`  Nonce: ${result.nonce}`);

    // Store for next test
    (globalThis as Record<string, unknown>).__testSignature = result.signature;
    (globalThis as Record<string, unknown>).__testNonce = result.nonce;
  });

  it("PUT /api/v1/agents/me/wallet — register wallet", async () => {
    const signature = (globalThis as Record<string, unknown>).__testSignature as string | undefined;
    const nonce = (globalThis as Record<string, unknown>).__testNonce as string | undefined;

    if (!signature || !nonce) {
      console.log("  Skipped — no signature available");
      return;
    }

    await delay(500);
    const result = await apiCall("PUT", "/api/v1/agents/me/wallet", {
      walletAddress: publicKey,
      signature,
      nonce,
    });

    if (result.error) {
      // May fail due to rate limiting or wallet already registered
      console.log(`  Wallet registration: ${result.error}`);
      if (result.code === "RATE_LIMITED") {
        console.log("  Rate limited — this is expected if test ran recently");
      }
    } else {
      assertSuccess(result, "PUT /wallet");
      expect(result.success).toBe(true);
      expect(result.walletAddress).toBe(publicKey);
      console.log(`  Wallet registered: ${result.walletAddress}`);
    }
  }, 15_000);

  it("verify wallet registration via profile", async () => {
    await delay(500);
    const result = await apiCall("GET", "/api/v1/agents/me");
    assertSuccess(result, "GET /agents/me (wallet check)");

    const agent = result.agent as Record<string, unknown>;
    if (agent.walletAddress) {
      expect(agent.walletAddress).toBe(publicKey);
      console.log(`  Profile shows wallet: ${agent.walletAddress}`);
    } else {
      console.log("  Profile shows no wallet (registration may have been rate limited)");
    }
  }, 15_000);
});
