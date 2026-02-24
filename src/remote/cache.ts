import fs from "node:fs";
import { cachePath, ensureDir, CACHE_DIR } from "../config/paths.js";

interface CacheMeta {
  fetchedAt: string;
  url: string;
}

const metaPath = (name: string): string => cachePath(`${name}.meta.json`);

/**
 * Fetch a remote file with TTL-based caching.
 *
 * - Returns cached content if within TTL.
 * - On network error, falls back to stale cache if available.
 * - If no cache exists and network fails, returns null (never crashes).
 */
export async function getCached(
  name: string,
  url: string,
  ttlMs: number,
): Promise<string | null> {
  ensureDir(CACHE_DIR);

  const contentPath = cachePath(name);
  const meta = readMeta(name);

  // Check if cache is fresh
  if (meta && fs.existsSync(contentPath)) {
    const age = Date.now() - new Date(meta.fetchedAt).getTime();
    if (age < ttlMs) {
      return fs.readFileSync(contentPath, "utf-8");
    }
  }

  // Try to fetch fresh content
  try {
    const response = await fetch(url);

    if (!response.ok) {
      return fallbackToStale(contentPath, name, url, response.status);
    }

    const content = await response.text();

    // Write content and metadata
    fs.writeFileSync(contentPath, content, "utf-8");
    fs.writeFileSync(
      metaPath(name),
      JSON.stringify({ fetchedAt: new Date().toISOString(), url } satisfies CacheMeta),
      "utf-8",
    );

    return content;
  } catch {
    return fallbackToStale(contentPath, name, url);
  }
}

/** Invalidate a cached file, forcing a fresh fetch on next access. */
export function invalidateCache(name: string): void {
  const meta = metaPath(name);
  if (fs.existsSync(meta)) {
    fs.unlinkSync(meta);
  }
}

function readMeta(name: string): CacheMeta | null {
  const mp = metaPath(name);
  if (!fs.existsSync(mp)) return null;

  try {
    return JSON.parse(fs.readFileSync(mp, "utf-8")) as CacheMeta;
  } catch {
    return null;
  }
}

function fallbackToStale(
  contentPath: string,
  name: string,
  url: string,
  status?: number,
): string | null {
  if (fs.existsSync(contentPath)) {
    const hint = status ? `HTTP ${status}` : "network error";
    console.error(
      `Warning: Could not refresh ${name} from ${url} (${hint}). Using cached version.`,
    );
    return fs.readFileSync(contentPath, "utf-8");
  }

  const hint = status ? `HTTP ${status}` : "network error";
  console.error(
    `Warning: Could not fetch ${name} from ${url} (${hint}). No cached version available.`,
  );
  return null;
}
