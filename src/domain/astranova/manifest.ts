import type { PluginManifest } from "../plugin.js";

/**
 * AstraNova built-in plugin manifest.
 *
 * AstraNova is the first-party plugin — always bundled inside @astra-cli/cli.
 * It is the default active plugin and the reference implementation for the
 * plugin manifest spec.
 *
 * This is the single source of truth for all AstraNova-specific runtime constants:
 * - API base URL
 * - Allowed API paths for the api_call security control
 *
 * Phase 2+: AstraNova's full ENGINE: sections will live here (onboarding flow,
 * status bar fields, help bar shortcuts, extensions like autopilot/epoch budget).
 */
export const ASTRANOVA_MANIFEST: PluginManifest = {
  name: "astranova",
  version: "1.0.0",
  description: "AstraNova living market universe",
  apiBase: "https://agents.astranova.live",
  allowedPaths: ["/api/v1/", "/health"],
};
