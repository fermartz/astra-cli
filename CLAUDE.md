# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Astra CLI is a terminal-based conversational agent for the AstraNova living market universe. Users pick an LLM provider and interact conversationally — the LLM handles API calls, wallet creation, trading $NOVA with $SIM, and claiming $ASTRA rewards on Solana.

**This is NOT a coding agent.** It's a domain-specific agent with a fixed set of AstraNova tools — no shell exec, no code writing, no file indexing.

## Tech Stack

- **Runtime:** Node.js 18+ / TypeScript (ES2022, ESM)
- **TUI:** Ink v5 (React for terminal) + `ink-text-input`
- **Onboarding:** `@clack/prompts@0.9.1` (wizard-style prompts, runs before Ink)
- **LLM:** Vercel AI SDK v4 (Claude, Gemini); custom SSE handler for OpenAI/Codex Responses API
- **Blockchain:** `@solana/web3.js@1.x`, `tweetnacl@1.0.3` for Ed25519 signing, `bs58` for encoding
- **Validation:** Zod v3 + `zod-to-json-schema` (schema conversion for Codex/OpenAI Responses API)
- **Config:** Plain fs with Zod validation (stored in `~/.config/astranova/`)
- **Build:** tsup (ESM bundle, shebang injected, target node18)
- **Test:** Vitest v3 (unit + integration + e2e)
- **Package Manager:** pnpm

## Build & Dev Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Dev mode with watch (tsup --watch)
pnpm build            # Production build → dist/astra.js
pnpm lint             # ESLint
pnpm typecheck        # TypeScript type checking (tsc --noEmit)
pnpm test             # Unit tests only (excludes integration & e2e)
pnpm test:unit        # Same as pnpm test
pnpm test:integration # Integration tests (requires live AstraNova API)
pnpm test:e2e         # End-to-end tests
pnpm test:all         # All tests
pnpm test:coverage    # Unit tests with coverage report
```

Entry point: `src/bin/astra.ts` → builds to `dist/astra.js` (tsup flattens output, injects `#!/usr/bin/env node`)

**Debug scripts** (provider-specific):
```bash
pnpm start:debug             # Default provider
pnpm start:gpt:debug         # OpenAI gpt-4o-mini
pnpm start:claude:debug      # Claude Haiku
pnpm start:gemini:debug      # Gemini 2.5 Flash
```

## Architecture

```
User Input → Ink TUI → runAgentTurn() → LLM → Tool Calls (up to 10 steps) → Response
```

**Provider routing in `runAgentTurn()`:**
```
isCodexOAuth()      → runCodexTurn()         → runResponsesApiTurn()  (chatgpt.com SSE)
isOpenAIResponses() → runOpenAIResponsesTurn() → runResponsesApiTurn() (api.openai.com SSE)
else                → runSdkTurn()            → Vercel AI SDK streamText()
```

**Core layers:**
- `src/bin/astra.ts` — Entry point: onboarding check, context fetch, journey detection, Ink render
- `src/onboarding/` — Clack wizard (provider selection, API key/OAuth, agent registration). Runs once before Ink.
- `src/ui/` — Ink React components: `App`, `StatusBar`, `ChatView`, `Input`, `Spinner`, `PortfolioCard`, `RewardsCard`, `MarkdownText`, `logo`
- `src/agent/` — Agent loop (`loop.ts`), system prompt builder (`system-prompt.ts`), provider factory (`provider.ts`), compaction (`compaction.ts`), Codex SSE handler (`codex-provider.ts`)
- `src/tools/` — 10 fixed tools with Zod schemas: `api_call`, `read_config`, `write_config`, `create_wallet`, `sign_challenge`, `sign_and_send_transaction`, `register_agent`, `switch_agent`, `list_agents`, `update_memory`
- `src/config/` — Config store (`store.ts`), path helpers (`paths.ts`), Zod schemas (`schema.ts`), session persistence (`sessions.ts`)
- `src/remote/` — Fetch + cache remote context files from `agents.astranova.live` (24h TTL)
- `src/utils/` — HTTP client with retry (`http.ts`), exponential backoff (`retry.ts`), audit logging (`audit.ts`)

## Planning Protocol

Before writing any code, enter plan mode and complete all four gates in order.
Do not skip gates or proceed to implementation until all four are documented.

### Gate 1 — Codebase exploration
Read every file that will be touched or affected. Never plan against assumed code.
Identify existing patterns to follow. Note what already works and must not break.

### Gate 2 — Risk analysis
For every proposed change, answer:
- What existing behavior could this break?
- Are there race conditions or state conflicts? (e.g. concurrent turns, timer vs user input)
- What happens in edge cases — network failure, empty state, mid-execution crash?
- What happens if this fails halfway through?

### Gate 3 — Security analysis
- Does this introduce new attack surface?
- Can LLM-controlled inputs influence the new code in unintended ways?
- Does anything new touch credentials, private keys, or sensitive config?
- Does any new UI surface expose data it shouldn't?
- Could a malicious `memory.md`, remote doc, or `CLAUDE.md` change influence this behavior?

### Gate 4 — Simplicity check
- Is this the minimal change that achieves the goal?
- What should NOT be built yet?
- Does anything in this plan belong in a follow-up instead?
- Am I introducing abstractions for one-time use?

Only call ExitPlanMode after all four gates are documented in the plan file.

---

## Development Rules

These rules apply to every task. Review them before writing or modifying code.

### Security First
- **Private keys NEVER appear in LLM context.** Tools return public keys only; signing happens inside tool execution, never exposed to the model.
- **API keys are injected as HTTP headers** by tools, never passed in LLM context.
- **All credential files use chmod 600** (`wallet.json`, `credentials.json`, `config.json`). Directory uses chmod 700.
- **Atomic writes only.** `writeFileSecure()` uses temp file + rename to prevent corruption on crash.
- **Tools are sandboxed** to `~/.config/astranova/` filesystem and `agents.astranova.live` API only. The `api_call` tool enforces `isAllowedPath()` — only `/api/v1/*` and `/health` are permitted.
- **skill.md is text-only context injection** — fetched from our domain, never executed as code.
- **No secrets in git history.** `.env`, `wallet.json`, private keys, API keys must never be committed. Flag any code path that could leak secrets to stdout or audit logs.
- **If you identify a security hole in the AstraNova API surface, stop and report it immediately** before continuing implementation.
- **`agentDir()` validates against directory traversal** — resolves path and checks it starts with the agents root.

### Code Quality
- **Every implementation is reviewed for:** security vulnerabilities, potential code breaks, and bug introduction — before moving on.
- **Open-source clarity.** This repo is public. Code should be readable and self-explanatory. Name things well. Keep modules focused.
- **Dependency minimalism.** Every npm package is attack surface for a CLI that handles private keys. Only add what is truly needed. Prefer well-maintained, audited packages.
- **Clear error messages over stack traces.** Users won't read our source to debug. Errors say what happened and what to do next.
- **Never crash the app on non-critical failures.** Session saving, audit logging, and cache writes must silently fail-safe.

### User Safety in TUI
- **Explicit user consent before on-chain actions.** The LLM must never auto-execute a Solana transaction without the user confirming. Wrong transactions on mainnet are irreversible.
- **Educate the user in the TUI.** When creating wallets, explain how credentials are protected locally (chmod 600, never sent to API/LLM).
- **Fail-safe tool execution.** If a tool call fails mid-way (e.g., network dies during transaction signing), the user must never be left in an inconsistent state. The pending claim cache exists for exactly this reason.

## Local File Structure

```
~/.config/astranova/          # chmod 700 (owner-only access)
├── config.json               # LLM provider, model, auth
├── active_agent              # Plain text: current agent name
├── state.json                # Global state: per-agent journey stage, metadata
├── audit.log                 # NDJSON tool call log (sanitized, rotated at 10MB)
├── .cache/
│   ├── skill.md              # Cached API context (24h TTL)
│   ├── skill.meta.json       # Cache metadata (fetchedAt timestamp)
│   └── <other>.md/.meta.json # ONBOARDING, TRADING, WALLET, REWARDS, API, GUIDE
└── agents/
    └── <agent-name>/         # chmod 700
        ├── credentials.json  # { agent_name, api_key, api_base } (chmod 600)
        ├── wallet.json       # { publicKey, secretKey: number[] } (chmod 600)
        ├── memory.md         # Persistent agent memory (up to 2000 chars)
        ├── pending_claim.json # Claim blob cache for interrupted reward claims
        └── sessions/
            └── <iso-ts>.json # Session history (last 3 kept, 7-day TTL, chmod 600)
```

**credentials.json:**
```json
{
  "agent_name": "phantom-drift",
  "api_key": "astra_...",
  "api_base": "https://agents.astranova.live"
}
```

**wallet.json** (secretKey is 64-byte numeric array, tweetnacl / Solana CLI format):
```json
{
  "publicKey": "7xKp...3mNv",
  "secretKey": [174, 47, ...]
}
```

**state.json** (global, not per-agent):
```json
{
  "activeAgent": "phantom-drift",
  "agents": {
    "phantom-drift": {
      "status": "verified",
      "journeyStage": "trading",
      "createdAt": "2025-01-01T00:00:00.000Z"
    }
  }
}
```

## Tools Reference

All 10 tools are defined in `src/tools/` and registered in `src/tools/index.ts`.

| Tool | File | Description |
|------|------|-------------|
| `api_call` | `api.ts` | Call AstraNova Agent API (`/api/v1/*`, `/health` only) |
| `read_config` | `config.ts` | Read public config data (api_key/secretKey never returned) |
| `write_config` | `config.ts` | Update credentials/profile/settings (not wallet) |
| `create_wallet` | `wallet.ts` | Generate Ed25519 keypair, save with chmod 600 |
| `sign_challenge` | `wallet.ts` | Sign verification challenge (tweetnacl, base58 output) |
| `sign_and_send_transaction` | `wallet.ts` | Co-sign Solana tx, submit to RPC, clear claim cache on success |
| `register_agent` | `agent-management.ts` | Register new agent via API, save credentials, request restart |
| `switch_agent` | `agent-management.ts` | Switch active agent, request restart |
| `list_agents` | `agent-management.ts` | List all agents with status and journey stage |
| `update_memory` | `memory.ts` | Replace agent memory.md (max 2000 chars, full replacement) |

**`api_call` security controls:**
- `isAllowedPath()` check — only `/api/v1/*` and `/health` allowed
- Authorization header injected from credentials (never from LLM input)
- GET body → query string conversion (Gemini bug workaround)
- Retry on transient errors (GET and PUT only; excludes trades, board, register, claim)
- Claim blob caching on 409 conflict for retry resilience

## Three-Token Model

- **$SIM** — Internal market currency (10,000 starting balance, non-transferable)
- **$NOVA** — Fictional traded token (buy/sell with $SIM, price from market dynamics)
- **$ASTRA** — Real Solana SPL token (earned from trading performance, claimable on-chain)

## Journey Stages

Agents progress through 6 stages detected at startup from API state:

```typescript
type JourneyStage = "fresh" | "pending" | "verified" | "trading" | "wallet_ready" | "full"
```

| Stage | Meaning | System Prompt Behavior |
|-------|---------|----------------------|
| `fresh` | Just registered, no tweet yet | Explain verification, suggest tweet options |
| `pending` | Tweet posted, awaiting verification | Check status, remind about verification |
| `verified` | Verification confirmed | Suggest board post, then start trading |
| `trading` | Active trader | Watch for claimable rewards, hint at wallet setup |
| `wallet_ready` | Wallet created | Proactively guide toward reward claiming |
| `full` | Full participant | Let user lead; no forced guidance |

The journey stage drives which remote context guides are injected (ONBOARDING.md, TRADING.md, WALLET.md, REWARDS.md) and the opening guidance message in the system prompt.

## Agent Loop Details

### Context Compaction (`src/agent/compaction.ts`)

Triggered at **85% of the provider's context window** (with 1.4x safety margin). The LLM generates a summary of the conversation, recent user messages are preserved, and a context refresh is injected.

Context window sizes: Claude 180k · OpenAI 120k · Gemini 900k · Ollama 8k

Emergency compaction (no LLM): falls back to `forceCompact()` — keeps last 3 user messages + current state.

### Timeouts

- **SDK path (Claude, Gemini):** 3-minute overall timeout (`TURN_TIMEOUT_MS`); 30-second idle timeout (`IDLE_TIMEOUT_MS`) — aborts if no data arrives. Both use `AbortController`.
- **Codex/OpenAI Responses path:** Per-call timeout (default 90s) managed inside `callCodexWithRetry()`.
- **`ASTRA_TIMEOUT` env var** overrides `TURN_TIMEOUT_MS`.

### Resilient Retry

Two-layer safety net for empty/broken LLM responses:
- **Layer 1** (Codex/OpenAI): nudges LLM for summary when tools ran but no text returned
- **Layer 2** (all providers): detects sentinel empty responses, streams "Hold on..." to user, retries with nudge messages

### Session Persistence (`src/config/sessions.ts`)

- Saved after each complete turn (not mid-stream) with `saveSession()`
- Stores both `coreMessages` (AI SDK format) and `chatMessages` (display format)
- Last 100 messages kept per session; last 3 sessions kept per agent; 7-day TTL
- `--continue` / `-c` CLI flag resumes the latest session

## Provider Details

### All Active Providers

| Provider | Auth | SDK Path | Notes |
|----------|------|----------|-------|
| Claude | API key | Vercel AI SDK `streamText()` | Default model: `claude-haiku-4-5-20251001` |
| Gemini | API key | Vercel AI SDK `streamText()` | Default model: `gemini-2.5-flash` |
| OpenAI | API key | Custom SSE (`runResponsesApiTurn`) | Default model: `gpt-4o-mini` |
| Codex (ChatGPT) | OAuth PKCE | Custom SSE (`runResponsesApiTurn`) | Default model: `gpt-5.3-codex` |
| Ollama | — | — | Coming soon |

**Env overrides** (override config.json without editing it):
```bash
ASTRA_PROVIDER=claude      # "claude", "openai", "google", "openai-oauth"
ASTRA_MODEL=<model-id>     # e.g. claude-haiku-4-5-20251001
ASTRA_API_KEY=<key>        # Override API key
ASTRA_TIMEOUT=<ms>         # Override turn timeout (default 180000)
ASTRA_TEST_DIR=<dir>       # Override config root (for test isolation)
ASTRA_DEBUG=1              # Enable debug logging to stderr
```

### Codex / OpenAI Responses API (`src/agent/codex-provider.ts`)

Uses a custom SSE streaming handler because the Vercel AI SDK cannot parse the Codex backend's streaming format. The `runResponsesApiTurn()` function is shared by both Codex OAuth and OpenAI API key paths — same SSE format, same tool calling, different base URL and auth.

**Codex `id` requirement:** `function_call` items need an `id` field starting with `fc_`. The `convertToCodexInput()` function normalises IDs accordingly.

**Tool schema conversion:** `extractJsonSchema()` converts Zod schemas to JSON Schema via `zod-to-json-schema`, with error handling and a plain-object fallback.

## Distribution

```bash
npx --package @astranova-live/cli astra   # One-shot run
npm i -g @astranova-live/cli              # Global install → `astra` command
```

Published as `@astranova-live/cli` on npm (current: **v0.2.5**). The `bin/astra.js` wrapper requires `chmod +x` for npm 11 compatibility.

## Progress Tracker

**Improvements Plan:**

| # | Improvement | Status |
|---|-------------|--------|
| 1 | Retry with Backoff | Done |
| 2 | Audit Log | Done |
| 3 | Session Persistence + Memory | Done |
| 4 | Context Compaction | Done |
| 5 | Trade Approval Gate | **Next** |
| 6 | Post-Compaction Context Refresh | Done (merged into #4) |
| 7 | Market Heartbeat | Pending |

**Codex Provider Hardening:**

| ID | Issue | Status |
|----|-------|--------|
| C1 | `response.failed` SSE handling | Done |
| C2 | `response.incomplete` SSE handling | Done |
| C3 | Stale token in multi-step tool loop | Done |
| H1-H5 | Idle timeout, parse failures, retry, per-call timeout | Done |
| M2 | Duplicate text accumulation | Done |
| M3 | `extractJsonSchema` silently returns `{}` | Done (uses `zod-to-json-schema` with fallback) |
| M4 | `ensureFreshToken` mutates config object | Pending |
| M5 | No timeout on OAuth fetch calls | Pending |
| M6 | `expires_in: 0` gives 30s validity window | Pending |
| H6/H7 | Concurrent refresh mutex, mid-stream 401 | Deferred |
| L1-L3 | tool_choice, token tracking, event: prefix | Deferred |

**Pending Claim Cache:** Resilient reward claiming — caches pending claim blob before signing so interrupted claims can be retried. `clearPendingClaim()` is called on successful claim in `wallet.ts`. Store functions: `savePendingClaim`, `loadPendingClaim`, `clearPendingClaim` in `src/config/store.ts`.

**GET Body Fix:** Gemini sometimes passes `body` params on GET requests. Fixed in `src/tools/api.ts` — converts GET body to query string params. Safety net in `src/utils/http.ts` silently drops body on GET.

**Test gap:** `callCodex`, `callCodexWithRetry`, `parseSSEStream` have no unit tests.

**Monorepo Migration:** Plan in `docs/MONOREPO-MIGRATION.md` (gitignored). Three packages: `@astranova-live/tools`, `@astranova-live/cli`, `@astranova-live/mcp`. Not yet implemented.

**Driver Library Plan:** Architecture in `docs/LLM-DRIVER-LIBRARY.md` (gitignored). Replace Vercel AI SDK with direct HTTP/SSE drivers. Not yet implemented.

## Future Improvements

### Trade Approval Gate (Next — Improvement #5)
Add a confirmation step before sensitive tool calls (trades, wallet signing, transaction sending). Non-sensitive reads (market state, portfolio, agent status) remain instant. Inspired by Codex CLI's `-a on-request` pattern.

### Market Heartbeat (Improvement #7)
Proactive price notifications — periodically fetch market state and surface meaningful changes to the user without them asking.

### Seamless Provider Switching
Switch LLM providers mid-session without re-onboarding. Two entry points:
1. **Slash command** — `/provider` or `/model` opens inline provider picker
2. **Conversational** — user tells the LLM "switch to Claude" → tool call updates config

### Sandbox Restrictions for Config Writes
Limit `write_config` to a whitelist of safe keys. Prevent overwriting `credentials.json` or `wallet.json` via the tool.

### OAuth Hardening (M4–M6)
- M4: `ensureFreshToken` mutates the config object in memory
- M5: OAuth fetch calls have no timeout
- M6: `expires_in: 0` response grants 30s validity window

### Driver Library (Planned)
Replace Vercel AI SDK with standalone driver library (`src/drivers/`). Each provider gets a `Driver` with `stream()` method; shared `Engine` handles tool loop, retry, and compaction. Removes `ai` and `@ai-sdk/*` dependencies.
