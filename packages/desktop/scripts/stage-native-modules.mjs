#!/usr/bin/env node
/**
 * Copies native node_modules (node-pty, node-addon-api) from pnpm's
 * symlinked store into real directories so electron-packager can find them.
 * Run before electron-forge make/package.
 */
import { cpSync, rmSync, realpathSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const nmDir = resolve(desktopRoot, "node_modules");
const require = createRequire(resolve(desktopRoot, "package.json"));

const modules = ["node-pty", "node-addon-api"];

for (const mod of modules) {
  const modDir = resolve(nmDir, mod);

  // Find the module via require.resolve (works across pnpm hoisting)
  let realPath;
  try {
    const pkgJson = require.resolve(`${mod}/package.json`);
    realPath = dirname(realpathSync(pkgJson));
    console.log(`  ${mod}: resolved via require.resolve → ${realPath}`);
  } catch {
    // Fallback: check node_modules directly
    if (existsSync(modDir)) {
      realPath = realpathSync(modDir);
      console.log(`  ${mod}: found in node_modules → ${realPath}`);
    } else {
      console.error(`  ERROR: ${mod} not found! Desktop app will fail at runtime.`);
      process.exit(1);
    }
  }

  // If target already exists and is a real directory with the right content, skip
  if (realPath === modDir) {
    console.log(`  ${mod}: already real directory`);
    continue;
  }

  // Remove existing symlink/dir, copy real files
  rmSync(modDir, { recursive: true, force: true });
  cpSync(realPath, modDir, { recursive: true });
  console.log(`  ${mod}: staged from ${realPath}`);
}

// Verify .node binaries exist (the actual native code)
try {
  const ptyDir = resolve(nmDir, "node-pty");
  const result = execSync(`find "${ptyDir}" -name "*.node" -o -name "spawn-helper"`, {
    encoding: "utf8",
  });
  if (result.trim()) {
    console.log(`  Native files found:`);
    for (const f of result.trim().split("\n")) {
      console.log(`    ${f}`);
    }
  } else {
    console.error("  ERROR: No .node files found in node-pty!");
    process.exit(1);
  }
} catch (err) {
  // find command may not work on Windows
  console.log("  Skipping .node verification (non-Unix platform)");
}

console.log("Native modules staged.");
