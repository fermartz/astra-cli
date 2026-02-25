# Session Memory — 2024-02-24

## What We Did Today

### 1. Codex Handoff Mode (Created then Deprioritized)
- Created `src/drivers/codex-handoff.ts` — spawns Codex CLI binary directly
- Added `codexMode` field to `src/config/schema.ts` (enum: "handoff" | "native", default "handoff")
- Modified `src/bin/astra.ts` to branch before Ink TUI when handoff mode
- User tested it, didn't like the Codex CLI experience
- **Decision: Focus on fixing native Codex SSE provider instead** since many users have ChatGPT subscriptions

### 2. Four Bug Fixes to Codex Native Path (in `src/agent/loop.ts`)
- **Fix 1 — Conversation history loss**: Codex input was filtering out tool messages. Now converts CoreMessage tool-call/tool-result parts to CodexInputItem function_call/function_call_output items so conversation context is preserved across turns.
- **Fix 2 — Response messages flat**: Session persistence was broken for Codex path because response messages were flat text instead of structured CoreMessage[]. Now builds assistant messages with tool-call content parts + tool messages with tool-result content parts, matching the SDK path format.
- **Fix 3 — Debug logging noise**: Replaced raw `process.stderr.write` calls with `debugLog()` gated behind `ASTRA_DEBUG` env var in both `loop.ts` and `src/tools/api.ts`.
- **Fix 4 — Dual ID mismatch on multi-turn tool calls**: Codex API requires `function_call` items to have an `id` starting with `fc_`, but CoreMessage only stores one `toolCallId` (the `call_` variant). On second+ turns, reconstructing history put `call_...` in the `id` field causing `Invalid 'input[1].id': Expected an ID that begins with 'fc'`. Fixed by generating `fc_<callId>` prefix when reconstructing from history.

### 3. Path Testability Refactor (`src/config/paths.ts`)
- Refactored from static constants to dynamic `_root()` function
- Checks `ASTRA_TEST_DIR` env var for test isolation
- Added `getRoot()` export
- Updated `store.ts`, `cache.ts`, `codex-handoff.ts` to use dynamic paths
- All path functions (`configPath()`, `agentDir()`, `cachePath()`, etc.) now resolve dynamically

### 4. Unit Test Suite — 137 Tests, All Passing
11 test files in `src/__tests__/`:
- `setup.ts` — Test harness with beforeEach/afterEach creating isolated temp dirs
- `schema.test.ts` (17) — Zod schema validation
- `config-store.test.ts` (25) — Config I/O, state, credentials, wallet, agents
- `journey-stages.test.ts` (10) — All 6 journey stage transitions
- `tools-api.test.ts` (19) — Path whitelist, body resolution (4 Codex formats), retry, board tracking
- `tools-config.test.ts` (12) — Security (never expose secrets), config reads/writes
- `tools-wallet.test.ts` (8) — Wallet creation, challenge signing, secret key never exposed
- `tools-agent-management.test.ts` (15) — Registration, switching, listing
- `tools-memory.test.ts` (8) — Memory save/load, replace semantics, char limit
- `sessions.test.ts` (9) — Session persistence, tool call serialization, pruning
- `audit.test.ts` (10) — Secret sanitization, audit entry writing
- `codex-provider.test.ts` (4) — Tool format conversion

### 5. Integration Test Suite — 13 Test Files (NOT YET RUN)
14 files in `src/__tests__/integration/` (harness + 13 tests):
- `harness.ts` — `executeTool()`, `apiCall()`, `assertSuccess()`, `delay()`
- `01-health` — Health endpoint, public endpoints, path whitelist
- `02-agent-profile` — Agent profile, read_config security, list_agents
- `03-market` — Market state, epoch history, response shape
- `04-portfolio` — Portfolio snapshot, rewards, non-negative values
- `05-trading` — Full buy/sell flow, portfolio updates, body flattening, errors
- `06-board` — Board reading, posting (handles 409), pagination
- `07-wallet` — Wallet creation, challenge signing, registration
- `08-rewards` — Reward listing, claim, sign_and_send_transaction
- `09-agent-registration` — Register new agent, verify creds, cleanup
- `10-agent-switching` — Switch agents, verify context, restore original
- `11-memory` — Memory save/load, replace semantics, char limit
- `12-session-persistence` — Session with tool calls, multi-step trade flow, pruning
- `13-codex-body-formats` — All 4 Codex body format variations with real API

## TODO

1. **Run integration tests** — `pnpm vitest run src/__tests__/integration/` — review results together
2. **Codex native end-to-end validation** — Run the CLI with Codex OAuth to verify all fixes work through the full pipeline
3. **Retry with backoff for transient failures** — Network drops, 429 rate limits, 5xx errors, OAuth token expiry mid-session. Currently these bubble up as errors with no retry. Add automatic retry (2-3 attempts with exponential backoff) before surfacing to the user. Also handle OAuth token auto-refresh on 401.
4. **Continue IMPROVEMENTS-PLAN.md** — Stopped at #4 (Context Compaction)
5. **Twitter/X verification** — Cannot be automated (needs real tweet URLs)

## Key Files Modified Today
- `src/agent/loop.ts` — 3 major fixes (conversation history, response messages, debug logging)
- `src/tools/api.ts` — Conditional debug logging
- `src/config/paths.ts` — Dynamic root resolution for testability
- `src/config/store.ts` — Updated to use dynamic paths
- `src/remote/cache.ts` — Updated to use dynamic paths
- `src/config/index.ts` — Added getRoot export

## Git Status
All committed and pushed to main.
