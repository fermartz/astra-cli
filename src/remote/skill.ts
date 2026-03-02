import fs from "node:fs";
import { getCached, invalidateCache } from "./cache.js";
import { getActiveManifest } from "../domain/plugin.js";
import { pluginSkillPath } from "../config/paths.js";

const TTL_24H = 24 * 60 * 60 * 1000;

type RemoteContext = "skill.md" | "ONBOARDING.md" | "WALLET.md" | "TRADING.md" | "REWARDS.md" | "GUIDE.md" | "API.md";

/**
 * Fetch a remote context file from the active plugin's API base.
 * Cached locally with 24h TTL. Falls back to stale cache on network error.
 * For skill.md:
 *   - Uses manifest.skillUrl (saved during install) when available.
 *   - If no skillUrl, uses the locally installed copy directly — no network
 *     call, no warning (avoids 404 noise when apiBase doesn't serve skill.md).
 * Returns null if unavailable (never crashes).
 */
export async function fetchRemoteContext(name: RemoteContext): Promise<string | null> {
  const manifest = getActiveManifest();
  // Prefix cache key with plugin name to avoid cross-plugin cache collisions
  const cacheKey = `${manifest.name}:${name}`;

  if (name === "skill.md") {
    if (manifest.skillUrl) {
      // Installed with a known URL — fetch & cache from there
      const content = await getCached(cacheKey, manifest.skillUrl, TTL_24H);
      if (content !== null) return content;
    }
    // No skillUrl (older install) or cache/network failed — use local copy silently
    const localPath = pluginSkillPath(manifest.name);
    if (fs.existsSync(localPath)) {
      return fs.readFileSync(localPath, "utf-8");
    }
    return null;
  }

  // All other context files (TRADING.md, WALLET.md, etc.) — fetch from apiBase as before
  return getCached(cacheKey, `${manifest.apiBase}/${name}`, TTL_24H);
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
  const manifest = getActiveManifest();
  const files: RemoteContext[] = ["skill.md", "ONBOARDING.md", "GUIDE.md", "API.md", "WALLET.md", "TRADING.md", "REWARDS.md"];
  for (const name of files) {
    invalidateCache(`${manifest.name}:${name}`);
  }
  // Re-fetch the most important ones immediately
  await Promise.all([
    fetchRemoteContext("skill.md"),
    fetchRemoteContext("ONBOARDING.md"),
    fetchRemoteContext("API.md"),
  ]);
}
