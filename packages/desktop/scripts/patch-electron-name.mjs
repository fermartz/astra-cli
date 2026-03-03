#!/usr/bin/env node
/**
 * Patches the dev Electron binary's Info.plist so macOS shows "Astra"
 * in the menu bar instead of "Electron" during development.
 * Only affects the local node_modules copy — no effect on production builds.
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const plistPath = resolve(
  __dirname,
  "../node_modules/electron/dist/Electron.app/Contents/Info.plist",
);

try {
  let plist = readFileSync(plistPath, "utf8");
  // Replace CFBundleDisplayName value
  plist = plist.replace(
    /(<key>CFBundleDisplayName<\/key>\s*<string>)Electron(<\/string>)/,
    "$1Astra$2",
  );
  // Replace CFBundleName value
  plist = plist.replace(
    /(<key>CFBundleName<\/key>\s*<string>)Electron(<\/string>)/,
    "$1Astra$2",
  );
  writeFileSync(plistPath, plist);
  console.log("Patched Electron Info.plist → Astra");
} catch {
  // Not on macOS or Electron not installed yet — skip silently
}
