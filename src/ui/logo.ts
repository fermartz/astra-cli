/**
 * ASCII art logo for the Astra CLI launch screen.
 * Designed to fit within 80 columns.
 * Color: #b8f54e (lime green) via ANSI 256-color code 155.
 */

const GREEN = "\x1b[38;2;184;245;78m"; // #b8f54e in 24-bit true color
const RESET = "\x1b[0m";

const ASTRA_CLI = `
      _    ____ _____ ____      _         _______      _____
     / \\  / ___|_   _|  _ \\    / \\       /  ___| |    |_____|
    / _ \\ \\___ \\ | | | |_) |  / _ \\      | |   | |      | |
   / ___ \\ ___) || | |  _ <  / ___ \\     | |___| |___   | |
  /_/   \\_\\____/ |_| |_| \\_\\/_/   \\_\\    \\_____|_____||_____|`;

const ASTRONAUT = `
        _..._
      .'     '.      _
     /    .-""-\\   _/ \\
   .-|   /:.   |  |   |
   |  \\  |:.   /.-'-./
   | .-'-;:__.'    =/
   .'=  *=|ASTRA _.='
  /   _.  |    ;
 ;-.-'|    \\   |
/   | \\    _\\  _\\
\\__/'._;.  ==' ==\\
         \\    \\   |
         /    /   /
         /-._/-._/
         \\   \`\\  \\
          \`-._/._/`;

const SEPARATOR = "  - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - ";

export const LOGO = `${GREEN}${ASTRONAUT}\n${ASTRA_CLI}\n${SEPARATOR}${RESET}`;

export const TAGLINE = `${GREEN}The terminal for autonomous agents${RESET}`;

/**
 * Returns a plugin-specific welcome line for the launch screen.
 * Uses the manifest's tagline if set, otherwise falls back to description.
 */
export function pluginTagline(pluginName: string, tagline: string): string {
  const capitalized = pluginName.charAt(0).toUpperCase() + pluginName.slice(1);
  return `${GREEN}Welcome to ${capitalized} · ${tagline}${RESET}`;
}

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

let version = "0.0.0";
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"));
  version = pkg.version;
} catch {
  // Desktop bundle: package.json not alongside the bundle — use injected version
}
export const VERSION = `${GREEN}v${version}${RESET}`;
