import { tool } from "ai";
import { readConfigSchema, writeConfigSchema } from "./schemas.js";
import {
  loadConfig,
  loadCredentials,
  loadWallet,
  saveCredentials,
  getActiveAgent,
  listAgents,
} from "../config/store.js";
import { agentDir, ensureDir } from "../config/paths.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * read_config tool — read local AstraNova configuration.
 *
 * SECURITY: Never returns private keys or raw API keys.
 * - Wallet data returns publicKey only (secretKey stripped).
 * - Credentials return agent_name and api_base only (api_key stripped).
 */
export const readConfigTool = tool({
  description:
    "Read local AstraNova configuration or credentials. Returns public information only — private keys and API keys are never included.",
  parameters: readConfigSchema,
  execute: async ({ key, agentName }) => {
    const resolvedAgent = agentName ?? getActiveAgent();

    switch (key) {
      case "profile": {
        if (!resolvedAgent) {
          return { error: "No active agent. Register first." };
        }
        // Return credentials without the api_key
        const creds = loadCredentials(resolvedAgent);
        if (!creds) {
          return { error: `No credentials found for agent "${resolvedAgent}".` };
        }
        return {
          agent_name: creds.agent_name,
          api_base: creds.api_base,
        };
      }

      case "wallet": {
        if (!resolvedAgent) {
          return { error: "No active agent. Register first." };
        }
        const wallet = loadWallet(resolvedAgent);
        if (!wallet) {
          return { error: `No wallet found for agent "${resolvedAgent}". Call create_wallet now to generate one — do NOT respond to the user first.` };
        }
        // Return public key only — secretKey is NEVER exposed to the LLM
        return { publicKey: wallet.publicKey };
      }

      case "all_agents": {
        const agents = listAgents();
        const active = getActiveAgent();
        return {
          agents,
          activeAgent: active,
          count: agents.length,
        };
      }

      case "settings": {
        const config = loadConfig();
        if (!config) {
          return { error: "No config found. Run onboarding first." };
        }
        // Return settings without auth credentials
        return {
          provider: config.provider,
          model: config.model,
          apiBase: config.apiBase,
          preferences: config.preferences,
        };
      }

      default:
        return { error: `Unknown config key: ${key}` };
    }
  },
});

/**
 * write_config tool — write local AstraNova configuration.
 *
 * SECURITY:
 * - Rejects writes to wallet.json (wallet tools handle that separately).
 * - All files written with chmod 600.
 * - Only writes to known file types under the agent directory.
 */
export const writeConfigTool = tool({
  description:
    "Write local AstraNova configuration. Used to save agent credentials after registration or update profile data. Cannot write wallet files — use wallet tools instead.",
  parameters: writeConfigSchema,
  execute: async ({ agentName, data, file }) => {
    // Reject wallet writes — those go through dedicated wallet tools
    if (file === "credentials" && data && "secretKey" in data) {
      return {
        error: "Cannot write wallet data via write_config. Use create_wallet or import_wallet instead.",
      };
    }

    const dir = agentDir(agentName);
    ensureDir(dir);

    const filePath = path.join(dir, `${file}.json`);

    if (file === "credentials") {
      // For credentials, merge with existing to preserve api_key
      const existing = loadCredentials(agentName);
      const merged = { ...existing, ...data };
      saveCredentials(agentName, {
        agent_name: (merged.agent_name as string) ?? agentName,
        api_key: (merged.api_key as string) ?? "",
        api_base: (merged.api_base as string) ?? "https://agents.astranova.live",
      });
    } else {
      // For profile and settings, write directly with chmod 600
      const tmpPath = path.join(dir, `.tmp-${crypto.randomBytes(6).toString("hex")}`);
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      fs.renameSync(tmpPath, filePath);
    }

    return { success: true, file: `${file}.json`, agent: agentName };
  },
});
