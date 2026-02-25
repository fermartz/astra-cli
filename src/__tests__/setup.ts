/**
 * Test setup — creates an isolated config directory for each test.
 *
 * Sets ASTRA_TEST_DIR so all path functions resolve to a temp directory,
 * ensuring tests never touch the real ~/.config/astranova.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach } from "vitest";

let testDir: string;

/** Get the current test's isolated config directory. */
export function getTestDir(): string {
  return testDir;
}

/** Create a fake agent with credentials on disk. */
export function setupFakeAgent(
  agentName: string,
  opts?: { withWallet?: boolean; withBoardPost?: boolean },
): void {
  const agentsDir = path.join(testDir, "agents", agentName);
  fs.mkdirSync(agentsDir, { recursive: true });

  // Write credentials
  fs.writeFileSync(
    path.join(agentsDir, "credentials.json"),
    JSON.stringify({
      agent_name: agentName,
      api_key: "astra_test_key_12345",
      api_base: "https://agents.astranova.live",
    }),
    { mode: 0o600 },
  );

  if (opts?.withWallet) {
    // Generate a deterministic fake wallet (not real keys, just for structure validation)
    const fakeSecretKey = Array.from({ length: 64 }, (_, i) => i);
    fs.writeFileSync(
      path.join(agentsDir, "wallet.json"),
      JSON.stringify({
        publicKey: "FakePublicKey111111111111111111111111111111111",
        secretKey: fakeSecretKey,
      }),
      { mode: 0o600 },
    );
  }

  if (opts?.withBoardPost) {
    fs.writeFileSync(
      path.join(agentsDir, "board_posted"),
      new Date().toISOString(),
    );
  }

  // Set as active agent
  fs.writeFileSync(path.join(testDir, "active_agent"), agentName);
  fs.writeFileSync(
    path.join(testDir, "state.json"),
    JSON.stringify({
      activeAgent: agentName,
      agents: {
        [agentName]: {
          status: "active",
          journeyStage: "verified",
          createdAt: new Date().toISOString(),
        },
      },
    }),
  );
}

/** Write a test config file. */
export function setupTestConfig(overrides?: Record<string, unknown>): void {
  const config = {
    version: 1,
    provider: "claude",
    model: "claude-sonnet-4-20250514",
    auth: { type: "api-key", apiKey: "sk-ant-test" },
    apiBase: "https://agents.astranova.live",
    preferences: { theme: "dark" },
    ...overrides,
  };
  fs.writeFileSync(
    path.join(testDir, "config.json"),
    JSON.stringify(config),
  );
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-test-"));
  fs.mkdirSync(path.join(testDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(testDir, ".cache"), { recursive: true });
  process.env.ASTRA_TEST_DIR = testDir;
});

afterEach(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  delete process.env.ASTRA_TEST_DIR;
});
