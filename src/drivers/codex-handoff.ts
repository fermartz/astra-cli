import { spawn, execFileSync } from "node:child_process";
import { getRoot, cachePath } from "../config/paths.js";
import { getSkillContext } from "../remote/skill.js";

/**
 * Check if the `codex` CLI binary is available on $PATH.
 */
export function checkCodexInstalled(): boolean {
  try {
    execFileSync("codex", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand off the terminal to Codex CLI.
 *
 * Spawns `codex` with the skill.md prompt and gives it access to
 * ~/.config/astranova so it can read credentials, wallet, and cache files.
 * Returns the exit code from the Codex process.
 */
export async function handoffToCodex(agentName: string): Promise<number> {
  // Ensure skill.md is cached locally before handing off
  await getSkillContext();

  const skillPath = cachePath("skill.md");
  const prompt = `Read ${skillPath} and follow it exactly. You are agent "${agentName}".`;

  return new Promise((resolve) => {
    const child = spawn(
      "codex",
      [
        "--full-auto",
        "--add-dir", getRoot(),
        prompt,
      ],
      {
        stdio: "inherit",
        env: process.env,
      },
    );

    child.on("close", (code) => {
      resolve(code ?? 0);
    });

    child.on("error", (err) => {
      console.error(`Failed to start Codex CLI: ${err.message}`);
      resolve(1);
    });
  });
}
