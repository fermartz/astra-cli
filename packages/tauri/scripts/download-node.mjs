#!/usr/bin/env node

/**
 * Downloads the official Node.js binary for the current platform.
 * Extracts only the `node` binary (not npm/npx) to `node-bin/`.
 * Verifies SHA256 checksum. Skips if matching version already exists.
 *
 * Usage: node scripts/download-node.mjs [--version 20.18.3]
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = join(ROOT, "node-bin");
const VERSION_FILE = join(OUT_DIR, ".node-version");

// Default: Node.js 20 LTS (latest patch)
const DEFAULT_VERSION = "20.18.3";

function getVersion() {
  const idx = process.argv.indexOf("--version");
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : DEFAULT_VERSION;
}

function getPlatformInfo() {
  const platform = process.platform;
  const arch = process.arch;

  // Map Node.js platform/arch to nodejs.org naming
  const platformMap = { darwin: "darwin", linux: "linux", win32: "win" };
  const archMap = { x64: "x64", arm64: "arm64" };

  const nodePlatform = platformMap[platform];
  const nodeArch = archMap[arch];

  if (!nodePlatform || !nodeArch) {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }

  const isWindows = platform === "win32";
  const ext = isWindows ? "zip" : "tar.gz";
  const binaryName = isWindows ? "node.exe" : "node";

  return { nodePlatform, nodeArch, isWindows, ext, binaryName };
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  await pipeline(res.body, createWriteStream(dest));
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function main() {
  const version = getVersion();
  const { nodePlatform, nodeArch, isWindows, ext, binaryName } = getPlatformInfo();

  const archiveName = `node-v${version}-${nodePlatform}-${nodeArch}.${ext}`;
  const baseUrl = `https://nodejs.org/dist/v${version}`;

  // Check if we already have this version
  if (existsSync(VERSION_FILE)) {
    const existing = readFileSync(VERSION_FILE, "utf8").trim();
    if (existing === version && existsSync(join(OUT_DIR, binaryName))) {
      console.log(`Node.js v${version} already downloaded, skipping.`);
      return;
    }
  }

  console.log(`Downloading Node.js v${version} for ${nodePlatform}-${nodeArch}...`);

  // Fetch SHASUMS256 for verification
  console.log("Fetching checksums...");
  const shasums = await fetchText(`${baseUrl}/SHASUMS256.txt`);
  const expectedHash = shasums
    .split("\n")
    .find((line) => line.includes(archiveName))
    ?.split(/\s+/)[0];

  if (!expectedHash) {
    throw new Error(`No checksum found for ${archiveName} in SHASUMS256.txt`);
  }

  // Download archive
  const archivePath = join(OUT_DIR, archiveName);
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Downloading ${archiveName}...`);
  await downloadFile(`${baseUrl}/${archiveName}`, archivePath);

  // Verify checksum
  console.log("Verifying checksum...");
  const actualHash = await sha256File(archivePath);
  if (actualHash !== expectedHash) {
    unlinkSync(archivePath);
    throw new Error(
      `Checksum mismatch!\n  Expected: ${expectedHash}\n  Got:      ${actualHash}`
    );
  }
  console.log("Checksum verified.");

  // Extract only the node binary
  const dirName = `node-v${version}-${nodePlatform}-${nodeArch}`;
  const destBinary = join(OUT_DIR, binaryName);

  if (isWindows) {
    // Windows: use tar.exe (available on Win10+) to extract node.exe from zip
    execSync(
      `tar -xf "${archivePath}" --strip-components=1 -C "${OUT_DIR}" "${dirName}/node.exe"`,
      { stdio: "inherit" }
    );
  } else {
    // Unix: extract just the node binary from the tarball
    execSync(
      `tar -xzf "${archivePath}" --strip-components=2 -C "${OUT_DIR}" "${dirName}/bin/node"`,
      { stdio: "inherit" }
    );
    chmodSync(destBinary, 0o755);
  }

  // Clean up archive
  unlinkSync(archivePath);

  // Write version marker
  writeFileSync(VERSION_FILE, version);

  // Verify extraction worked
  if (!existsSync(destBinary)) {
    throw new Error(`Failed to extract ${binaryName} to ${OUT_DIR}`);
  }

  const size = (readFileSync(destBinary).length / 1024 / 1024).toFixed(1);
  console.log(`Done! ${binaryName} (${size}MB) → ${OUT_DIR}/`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
