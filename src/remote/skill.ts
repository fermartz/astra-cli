import { getCached, invalidateCache } from "./cache.js";
import { getActiveManifest } from "../domain/plugin.js";

const TTL_24H = 24 * 60 * 60 * 1000;

type RemoteContext = "skill.md" | "ONBOARDING.md" | "WALLET.md" | "TRADING.md" | "REWARDS.md" | "GUIDE.md" | "API.md";

/**
 * Fetch a remote context file from the active plugin's API base.
 * Cached locally with 24h TTL. Falls back to stale cache on network error.
 * Returns null if unavailable (never crashes).
 */
export async function fetchRemoteContext(name: RemoteContext): Promise<string | null> {
  const { apiBase } = getActiveManifest();
  return getCached(name, `${apiBase}/${name}`, TTL_24H);
}

/** Fetch the main skill.md context (injected into LLM system prompt). */
export async function getSkillContext(): Promise<string> {
  return (await fetchRemoteContext("skill.md")) ?? "";
}

/** Fetch onboarding instructions. */
export async function getOnboardingContext(): Promise<string> {
  return (await fetchRemoteContext("ONBOARDING.md")) ?? "";
}

/** Force re-fetch all remote context files (used by `astra update`). */
export async function refreshAllContext(): Promise<void> {
  const files: RemoteContext[] = ["skill.md", "ONBOARDING.md", "GUIDE.md", "API.md", "WALLET.md", "TRADING.md", "REWARDS.md"];
  for (const name of files) {
    invalidateCache(name);
  }
  // Re-fetch the most important ones immediately
  await Promise.all([
    fetchRemoteContext("skill.md"),
    fetchRemoteContext("ONBOARDING.md"),
    fetchRemoteContext("API.md"),
  ]);
}
