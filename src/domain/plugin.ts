import { z } from "zod";

/**
 * Plugin manifest — describes an agent app that can plug into Astra CLI.
 *
 * A plugin is a single skill.md file hosted at an HTTPS URL.
 * The engine parses known ## ENGINE: sections from it:
 *   - Everything above the first ENGINE: section is injected as LLM context.
 *   - ENGINE: sections drive the TUI, onboarding, and status bar.
 *
 * Phase 1: TypeScript interface + runtime manifest registry.
 * Phase 2: Full manifest parsing from remote skill.md + `astra add <url>`.
 * Phase 3: Multi-plugin runtime — plugin switching, plugin-aware TUI.
 */
export const PluginManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  /** Base URL for all api_call requests (no trailing slash). */
  apiBase: z.string(),
  /** Path prefixes the LLM is allowed to call via api_call. */
  allowedPaths: z.array(z.string()),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ─── Runtime Active Manifest ───────────────────────────────────────────

let _activeManifest: PluginManifest | null = null;

/**
 * Set the active plugin manifest.
 * Must be called once at startup (bin/astra.ts) before any tool or remote context call.
 */
export function setActiveManifest(manifest: PluginManifest): void {
  _activeManifest = manifest;
}

/**
 * Get the active plugin manifest.
 * Throws if called before setActiveManifest() — this is a programming error.
 */
export function getActiveManifest(): PluginManifest {
  if (!_activeManifest) {
    throw new Error(
      "No active plugin manifest. Call setActiveManifest() at startup before using tools or remote context.",
    );
  }
  return _activeManifest;
}
