import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModelV1 } from "ai";
import { loadConfig, saveConfig } from "../config/store.js";
import type { Config } from "../config/schema.js";
import { isTokenExpired, refreshTokens } from "../onboarding/oauth.js";

/**
 * Check if the current provider is Codex OAuth.
 * Used by the agent loop to route to the custom Codex SSE provider.
 */
export function isCodexOAuth(): boolean {
  const config = loadConfig();
  return config?.provider === "openai-oauth";
}

/**
 * Get the Codex OAuth access token (auto-refreshing if expired).
 * Only call this when isCodexOAuth() returns true.
 */
export async function getCodexAccessToken(): Promise<string> {
  const config = loadConfig();
  if (!config || config.auth.type !== "oauth" || !config.auth.oauth) {
    throw new Error("Codex OAuth not configured. Re-run onboarding.");
  }

  await ensureFreshToken(config);
  return config.auth.oauth.accessToken;
}

/**
 * Get the configured LLM model instance (for non-Codex providers).
 *
 * Reads provider + model + auth from config and returns a Vercel AI SDK
 * model ready for streamText().
 *
 * API keys and tokens are passed directly to the provider constructor —
 * they are never set as global environment variables.
 */
export async function getModel(): Promise<LanguageModelV1> {
  const config = loadConfig();
  if (!config) {
    throw new Error(
      "No config found. Run the onboarding wizard first (delete ~/.config/astranova/config.json to re-run).",
    );
  }

  return createModelFromConfig(config);
}

/**
 * Check if the OAuth token is expired and refresh it if needed.
 * Updates config.json with the new tokens.
 */
async function ensureFreshToken(config: Config): Promise<void> {
  const oauth = config.auth.oauth;
  if (!oauth) return;

  if (!isTokenExpired(oauth.expiresAt)) return;

  try {
    const tokens = await refreshTokens({
      refreshToken: oauth.refreshToken,
      clientId: oauth.clientId,
    });

    // Update config with new tokens
    config.auth.oauth = {
      ...oauth,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    };
    saveConfig(config);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(
      `OAuth token refresh failed: ${message}\nPlease re-run onboarding to log in again (delete ~/.config/astranova/config.json).`,
    );
  }
}

function createModelFromConfig(config: Config): LanguageModelV1 {
  const { provider, model, auth } = config;

  switch (provider) {
    case "claude": {
      if (auth.type !== "api-key" || !auth.apiKey) {
        throw new Error("Claude requires an API key. Re-run onboarding to set one up.");
      }
      const anthropic = createAnthropic({ apiKey: auth.apiKey });
      return anthropic(model);
    }

    case "openai": {
      if (auth.type !== "api-key" || !auth.apiKey) {
        throw new Error("OpenAI requires an API key. Re-run onboarding to set one up.");
      }
      const openai = createOpenAI({ apiKey: auth.apiKey });
      return openai(model);
    }

    case "google": {
      if (auth.type !== "api-key" || !auth.apiKey) {
        throw new Error("Google AI requires an API key. Re-run onboarding to set one up.");
      }
      const google = createGoogleGenerativeAI({ apiKey: auth.apiKey });
      return google(model);
    }

    case "openai-oauth":
      // Codex OAuth uses custom SSE provider (not Vercel AI SDK).
      // This should never be called — the loop routes to runCodexTurn instead.
      throw new Error("Codex OAuth uses custom provider. This is a bug — please report.");

    case "ollama":
      throw new Error(
        "Ollama is not yet supported. Please choose Claude, OpenAI, Gemini, or ChatGPT/Codex.",
      );

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
