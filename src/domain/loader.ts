import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import React from "react";
import { render } from "ink";
import { PluginManifestSchema, type PluginManifest } from "./plugin.js";
import { validatePluginUrl, validateAllowedPaths, scanForInjection } from "./validator.js";
import { pluginDir, pluginManifestPath, pluginSkillPath, pluginMapPath, ensureDir, getRoot } from "../config/paths.js";
import { setActivePlugin, getActivePlugin, loadState } from "../config/store.js";
import { PLUGIN_REGISTRY } from "./registry.js";
import PluginInstaller from "../ui/PluginInstaller.js";
import PluginPicker from "../ui/PluginPicker.js";
import type { PluginChoice } from "../ui/PluginPicker.js";

// ─── Plugin Map Types ──────────────────────────────────────────────────

export interface PluginStatusField {
  path: string;   // dot-path into API response, e.g. "stats.post_count"
  label: string;  // display label
  color: string;  // ink color string
}

export interface PluginMap {
  version: 1;
  pluginName: string;
  description?: string;
  status?: { poll: string; intervalMs?: number; fields: PluginStatusField[] };
  commands?: Array<{ command: string; description: string }>;
  routes?: Array<{ method: string; path: string; summary?: string }>;
  workflows?: Record<string, string[]>;
  capabilities?: {
    requiresWallet?: boolean;
    requiresVerification?: boolean;
    supportsFileUpload?: boolean;
    authType?: string;
  };
}

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
  const rawName = typeof meta.name === "string" ? meta.name.trim() : undefined;
  // Validate plugin name — same rules as agent names to prevent path traversal
  const name = rawName && /^[a-z0-9_-]+$/.test(rawName) ? rawName : undefined;
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

/**
 * Extract API routes from skill.md narrative by scanning for curl patterns.
 * Returns unique METHOD + path pairs (deduplicated).
 */
export function extractRoutes(narrative: string): Array<{ method: string; path: string }> {
  const routes: Array<{ method: string; path: string }> = [];
  const seen = new Set<string>();

  const curlPattern = /curl\s+(?:-X\s+(GET|POST|PUT|PATCH|DELETE)\s+)?["']?https?:\/\/[^/\s]+(\S+?)["']?\s/g;
  let match: RegExpExecArray | null;

  while ((match = curlPattern.exec(narrative)) !== null) {
    const method = match[1] ?? "GET";
    const rawPath = match[2].split("?")[0].replace(/["']/g, "");
    const key = `${method} ${rawPath}`;
    if (!seen.has(key)) {
      seen.add(key);
      routes.push({ method, path: rawPath });
    }
  }

  return routes;
}

function buildPluginMap(
  pluginName: string,
  manifest: PluginManifest,
  sections: Record<string, SectionData>,
  skillMd: string,
): PluginMap {
  const map: PluginMap = { version: 1, pluginName };

  if (manifest.description) {
    map.description = manifest.description;
  }

  // ENGINE:STATUS
  const statusSection = sections["STATUS"];
  if (statusSection) {
    const poll = typeof statusSection.poll === "string" ? statusSection.poll.trim() : null;
    const intervalMs = typeof statusSection.intervalMs === "string"
      ? parseInt(statusSection.intervalMs, 10) || undefined
      : undefined;
    const rawFields = Array.isArray(statusSection.fields) ? statusSection.fields : [];
    const fields: PluginStatusField[] = rawFields.flatMap((raw) => {
      const parts = (raw as string).split("|").map((s) => s.trim());
      if (parts.length === 3) return [{ path: parts[0], label: parts[1], color: parts[2] }];
      return [];
    });
    // Security: poll path must be within manifest's allowedPaths
    const pollAllowed = poll && manifest.allowedPaths.some((ap) => poll.startsWith(ap));
    if (poll && pollAllowed && fields.length > 0) {
      map.status = { poll, fields };
      if (intervalMs) map.status.intervalMs = intervalMs;
    }
  }

  // ENGINE:COMMANDS
  const cmdSection = sections["COMMANDS"];
  if (cmdSection) {
    const rawCmds = Array.isArray(cmdSection.commands) ? cmdSection.commands : [];
    map.commands = rawCmds.flatMap((raw) => {
      const match = (raw as string).match(/^(\S+)\s{2,}(.+)$/);
      if (match) return [{ command: match[1], description: match[2].trim() }];
      return [];
    });
  }

  // ENGINE:ROUTES (overrides auto-extraction) or auto-extract from curl patterns
  const routesSection = sections["ROUTES"];
  if (routesSection && Array.isArray(routesSection.routes)) {
    map.routes = routesSection.routes.flatMap((raw) => {
      const m = (raw as string).match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)(?:\s{2,}(.+))?$/);
      if (m) return [{ method: m[1], path: m[2], summary: m[3]?.trim() }];
      return [];
    });
  } else {
    const narrative = extractNarrativeContent(skillMd);
    const routes = extractRoutes(narrative);
    if (routes.length > 0) map.routes = routes;
  }

  // ENGINE:WORKFLOWS
  const workflowSection = sections["WORKFLOWS"];
  if (workflowSection) {
    const workflows: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(workflowSection)) {
      if (Array.isArray(value)) {
        workflows[key] = value;
      }
    }
    if (Object.keys(workflows).length > 0) map.workflows = workflows;
  }

  // ENGINE:CAPABILITIES
  const capSection = sections["CAPABILITIES"];
  if (capSection) {
    map.capabilities = {};
    if (typeof capSection.requiresWallet === "string")
      map.capabilities.requiresWallet = capSection.requiresWallet === "true";
    if (typeof capSection.requiresVerification === "string")
      map.capabilities.requiresVerification = capSection.requiresVerification === "true";
    if (typeof capSection.supportsFileUpload === "string")
      map.capabilities.supportsFileUpload = capSection.supportsFileUpload === "true";
    if (typeof capSection.authType === "string")
      map.capabilities.authType = capSection.authType;
  }

  return map;
}

export function loadPluginMap(pluginName: string): PluginMap | null {
  const p = pluginMapPath(pluginName);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as PluginMap;
  } catch {
    return null;
  }
}

function savePluginToDisk(
  manifest: PluginManifest,
  skillMdContent: string,
  sections: Record<string, SectionData>,
): void {
  ensureDir(pluginDir(manifest.name));
  writeFileSecure(pluginManifestPath(manifest.name), JSON.stringify(manifest, null, 2));
  writeFileSecure(pluginSkillPath(manifest.name), skillMdContent);
  const pluginMap = buildPluginMap(manifest.name, manifest, sections, skillMdContent);
  writeFileSecure(pluginMapPath(manifest.name), JSON.stringify(pluginMap, null, 2));
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Install a plugin from a skill.md URL.
 * Uses an Ink-based UI for progress and confirmation.
 */
export async function addPlugin(manifestUrl: string): Promise<void> {
  const { waitUntilExit } = render(
    React.createElement(PluginInstaller, {
      manifestUrl,
      onInstall: async (url: string) => {
        // Step 1 — Validate URL
        const urlResult = validatePluginUrl(url);
        if (!urlResult.ok) {
          throw new Error(urlResult.reason);
        }

        // Step 2 — Fetch skill.md
        let skillMdContent: string;
        try {
          skillMdContent = await fetchWithLimit(
            urlResult.url.toString(),
            MAX_SKILL_MD_BYTES,
            FETCH_TIMEOUT_MS,
          );
        } catch (err) {
          throw new Error(
            `Could not fetch plugin: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // Step 3 — Parse ENGINE:META
        const sections = parseEngineSections(skillMdContent);
        const metaSection = sections["META"];

        if (!metaSection) {
          throw new Error(
            "This file has no ## ENGINE:META section and cannot be installed as a plugin.",
          );
        }

        // Step 4 — Build and validate manifest
        const manifestData = buildManifestFromMeta(metaSection);
        const manifestResult = PluginManifestSchema.safeParse(manifestData);

        if (!manifestResult.success) {
          throw new Error(
            `Plugin manifest is incomplete: ${manifestResult.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`,
          );
        }

        const manifest = manifestResult.data;

        // Validate allowedPaths safety
        const pathsResult = validateAllowedPaths(manifest.allowedPaths);
        if (!pathsResult.ok) {
          throw new Error(`Security check failed: ${pathsResult.reason}`);
        }

        // Step 5 — Scan narrative for injection
        const narrative = extractNarrativeContent(skillMdContent);
        const injectionResult = scanForInjection(narrative);
        if (!injectionResult.ok) {
          throw new Error(
            `Security scan blocked: skill.md matched injection pattern "${injectionResult.pattern}".`,
          );
        }

        // Step 6 — Registry check
        const isCertified = await checkRegistry(manifest.name);

        let apiBaseHost: string;
        try {
          apiBaseHost = new URL(manifest.apiBase).hostname;
        } catch {
          apiBaseHost = manifest.apiBase;
        }

        return {
          details: {
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            apiHost: apiBaseHost,
            isCertified,
          },
          confirm: () => {
            // Save to disk
            const manifestWithSkillUrl: PluginManifest = { ...manifest, skillUrl: urlResult.url.toString() };
            savePluginToDisk(manifestWithSkillUrl, skillMdContent, sections);
            setActivePlugin(manifestWithSkillUrl.name);
          },
        };
      },
    }),
    { incrementalRendering: true },
  );

  await waitUntilExit();
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
 * Interactive plugin picker using Ink.
 * Shows the curated PLUGIN_REGISTRY with install status.
 * Handles: already active, installed (switch), not installed (full wizard).
 *
 * Called from astra.ts after the TUI exits with a .plugins-picker flag.
 */
export async function runPluginsPicker(): Promise<void> {
  if (!loadState()) {
    console.error("No configuration found. Run `astra` to complete setup first.");
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

  const choices: PluginChoice[] = PLUGIN_REGISTRY.map((entry) => {
    const isActive = entry.name === activePlugin;
    const isInstalled = installedNames.has(entry.name);
    const status: "active" | "installed" | "not_installed" = isActive
      ? "active"
      : isInstalled
        ? "installed"
        : "not_installed";
    return {
      name: entry.name,
      tagline: entry.tagline,
      status,
      skillUrl: entry.skillUrl ?? undefined,
    };
  });

  await new Promise<unknown>((resolve) => {
    const { waitUntilExit } = render(
      React.createElement(PluginPicker, {
        choices,
        onSelect: (choice: PluginChoice) => {
          if (choice.status === "active") {
            console.log(`\n  ${choice.name} is already the active plugin.\n`);
            relaunchTUI();
          }

          if (choice.status === "installed") {
            setActivePlugin(choice.name);
            console.log(`\n  Switched to ${choice.name}. Restarting...\n`);
            relaunchTUI();
          }

          // Not installed — run full install wizard, then relaunch TUI
          if (!choice.skillUrl) {
            console.error(`\n  ${choice.name} has no install URL.\n`);
            process.exit(1);
          }
          void addPlugin(choice.skillUrl).then(() => {
            relaunchTUI();
          });
        },
        onCancel: () => {
          relaunchTUI();
        },
      }),
      { incrementalRendering: true },
    );

    void waitUntilExit().then(resolve);
  });
}
