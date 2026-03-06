import { exec } from "node:child_process";

export const DEFAULT_MODELS: Record<string, string> = {
  "openai-oauth": "gpt-5.3-codex",
  claude: "claude-sonnet-4-20250514",
  openai: "gpt-4o-mini",
  google: "gemini-2.5-flash",
  ollama: "llama3.1",
};

// ─── Browser Open ──────────────────────────────────────────────────────

export function openBrowser(url: string): void {
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

// ─── API Key Validation ────────────────────────────────────────────────

interface ValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate an API key by making a lightweight call to the provider.
 */
export async function validateApiKey(provider: string, apiKey: string): Promise<ValidationResult> {
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

/** Provider display labels used in both onboarding and /model command. */
export const PROVIDER_OPTIONS = [
  { value: "openai-oauth", label: "ChatGPT / Codex", hint: "login with ChatGPT — no API key needed" },
  { value: "claude", label: "Claude (Anthropic)", hint: "API key" },
  { value: "openai", label: "GPT (OpenAI)", hint: "API key" },
  { value: "google", label: "Gemini (Google)", hint: "API key" },
  { value: "ollama", label: "Local (Ollama)", hint: "coming soon" },
] as const;

/** Labels for API key prompts. */
export const API_KEY_LABELS: Record<string, string> = {
  claude: "Anthropic API key",
  openai: "OpenAI API key",
  google: "Google AI API key",
};

/** Placeholders for API key prompts. */
export const API_KEY_PLACEHOLDERS: Record<string, string> = {
  claude: "sk-ant-...",
  openai: "sk-...",
  google: "AIza...",
};
