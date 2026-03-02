import * as clack from "@clack/prompts";
import { isConfigured, saveConfig } from "../config/store.js";
import { ensureBaseStructure } from "../config/paths.js";
import type { Config } from "../config/schema.js";
import { selectProvider } from "./provider.js";
import { registerAgent } from "./register.js";
import { LOGO, TAGLINE, VERSION } from "../ui/logo.js";
import { getActiveManifest } from "../domain/plugin.js";

export interface OnboardingResult {
  agentName: string;
  verificationCode: string;
}

/**
 * Run the first-time onboarding wizard.
 * Returns null if the user is already configured (skip onboarding).
 *
 * Steps:
 * 1. Welcome message
 * 2. LLM provider + API key
 * 3. Agent registration
 * 4. (Phase 2: Wallet setup — skipped for now)
 * 5. (Phase 3: OAuth flow — skipped for now)
 */
export async function runOnboarding(): Promise<OnboardingResult | null> {
  if (isConfigured()) {
    return null;
  }

  ensureBaseStructure();

  // Show logo
  console.log(LOGO);
  console.log(`  ${TAGLINE}`);
  console.log(`  ${VERSION}\n`);

  const manifest = getActiveManifest();
  clack.intro(manifest.description);

  // Step 1: Choose LLM provider and enter API key
  const { provider, model, auth } = await selectProvider();

  // Save CLI config — apiBase comes from the active plugin manifest
  const config: Config = {
    version: 1,
    provider,
    model,
    auth,
    apiBase: manifest.apiBase,
    preferences: { theme: "dark" },
    autopilot: { mode: "off", intervalMs: 300_000 },
  };
  saveConfig(config);

  clack.log.success(`Provider set to ${provider} (${model})`);

  // Step 2: Register agent
  const { agentName, verificationCode } = await registerAgent();

  // Future steps (Phase 2+)
  clack.log.info(
    "Wallet setup and X/Twitter verification are available after launch — use the chat to set them up.",
  );

  clack.outro(`Setup complete — launching ${manifest.name}...`);

  return { agentName, verificationCode };
}
