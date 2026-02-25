/**
 * Tests for tools/wallet.ts — create_wallet, sign_challenge, sign_and_send_transaction.
 *
 * Tests wallet creation, challenge signing, duplicate wallet prevention,
 * and security (secret keys never exposed in tool results).
 */
import { describe, it, expect } from "vitest";
import "./setup.js";
import { setupFakeAgent, setupTestConfig } from "./setup.js";
import { createWalletTool, signChallengeTool } from "../tools/wallet.js";
import { loadWallet } from "../config/store.js";

// Helper to execute tools
async function execCreateWallet(args: Record<string, unknown>): Promise<unknown> {
  const execute = (createWalletTool as unknown as { execute: (args: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown> }).execute;
  return execute(args, {});
}

async function execSignChallenge(args: Record<string, unknown>): Promise<unknown> {
  const execute = (signChallengeTool as unknown as { execute: (args: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown> }).execute;
  return execute(args, {});
}

describe("create_wallet tool", () => {
  describe("Happy path", () => {
    it("generates a new wallet and saves it", async () => {
      setupFakeAgent("new-wallet-agent");
      const result = await execCreateWallet({ agentName: "new-wallet-agent" }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.publicKey).toBeDefined();
      expect(typeof result.publicKey).toBe("string");
      expect((result.publicKey as string).length).toBeGreaterThan(30); // Solana pubkeys are ~44 chars

      // Verify wallet was saved to disk
      const wallet = loadWallet("new-wallet-agent");
      expect(wallet).not.toBeNull();
      expect(wallet!.publicKey).toBe(result.publicKey);
      expect(wallet!.secretKey).toHaveLength(64);
    });

    it("NEVER returns the secret key in the result", async () => {
      setupFakeAgent("secret-test");
      const result = await execCreateWallet({ agentName: "secret-test" }) as Record<string, unknown>;

      expect(result).not.toHaveProperty("secretKey");
      expect(result).not.toHaveProperty("secret_key");
      expect(result).not.toHaveProperty("privateKey");
      expect(JSON.stringify(result)).not.toContain("secretKey");
    });
  });

  describe("Duplicate prevention", () => {
    it("returns error when wallet already exists", async () => {
      setupFakeAgent("dupe-agent", { withWallet: true });
      const result = await execCreateWallet({ agentName: "dupe-agent" }) as Record<string, unknown>;

      expect(result.error).toContain("already exists");
      expect(result.publicKey).toBeDefined(); // Shows existing public key
      expect(result.hint).toContain("existing wallet");
    });
  });
});

describe("sign_challenge tool", () => {
  describe("Happy path", () => {
    it("signs a challenge and returns signature + nonce", async () => {
      // Create a real wallet first
      setupFakeAgent("signer");
      await execCreateWallet({ agentName: "signer" });

      const challenge = "AstraNova wallet verification: abc123def456";
      const result = await execSignChallenge({ challenge }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.signature).toBeDefined();
      expect(typeof result.signature).toBe("string");
      expect((result.signature as string).length).toBeGreaterThan(0);
      expect(result.walletAddress).toBeDefined();
      expect(result.nonce).toBe("abc123def456");
    });

    it("extracts nonce correctly from challenge string", async () => {
      setupFakeAgent("nonce-test");
      await execCreateWallet({ agentName: "nonce-test" });

      const challenge = "AstraNova wallet verification: my-unique-nonce-789";
      const result = await execSignChallenge({ challenge }) as Record<string, unknown>;
      expect(result.nonce).toBe("my-unique-nonce-789");
    });

    it("NEVER exposes the secret key in the result", async () => {
      setupFakeAgent("sign-secret");
      await execCreateWallet({ agentName: "sign-secret" });

      const result = await execSignChallenge({
        challenge: "AstraNova wallet verification: test",
      }) as Record<string, unknown>;

      expect(result).not.toHaveProperty("secretKey");
      expect(result).not.toHaveProperty("secret_key");
      expect(result).not.toHaveProperty("privateKey");
    });
  });

  describe("Error cases", () => {
    it("returns error when no wallet exists", async () => {
      setupFakeAgent("no-wallet");
      const result = await execSignChallenge({
        challenge: "AstraNova wallet verification: test",
      }) as Record<string, unknown>;

      expect(result.error).toContain("No wallet found");
    });

    it("returns error when no active agent", async () => {
      // Don't set up any agent
      const result = await execSignChallenge({
        challenge: "AstraNova wallet verification: test",
      }) as Record<string, unknown>;

      expect(result.error).toContain("No active agent");
    });
  });
});
