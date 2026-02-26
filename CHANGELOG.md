# Changelog

All notable changes to Astra CLI are documented here.

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
