import { exec } from "node:child_process";
import * as clack from "@clack/prompts";
import type { Config } from "../config/schema.js";
import {
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  parseCallbackUrl,
  isRemoteEnvironment,
  REDIRECT_URI,
} from "./oauth.js";
import { waitForCallback } from "./callback-server.js";

interface ProviderChoice {
  provider: Config["provider"];
  model: string;
  auth: Config["auth"];
}

const DEFAULT_MODELS: Record<string, string> = {
  "openai-oauth": "gpt-5.3-codex",
  claude: "claude-sonnet-4-20250514",
  openai: "gpt-5.1",
  google: "gemini-2.0-flash",
  ollama: "llama3.1",
};

/**
 * Prompt the user to choose an LLM provider and enter credentials.
 * Supports Claude, OpenAI, Gemini (API key) and ChatGPT/Codex (OAuth).
 */
export async function selectProvider(): Promise<ProviderChoice> {
  for (;;) {
    const provider = await clack.select({
      message: "Choose your LLM provider",
      options: [
        {
          value: "openai-oauth",
          label: "ChatGPT / Codex",
          hint: "login with ChatGPT subscription — no API key needed",
        },
        {
          value: "claude",
          label: "Claude (Anthropic)",
          hint: "API key",
        },
        {
          value: "openai",
          label: "GPT (OpenAI)",
          hint: "coming soon",
        },
        {
          value: "google",
          label: "Gemini (Google)",
          hint: "coming soon",
        },
        {
          value: "ollama",
          label: "Local (Ollama)",
          hint: "coming soon",
        },
      ],
    });

    if (clack.isCancel(provider)) {
      clack.cancel("Setup cancelled.");
      process.exit(0);
    }

    // OpenAI, Gemini, Ollama deferred — ship with Claude + Codex only
    if (provider === "openai" || provider === "google" || provider === "ollama") {
      const names: Record<string, string> = { openai: "OpenAI", google: "Gemini", ollama: "Ollama" };
      clack.log.warn(`${names[provider as string]} support is coming soon. Please choose Claude or ChatGPT/Codex for now.`);
      continue;
    }

    // ChatGPT / Codex OAuth flow
    if (provider === "openai-oauth") {
      const oauthResult = await runCodexOAuth();
      if (!oauthResult) continue; // User cancelled or failed, re-show menu
      return oauthResult;
    }

    // API key flow
    const apiKey = await promptApiKey(provider as string);
    const model = DEFAULT_MODELS[provider as string] ?? "";

    return {
      provider: provider as Config["provider"],
      model,
      auth: { type: "api-key", apiKey },
    };
  }
}

// ─── Codex OAuth Flow ──────────────────────────────────────────────────

async function runCodexOAuth(): Promise<ProviderChoice | null> {
  const remote = isRemoteEnvironment();
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl({ state, challenge });

  if (remote) {
    return runRemoteOAuth(authorizeUrl, state, verifier);
  }
  return runLocalOAuth(authorizeUrl, state, verifier);
}

async function runLocalOAuth(
  authorizeUrl: string,
  state: string,
  verifier: string,
): Promise<ProviderChoice | null> {
  const spinner = clack.spinner();

  clack.log.info("Opening your browser to log in with ChatGPT...");
  clack.log.message(`If the browser doesn't open, visit:\n${authorizeUrl}`);

  // Try to open browser
  openBrowser(authorizeUrl);

  spinner.start("Waiting for login... (3 min timeout)");

  let code: string;
  try {
    const result = await waitForCallback({
      redirectUri: REDIRECT_URI,
      expectedState: state,
    });
    code = result.code;
    spinner.stop("Callback received.");
  } catch {
    // Callback failed (timeout or port conflict) — fall back to manual paste
    spinner.stop("Callback not detected.");
    const manualResult = await promptManualPaste(state);
    if (!manualResult) return null;
    code = manualResult;
  }

  return exchangeAndReturn(code, verifier);
}

async function runRemoteOAuth(
  authorizeUrl: string,
  state: string,
  verifier: string,
): Promise<ProviderChoice | null> {
  clack.log.info(
    [
      "You're in a remote environment.",
      "Open this URL in your local browser:",
      "",
      authorizeUrl,
      "",
      "After signing in, paste the redirect URL here.",
    ].join("\n"),
  );

  const code = await promptManualPaste(state);
  if (!code) return null;

  return exchangeAndReturn(code, verifier);
}

async function promptManualPaste(state: string): Promise<string | null> {
  const input = await clack.text({
    message: "Paste the redirect URL from your browser",
    placeholder: `${REDIRECT_URI}?code=...&state=...`,
    validate(value) {
      if (!value || value.trim().length === 0) {
        return "URL is required";
      }
      const parsed = parseCallbackUrl(value, state);
      if ("error" in parsed) {
        return parsed.error;
      }
      return undefined;
    },
  });

  if (clack.isCancel(input)) {
    clack.log.warn("OAuth cancelled. Returning to provider selection.");
    return null;
  }

  const parsed = parseCallbackUrl(input as string, state);
  if ("error" in parsed) {
    clack.log.error(parsed.error);
    return null;
  }
  return parsed.code;
}

async function exchangeAndReturn(
  code: string,
  verifier: string,
): Promise<ProviderChoice | null> {
  const spinner = clack.spinner();
  spinner.start("Exchanging code for tokens...");

  try {
    const tokens = await exchangeCodeForTokens({ code, codeVerifier: verifier });
    spinner.stop("Authenticated successfully.");

    return {
      provider: "openai-oauth",
      model: DEFAULT_MODELS["openai-oauth"] ?? "gpt-5.3-codex",
      auth: {
        type: "oauth",
        oauth: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          clientId: tokens.clientId,
        },
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    spinner.stop(`Authentication failed: ${message}`);
    clack.log.error("Please try again or choose a different provider.");
    return null;
  }
}

// ─── Browser Open ──────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;

  exec(command, (err) => {
    if (err) {
      // Silently fail — URL is already displayed in terminal
    }
  });
}

// ─── API Key Flow ──────────────────────────────────────────────────────

/**
 * Prompt for an API key and validate it with a lightweight test call.
 */
async function promptApiKey(provider: string): Promise<string> {
  const labels: Record<string, string> = {
    claude: "Anthropic API key",
    openai: "OpenAI API key",
    google: "Google AI API key",
  };

  const placeholders: Record<string, string> = {
    claude: "sk-ant-...",
    openai: "sk-...",
    google: "AIza...",
  };

  const apiKey = await clack.text({
    message: `Enter your ${labels[provider] ?? "API key"}`,
    placeholder: placeholders[provider] ?? "your-api-key",
    validate(value) {
      if (!value || value.trim().length === 0) {
        return "API key is required";
      }
      return undefined;
    },
  });

  if (clack.isCancel(apiKey)) {
    clack.cancel("Setup cancelled.");
    process.exit(0);
  }

  const trimmed = (apiKey as string).trim();

  // Validate with a test call
  const spinner = clack.spinner();
  spinner.start("Validating API key...");

  const valid = await validateApiKey(provider, trimmed);

  if (!valid.ok) {
    spinner.stop(`API key validation failed: ${valid.error}`);
    clack.log.error("Please check your key and try again.");
    return promptApiKey(provider);
  }

  spinner.stop("API key validated.");
  return trimmed;
}

interface ValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate an API key by making a lightweight call to the provider.
 */
async function validateApiKey(provider: string, apiKey: string): Promise<ValidationResult> {
  try {
    switch (provider) {
      case "claude": {
        const res = await fetch("https://api.anthropic.com/v1/models", {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
        });
        if (!res.ok) return { ok: false, error: `Anthropic returned HTTP ${res.status}` };
        return { ok: true };
      }

      case "openai": {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) return { ok: false, error: `OpenAI returned HTTP ${res.status}` };
        return { ok: true };
      }

      case "google": {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        );
        if (!res.ok) return { ok: false, error: `Google AI returned HTTP ${res.status}` };
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unknown provider: ${provider}` };
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { ok: false, error: `Network error: ${message}` };
  }
}
