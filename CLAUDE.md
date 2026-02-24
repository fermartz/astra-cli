# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Astra CLI is a terminal-based conversational agent for the AstraNova living market universe. Users pick an LLM provider and interact conversationally — the LLM handles API calls, wallet creation, trading $NOVA with $SIM, and claiming $ASTRA rewards on Solana. See `docs/astra-cli.md` for the full implementation plan.

**This is NOT a coding agent.** It's a domain-specific agent with a fixed set of AstraNova tools — no shell exec, no code writing, no file indexing.

## Tech Stack

- **Runtime:** Node.js 18+ / TypeScript
- **TUI:** Ink v5 (React for terminal) + Yoga layout
- **Onboarding:** Clack v0.8 (wizard-style prompts, runs before Ink)
- **LLM:** Vercel AI SDK v4 (multi-provider: Claude, OpenAI, Gemini, Ollama, ChatGPT/Codex OAuth)
- **Blockchain:** @solana/web3.js v2, @solana-program/token-2022
- **Validation:** Zod v3
- **Config:** Plain fs with Zod validation (stored in `~/.config/astranova/`)
- **Build:** Bun bundler or tsup
- **Package Manager:** pnpm

## Build & Dev Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Dev mode with watch
pnpm build            # Production build
pnpm lint             # ESLint
pnpm typecheck        # TypeScript type checking
pnpm test             # Run tests
```

Entry point: `src/bin/astra.ts` → builds to `dist/astra.js` (tsup flattens output)

## Architecture

```
User Input → Ink TUI → Vercel AI SDK streamText() → LLM → Tool Calls (0-5) → Response
```

**Core layers:**
- `src/onboarding/` — Clack wizard (provider selection, API key, wallet setup, agent registration). Runs once before Ink renders.
- `src/ui/` — Ink React components (App, StatusBar, ChatView, Input, Spinner).
- `src/agent/` — Agent loop (`streamText` with `maxSteps: 5`), system prompt builder (injects remote `skill.md`), provider factory.
- `src/tools/` — Fixed set of 6 tools with Zod schemas: `api_call`, `create_wallet`, `import_wallet`, `sign_and_send_transaction`, `read_config`, `write_config`.
- `src/solana/` — Keypair generation/import, message signing, transaction signing, RPC client.
- `src/config/` — Config store (plain fs), path helpers (`~/.config/astranova/`), Zod schema validation.
- `src/remote/` — Fetch + cache `skill.md`/`guide.md`/`heartbeat.md` from `agents.astranova.live` (24h TTL).

**Multi-LLM provider setup:** Provider factory in `src/agent/provider.ts` wraps Vercel AI SDK adapters (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `ollama-ai-provider`). ChatGPT/Codex uses OAuth with localhost callback server — see `docs/codex-oauth-reference.md` for the full implementation reference (PKCE, callback server, token refresh, remote environment support).

## Development Rules

These rules apply to every task. Review them before writing or modifying code.

### Security First
- **Private keys NEVER appear in LLM context.** Tools return public keys only; signing happens inside tool execution.
- **API keys are injected as HTTP headers** by tools, never exposed to the LLM.
- **All credential files use chmod 600** (`wallet.json`, `credentials.json`, `config.json`).
- **Tools are sandboxed** to `~/.config/astranova/` filesystem and `agents.astranova.live` API. No shell execution, no arbitrary file access.
- **skill.md is text-only context injection** — fetched from our domain, never executed as code.
- **No secrets in git history.** `.env`, `wallet.json`, private keys, API keys must never be committed. `.gitignore` is set up from step 1. Flag any code path that could leak secrets to stdout or logs.
- **If you identify a security hole in the AstraNova API surface, stop and report it immediately** before continuing implementation.

### Code Quality
- **Every implementation is reviewed for:** security vulnerabilities, potential code breaks, and bug introduction — before moving on.
- **Open-source clarity.** This repo is public. Code should be readable and self-explanatory. Name things well. Keep modules focused.
- **Dependency minimalism.** Every npm package is attack surface for a CLI that handles private keys. Only add what is truly needed. Prefer well-maintained, audited packages.
- **Clear error messages over stack traces.** Users won't read our source to debug. Errors say what happened and what to do next.

### User Safety in TUI
- **Explicit user consent before on-chain actions.** The LLM must never auto-execute a Solana transaction without the user confirming. Wrong transactions on mainnet are irreversible.
- **Educate the user in the TUI.** When creating wallets, explain how credentials are protected locally (chmod 600, never sent to API/LLM). Also make clear the user is responsible for protecting their own machine and backup.
- **Fail-safe tool execution.** If a tool call fails mid-way (e.g., network dies during transaction signing), the user must never be left in an inconsistent state. Especially critical for `sign_and_send_transaction`.

## Local File Structure

Matches the AstraNova API convention (`skill.md` is the source of truth for paths).

```
~/.config/astranova/
├── config.json                  # Astra CLI config: LLM provider, model, preferences
├── active_agent                 # Plain text: name of the currently active agent
├── .cache/
│   ├── skill.md                 # Cached remote context (24h TTL)
│   └── skill.meta.json          # Cache metadata (fetchedAt)
└── agents/
    └── <agent-name>/
        ├── credentials.json     # { agent_name, api_key, api_base } (chmod 600)
        └── wallet.json          # { publicKey, secretKey: number[] } (chmod 600)
```

**credentials.json** (from live API registration response):
```json
{
  "agent_name": "phantom-drift",
  "api_key": "astra_...",
  "api_base": "https://agents.astranova.live"
}
```

**wallet.json** (secretKey is 64-byte numeric array, matching Solana CLI / tweetnacl format):
```json
{
  "publicKey": "7xKp...3mNv",
  "secretKey": [174, 47, ...]
}
```

## Three-Token Model

- **$SIM** — Internal market currency (10,000 starting balance, non-transferable)
- **$NOVA** — Fictional traded token (buy/sell with $SIM, price from market dynamics)
- **$ASTRA** — Real Solana SPL token (earned from performance, claimable on-chain)

## Distribution

```bash
npx @astra/cli        # One-shot run
npm i -g @astra/cli   # Global install → `astra` command
```

## Progress Tracker

**Improvements Plan:** See `docs/IMPROVEMENTS-PLAN.md` for the full 7-step plan.

| # | Improvement | Status |
|---|-------------|--------|
| 1 | Retry with Backoff | Done |
| 2 | Audit Log | Done |
| 3 | Session Persistence + Memory | Done |
| 4 | Context Compaction | **Next** — pick up here |
| 5 | Trade Approval Gate | Pending |
| 6 | Post-Compaction Context Refresh | Pending |
| 7 | Market Heartbeat | Pending |

**We stopped at #4 (Context Compaction) and will come back to continue.**

## Future Improvements

### Tool Execution Approval
Add a confirmation step before sensitive tool calls (trades, wallet signing, transaction sending). The LLM should preview the action and wait for user approval before executing. Inspired by Codex CLI's `-a on-request` pattern. Non-sensitive reads (market state, portfolio, agent status) should remain instant.

### Driver Pattern for Providers
Refactor provider-specific logic from inline `loop.ts` conditionals into separate driver modules (`src/agent/drivers/codex.ts`, `src/agent/drivers/sdk.ts`). Each driver owns its own API interaction, message formatting, and tool schema conversion. Makes adding new providers (Ollama, future APIs) cleaner and more testable.

### Sandbox Restrictions for Config Writes
Limit `write_config` tool to a whitelist of safe keys/files. Prevent the LLM from overwriting sensitive files like `credentials.json` or `wallet.json` through the write_config tool — those should only be written by dedicated onboarding/wallet tools with explicit user consent.

### Retry with Backoff
Add automatic retry (2-3 attempts with exponential backoff) for transient Codex API failures and AstraNova API timeouts, instead of immediately surfacing the error to the user.

### Proactive Token Refresh
Refresh OAuth tokens in a background interval rather than on-demand, to avoid mid-conversation token expiry causing a failed response.

### Audit Log
Log all tool calls (name, arguments, result summary) to a local file (`~/.config/astranova/.cache/audit.log`) for transparency and debugging. Never log secrets.

### Seamless Provider Switching
Users should be able to switch LLM providers without re-onboarding. The experience should be as frictionless as possible — similar to how Claude Code lets you switch models mid-session. Two entry points:

1. **Slash command** — `/provider` or `/model` opens an inline provider picker (Clack select) within the TUI. User picks new provider, enters API key or does OAuth if needed, and the conversation continues immediately with the new model. No restart required.
2. **Conversational** — User tells the LLM "switch to Claude" or "use GPT" and the LLM triggers the provider switch via a tool call.

Agent credentials, conversation history, and wallet data are completely separate from the LLM provider — switching should only update `config.json` (provider, model, auth fields). The TUI reloads the model on the next message without restarting.
