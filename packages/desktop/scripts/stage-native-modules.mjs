#!/usr/bin/env node
/**
 * Copies native node_modules (node-pty, node-addon-api) from pnpm's
 * symlinked store into real directories so electron-packager can find them.
 * Run before electron-forge make/package.
 */
import { cpSync, rmSync, realpathSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const nmDir = resolve(desktopRoot, "node_modules");

const modules = ["node-pty", "node-addon-api"];

for (const mod of modules) {
  const modDir = resolve(nmDir, mod);
  if (!existsSync(modDir)) {
    console.log(`  ${mod}: not found, skipping`);
    continue;
  }

  const realPath = realpathSync(modDir);
  if (realPath === modDir) {
    console.log(`  ${mod}: already real directory`);
    continue;
  }

  // Remove symlink, copy real files
  rmSync(modDir, { recursive: true, force: true });
  cpSync(realPath, modDir, { recursive: true });
  console.log(`  ${mod}: copied from ${realPath}`);
}

console.log("Native modules staged.");
