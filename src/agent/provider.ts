import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV1 } from "ai";
import { loadConfig, saveConfig } from "../config/store.js";
import type { Config } from "../config/schema.js";
import { isTokenExpired, refreshTokens } from "../onboarding/oauth.js";

/**
 * Check if the current provider is Codex OAuth.
 * Used by the agent loop to route to the custom Codex SSE provider.
 * Returns false if ASTRA_PROVIDER env override is set to a non-oauth provider.
 */
export function isCodexOAuth(): boolean {
  const override = process.env.ASTRA_PROVIDER;
  if (override) return override === "openai-oauth";
  const config = loadConfig();
  return config?.provider === "openai-oauth";
}

/**
 * Check if the current provider is OpenAI with API key (Responses API path).
 * Used by the agent loop to route to the Responses API instead of Vercel AI SDK.
 */
export function isOpenAIResponses(): boolean {
  const override = process.env.ASTRA_PROVIDER;
  if (override) return override === "openai";
  const config = loadConfig();
  return config?.provider === "openai";
}

/**
 * Get the OpenAI API key for the Responses API path.
 * Checks env var override first, then config.
 */
export function getOpenAIApiKey(): string {
  const envKey = process.env.ASTRA_API_KEY;
  if (envKey) return envKey;
  const config = loadConfig();
  if (config?.auth?.type === "api-key" && config.auth.apiKey) {
    return config.auth.apiKey;
  }
  throw new Error(
    "OpenAI API key not found. Set ASTRA_API_KEY or re-run onboarding.",
  );
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

  // Allow env override for testing providers without changing config
  const providerOverride = process.env.ASTRA_PROVIDER;
  const apiKeyOverride = process.env.ASTRA_API_KEY;
  const modelOverride = process.env.ASTRA_MODEL;

  if (providerOverride) {
    if (!apiKeyOverride) {
      throw new Error(
        `ASTRA_PROVIDER=${providerOverride} is set but ASTRA_API_KEY is missing.\nExport your API key: export ASTRA_API_KEY=sk-...`,
      );
    }
    return createModelFromConfig({
      ...config,
      provider: providerOverride as Config["provider"],
      model: modelOverride ?? config.model,
      auth: { type: "api-key", apiKey: apiKeyOverride },
    });
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

    case "google":
      throw new Error(
        "Gemini support is coming soon. Please use Claude or ChatGPT/Codex.\nTo switch, delete ~/.config/astranova/config.json and re-run astra.",
      );

    case "openai-oauth":
      // Codex OAuth uses custom SSE provider (not Vercel AI SDK).
      // This should never be called — the loop routes to runCodexTurn instead.
      throw new Error("Codex OAuth uses custom provider. This is a bug — please report.");

    case "ollama":
      throw new Error(
        "Ollama support is coming soon. Please use Claude or ChatGPT/Codex.\nTo switch, delete ~/.config/astranova/config.json and re-run astra.",
      );

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
