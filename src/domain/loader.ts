import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as clack from "@clack/prompts";
import { PluginManifestSchema, type PluginManifest } from "./plugin.js";
import { validatePluginUrl, validateAllowedPaths, scanForInjection } from "./validator.js";
import { pluginDir, pluginManifestPath, pluginSkillPath, ensureDir, getRoot } from "../config/paths.js";
import { setActivePlugin, getActivePlugin, loadState } from "../config/store.js";
import { PLUGIN_REGISTRY } from "./registry.js";

const MAX_SKILL_MD_BYTES = 1_024 * 1_024; // 1 MB
const FETCH_TIMEOUT_MS = 10_000; // 10 seconds
const REGISTRY_URL = "https://plugins.astra-cli.dev/registry.json";

// ─── ENGINE Section Parser ─────────────────────────────────────────────

type SectionData = Record<string, string | string[]>;

/**
 * Parse all ## ENGINE:<NAME> sections from a skill.md file.
 *
 * Structure:
 *   ## ENGINE:META
 *   name: moltbook
 *   allowedPaths:
 *     - /api/v1/
 *
 * Returns a map of section name → key/value pairs.
 * The parser handles simple string values and string arrays.
 * Section content is never sent to the LLM.
 */
export function parseEngineSections(skillMd: string): Record<string, SectionData> {
  const sections: Record<string, SectionData> = {};
  const lines = skillMd.split("\n");

  let currentSection: string | null = null;
  let currentData: SectionData = {};
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  const flushArray = (): void => {
    if (currentKey !== null && currentArray !== null) {
      currentData[currentKey] = currentArray;
      currentKey = null;
      currentArray = null;
    }
  };

  const flushSection = (): void => {
    if (currentSection !== null) {
      flushArray();
      sections[currentSection] = currentData;
    }
  };

  for (const line of lines) {
    // Detect ## ENGINE:<NAME> (uppercase section name)
    const engineMatch = line.match(/^##\s+ENGINE:([A-Z_]+)\s*$/);
    if (engineMatch) {
      flushSection();
      currentSection = engineMatch[1];
      currentData = {};
      currentKey = null;
      currentArray = null;
      continue;
    }

    // Any ## header (non-ENGINE) ends the current section
    if (/^##\s/.test(line) && currentSection !== null) {
      flushSection();
      currentSection = null;
      currentData = {};
      continue;
    }

    if (currentSection === null) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed === "---") continue;

    // Array item: "  - value" or "- value"
    if (trimmed.startsWith("- ") && currentKey !== null && currentArray !== null) {
      currentArray.push(trimmed.slice(2).trim());
      continue;
    }

    // Flush pending array before a new key:value
    flushArray();

    // Key:value pair
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      if (value === "") {
        // Empty value → following lines are array items
        currentKey = key;
        currentArray = [];
      } else {
        currentKey = key;
        currentData[key] = value;
      }
    }
  }

  flushSection();
  return sections;
}

/**
 * Extract the narrative content of a skill.md (everything before the first ENGINE: section).
 * This is the part injected into the LLM system prompt.
 */
export function extractNarrativeContent(skillMd: string): string {
  const firstEngineIdx = skillMd.search(/\n##\s+ENGINE:/);
  if (firstEngineIdx === -1) return skillMd;
  return skillMd.slice(0, firstEngineIdx);
}

// ─── Manifest Builder ──────────────────────────────────────────────────

function buildManifestFromMeta(meta: SectionData): Partial<PluginManifest> {
  const name = typeof meta.name === "string" ? meta.name.trim() : undefined;
  const version = typeof meta.version === "string" ? meta.version.trim() : "0.0.0";
  const description =
    typeof meta.description === "string" ? meta.description.trim() : (name ?? "Unknown");
  const apiBase =
    typeof meta.apiBase === "string" ? meta.apiBase.trim().replace(/\/$/, "") : undefined;

  let allowedPaths: string[] | undefined;
  if (Array.isArray(meta.allowedPaths)) {
    allowedPaths = meta.allowedPaths;
  } else if (typeof meta.allowedPaths === "string") {
    allowedPaths = [meta.allowedPaths];
  }

  return { name, version, description, apiBase, allowedPaths };
}

// ─── Network Helpers ───────────────────────────────────────────────────

async function fetchWithLimit(url: string, maxBytes: number, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      throw new Error(`Response too large (${contentLength} bytes, max ${maxBytes})`);
    }

    const text = await response.text();
    if (text.length > maxBytes) {
      throw new Error(`Response too large (${text.length} chars, max ${maxBytes})`);
    }

    return text;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  }
}

/**
 * Check if a plugin name is in the official certified registry.
 * Returns false silently on any network or parse error.
 */
async function checkRegistry(pluginName: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(REGISTRY_URL, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) return false;

    const data: unknown = await response.json();
    if (!Array.isArray(data)) return false;

    return (data as string[]).includes(pluginName);
  } catch {
    // Registry unavailable or not yet set up — silently treat as uncertified
    return false;
  }
}

// ─── File Writer ───────────────────────────────────────────────────────

function writeFileSecure(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmpPath = path.join(dir, `.tmp-${crypto.randomBytes(6).toString("hex")}`);
  fs.writeFileSync(tmpPath, data, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function savePluginToDisk(manifest: PluginManifest, skillMdContent: string): void {
  ensureDir(pluginDir(manifest.name));
  writeFileSecure(pluginManifestPath(manifest.name), JSON.stringify(manifest, null, 2));
  writeFileSecure(pluginSkillPath(manifest.name), skillMdContent);
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Install a plugin from a skill.md URL.
 *
 * Flow:
 *  1. Validate URL (HTTPS, not private/localhost)
 *  2. Fetch skill.md
 *  3. Parse ENGINE:META → manifest fields
 *  4. Validate manifest schema + allowedPaths safety
 *  5. Scan narrative content for prompt injection
 *  6. Check official certified registry
 *  7. Show details and confirm with user
 *  8. Save manifest.json + skill.md to plugins dir (chmod 600)
 *  9. Set as active plugin in state.json
 *
 * Exits the process on validation failure or user cancellation.
 */
export async function addPlugin(manifestUrl: string): Promise<void> {
  clack.intro(" astra add ");

  // Step 1 — Validate URL
  const urlResult = validatePluginUrl(manifestUrl);
  if (!urlResult.ok) {
    clack.log.error(urlResult.reason);
    clack.outro("Installation cancelled.");
    process.exit(1);
  }

  // Step 2 — Fetch skill.md
  const spin = clack.spinner();
  spin.start(`Fetching ${urlResult.url.hostname}...`);

  let skillMdContent: string;
  try {
    skillMdContent = await fetchWithLimit(
      urlResult.url.toString(),
      MAX_SKILL_MD_BYTES,
      FETCH_TIMEOUT_MS,
    );
  } catch (err) {
    spin.stop("Fetch failed.");
    clack.log.error(
      `Could not fetch plugin: ${err instanceof Error ? err.message : String(err)}`,
    );
    clack.outro("Installation cancelled.");
    process.exit(1);
  }

  spin.stop("Fetched.");

  // Step 3 — Parse ENGINE:META
  const sections = parseEngineSections(skillMdContent);
  const metaSection = sections["META"];

  if (!metaSection) {
    clack.log.error("This file has no ## ENGINE:META section and cannot be installed as a plugin.");
    clack.log.info(
      "Plugin skill.md files must include an ## ENGINE:META section with name, apiBase, and allowedPaths.",
    );
    clack.outro("Installation cancelled.");
    process.exit(1);
  }

  // Step 4 — Build and validate manifest
  const manifestData = buildManifestFromMeta(metaSection);
  const manifestResult = PluginManifestSchema.safeParse(manifestData);

  if (!manifestResult.success) {
    clack.log.error(
      `Plugin manifest is incomplete: ${manifestResult.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`,
    );
    clack.outro("Installation cancelled.");
    process.exit(1);
  }

  const manifest = manifestResult.data;

  // Validate allowedPaths safety (defense in depth — engine enforces this at runtime too)
  const pathsResult = validateAllowedPaths(manifest.allowedPaths);
  if (!pathsResult.ok) {
    clack.log.error(`Security check failed: ${pathsResult.reason}`);
    clack.outro("Installation cancelled.");
    process.exit(1);
  }

  // Step 5 — Scan narrative for injection
  const narrative = extractNarrativeContent(skillMdContent);
  const injectionResult = scanForInjection(narrative);
  if (!injectionResult.ok) {
    clack.log.error(
      `Security scan blocked: skill.md matched injection pattern "${injectionResult.pattern}".`,
    );
    clack.log.warn("This plugin may be attempting prompt injection. Installation blocked.");
    clack.outro("Installation cancelled.");
    process.exit(1);
  }

  // Step 6 — Registry check (silently fails if network unavailable)
  const spin2 = clack.spinner();
  spin2.start("Checking registry...");
  const isCertified = await checkRegistry(manifest.name);
  spin2.stop(isCertified ? "Certified." : "Registry checked.");

  // Show plugin details
  let apiBaseHost: string;
  try {
    apiBaseHost = new URL(manifest.apiBase).hostname;
  } catch {
    apiBaseHost = manifest.apiBase;
  }

  clack.log.info(`Plugin:      ${manifest.name} v${manifest.version}`);
  clack.log.info(`Description: ${manifest.description}`);
  clack.log.info(`API:         ${apiBaseHost}`);

  if (isCertified) {
    clack.log.success(`Certified ✓  Official @astra-cli registry`);
  } else {
    clack.log.warn(`Uncertified  Not in the official registry`);
    clack.log.warn(`             Source: ${urlResult.url.hostname}`);
  }

  // Step 7 — Confirm with user
  const message = isCertified
    ? `Install ${manifest.name}?`
    : `Install uncertified plugin "${manifest.name}"? API calls will go to ${apiBaseHost}`;

  const confirmed = await clack.confirm({ message, initialValue: isCertified });

  if (clack.isCancel(confirmed) || !confirmed) {
    clack.outro("Installation cancelled.");
    process.exit(0);
  }

  // Step 8 — Save to disk (manifest.json + skill.md, both chmod 600)
  // Attach the original install URL so future skill.md refreshes use the right source.
  const manifestWithSkillUrl: PluginManifest = { ...manifest, skillUrl: urlResult.url.toString() };
  try {
    savePluginToDisk(manifestWithSkillUrl, skillMdContent);
  } catch (err) {
    clack.log.error(
      `Failed to save plugin: ${err instanceof Error ? err.message : String(err)}`,
    );
    clack.outro("Installation failed.");
    process.exit(1);
  }

  // Step 9 — Set as active plugin
  setActivePlugin(manifestWithSkillUrl.name);

  clack.outro(
    `Plugin "${manifest.name}" installed successfully.\nRun \`astra\` to load it, or \`astra --plugin ${manifest.name}\` for this session only.`,
  );
}

/**
 * List all installed third-party plugins (from plugins/ directory).
 * AstraNova is always available as the built-in default and is not included here.
 */
export function listInstalledPlugins(): PluginManifest[] {
  const pluginsRoot = path.join(getRoot(), "plugins");
  if (!fs.existsSync(pluginsRoot)) return [];
  return fs
    .readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => {
      try {
        const raw = fs.readFileSync(pluginManifestPath(e.name), "utf-8");
        return [PluginManifestSchema.parse(JSON.parse(raw))];
      } catch {
        return [];
      }
    });
}

/**
 * Interactive plugin picker using clack.
 * Shows the curated PLUGIN_REGISTRY with install status.
 * Handles: already active, installed (switch), not installed (full wizard).
 *
 * Called from astra.ts after the TUI exits with a .plugins-picker flag.
 */
export async function runPluginsPicker(): Promise<void> {
  if (!loadState()) {
    clack.log.error("No configuration found. Run `astra` to complete setup first.");
    process.exit(1);
  }

  // Strip --plugins-picker so relaunching goes back to the TUI, not the picker again
  const tuiArgs = process.argv.slice(1).filter((a) => a !== "--plugins-picker");

  function relaunchTUI(): never {
    try {
      execFileSync(process.execPath, tuiArgs, { stdio: "inherit", env: process.env });
    } catch {
      // execFileSync throws when the child exits — that's expected
    }
    process.exit(0);
  }

  const activePlugin = getActivePlugin();
  const installed = listInstalledPlugins();
  const installedNames = new Set(["astranova", ...installed.map((p) => p.name)]);

  clack.intro(" astra plugins ");

  const choices = PLUGIN_REGISTRY.map((entry) => {
    const isActive = entry.name === activePlugin;
    const isInstalled = installedNames.has(entry.name);
    const status: "active" | "installed" | "not_installed" = isActive
      ? "active"
      : isInstalled
        ? "installed"
        : "not_installed";
    const statusLabel = isActive ? "(active)" : isInstalled ? "(installed)" : "(not installed)";
    return {
      value: entry.name,
      label: `${entry.name.padEnd(12)} ${statusLabel}`,
      hint: entry.tagline,
      status,
      entry,
    };
  });

  const selected = await clack.select<(typeof choices)[number]["value"]>({
    message: "Select a plugin:",
    options: choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint })),
  });

  if (clack.isCancel(selected)) {
    clack.outro("No changes made.");
    relaunchTUI();
  }

  const choice = choices.find((c) => c.value === selected)!;

  // Already active — go back to TUI
  if (choice.status === "active") {
    clack.outro(`${choice.entry.name} is already the active plugin.`);
    relaunchTUI();
  }

  // Installed but not active — switch and relaunch TUI
  if (choice.status === "installed") {
    setActivePlugin(choice.entry.name);
    clack.outro(`Switched to ${choice.entry.name}. Restarting...`);
    relaunchTUI();
  }

  // Not installed — run full install wizard, then relaunch TUI on success
  if (!choice.entry.skillUrl) {
    clack.log.error(`${choice.entry.name} has no install URL.`);
    process.exit(1);
  }
  await addPlugin(choice.entry.skillUrl);
  // addPlugin() calls process.exit() on failure/cancel; returns on success
  relaunchTUI();
}
