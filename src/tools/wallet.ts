import { tool } from "ai";
import {
  Keypair,
  Connection,
  VersionedTransaction,
  clusterApiUrl,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  createWalletSchema,
  signChallengeSchema,
  signAndSendTransactionSchema,
} from "./schemas.js";
import {
  getActiveAgent,
  loadWallet,
  saveWallet,
} from "../config/store.js";

// Default to devnet — can be overridden via config in the future
const SOLANA_RPC = clusterApiUrl("devnet");

/**
 * create_wallet tool — generates a new Solana keypair and saves it locally.
 *
 * Security:
 * - Private key stored in wallet.json with chmod 600
 * - Only the public key is returned to the LLM (never the secret key)
 */
export const createWalletTool = tool({
  description:
    "Generate a new Solana wallet keypair. Saves the keypair locally and returns the public key. The secret key is stored securely and never exposed.",
  parameters: createWalletSchema,
  execute: async ({ agentName }) => {
    // Check if wallet already exists
    const existing = loadWallet(agentName);
    if (existing) {
      return {
        error: `Wallet already exists for agent "${agentName}".`,
        publicKey: existing.publicKey,
        hint: "Use the existing wallet or delete wallet.json to regenerate.",
      };
    }

    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    const secretKey = Array.from(keypair.secretKey);

    saveWallet(agentName, { publicKey, secretKey });

    return {
      success: true,
      publicKey,
      message: `Wallet created. Public key: ${publicKey}. Now request a challenge from the API to register it.`,
    };
  },
});

/**
 * sign_challenge tool — signs a wallet registration challenge.
 *
 * Security:
 * - Secret key is loaded from wallet.json, used in-memory, never returned
 * - Only the base58-encoded signature is returned
 */
export const signChallengeTool = tool({
  description:
    "Sign a challenge string with the agent's wallet secret key. Returns a base58-encoded signature for wallet registration. The secret key is never exposed.",
  parameters: signChallengeSchema,
  execute: async ({ challenge }) => {
    const agentName = getActiveAgent();
    if (!agentName) {
      return { error: "No active agent found." };
    }

    const wallet = loadWallet(agentName);
    if (!wallet) {
      return {
        error: `No wallet found for agent "${agentName}". Create one first using create_wallet.`,
      };
    }

    try {
      const secretKeyBytes = Uint8Array.from(wallet.secretKey);
      const messageBytes = new TextEncoder().encode(challenge);
      const signature = nacl.sign.detached(messageBytes, secretKeyBytes);
      const signatureBase58 = bs58.encode(signature);

      // Extract nonce from challenge string
      // Format 1: "AstraNova wallet verification: <nonce>"
      // Format 2: multiline challenge where nonce is on its own line or after a colon
      let nonce = "";
      const singleLineMatch = /(?:verification|nonce)[:\s]+([a-zA-Z0-9_-]+)\s*$/m.exec(challenge);
      if (singleLineMatch) {
        nonce = singleLineMatch[1].trim();
      } else {
        // Fallback: last word/token in the challenge (often the nonce)
        const tokens = challenge.trim().split(/\s+/);
        nonce = tokens[tokens.length - 1] ?? "";
      }

      return {
        success: true,
        signature: signatureBase58,
        walletAddress: wallet.publicKey,
        nonce,
        challengeRaw: challenge,
        message: `Challenge signed. Now call PUT /api/v1/agents/me/wallet with {"walletAddress":"${wallet.publicKey}","signature":"${signatureBase58}","nonce":"${nonce}"}`,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { error: `Failed to sign challenge: ${message}` };
    }
  },
});

/**
 * sign_and_send_transaction tool — co-signs and submits a Solana transaction.
 *
 * Used for claiming $ASTRA rewards:
 * 1. LLM calls api_call POST /api/v1/agents/me/rewards/claim → gets base64 transaction
 * 2. LLM calls sign_and_send_transaction with the base64 transaction
 * 3. This tool deserializes, co-signs with wallet, submits to Solana
 * 4. Returns the transaction signature for confirmation
 *
 * Security:
 * - Secret key loaded in-memory, never returned
 * - Transaction is partially signed by treasury; we only add our signature as fee payer
 * - Submitted to Solana RPC, not to any third party
 */
export const signAndSendTransactionTool = tool({
  description:
    "Co-sign and submit a partially-signed Solana transaction (base64). Used for claiming $ASTRA rewards. Returns the transaction signature.",
  parameters: signAndSendTransactionSchema,
  execute: async ({ transaction: txBase64 }) => {
    const agentName = getActiveAgent();
    if (!agentName) {
      return { error: "No active agent found." };
    }

    const wallet = loadWallet(agentName);
    if (!wallet) {
      return {
        error: `No wallet found for agent "${agentName}". Create one first using create_wallet.`,
      };
    }

    try {
      // Deserialize the partially-signed transaction
      const txBuffer = Buffer.from(txBase64, "base64");
      const tx = VersionedTransaction.deserialize(txBuffer);

      // Reconstruct keypair and co-sign
      const secretKeyBytes = Uint8Array.from(wallet.secretKey);
      const keypair = Keypair.fromSecretKey(secretKeyBytes);
      tx.sign([keypair]);

      // Submit to Solana
      const connection = new Connection(SOLANA_RPC, "confirmed");
      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      // Wait for confirmation
      const confirmation = await connection.confirmTransaction(signature, "confirmed");

      if (confirmation.value.err) {
        return {
          error: `Transaction confirmed but failed: ${JSON.stringify(confirmation.value.err)}`,
          txSignature: signature,
        };
      }

      return {
        success: true,
        txSignature: signature,
        message: `Transaction submitted and confirmed. Signature: ${signature}. Now confirm with the API using POST /api/v1/agents/me/rewards/confirm.`,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { error: `Transaction failed: ${message}` };
    }
  },
});
