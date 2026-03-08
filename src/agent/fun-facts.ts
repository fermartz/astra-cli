import { generateText } from "ai";
import { getModel, isCodexOAuth, isOpenAIResponses, getCodexAccessToken, getOpenAIApiKey } from "./provider.js";
import { callCodex } from "./codex-provider.js";
import { loadConfig } from "../config/store.js";

const CATEGORIES = [
  "Cosmic fact — astronomy, physics, space phenomena",
  "Space history — missions, discoveries, milestones",
  "Market fact — trading history, market psychology, financial milestones",
  "Crypto fact — blockchain history, culture, notable events",
  "Word origin — etymology related to astronomy, science, or trading",
];

function buildFunFactPrompt(): string {
  const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)]!;
  return `Generate exactly one fun fact from this category: ${category}

Rules:
- Maximum 120 characters total including the category label
- Format: Category: Fact (one short sentence)
- No markdown, no bold, no asterisks
- Be concise — shorter is better`;
}

const DEBUG = !!process.env.ASTRA_DEBUG;
function debugLog(msg: string): void {
  if (DEBUG) process.stderr.write(`[fun-facts] ${msg}\n`);
}

/** OpenAI Responses API base URL */
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

/** Generate a single fun fact via a lightweight LLM call. Returns null on failure. */
export async function generateFunFact(): Promise<string | null> {
  try {
    debugLog("Generating fun fact...");
    const config = loadConfig();
    if (!config) return null;

    let text: string;

    if (isCodexOAuth()) {
      // Codex OAuth — use custom SSE provider
      const token = await getCodexAccessToken();
      const result = await callCodex({
        accessToken: token,
        model: config.model ?? "gpt-4o-mini",
        instructions: buildFunFactPrompt(),
        input: [{ role: "user", content: "go" }],
        timeoutMs: 30_000,
      });
      text = result.text;
    } else if (isOpenAIResponses()) {
      // OpenAI API key — use Responses API
      const apiKey = getOpenAIApiKey();
      const result = await callCodex({
        accessToken: apiKey,
        model: config.model ?? "gpt-4o-mini",
        instructions: buildFunFactPrompt(),
        input: [{ role: "user", content: "go" }],
        timeoutMs: 30_000,
        baseUrl: OPENAI_RESPONSES_URL,
      });
      text = result.text;
    } else {
      // SDK providers (Claude, Gemini) — use generateText
      const model = await getModel();
      const result = await generateText({
        model,
        system: buildFunFactPrompt(),
        messages: [{ role: "user", content: "go" }],
        maxTokens: 80,
      });
      text = result.text;
    }

    debugLog(`Fun fact result: ${text.trim().slice(0, 60)}...`);
    return text.trim() || null;
  } catch (err) {
    debugLog(`Fun fact error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
