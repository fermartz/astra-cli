/**
 * E2E LLM Journey Test
 *
 * Sends real user messages through runAgentTurn() (no TUI) and verifies
 * the LLM calls the right tools. Uses your real config + credentials —
 * NOT mocked.
 *
 * This is NOT a vitest — it's a manual-run script since it makes real LLM
 * calls (slow, costs money, non-deterministic).
 *
 * Run with:
 *   pnpm tsx src/__tests__/e2e/journey.test.ts
 *   pnpm tsx src/__tests__/e2e/journey.test.ts --scenario 2   # run only scenario 2
 *   ASTRA_DEBUG=1 pnpm tsx ...                                 # verbose LLM debug logs
 */
import type { CoreMessage } from "ai";
import { runAgentTurn, type AgentLoopCallbacks } from "../../agent/loop.js";
import type { AgentProfile } from "../../agent/system-prompt.js";
import {
  loadConfig,
  getActiveAgent,
  loadCredentials,
  loadWallet,
  hasBoardPost,
  loadState,
} from "../../config/store.js";
import {
  getSkillContext,
  fetchRemoteContext,
} from "../../remote/skill.js";
import { loadMemory } from "../../tools/memory.js";

// ─── Types ──────────────────────────────────────────────────────────────

interface ToolCall {
  toolName: string;
  args: Record<string, unknown>;
}

interface TurnResult {
  text: string;
  toolsCalled: ToolCall[];
  responseMessages: CoreMessage[];
}

interface AssertionResult {
  label: string;
  passed: boolean;
  detail?: string;
}

interface ScenarioResult {
  name: string;
  assertions: AssertionResult[];
}

// ─── ANSI colors ────────────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";

// ─── Shared state loaded once at startup ────────────────────────────────

let skillContext = "";
let tradingContext = "";
let walletContext = "";
let rewardsContext = "";
let onboardingContext = "";
let apiContext = "";
let agentName = "";
let memoryContent = "";

async function loadSharedContext(): Promise<void> {
  const config = loadConfig();
  if (!config) throw new Error("No config found. Run onboarding first.");

  agentName = getActiveAgent() ?? "";
  if (!agentName) throw new Error("No active agent.");

  const creds = loadCredentials(agentName);
  if (!creds) throw new Error(`No credentials for agent "${agentName}".`);

  [skillContext, tradingContext, walletContext, rewardsContext, onboardingContext, apiContext] =
    await Promise.all([
      getSkillContext(),
      fetchRemoteContext("TRADING.md").then((c) => c ?? ""),
      fetchRemoteContext("WALLET.md").then((c) => c ?? ""),
      fetchRemoteContext("REWARDS.md").then((c) => c ?? ""),
      fetchRemoteContext("ONBOARDING.md").then((c) => c ?? ""),
      fetchRemoteContext("API.md").then((c) => c ?? ""),
    ]);

  memoryContent = loadMemory(agentName);
}

// ─── Helper: send a message through runAgentTurn ────────────────────────

async function sendMessage(
  userText: string,
  conversation: CoreMessage[],
  profile: AgentProfile,
): Promise<TurnResult> {
  // Append user message
  conversation.push({ role: "user", content: userText });

  let accumulatedText = "";

  const callbacks: AgentLoopCallbacks = {
    onTextChunk: (chunk) => {
      accumulatedText += chunk;
    },
    onToolCallStart: (name) => {
      process.stdout.write(`    ${DIM}→ tool: ${name}${RESET}\n`);
    },
  };

  const result = await runAgentTurn(
    conversation,
    skillContext,
    tradingContext,
    walletContext,
    rewardsContext,
    onboardingContext,
    apiContext,
    profile,
    callbacks,
    memoryContent,
  );

  // Extract tool calls from responseMessages
  const toolsCalled: ToolCall[] = [];
  for (const msg of result.responseMessages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          (part as { type: string }).type === "tool-call"
        ) {
          const tc = part as { type: "tool-call"; toolName: string; args: Record<string, unknown> };
          toolsCalled.push({ toolName: tc.toolName, args: tc.args });
        }
      }
    }
  }

  // Append response messages to conversation for chaining
  conversation.push(...result.responseMessages);

  return {
    text: result.text,
    toolsCalled,
    responseMessages: result.responseMessages,
  };
}

// ─── Assertion helpers ──────────────────────────────────────────────────

function expectToolCalled(
  result: TurnResult,
  toolName: string,
  argMatch?: Record<string, unknown>,
): AssertionResult {
  const match = result.toolsCalled.find((tc) => {
    if (tc.toolName !== toolName) return false;
    if (!argMatch) return true;
    // Check if all argMatch keys exist and match in tc.args
    return Object.entries(argMatch).every(([key, val]) => {
      const actual = tc.args[key];
      if (typeof val === "string" && typeof actual === "string") {
        return actual.includes(val);
      }
      if (typeof val === "object" && val !== null && typeof actual === "object" && actual !== null) {
        // Shallow check: every key in val matches in actual
        return Object.entries(val as Record<string, unknown>).every(([k, v]) => {
          const a = (actual as Record<string, unknown>)[k];
          if (typeof v === "string" && typeof a === "string") return a.includes(v);
          return a === v;
        });
      }
      return actual === val;
    });
  });

  const label = argMatch
    ? `${toolName} called with ${JSON.stringify(argMatch)}`
    : `${toolName} called`;

  if (match) {
    return { label, passed: true };
  }

  const calledNames = result.toolsCalled.map((tc) => `${tc.toolName}(${JSON.stringify(tc.args)})`);
  return {
    label,
    passed: false,
    detail: calledNames.length > 0
      ? `Tools called: ${calledNames.join(", ")}`
      : "No tools were called",
  };
}

function expectNoToolCalled(result: TurnResult): AssertionResult {
  if (result.toolsCalled.length === 0) {
    return { label: "No tool calls (text-only response)", passed: true };
  }
  return {
    label: "No tool calls (text-only response)",
    passed: false,
    detail: `Tools called: ${result.toolsCalled.map((tc) => tc.toolName).join(", ")}`,
  };
}

function expectTextContains(result: TurnResult, substring: string): AssertionResult {
  const lower = result.text.toLowerCase();
  if (lower.includes(substring.toLowerCase())) {
    return { label: `Text mentions "${substring}"`, passed: true };
  }
  return {
    label: `Text mentions "${substring}"`,
    passed: false,
    detail: `Text (first 200 chars): "${result.text.slice(0, 200)}"`,
  };
}

function expectTextNotEmpty(result: TurnResult): AssertionResult {
  const trimmed = result.text.trim();
  if (trimmed.length > 0 && !trimmed.startsWith("(No response")) {
    return { label: "LLM returned non-empty text", passed: true };
  }
  return {
    label: "LLM returned non-empty text",
    passed: false,
    detail: `Text: "${result.text}"`,
  };
}

// ─── Scenarios ──────────────────────────────────────────────────────────

async function scenario1_onboarding(): Promise<ScenarioResult> {
  const assertions: AssertionResult[] = [];
  const conversation: CoreMessage[] = [];

  const profile: AgentProfile = {
    agentName,
    status: "pending_verification",
    verificationCode: "test-VERIFY-CODE",
    isNewAgent: true,
    journeyStage: "pending",
  };

  // Turn 1: empty message — LLM should proactively guide verification
  process.stdout.write(`  ${CYAN}Turn 1:${RESET} "" (empty — expect verification guidance)\n`);
  const turn1 = await sendMessage("", conversation, profile);
  assertions.push(expectTextNotEmpty(turn1));
  assertions.push(expectTextContains(turn1, "verif"));
  assertions.push(expectNoToolCalled(turn1));

  // Turn 2: user posts tweet URL → LLM should call verify API
  process.stdout.write(`  ${CYAN}Turn 2:${RESET} "I posted the tweet: https://x.com/testuser/status/123456"\n`);
  const turn2 = await sendMessage(
    "I posted the tweet, here's the URL: https://x.com/testuser/status/123456",
    conversation,
    profile,
  );
  assertions.push(expectToolCalled(turn2, "api_call", { method: "POST", path: "/api/v1/agents/me/verify" }));
  assertions.push(expectTextNotEmpty(turn2));

  return { name: "Onboarding (verification flow)", assertions };
}

async function scenario2_marketCheck(): Promise<ScenarioResult> {
  const assertions: AssertionResult[] = [];
  const conversation: CoreMessage[] = [];

  const profile: AgentProfile = {
    agentName,
    status: "active",
    simBalance: 10000,
    journeyStage: "verified",
  };

  // Turn 1: check market
  process.stdout.write(`  ${CYAN}Turn 1:${RESET} "check the market"\n`);
  const turn1 = await sendMessage("check the market", conversation, profile);
  assertions.push(expectToolCalled(turn1, "api_call", { path: "/api/v1/market/state" }));
  assertions.push(expectTextNotEmpty(turn1));

  // Turn 2: show epochs
  process.stdout.write(`  ${CYAN}Turn 2:${RESET} "show me recent epochs"\n`);
  const turn2 = await sendMessage("show me recent epochs", conversation, profile);
  assertions.push(expectToolCalled(turn2, "api_call", { path: "/api/v1/market/epochs" }));
  assertions.push(expectTextNotEmpty(turn2));

  return { name: "Market Check", assertions };
}

async function scenario3_trading(): Promise<ScenarioResult> {
  const assertions: AssertionResult[] = [];
  const conversation: CoreMessage[] = [];

  const profile: AgentProfile = {
    agentName,
    status: "active",
    simBalance: 10000,
    journeyStage: "verified",
  };

  // Turn 1: buy nova
  process.stdout.write(`  ${CYAN}Turn 1:${RESET} "buy 100 nova"\n`);
  const turn1 = await sendMessage("buy 100 nova", conversation, profile);
  assertions.push(expectToolCalled(turn1, "api_call", { method: "POST", path: "/api/v1/trades" }));
  assertions.push(expectTextNotEmpty(turn1));

  // Turn 2: sell nova
  process.stdout.write(`  ${CYAN}Turn 2:${RESET} "sell 50 nova"\n`);
  const turn2 = await sendMessage("sell 50 nova", conversation, profile);
  assertions.push(expectToolCalled(turn2, "api_call", { method: "POST", path: "/api/v1/trades" }));
  assertions.push(expectTextNotEmpty(turn2));

  return { name: "Trading", assertions };
}

async function scenario4_walletSetup(): Promise<ScenarioResult> {
  const assertions: AssertionResult[] = [];
  const conversation: CoreMessage[] = [];

  const profile: AgentProfile = {
    agentName,
    status: "active",
    journeyStage: "trading",
  };

  // Turn 1: setup wallet — expect multi-step tool chain
  process.stdout.write(`  ${CYAN}Turn 1:${RESET} "setup wallet" (expect multi-tool chain)\n`);
  const turn1 = await sendMessage("setup wallet", conversation, profile);

  // The key test: LLM should call multiple tools in sequence
  assertions.push(expectToolCalled(turn1, "read_config"));

  // create_wallet is only expected if no wallet exists locally.
  // If a wallet already exists, the LLM correctly skips creation and goes
  // straight to challenge/sign/register.
  const hasLocalWallet = loadWallet(agentName) !== null;
  if (hasLocalWallet) {
    const skipResult: AssertionResult = {
      label: "create_wallet skipped (wallet already exists locally)",
      passed: true,
    };
    assertions.push(skipResult);
  } else {
    assertions.push(expectToolCalled(turn1, "create_wallet"));
  }

  assertions.push(expectToolCalled(turn1, "api_call", { method: "POST", path: "wallet/challenge" }));
  assertions.push(expectToolCalled(turn1, "sign_challenge"));
  assertions.push(expectToolCalled(turn1, "api_call", { method: "PUT", path: "/api/v1/agents/me/wallet" }));
  assertions.push(expectToolCalled(turn1, "api_call", { method: "GET", path: "/api/v1/agents/me" }));
  assertions.push(expectTextNotEmpty(turn1));

  return { name: "Wallet Setup (multi-tool chain)", assertions };
}

async function scenario5_offTopic(): Promise<ScenarioResult> {
  const assertions: AssertionResult[] = [];
  const conversation: CoreMessage[] = [];

  const profile: AgentProfile = {
    agentName,
    status: "active",
    simBalance: 10000,
    journeyStage: "verified",
  };

  // Turn 1: off-topic question
  process.stdout.write(`  ${CYAN}Turn 1:${RESET} "what's the weather in Tokyo?"\n`);
  const turn1 = await sendMessage("what's the weather in Tokyo?", conversation, profile);
  assertions.push(expectNoToolCalled(turn1));
  assertions.push(expectTextNotEmpty(turn1));

  return { name: "Off-topic (redirect to AstraNova)", assertions };
}

// ─── Runner ─────────────────────────────────────────────────────────────

const SCENARIOS = [
  { id: 1, name: "Onboarding", fn: scenario1_onboarding },
  { id: 2, name: "Market Check", fn: scenario2_marketCheck },
  { id: 3, name: "Trading", fn: scenario3_trading },
  { id: 4, name: "Wallet Setup", fn: scenario4_walletSetup },
  { id: 5, name: "Off-topic", fn: scenario5_offTopic },
];

function printAssertions(assertions: AssertionResult[]): void {
  for (const a of assertions) {
    if (a.passed) {
      process.stdout.write(`    ${GREEN}✓${RESET} ${a.label}\n`);
    } else {
      process.stdout.write(`    ${RED}✗${RESET} ${a.label}\n`);
      if (a.detail) {
        process.stdout.write(`      ${DIM}${a.detail}${RESET}\n`);
      }
    }
  }
}

async function main(): Promise<void> {
  // Parse --scenario N flag
  const scenarioArg = process.argv.find((a) => a === "--scenario" || a === "-s");
  const scenarioIdx = scenarioArg ? process.argv.indexOf(scenarioArg) : -1;
  const scenarioFilter = scenarioIdx >= 0 ? Number(process.argv[scenarioIdx + 1]) : null;

  process.stdout.write(`\n${BOLD}═══ E2E LLM Journey Test ═══${RESET}\n\n`);
  process.stdout.write(`${DIM}Loading config and remote context...${RESET}\n`);

  await loadSharedContext();

  process.stdout.write(`${DIM}Agent: ${agentName}${RESET}\n`);
  process.stdout.write(`${DIM}Skill context: ${skillContext.length} chars${RESET}\n\n`);

  const scenariosToRun = scenarioFilter
    ? SCENARIOS.filter((s) => s.id === scenarioFilter)
    : SCENARIOS;

  if (scenariosToRun.length === 0) {
    process.stderr.write(`No scenario with id ${scenarioFilter}. Available: ${SCENARIOS.map((s) => s.id).join(", ")}\n`);
    process.exit(1);
  }

  const results: ScenarioResult[] = [];

  for (const scenario of scenariosToRun) {
    process.stdout.write(`${BOLD}═══ SCENARIO ${scenario.id}: ${scenario.name} ═══${RESET}\n`);

    try {
      const result = await scenario.fn();
      results.push(result);
      printAssertions(result.assertions);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`  ${RED}FATAL: ${msg}${RESET}\n`);
      if (err instanceof Error && err.stack) {
        process.stdout.write(`  ${DIM}${err.stack.split("\n").slice(1, 4).join("\n  ")}${RESET}\n`);
      }
      results.push({
        name: scenario.name,
        assertions: [{ label: "Scenario execution", passed: false, detail: msg }],
      });
    }

    process.stdout.write("\n");
  }

  // Summary
  const totalAssertions = results.flatMap((r) => r.assertions);
  const passed = totalAssertions.filter((a) => a.passed).length;
  const failed = totalAssertions.filter((a) => !a.passed).length;
  const total = totalAssertions.length;

  process.stdout.write(`${BOLD}═══ RESULTS ═══${RESET}\n`);
  process.stdout.write(`${passed === total ? GREEN : RED}${passed}/${total} passed`);
  if (failed > 0) {
    process.stdout.write(`, ${failed} failure${failed > 1 ? "s" : ""}`);
  }
  process.stdout.write(`${RESET}\n\n`);

  // List failures
  if (failed > 0) {
    process.stdout.write(`${RED}Failures:${RESET}\n`);
    for (const r of results) {
      const failures = r.assertions.filter((a) => !a.passed);
      if (failures.length > 0) {
        process.stdout.write(`  ${r.name}:\n`);
        for (const f of failures) {
          process.stdout.write(`    ${RED}✗${RESET} ${f.label}\n`);
          if (f.detail) {
            process.stdout.write(`      ${DIM}${f.detail}${RESET}\n`);
          }
        }
      }
    }
    process.stdout.write("\n");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n${RED}Fatal error: ${msg}${RESET}\n`);
  process.exit(1);
});
