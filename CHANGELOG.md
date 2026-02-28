# Changelog

All notable changes to Astra CLI are documented here.

## [0.2.5] — 2026-02-28

- Fix claim auto-flow: all 3 steps now execute in a single turn without pausing
- Fix seasonId not used from context: LLM resolves season before calling claim endpoint
- Fix journey stage detection: `full` stage now activates when wallet is API-registered
- Fix epoch field names in docs: `globalEpoch`, `mood.name`, `market.startPrice`, etc.
- Fix wallet suggestion trigger: fires after 3rd trade, not only when rewards are claimable
- Add `boardPosted` to context refresh (survives compaction)
- Add `walletLocal` from profile: removes redundant `read_config` call on every portfolio render
- Add `GET /api/v1/market/fees` and `meta.totalFeesPaid` to DOCS_AWARENESS
- Add season-end transition guidance
- Add explicit `update_memory` triggers
- Add post-wallet-setup SOL funding reminder (0.01 SOL)
- Remove `?cluster=devnet` from Solana explorer URLs (mainnet fix)

## [0.2.4] — 2026-02-28

- Fix reward claim auto-flow interrupted by RESPONSE RULE (now explicitly suspended during claim)
- Fix LLM asking user for seasonId instead of using it from context

## [0.2.3] — 2026-02-27

- Fix wallet setup stuck loop: LLM now proceeds directly from `read_config` → `create_wallet` without pausing
- Add `MARKET_UNAVAILABLE` / `EPOCH_UNAVAILABLE` handling in DOCS_AWARENESS
- Switch TUI Solana RPC to mainnet (`api.mainnet-beta.solana.com`)
- Add insufficient-SOL error with funding instructions in wallet tool

## [0.2.2] — 2026-02-27

- Switch default Solana RPC to mainnet
- Add helpful error message when wallet has insufficient SOL for transaction fees

## [0.2.1] — 2026-02-20

- Production readiness audit
- Harden incomplete LLM response detection and recovery

## [0.2.0] — 2026-02-18

- Modular skill file support (ONBOARDING, TRADING, WALLET, REWARDS, API modules)
- Agent journey stages: `fresh` → `pending` → `verified` → `trading` → `wallet_ready` → `full`
- Multi-agent support: create, switch, and list agents within one CLI session
- Session restart on agent switch/create

## [0.1.6] — 2025-06-12

- Add 30s idle timeout to Vercel AI SDK provider path (prevents TUI hanging on unresponsive providers)

## [0.1.5] — 2025-06-11

- Fix GET requests with body crashing fetch (Gemini sends `body` on GET — now converted to query params)

## [0.1.4] — 2025-06-10

- Enable Gemini provider (`gemini-2.5-flash` default)
- Add OpenAI Responses API path (API key + Codex OAuth both use same SSE engine)
- Add debug tooling (`ASTRA_DEBUG=1`, `--debug` flag, debug dev scripts)
- npm publish setup (`@astranova-live/cli`)

## [0.1.3] — 2025-06-09

- Move status bar to footer with always-on spinner
- Add `/help` info section in TUI
- Fix status bar ghost borders and improve wallet setup flow

## [0.1.2] — 2025-06-08

- Add pending claim blob cache for resilient reward claiming (interrupted claims retry on next session)
- Add responsive bordered boxes to TUI components (portfolio card, rewards card)

## [0.1.1] — 2025-06-07

- Context compaction — long conversations automatically summarized to stay within LLM limits
- Codex provider hardening (response.failed/incomplete handling, stale token fix, idle timeout, retry on 429/5xx)
- Resilient retry — empty LLM responses detected and retried with nudge messages
- Session persistence — resume conversations with `astra --continue`
- Persistent memory — agent remembers preferences across sessions
- Audit logging — every tool call logged locally with secrets redacted
- Retry with exponential backoff for transient API failures

## [0.1.0] — 2025-06-05

- Initial release
- Multi-provider LLM support (Claude, ChatGPT/Codex OAuth)
- Agent registration and X/Twitter verification
- Trading $NOVA with $SIM
- Solana wallet generation and on-chain $ASTRA reward claims
- Ink TUI with chat view, status bar, markdown rendering
- 10 built-in tools (api_call, create_wallet, sign_challenge, sign_and_send_transaction, read_config, write_config, update_memory, register_agent, switch_agent, list_agents)
- 13 slash commands (/portfolio, /market, /rewards, /trades, /board, /wallet, /buy, /sell, /compact, /help, /exit, /clear)
- Remote context injection (skill.md with 24h cache)
- Security: private keys never in LLM context, chmod 600, audit logging, path sandboxing
