/**
 * Full autopilot daemon worker.
 *
 * Runs as a detached background process (spawned with --daemon flag).
 * Each tick is stateless: builds a fresh trigger with strategy content,
 * calls runAgentTurn(), and appends the result to autopilot.log.
 *
 * Stops cleanly on SIGTERM (sent by stopDaemon() or /auto off).
 */

import process from "node:process";
import {
  getActiveAgent,
  loadAutopilotConfig,
  loadEpochBudget,
  saveEpochBudget,
  appendAutopilotLog,
} from "../config/store.js";
import { getSkillContext, fetchRemoteContext } from "../remote/skill.js";
import { runAgentTurn } from "../agent/loop.js";
import { loadMemory } from "../tools/memory.js";
import { loadStrategy } from "../tools/strategy.js";
import { buildAutopilotTrigger, EPOCH_BUDGET, BUDGET_BUFFER } from "../autopilot/scheduler.js";
import type { AgentProfile } from "../agent/system-prompt.js";
import type { CoreMessage } from "ai";
import { loadState } from "../config/store.js";

const DEBUG = !!process.env.ASTRA_DEBUG;

function debugLog(msg: string): void {
  if (DEBUG) process.stderr.write(`[astra-daemon] ${msg}\n`);
}

export async function runDaemon(): Promise<void> {
  const agentName = getActiveAgent();
  if (!agentName) {
    process.stderr.write("[astra-daemon] No active agent — exiting.\n");
    process.exit(1);
  }

  const autopilotConfig = loadAutopilotConfig();
  if (autopilotConfig.mode !== "full") {
    process.stderr.write("[astra-daemon] Autopilot mode is not full — exiting.\n");
    process.exit(0);
  }

  debugLog(`Starting for agent "${agentName}", interval ${autopilotConfig.intervalMs}ms`);

  // Load remote context once at startup (24h cache, graceful fallback)
  const [skillContext, tradingContext, walletContext, rewardsContext, onboardingContext, apiContext] =
    await Promise.all([
      getSkillContext(),
      fetchRemoteContext("TRADING.md").then((c) => c ?? ""),
      fetchRemoteContext("WALLET.md").then((c) => c ?? ""),
      fetchRemoteContext("REWARDS.md").then((c) => c ?? ""),
      fetchRemoteContext("ONBOARDING.md").then((c) => c ?? ""),
      fetchRemoteContext("API.md").then((c) => c ?? ""),
    ]);

  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let isRunning = false;

  // Clean shutdown on SIGTERM
  process.on("SIGTERM", () => {
    debugLog("Received SIGTERM — shutting down.");
    if (intervalHandle) clearInterval(intervalHandle);
    process.exit(0);
  });

  async function runTick(): Promise<void> {
    if (isRunning) {
      debugLog("Tick skipped — previous turn still running.");
      return;
    }

    // Re-read strategy and memory fresh each tick (user may have updated them)
    const strategy = loadStrategy(agentName!);
    if (!strategy) {
      debugLog("No strategy found — skipping tick.");
      return;
    }

    // Epoch budget check
    const budget = loadEpochBudget(agentName!);
    const tradeCount = budget?.callCount ?? 0;
    if (tradeCount >= EPOCH_BUDGET - BUDGET_BUFFER) {
      debugLog(`Epoch budget reached (${tradeCount}/${EPOCH_BUDGET}) — skipping tick.`);
      appendAutopilotLog(agentName!, {
        ts: new Date().toISOString(),
        action: `Budget reached (${tradeCount}/${EPOCH_BUDGET}) — skipping until next epoch`,
      });
      return;
    }

    const trigger = buildAutopilotTrigger("full", strategy);
    if (!trigger) return;

    const state = loadState();
    const profile: AgentProfile = {
      agentName: agentName!,
      autopilotMode: "full",
      hasStrategy: true,
      journeyStage: state?.agents[agentName!]?.journeyStage ?? "full",
    };

    const memoryContent = loadMemory(agentName!);
    const coreMessages: CoreMessage[] = [{ role: "user", content: trigger }];

    isRunning = true;
    try {
      debugLog("Running autopilot turn...");
      const result = await runAgentTurn(
        coreMessages,
        skillContext,
        tradingContext,
        walletContext,
        rewardsContext,
        onboardingContext,
        apiContext,
        profile,
        { onTextChunk: () => {}, onToolCallStart: () => {}, onToolCallEnd: () => {} },
        memoryContent,
      );

      const responseText = result.text.trim();
      const summary = responseText.split("\n")[0].slice(0, 120) || "checked → no response";
      debugLog(`Turn complete: ${summary}`);

      appendAutopilotLog(agentName!, {
        ts: new Date().toISOString(),
        action: summary,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog(`Turn error: ${msg}`);
      appendAutopilotLog(agentName!, {
        ts: new Date().toISOString(),
        action: `error: ${msg.slice(0, 100)}`,
      });
    } finally {
      isRunning = false;
    }
  }

  // Run first tick immediately, then on interval
  await runTick();
  intervalHandle = setInterval(() => { void runTick(); }, autopilotConfig.intervalMs);

  debugLog("Daemon running. Waiting for ticks...");
}
